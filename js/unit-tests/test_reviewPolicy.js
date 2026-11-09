/**
 * Unit tests for js/common/reviewPolicy.js — the gh-1351 reviewPolicy config
 * (epic gh-1328 §1/§3-verdict/§4.6): preset tables, resolution chain
 * (projectConfig.reviewPolicy → workflow jobParams → built-in default),
 * hard validation at leg start, machine approval recomputation from the
 * severity census + policy, legacy-knob audit, density control.
 *
 * Pure module — no dmtools globals; loaded with an empty require map.
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
    makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {});
var mod = loadModule('js/common/reviewPolicy.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});

function validationErrorMessage(fn) {
    try {
        fn();
    } catch (e) {
        return e;
    }
    return null;
}

suite('reviewPolicy — preset tables (epic gh-1328 §4.2)', function() {

    test('default preset: BLOCKING/IMPORTANT rework+mandatory, SUGGESTION polish+mandatory, NIT none+opportunistic', function() {
        var p = mod.defaultPolicy();
        assert.equal(p.preset, 'default');
        assert.deepEqual(p.severities.BLOCKING, { round: 'rework', fix: 'mandatory' });
        assert.deepEqual(p.severities.IMPORTANT, { round: 'rework', fix: 'mandatory' });
        assert.deepEqual(p.severities.SUGGESTION, { round: 'polish', fix: 'mandatory' });
        assert.deepEqual(p.severities.NIT, { round: 'none', fix: 'opportunistic' });
    });

    test('fix-everything preset: nits always fixed (polish + mandatory)', function() {
        var p = mod.presetPolicy('fix-everything');
        assert.deepEqual(p.severities.NIT, { round: 'polish', fix: 'mandatory' });
        assert.deepEqual(p.severities.SUGGESTION, { round: 'polish', fix: 'mandatory' });
        assert.deepEqual(p.severities.BLOCKING, { round: 'rework', fix: 'mandatory' });
    });

    test('relaxed preset: suggestions optional (no round), nits none', function() {
        var p = mod.presetPolicy('relaxed');
        assert.equal(p.severities.SUGGESTION.round, 'none');
        assert.equal(p.severities.NIT.round, 'none');
        // IMPORTANT still gates approval in relaxed — only suggestions relax.
        assert.equal(p.severities.IMPORTANT.round, 'rework');
        assert.equal(p.severities.BLOCKING.round, 'rework');
    });

    test('investigation preset: every tier round none + fix never (pure signal, triage closes all)', function() {
        var p = mod.presetPolicy('investigation');
        var tiers = ['BLOCKING', 'IMPORTANT', 'SUGGESTION', 'NIT'];
        for (var i = 0; i < tiers.length; i++) {
            assert.deepEqual(p.severities[tiers[i]], { round: 'none', fix: 'never' }, tiers[i]);
        }
    });

    test('epic default bounds ride every preset policy', function() {
        var p = mod.defaultPolicy();
        assert.equal(p.bounds.polishMaxThreads, 6);
        assert.equal(p.bounds.polishMaxChangedLines, 80);
        assert.equal(p.bounds.opportunisticMaxThreads, 8);
        assert.equal(p.bounds.opportunisticSameFilesOnly, true);
        assert.equal(p.bounds.densityBase, 2);
        assert.equal(p.bounds.densityK, 3);
        assert.equal(p.bounds.densityUnit, 200);
        assert.equal(p.bounds.densityMin, 2);
        assert.equal(p.bounds.densityMax, 8);
        assert.equal(p.bounds.sweepBatch, 10);
        assert.equal(p.bounds.sweepMaxAgeDays, 30);
    });
});

suite('reviewPolicy — resolution chain (config → jobParams → default)', function() {

    test('missing config + missing jobParams → built-in default, silent', function() {
        var p = mod.resolveReviewPolicy({}, {});
        assert.equal(p.preset, 'default');
        assert.equal(p.source, 'built-in default');
        var p2 = mod.resolveReviewPolicy(null, null);
        assert.equal(p2.preset, 'default');
    });

    test('projectConfig.reviewPolicy wins', function() {
        var config = { reviewPolicy: { preset: 'relaxed' } };
        var jp = { reviewPolicy: { preset: 'investigation' } };
        var p = mod.resolveReviewPolicy(config, jp);
        assert.equal(p.preset, 'relaxed');
        assert.equal(p.source, 'projectConfig.reviewPolicy');
    });

    test('workflow jobParams.reviewPolicy applies when config has none', function() {
        var jp = { reviewPolicy: { preset: 'investigation' } };
        var p = mod.resolveReviewPolicy({}, jp);
        assert.equal(p.preset, 'investigation');
        assert.equal(p.source, 'jobParams.reviewPolicy');
    });

    test('jobParams.reviewPolicy as a JSON string parses', function() {
        var jp = { reviewPolicy: '{"preset":"fix-everything"}' };
        var p = mod.resolveReviewPolicy({}, jp);
        assert.equal(p.preset, 'fix-everything');
    });

    test('config-level partial severities override only the named tier', function() {
        var config = { reviewPolicy: { severities: { IMPORTANT: { round: 'none', fix: 'never' } } } };
        var p = mod.resolveReviewPolicy(config, {});
        assert.deepEqual(p.severities.IMPORTANT, { round: 'none', fix: 'never' });
        assert.deepEqual(p.severities.BLOCKING, { round: 'rework', fix: 'mandatory' }, 'rest rides the default table');
        assert.equal(p.preset, 'default');
    });

    test('identity block passes through to the resolved policy (gh-1332 owns its knobs)', function() {
        var config = { reviewPolicy: { identity: { claimSimilarityThreshold: 'high' } } };
        var p = mod.resolveReviewPolicy(config, {});
        assert.deepEqual(p.identity, { claimSimilarityThreshold: 'high' });
    });
});

suite('reviewPolicy — hard validation at leg start (malformed → error)', function() {

    test('unknown tier throws with the tier named', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { severities: { TRIVIAL: { round: 'none', fix: 'never' } } } }, {});
        });
        assert.ok(e, 'unknown tier must throw');
        assert.contains(e.message, 'TRIVIAL');
        assert.ok(mod.isReviewPolicyError(e), 'marked as a policy validation error');
    });

    test('bad round enum throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { severities: { NIT: { round: 'someday', fix: 'never' } } } }, {});
        });
        assert.ok(e, 'bad round enum must throw');
        assert.contains(e.message, 'someday');
    });

    test('bad fix enum throws (both spellings of the correct value are accepted)', function() {
        var e1 = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { severities: { NIT: { round: 'none', fix: 'sometimes' } } } }, {});
        });
        assert.ok(e1, 'bad fix enum must throw');
        // The epic schema spells the value 'oportunistic'; the standard spelling is accepted too.
        var okTypo = mod.resolveReviewPolicy({ reviewPolicy: { severities: { NIT: { round: 'none', fix: 'oportunistic' } } } }, {});
        assert.equal(okTypo.severities.NIT.fix, 'opportunistic');
        var okFixed = mod.resolveReviewPolicy({ reviewPolicy: { severities: { NIT: { round: 'none', fix: 'opportunistic' } } } }, {});
        assert.equal(okFixed.severities.NIT.fix, 'opportunistic');
    });

    test('unknown preset throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { preset: 'yolo' } }, {});
        });
        assert.ok(e, 'unknown preset must throw');
        assert.contains(e.message, 'yolo');
    });

    test('unknown bounds key throws (looseness must be explicit)', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { bounds: { densityVariance: 3 } } }, {});
        });
        assert.ok(e, 'unknown bounds key must throw');
        assert.contains(e.message, 'densityVariance');
    });

    test('non-numeric density bound throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { bounds: { densityMax: 'lots' } } }, {});
        });
        assert.ok(e, 'non-numeric bound must throw');
    });

    test('non-boolean opportunisticSameFilesOnly throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { bounds: { opportunisticSameFilesOnly: 'yes' } } }, {});
        });
        assert.ok(e, 'non-boolean bound must throw');
    });

    test('non-object reviewPolicy (bare string) throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: 'relaxed' }, {});
        });
        assert.ok(e, 'bare-string policy must throw');
    });

    test('broken JSON in jobParams.reviewPolicy throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({}, { reviewPolicy: '{preset:relaxed' });
        });
        assert.ok(e, 'broken JSON policy must throw');
    });

    test('severity entry missing the round key throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { severities: { NIT: { fix: 'never' } } } }, {});
        });
        assert.ok(e, 'severity entry missing round must throw');
    });
});

suite('reviewPolicy — approval gating from census + policy', function() {

    test('default policy: blocking or important census gates (hasBlockingOrImportant)', function() {
        var p = mod.defaultPolicy();
        assert.equal(mod.hasBlockingOrImportant({ blocking: 1 }, p), true);
        assert.equal(mod.hasBlockingOrImportant({ important: 2 }, p), true);
        assert.equal(mod.hasBlockingOrImportant({ blocking: 1, important: 0, suggestions: 4, nits: 9 }, p), true);
        assert.equal(mod.hasBlockingOrImportant({ blocking: 0, important: 0, suggestions: 4, nits: 9 }, p), false);
        assert.equal(mod.hasBlockingOrImportant({}, p), false);
    });

    test('gatingCensusCount names the first gating tier in severity order', function() {
        var p = mod.defaultPolicy();
        assert.deepEqual(mod.gatingCensusCount({ important: 2, blocking: 1 }, p), { count: 1, tier: 'BLOCKING' });
        assert.deepEqual(mod.gatingCensusCount({ important: 2 }, p), { count: 2, tier: 'IMPORTANT' });
        assert.deepEqual(mod.gatingCensusCount({ suggestions: 3, nits: 4 }, p), { count: 0, tier: null });
    });

    test('relaxed policy still gates on blocking/important; suggestion-only census is clean', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { preset: 'relaxed' } }, {});
        assert.equal(mod.hasBlockingOrImportant({ suggestions: 5 }, p), false);
        assert.equal(mod.hasBlockingOrImportant({ important: 1 }, p), true);
    });

    test('investigation policy: nothing gates — every census is clean', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { preset: 'investigation' } }, {});
        assert.equal(mod.hasBlockingOrImportant({ blocking: 3, important: 2, suggestions: 1, nits: 1 }, p), false);
    });

    test('explicit config weakens a tier: IMPORTANT round none stops gating (owner standing approval)', function() {
        var config = { reviewPolicy: { severities: { IMPORTANT: { round: 'none', fix: 'never' } } } };
        var p = mod.resolveReviewPolicy(config, {});
        assert.equal(mod.hasBlockingOrImportant({ important: 1 }, p), false);
        assert.equal(mod.hasBlockingOrImportant({ blocking: 1 }, p), true, 'BLOCKING still gates');
    });

    test('machineApprovalDecision: BLOCK passes through (security/data-loss is model-classified)', function() {
        var d = mod.machineApprovalDecision('BLOCK', { blocking: 1 }, mod.defaultPolicy());
        assert.equal(d.approved, false);
        assert.equal(d.verdict, 'BLOCK');
        assert.equal(d.recomputed, false);
    });

    test('machineApprovalDecision: APPROVE + open important → recomputed REQUEST_CHANGES (IMPORTANT gates)', function() {
        var d = mod.machineApprovalDecision('APPROVE', { blocking: 0, important: 1, suggestions: 2 }, mod.defaultPolicy());
        assert.equal(d.approved, false);
        assert.equal(d.verdict, 'REQUEST_CHANGES');
        assert.equal(d.recomputed, true, 'the machine overrode the advisory token');
        assert.contains(d.reason, 'IMPORTANT');
    });

    test('machineApprovalDecision: APPROVE + blocking → recomputed REQUEST_CHANGES', function() {
        var d = mod.machineApprovalDecision('APPROVE', { blocking: 2 }, mod.defaultPolicy());
        assert.equal(d.approved, false);
        assert.equal(d.verdict, 'REQUEST_CHANGES');
    });

    test('machineApprovalDecision: REQUEST_CHANGES + only suggestions/nits → recomputed APPROVE (convergence)', function() {
        var d = mod.machineApprovalDecision('REQUEST_CHANGES', { blocking: 0, important: 0, suggestions: 3, nits: 2 }, mod.defaultPolicy());
        assert.equal(d.approved, true);
        assert.equal(d.verdict, 'APPROVE');
        assert.equal(d.recomputed, true);
    });

    test('machineApprovalDecision: clean census keeps APPROVE without recomputation', function() {
        var d = mod.machineApprovalDecision('APPROVE', { blocking: 0, important: 0, suggestions: 2, nits: 1, digest: 4 }, mod.defaultPolicy());
        assert.equal(d.approved, true);
        assert.equal(d.verdict, 'APPROVE');
        assert.equal(d.recomputed, false);
    });

    test('machineApprovalDecision: investigation policy approves over a blocking census (explicit owner config)', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { preset: 'investigation' } }, {});
        var d = mod.machineApprovalDecision('APPROVE', { blocking: 1 }, p);
        assert.equal(d.approved, true);
        assert.equal(d.verdict, 'APPROVE');
    });
});

suite('reviewPolicy — legacy knob audit (derived from / rejected alongside the policy)', function() {

    test('allowApproveWithSuggestions=false conflicts → logged, policy wins', function() {
        var audit = mod.legacyKnobAudit({ allowApproveWithSuggestions: false }, mod.defaultPolicy());
        assert.equal(audit.lines.length, 1);
        assert.contains(audit.lines[0], 'allowApproveWithSuggestions=false');
        assert.contains(audit.lines[0], 'policy wins');
    });

    test('allowApproveWithSuggestions=true agrees with the policy — no conflict line', function() {
        var audit = mod.legacyKnobAudit({ allowApproveWithSuggestions: true }, mod.defaultPolicy());
        assert.equal(audit.lines.length, 0);
    });

    test('importantBlocksApproval is derived from the policy table', function() {
        var audit = mod.legacyKnobAudit({}, mod.defaultPolicy());
        assert.equal(audit.derived.importantBlocksApproval, true);
        var investigation = mod.legacyKnobAudit({}, mod.presetPolicy('investigation'));
        assert.equal(investigation.derived.importantBlocksApproval, false);
    });

    test('importantBlocksApproval=false conflicts with a rework-round IMPORTANT → logged', function() {
        var audit = mod.legacyKnobAudit({ importantBlocksApproval: false }, mod.defaultPolicy());
        assert.equal(audit.lines.length, 1);
        assert.contains(audit.lines[0], 'importantBlocksApproval=false');
    });

    test('maxReviewThreadsBeforeForceApprove is rejected alongside the policy (density bounds own budgets)', function() {
        var audit = mod.legacyKnobAudit({ maxReviewThreadsBeforeForceApprove: 2 }, mod.defaultPolicy());
        assert.equal(audit.lines.length, 1);
        assert.contains(audit.lines[0], 'maxReviewThreadsBeforeForceApprove');
        assert.equal(audit.derived.maxReviewThreadsBeforeForceApprove, 8);
    });

    test('no legacy knobs → silent audit', function() {
        var audit = mod.legacyKnobAudit({}, mod.defaultPolicy());
        assert.equal(audit.lines.length, 0);
        assert.equal(audit.derived.allowApproveWithSuggestions, true);
    });
});

suite('reviewPolicy — density control (epic gh-1328 §4.6)', function() {

    test('calibrated formula: 20→3 · 50→4 · 200→5 · 800→8', function() {
        var b = mod.DEFAULT_BOUNDS;
        assert.equal(mod.allowedSuggestionThreads(20, b), 3);
        assert.equal(mod.allowedSuggestionThreads(50, b), 4);
        assert.equal(mod.allowedSuggestionThreads(200, b), 5);
        assert.equal(mod.allowedSuggestionThreads(800, b), 8);
    });

    test('clamped to [densityMin..densityMax]: 0 additions → 2, huge diff → 8', function() {
        var b = mod.DEFAULT_BOUNDS;
        assert.equal(mod.allowedSuggestionThreads(0, b), 2);
        assert.equal(mod.allowedSuggestionThreads(100000, b), 8);
    });

    test('1 suggestion on a 1000-line diff is uncapped (allowed 8 ≥ 1)', function() {
        var b = mod.DEFAULT_BOUNDS;
        assert.ok(mod.allowedSuggestionThreads(1000, b) >= 1);
        assert.equal(mod.allowedSuggestionThreads(1000, b), 8);
    });

    test('missing additions count rides the floor (fail closed to the minimum)', function() {
        assert.equal(mod.allowedSuggestionThreads(null, mod.DEFAULT_BOUNDS), 2);
    });

    test('custom bounds re-fit the curve (quarterly re-fit seam)', function() {
        var b = mod.presetPolicy('default').bounds;
        b.densityBase = 1;
        b.densityK = 2;
        b.densityUnit = 100;
        b.densityMin = 1;
        b.densityMax = 4;
        assert.equal(mod.allowedSuggestionThreads(100, b), 3);
        assert.equal(mod.allowedSuggestionThreads(1000, b), 4);
    });

    test('densityOverflow reports the over-posted suggestion/nit threads vs the allowed cap', function() {
        var audit = mod.densityAudit({ suggestions: 10, nits: 0, digest: 0 }, 50, mod.DEFAULT_BOUNDS);
        assert.equal(audit.allowed, 4);
        assert.equal(audit.posted, 10);
        assert.ok(audit.overflow, '10 💡 threads on a 50-line diff overflow the cap of 4');
        assert.contains(audit.warning, '4');
    });

    test('densityAudit: digest lines are not posted threads — 2 posted + 8 digest does not overflow', function() {
        var audit = mod.densityAudit({ suggestions: 2, nits: 0, digest: 8 }, 50, mod.DEFAULT_BOUNDS);
        assert.equal(audit.overflow, false);
    });

    test('densityAudit: blocking/important threads never cap (not counted as posted 💡/🪶)', function() {
        var audit = mod.densityAudit({ blocking: 3, important: 4, suggestions: 1, nits: 0 }, 20, mod.DEFAULT_BOUNDS);
        assert.equal(audit.posted, 1);
        assert.equal(audit.overflow, false);
    });

    test('densityAudit: at or under the cap stays quiet (no warning line)', function() {
        var audit = mod.densityAudit({ suggestions: 1, nits: 1 }, 50, mod.DEFAULT_BOUNDS);
        assert.equal(audit.overflow, false);
        assert.equal(audit.warning, null);
    });
});

suite('reviewPolicy — policy table stamp (run contexts)', function() {

    test('policyTableMarkdown renders the preset, source, tier table and density bounds', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { preset: 'relaxed' } }, {});
        var md = mod.policyTableMarkdown(p);
        assert.contains(md, 'relaxed');
        assert.contains(md, 'projectConfig.reviewPolicy');
        assert.contains(md, 'BLOCKING');
        assert.contains(md, 'IMPORTANT');
        assert.contains(md, 'SUGGESTION');
        assert.contains(md, 'NIT');
        assert.contains(md, 'densityMax=8');
        assert.contains(md, 'advisory', 'the model-is-advisory doctrine is stamped');
    });

    test('policyTableMarkdown renders the built-in default when nothing is configured', function() {
        var md = mod.policyTableMarkdown(mod.resolveReviewPolicy({}, {}));
        assert.contains(md, 'built-in default');
        assert.contains(md, 'default');
    });
});

suite('reviewPolicy — census key mapping', function() {

    test('CENSUS_KEY_BY_TIER maps every tier to its normalized census key', function() {
        assert.equal(mod.CENSUS_KEY_BY_TIER.BLOCKING, 'blocking');
        assert.equal(mod.CENSUS_KEY_BY_TIER.IMPORTANT, 'important');
        assert.equal(mod.CENSUS_KEY_BY_TIER.SUGGESTION, 'suggestions');
        assert.equal(mod.CENSUS_KEY_BY_TIER.NIT, 'nits');
    });

    test('gating census reads the plural-normalized keys (suggestions/nits), never the singular', function() {
        var p = mod.defaultPolicy();
        // The singular spellings are normalized upstream (normalizeIssueCounts); the
        // gating read counts the plural keys only — a singular-only census is NOT gating.
        assert.deepEqual(mod.gatingCensusCount({ suggestion: 3 }, p), { count: 0, tier: null });
    });
});

suite('reviewPolicy — policyInputContextMarkdown (gh-1351 run-context file body)', function() {

    test('renders the resolved preset, the resolution source and the tier table', function() {
        var p = mod.presetPolicy('fix-everything');
        var md = mod.policyInputContextMarkdown(p);
        assert.contains(md, '# Review Policy');
        assert.contains(md, 'fix-everything');
        assert.contains(md, 'built-in preset');
        assert.contains(md, 'projectConfig.reviewPolicy');
        assert.contains(md, '| Severity | Round | Fix | Gates approval |');
        assert.contains(md, '🪶 NIT | polish | mandatory |');
    });

    test('carries the density cap formula and the top-K/digest reviewer duties', function() {
        var md = mod.policyInputContextMarkdown(mod.defaultPolicy());
        assert.contains(md, 'clamp(round(2 + 3*sqrt(additions/200)), 2, 8)');
        assert.contains(md, 'top-K', 'the reviewer ranks findings and posts top-K threads');
        assert.contains(md, 'digest', 'overflow becomes a ranked digest list in the general comment');
        assert.contains(md, 'never capped', '🚨/⚠️ threads are never capped');
    });

    test('carries the downgrade protocol wording (epic §3 escape hatch)', function() {
        var md = mod.policyInputContextMarkdown(mod.defaultPolicy());
        assert.contains(md, 'downgrade');
        assert.contains(md, 'justification', 'a ⚠️→💡 downgrade needs a written justification in the census');
    });

    test('carries the machine-enforcement doctrine (model advisory, machine enforces)', function() {
        var md = mod.policyInputContextMarkdown(mod.defaultPolicy());
        assert.contains(md, 'advisory');
        assert.contains(md, 'REQUEST_CHANGES');
        assert.contains(md, 'APPROVE');
    });

    test('missing policy argument renders the built-in default', function() {
        var md = mod.policyInputContextMarkdown(null);
        assert.contains(md, 'default');
    });
});

suite('reviewPolicy — bounds validation branches (gh-1351 ratchet)', function() {

    test('valid numeric bounds ride numericBound and override the defaults', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: {
            bounds: { densityBase: 1, densityK: 2, densityUnit: 100, densityMin: 1, densityMax: 5, polishMaxThreads: 4 }
        } }, {});
        assert.equal(p.bounds.densityBase, 1);
        assert.equal(p.bounds.densityK, 2);
        assert.equal(p.bounds.densityUnit, 100);
        assert.equal(p.bounds.densityMin, 1);
        assert.equal(p.bounds.densityMax, 5);
        assert.equal(p.bounds.polishMaxThreads, 4);
        assert.equal(p.bounds.sweepBatch, 10, 'unnamed bounds keep the epic default');
    });

    test('numeric bounds coerce numeric strings (documented coercion)', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { bounds: { densityMax: '6' } } }, {});
        assert.equal(p.bounds.densityMax, 6);
    });

    test('non-positive bound throws (0 and negative)', function() {
        assert.ok(validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { bounds: { densityMax: 0 } } }, {});
        }), 'zero bound must throw');
        assert.ok(validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { bounds: { sweepBatch: -3 } } }, {});
        }), 'negative bound must throw');
    });

    test('non-finite bound throws (Infinity)', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { bounds: { densityMax: 1e999 } } }, {});
        });
        assert.ok(e, 'Infinity bound must throw');
    });

    test('valid boolean bound accepted (opportunisticSameFilesOnly false)', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { bounds: { opportunisticSameFilesOnly: false } } }, {});
        assert.equal(p.bounds.opportunisticSameFilesOnly, false, 'the boolean override lands');
        assert.equal(p.bounds.densityMax, 8, 'numbers ride the defaults');
    });

    test('non-object severities block throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { severities: 'relaxed' } }, {});
        });
        assert.ok(e, 'string severities must throw');
    });

    test('non-object bounds block throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { bounds: 42 } }, {});
        });
        assert.ok(e, 'number bounds must throw');
    });

    test('non-object identity block throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { identity: 'nope' } }, {});
        });
        assert.ok(e, 'string identity must throw');
    });

    test('severity entry that is not an object throws', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { severities: { NIT: 'polish' } } }, {});
        });
        assert.ok(e, 'bare-string severity entry must throw');
    });

    test('null severities/bounds blocks ride the preset silently', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { preset: 'relaxed', severities: null, bounds: null, identity: null } }, {});
        assert.equal(p.preset, 'relaxed');
        assert.equal(p.severities.SUGGESTION.round, 'none');
        assert.equal(p.bounds.densityMax, 8);
        assert.deepEqual(p.identity, {}, 'null identity becomes an empty object');
    });
});

suite('reviewPolicy — verification knob (gh-1403: none | filter)', function() {

    test('missing verification rides the default none (owners opt in)', function() {
        assert.equal(mod.defaultPolicy().verification, 'none');
        assert.equal(mod.resolveReviewPolicy({}, {}).verification, 'none');
        assert.equal(mod.presetPolicy('relaxed').verification, 'none');
    });

    test('verification filter resolves from projectConfig.reviewPolicy', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { verification: 'filter' } }, {});
        assert.equal(p.verification, 'filter');
        assert.equal(p.preset, 'default', 'partial config rides the default preset');
    });

    test('verification none resolves explicitly', function() {
        var p = mod.resolveReviewPolicy({ reviewPolicy: { verification: 'none' } }, {});
        assert.equal(p.verification, 'none');
    });

    test('verification rides the jobParams JSON-string path too', function() {
        var p = mod.resolveReviewPolicy({}, { reviewPolicy: JSON.stringify({ verification: 'filter' }) });
        assert.equal(p.verification, 'filter');
    });

    test('unknown verification value is a hard validation error', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { verification: 'vote' } }, {});
        });
        assert.ok(e, 'unknown verification must throw');
        assert.equal(e.name, 'ReviewPolicyValidationError');
        assert.ok(e.message.indexOf('none | filter') !== -1, 'error names the enum: ' + e.message);
    });

    test('non-string verification is a hard validation error', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { verification: true } }, {});
        });
        assert.ok(e, 'boolean verification must throw');
        assert.equal(e.name, 'ReviewPolicyValidationError');
    });

    test('verification stays case-sensitive (FILTER rejected)', function() {
        var e = validationErrorMessage(function() {
            mod.resolveReviewPolicy({ reviewPolicy: { verification: 'FILTER' } }, {});
        });
        assert.ok(e, 'uppercase verification must throw');
    });

    test('policy stamps carry the verification mode', function() {
        var filtered = mod.validateReviewPolicy({ verification: 'filter' }, 'test');
        var plain = mod.defaultPolicy();
        assert.ok(mod.policyTableMarkdown(filtered).indexOf('Verification: `filter`') !== -1,
            'table stamp names the filter mode');
        assert.ok(mod.policyTableMarkdown(plain).indexOf('Verification: `none`') !== -1,
            'table stamp names the none mode');
        assert.ok(mod.policyInputContextMarkdown(filtered).indexOf('Verification: `filter`') !== -1,
            'run-context stamp names the filter mode');
    });
});
