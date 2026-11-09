/**
 * Unit tests for js/common/reviewFilter.js — the gh-1403 finding-filter leg:
 * candidate selection (rework/polish tiers only, 💡-digest/🪶-none never),
 * the verdict parse/validate ladder (keep | demote(<tier>) | drop + reason),
 * the post-filter census recomputation, the anti-over-suppression stats and
 * the fresh-context filter prompt/input builders.
 *
 * Pure module — no dmtools globals; loaded with an empty require map.
 */
var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
    makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {});
var reviewPolicy = loadModule('js/common/reviewPolicy.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var reviewSpecClaims = loadModule('js/common/reviewSpecClaims.js', makeRequire({
    './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
        './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
        './reviewVerdicts.js': reviewVerdicts
    }), {})
}), {});
var mod = loadModule('js/common/reviewFilter.js', makeRequire({
    './reviewPolicy.js': reviewPolicy,
    './reviewVerdicts.js': reviewVerdicts,
    './reviewSpecClaims.js': reviewSpecClaims
}), {});

// A claim resolver that just returns the comment body — the runner resolves
// file-referenced comments through readMarkdownFile; the pure module only
// needs the resolved string.
function bodyClaimResolver(c) { return c.body || null; }

function reviewDataWith(inlineComments, issueCounts) {
    return {
        recommendation: 'REQUEST_CHANGES',
        inlineComments: inlineComments,
        issueCounts: issueCounts || { blocking: 0, important: 0, suggestions: 0, nits: 0, digest: 0 }
    };
}

function inline(path, line, severity, body) {
    return { path: path, line: line, severity: severity, body: body || ('claim for ' + path + ':' + line) };
}

suite('reviewFilter — candidate selection (gh-1403: rework/polish tiers only)', function() {

    test('default policy: BLOCKING/IMPORTANT (rework) and SUGGESTION (polish) are candidates; NIT never', function() {
        var policy = reviewPolicy.defaultPolicy();
        var data = reviewDataWith([
            inline('a.js', 10, 'BLOCKING'),
            inline('b.js', 20, 'IMPORTANT'),
            inline('c.js', 30, 'SUGGESTION'),
            inline('d.js', 40, 'NIT')
        ]);
        var candidates = mod.selectFilterCandidates(data, policy, bodyClaimResolver);
        assert.equal(candidates.length, 3, 'NIT (round none) is never filtered');
        assert.deepEqual(candidates.map(function(c) { return c.severity; }), ['BLOCKING', 'IMPORTANT', 'SUGGESTION']);
        assert.equal(candidates[0].id, 0, 'ids carry the original inlineComments position');
        assert.equal(candidates[2].id, 2);
    });

    test('relaxed preset: SUGGESTION round none drops out of the candidate set', function() {
        var policy = reviewPolicy.presetPolicy('relaxed');
        var data = reviewDataWith([
            inline('a.js', 10, 'IMPORTANT'),
            inline('c.js', 30, 'SUGGESTION')
        ]);
        var candidates = mod.selectFilterCandidates(data, policy, bodyClaimResolver);
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].severity, 'IMPORTANT');
    });

    test('fix-everything preset: NIT round polish IS a candidate', function() {
        var policy = reviewPolicy.presetPolicy('fix-everything');
        var data = reviewDataWith([inline('d.js', 40, 'NIT')]);
        var candidates = mod.selectFilterCandidates(data, policy, bodyClaimResolver);
        assert.equal(candidates.length, 1, 'policy-driven: polish-round nits go through the filter');
        assert.equal(candidates[0].severity, 'NIT');
    });

    test('candidates without a resolvable claim or severity are skipped', function() {
        var policy = reviewPolicy.defaultPolicy();
        var data = reviewDataWith([
            { path: 'x.js', line: 1, severity: 'IMPORTANT' }, // no body → no claim
            { path: 'y.js', line: 2 }, // no severity
            inline('z.js', 3, 'IMPORTANT')
        ]);
        var candidates = mod.selectFilterCandidates(data, policy, function(c) { return c.body || null; });
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].path, 'z.js');
    });

    test('the claim is severity-stripped (the filter never sees the finder severity)', function() {
        var policy = reviewPolicy.defaultPolicy();
        var data = reviewDataWith([
            { path: 'a.js', line: 10, severity: 'BLOCKING', body: '\uD83D\uDEA8 severity: BLOCKING \u2014\nnull deref on the empty map path' }
        ]);
        var candidates = mod.selectFilterCandidates(data, policy, bodyClaimResolver);
        var claim = candidates[0].claim;
        assert.ok(claim.indexOf('null deref') !== -1, 'claim text kept');
        assert.ok(claim.indexOf('BLOCKING') === -1, 'machine severity line stripped: ' + claim);
    });
});

suite('reviewFilter — verdict parse ladder', function() {

    test('valid verdict file parses (keep | demote | drop with reasons)', function() {
        var raw = JSON.stringify({ verdicts: [
            { id: 0, decision: 'keep' },
            { id: 1, decision: 'demote', tier: 'SUGGESTION', reason: 'real but cosmetic' },
            { id: 2, decision: 'drop', reason: 'claim contradicted by the caller guard' }
        ] });
        var out = mod.parseFilterVerdicts(raw);
        assert.equal(out.verdicts.length, 3);
        assert.equal(out.notes.length, 0);
        assert.equal(out.verdicts[1].tier, 'SUGGESTION');
    });

    test('null/absent/malformed input parses to zero verdicts with a note (fail-open)', function() {
        assert.equal(mod.parseFilterVerdicts(null).verdicts.length, 0);
        assert.equal(mod.parseFilterVerdicts(undefined).verdicts.length, 0);
        assert.equal(mod.parseFilterVerdicts('not json {').verdicts.length, 0);
        assert.ok(mod.parseFilterVerdicts('not json {').notes.length > 0, 'malformed JSON is noted');
        assert.equal(mod.parseFilterVerdicts(JSON.stringify([1, 2])).verdicts.length, 0, 'array payload rejected');
    });

    test('unknown decision is skipped with a note (fail-open to keep)', function() {
        var raw = JSON.stringify({ verdicts: [
            { id: 0, decision: 'escalate', reason: 'made up' }
        ] });
        var out = mod.parseFilterVerdicts(raw);
        assert.equal(out.verdicts.length, 0);
        assert.ok(out.notes[0].indexOf('escalate') !== -1);
    });

    test('demote without a tier, or to an unknown tier, is structurally skipped', function() {
        var raw = JSON.stringify({ verdicts: [
            { id: 0, decision: 'demote', reason: 'no tier given' },
            { id: 1, decision: 'demote', tier: 'CRITICAL', reason: 'not a real tier' },
            { id: 2, decision: 'demote', tier: 'SUGGESTION', reason: 'structurally valid' }
        ] });
        var out = mod.parseFilterVerdicts(raw);
        assert.equal(out.verdicts.length, 1);
        assert.equal(out.verdicts[0].id, 2);
        assert.equal(out.notes.length, 2);
    });

    test('drop and demote without a reason are skipped (the one-line reason is the contract)', function() {
        var raw = JSON.stringify({ verdicts: [
            { id: 0, decision: 'drop' },
            { id: 1, decision: 'demote', tier: 'SUGGESTION' },
            { id: 2, decision: 'keep' },
            { id: 3, decision: 'drop', reason: '  ' }
        ] });
        var out = mod.parseFilterVerdicts(raw);
        assert.equal(out.verdicts.length, 1, 'only the reasonless keep survives');
        assert.equal(out.verdicts[0].id, 2);
    });

    test('verdicts for unknown ids and duplicate ids are skipped with notes (first wins)', function() {
        var raw = JSON.stringify({ verdicts: [
            { id: 99, decision: 'drop', reason: 'no such candidate' },
            { id: 0, decision: 'drop', reason: 'first' },
            { id: 0, decision: 'keep' }
        ] });
        var out = mod.parseFilterVerdicts(raw);
        assert.equal(out.verdicts.length, 2, 'unknown ids are matched (and dropped) at apply time');
        assert.equal(out.verdicts[0].decision, 'drop');
        assert.equal(out.notes.length, 1, 'duplicate id noted, first wins');
    });
});

suite('reviewFilter — verdict application', function() {

    test('keep leaves the finding untouched', function() {
        var data = reviewDataWith([inline('a.js', 10, 'IMPORTANT')]);
        var candidates = mod.selectFilterCandidates(data, reviewPolicy.defaultPolicy(), bodyClaimResolver);
        var verdicts = mod.parseFilterVerdicts(JSON.stringify({ verdicts: [{ id: 0, decision: 'keep' }] })).verdicts;
        var out = mod.applyFilterVerdicts(data, candidates, verdicts);
        assert.equal(data.inlineComments.length, 1);
        assert.equal(data.inlineComments[0].severity, 'IMPORTANT');
        assert.equal(out.dropped.length, 0);
        assert.equal(out.changed, true, 'verdicts were applied (all-keep is still a filter outcome)');
    });

    test('demote downgrades the severity and stamps the machine demotion note', function() {
        var data = reviewDataWith([inline('a.js', 10, 'IMPORTANT', 'overstated claim')]);
        var candidates = mod.selectFilterCandidates(data, reviewPolicy.defaultPolicy(), bodyClaimResolver);
        var verdicts = mod.parseFilterVerdicts(JSON.stringify({ verdicts: [
            { id: 0, decision: 'demote', tier: 'SUGGESTION', reason: 'cosmetic' }
        ] })).verdicts;
        var out = mod.applyFilterVerdicts(data, candidates, verdicts);
        assert.equal(data.inlineComments[0].severity, 'SUGGESTION');
        assert.equal(out.applied[0].from, 'IMPORTANT');
        assert.equal(out.applied[0].to, 'SUGGESTION');
        var note = out.applied[0].note;
        assert.ok(note.indexOf(reviewSpecClaims.DEMOTION_NOTE_HEAD) === 0, 'note reuses the demotion head');
        assert.ok(note.indexOf('review-filter') !== -1, 'note names the filter provenance');
        assert.ok(note.indexOf('cosmetic') !== -1, 'note carries the filter reason');
    });

    test('a demote to the same or higher tier is refused at apply time (fail-open keep)', function() {
        var data = reviewDataWith([
            inline('a.js', 10, 'IMPORTANT'),
            inline('b.js', 20, 'SUGGESTION')
        ]);
        var candidates = mod.selectFilterCandidates(data, reviewPolicy.defaultPolicy(), bodyClaimResolver);
        var verdicts = mod.parseFilterVerdicts(JSON.stringify({ verdicts: [
            { id: 0, decision: 'demote', tier: 'BLOCKING', reason: 'upgrade is not a demote' },
            { id: 1, decision: 'demote', tier: 'SUGGESTION', reason: 'same tier is not a demote' }
        ] })).verdicts;
        var out = mod.applyFilterVerdicts(data, candidates, verdicts);
        assert.equal(data.inlineComments[0].severity, 'IMPORTANT', 'upgrade refused');
        assert.equal(data.inlineComments[1].severity, 'SUGGESTION', 'same-tier refused');
        assert.equal(out.applied.length, 0);
        assert.equal(out.notes.length, 2, 'both refusals noted');
    });

    test('drop removes the thread from inlineComments and records it (multi-item)', function() {
        var data = reviewDataWith([
            inline('a.js', 10, 'IMPORTANT', 'wrong claim one'),
            inline('b.js', 20, 'IMPORTANT', 'real claim two'),
            inline('c.js', 30, 'IMPORTANT', 'speculative three')
        ]);
        var candidates = mod.selectFilterCandidates(data, reviewPolicy.defaultPolicy(), bodyClaimResolver);
        var verdicts = mod.parseFilterVerdicts(JSON.stringify({ verdicts: [
            { id: 0, decision: 'drop', reason: 'guard exists upstream' },
            { id: 1, decision: 'keep' },
            { id: 2, decision: 'drop', reason: 'no failing scenario' }
        ] })).verdicts;
        var out = mod.applyFilterVerdicts(data, candidates, verdicts);
        assert.equal(data.inlineComments.length, 1, 'only the kept finding posts');
        assert.equal(data.inlineComments[0].path, 'b.js');
        assert.equal(out.dropped.length, 2);
        assert.equal(out.dropped[0].path, 'a.js');
        assert.equal(out.dropped[0].reason, 'guard exists upstream');
        assert.equal(out.dropped[1].claim, 'claim for c.js:30', 'dropped entries keep the claim for the digest list');
    });

    test('empty verdict list changes nothing (filter ran, said nothing)', function() {
        var data = reviewDataWith([inline('a.js', 10, 'IMPORTANT')]);
        var candidates = mod.selectFilterCandidates(data, reviewPolicy.defaultPolicy(), bodyClaimResolver);
        var out = mod.applyFilterVerdicts(data, candidates, []);
        assert.equal(out.changed, false);
        assert.equal(data.inlineComments.length, 1);
    });
});

suite('reviewFilter — post-filter census recomputation', function() {

    test('census is recomputed from the FILTERED thread set + digest', function() {
        var data = reviewDataWith([
            inline('a.js', 10, 'IMPORTANT'),
            inline('b.js', 20, 'IMPORTANT'),
            inline('c.js', 30, 'SUGGESTION')
        ], { blocking: 0, important: 3, suggestions: 1, nits: 0, digest: 2 });
        var candidates = mod.selectFilterCandidates(data, reviewPolicy.defaultPolicy(), bodyClaimResolver);
        var verdicts = mod.parseFilterVerdicts(JSON.stringify({ verdicts: [
            { id: 0, decision: 'drop', reason: 'x' },
            { id: 1, decision: 'keep' },
            { id: 2, decision: 'demote', tier: 'NIT', reason: 'y' }
        ] })).verdicts;
        var applied = mod.applyFilterVerdicts(data, candidates, verdicts);
        var census = mod.recomputeCensus(data, applied.dropped.length);
        assert.equal(census.important, 1, 'one IMPORTANT kept');
        assert.equal(census.suggestions, 0, 'the demoted suggestion moved to NIT');
        assert.equal(census.nits, 1, 'the demote target tier counts');
        assert.equal(census.digest, 3, 'agent digest 2 + dropped 1');
        assert.equal(census.blocking, 0);
    });

    test('unknown severity never gates — it counts as a digest line', function() {
        var data = reviewDataWith([
            inline('a.js', 10, 'IMPORTANT'),
            { path: 'w.js', line: 5, severity: 'WHATEVER', body: 'mystery' }
        ], { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 });
        var census = mod.recomputeCensus(data, 0);
        assert.equal(census.important, 1);
        assert.equal(census.digest, 1, 'unknown severity stays visible without gating');
    });

    test('missing issueCounts digest rides zero', function() {
        var data = reviewDataWith([inline('a.js', 10, 'NIT')], {});
        var census = mod.recomputeCensus(data, 0);
        assert.equal(census.nits, 1);
        assert.equal(census.digest, 0);
    });
});

suite('reviewFilter — anti-over-suppression stats', function() {

    test('stats count kept/demoted/dropped and the drop rate', function() {
        var stats = mod.filterStats(4, [
            { decision: 'keep' }, { decision: 'drop' }, { decision: 'drop' }, { decision: 'demote' }
        ]);
        assert.equal(stats.candidates, 4);
        assert.equal(stats.kept, 1);
        assert.equal(stats.demoted, 1);
        assert.equal(stats.dropped, 2);
        assert.equal(stats.dropRate, 0.5);
    });

    test('zero candidates ride a zero drop rate (no division by zero)', function() {
        var stats = mod.filterStats(0, []);
        assert.equal(stats.dropRate, 0);
    });

    test('all candidates dropped → the misconfigured-filter warning fires', function() {
        var stats = mod.filterStats(3, [
            { decision: 'drop' }, { decision: 'drop' }, { decision: 'drop' }
        ]);
        var warning = mod.buildOverSuppressionWarning(stats);
        assert.ok(warning, '≈100% drop rate must warn');
        assert.ok(warning.indexOf('misconfigured') !== -1);
        assert.ok(warning.indexOf('3/3') !== -1, 'warning names the sample: ' + warning);
    });

    test('partial drops never warn', function() {
        assert.equal(mod.buildOverSuppressionWarning(mod.filterStats(4, [
            { decision: 'keep' }, { decision: 'drop' }, { decision: 'drop' }, { decision: 'drop' }
        ])), null);
        assert.equal(mod.buildOverSuppressionWarning(mod.filterStats(0, [])), null);
    });
});

suite('reviewFilter — digest lines + comment injection', function() {

    test('one digest line per dropped candidate, severity-free, reason-suffixed', function() {
        var lines = mod.buildDroppedDigestLines([
            { path: 'a.js', line: 10, claim: 'wrong claim one', reason: 'guard exists upstream' },
            { path: 'b.js', line: 20, claim: 'speculative two', reason: 'no failing scenario' }
        ]);
        assert.equal(lines.length, 2);
        assert.ok(lines[0].indexOf('`a.js:10`') !== -1);
        assert.ok(lines[0].indexOf('guard exists upstream') !== -1);
        assert.ok(lines[0].indexOf('BLOCKING') === -1, 'digest lines never carry the finder severity');
        assert.ok(lines[1].indexOf('`b.js:20`') !== -1);
    });

    test('over-long claims are truncated in digest lines', function() {
        var long = new Array(400 + 1).join('x');
        var lines = mod.buildDroppedDigestLines([{ path: 'a.js', line: 1, claim: long, reason: 'r' }]);
        assert.ok(lines[0].length < 300, 'digest line bounded: ' + lines[0].length);
    });

    test('injection is null when nothing was dropped; a section otherwise', function() {
        assert.equal(mod.buildGeneralCommentInjection(mod.filterStats(2, [{ decision: 'keep' }, { decision: 'demote' }]), []), null);
        var section = mod.buildGeneralCommentInjection(mod.filterStats(2, [{ decision: 'keep' }, { decision: 'drop' }]), [
            { path: 'a.js', line: 10, claim: 'claim', reason: 'why' }
        ]);
        assert.ok(section.indexOf('Review filter') !== -1);
        assert.ok(section.indexOf('`a.js:10`') !== -1);
        assert.ok(section.indexOf('1/2') !== -1, 'stats line names the drop rate');
    });
});

suite('reviewFilter — filter input + prompt builders', function() {

    test('input JSON carries id/path/line/claim and NEVER severity or rationale fields', function() {
        var candidates = [
            { id: 0, path: 'a.js', line: 10, severity: 'BLOCKING', claim: 'the claim' }
        ];
        var text = mod.buildFilterInputJson(candidates);
        var parsed = JSON.parse(text);
        assert.equal(parsed.candidates.length, 1);
        assert.equal(parsed.candidates[0].id, 0);
        assert.equal(parsed.candidates[0].claim, 'the claim');
        assert.ok(text.indexOf('BLOCKING') === -1, 'no severity in the filter input');
        assert.ok(text.indexOf('"severity"') === -1, 'no severity field in the filter input');
        assert.ok(text.indexOf('rationale') === -1, 'no rationale field in the filter input');
    });

    test('the prompt is a fresh-context contract: inputs, verdict rules, output file, boundaries', function() {
        var prompt = mod.buildFilterPrompt('input/pr-7/pr_diff.txt');
        assert.ok(prompt.indexOf('outputs/pr_review_filter_input.json') !== -1, 'input file named');
        assert.ok(prompt.indexOf('outputs/pr_review_filter.json') !== -1, 'output file named');
        assert.ok(prompt.indexOf('input/pr-7/pr_diff.txt') !== -1, 'diff path injected');
        assert.ok(prompt.indexOf('keep') !== -1 && prompt.indexOf('demote') !== -1 && prompt.indexOf('drop') !== -1);
        assert.ok(prompt.indexOf('callers') !== -1, 'interaction neighborhood instructed');
        assert.ok(prompt.indexOf('severity') !== -1, 'the guard is stated: no finder severity visible');
        assert.ok(prompt.indexOf('response.md') !== -1, 'response.md boundary stated');
        assert.ok(prompt.indexOf('codegraph') !== -1, 'codegraph neighborhood tools named');
    });

    test('filter stamp line summarizes one round', function() {
        var line = mod.buildFilterStampLine(mod.filterStats(4, [
            { decision: 'keep' }, { decision: 'demote' }, { decision: 'drop' }, { decision: 'drop' }
        ]));
        assert.ok(line.indexOf('4') !== -1 && line.indexOf('1') !== -1 && line.indexOf('2') !== -1);
        assert.ok(line.indexOf('50%') !== -1, 'drop rate rendered as a percentage: ' + line);
        assert.ok(line.indexOf('gh-1403') !== -1);
    });

    test('file names are exported for the runner + tests', function() {
        assert.equal(mod.OUTPUT_FILE, 'pr_review_filter.json');
        assert.equal(mod.INPUT_FILE, 'pr_review_filter_input.json');
    });
});
