/**
 * Unit tests for js/common/tcTriage.js — the gh-1329 mechanical triage engine.
 *
 * The whole logic is the ticket's triage table:
 *   | build SHA vs last green | env fingerprint vs last green | verdict |
 *   | same    | same    | flake or time-dependence -> auto-retry -> flaky -> maintenance |
 *   | same    | changed | environment shift -> maintenance |
 *   | changed | same    | code is the only candidate -> differential rerun attributes it |
 *   | changed | changed | differential still runs; inconclusive residue -> sweep |
 *
 * Plus the two scoping rules that keep the bug parked:
 *   - the bug's verdict is gated only by its own oracle TC (sibling/guard
 *     failures route to test maintenance, never bounce);
 *   - a fresh TC's first run is validation — it can never bounce the bug.
 */

var triage = loadModule('js/common/tcTriage.js', makeRequire({}));

suite('tcTriage: role resolution', function() {

    test('explicit role strings map to own-oracle and guard', function() {
        assert.equal(triage.resolveTcRole({ role: 'verifies' }, 'BUG-1'), triage.ROLE_OWN);
        assert.equal(triage.resolveTcRole({ role: 'own oracle' }, 'BUG-1'), triage.ROLE_OWN);
        assert.equal(triage.resolveTcRole({ role: 'regression guard' }, 'BUG-1'), triage.ROLE_GUARD);
        assert.equal(triage.resolveTcRole({ role: 'guard' }, 'BUG-1'), triage.ROLE_GUARD);
        assert.equal(triage.resolveTcRole({ role: 'sibling' }, 'BUG-1'), triage.ROLE_GUARD);
    });

    test('verifies key equal to the bug is own, a different key is a sibling', function() {
        assert.equal(triage.resolveTcRole({ verifies: 'BUG-1' }, 'BUG-1'), triage.ROLE_OWN);
        assert.equal(triage.resolveTcRole({ verifies: 'BUG-2' }, 'BUG-1'), triage.ROLE_SIBLING);
        assert.equal(triage.resolveTcRole({ verifies: 'bug-1' }, 'BUG-1'), triage.ROLE_OWN);
    });

    test('absent metadata defaults to own oracle (legacy-safe: bounce stays bounded)', function() {
        assert.equal(triage.resolveTcRole({}, 'BUG-1'), triage.ROLE_OWN);
        assert.equal(triage.resolveTcRole(null, 'BUG-1'), triage.ROLE_OWN);
        assert.equal(triage.resolveTcRole(undefined, 'BUG-1'), triage.ROLE_OWN);
    });

    test('explicit regressionGuard boolean marks a guard', function() {
        assert.equal(triage.resolveTcRole({ regressionGuard: true }, 'BUG-1'), triage.ROLE_GUARD);
        assert.equal(triage.resolveTcRole({ regressionGuard: false }, 'BUG-1'), triage.ROLE_OWN);
    });

    test('a guard that verifies another bug is a sibling of this run', function() {
        assert.equal(triage.resolveTcRole({ role: 'regression guard', verifies: 'BUG-2' }, 'BUG-1'), triage.ROLE_SIBLING);
        assert.equal(triage.resolveTcRole({ role: 'regression guard', verifies: 'BUG-1' }, 'BUG-1'), triage.ROLE_GUARD);
    });
});

suite('tcTriage: validated guard failure — the mechanical table', function() {

    var validated = {
        tcKey: 'TS-1',
        role: triage.ROLE_GUARD,
        validated: true,
        current: { sha: 'sha-new', envFingerprint: 'env-1' },
        lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' },
        maxReworkRounds: 2,
        redRounds: 0
    };

    test('AC: same SHA + same env fingerprint -> no rerun, no bounce; maintenance entry', function() {
        var v = triage.triageFailure(Object.assign({}, validated, {
            current: { sha: 'sha-green', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' }
        }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'flaky-same-build');
        assert.ok(v.ledgerEntry);
    });

    test('AC: same SHA + changed env -> environment shift -> maintenance', function() {
        var v = triage.triageFailure(Object.assign({}, validated, {
            current: { sha: 'sha-green', envFingerprint: 'env-2' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' }
        }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'environment-shift');
    });

    test('retry green on the same build -> nothing happened (no ledger entry)', function() {
        var v = triage.triageFailure(Object.assign({}, validated, {
            current: { sha: 'sha-green', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' },
            retryGreen: true
        }));
        assert.equal(v.action, triage.ACTION_NONE);
        assert.notOk(v.ledgerEntry);
    });

    test('AC: new SHA, differential green on the last-green build -> earned bounce with evidence', function() {
        var v = triage.triageFailure(Object.assign({}, validated, { differential: 'green' }));
        assert.equal(v.action, triage.ACTION_BOUNCE);
        assert.equal(v.reason, 'regression-from-change-range');
        assert.equal(v.evidence.differential, 'green');
        assert.ok(v.ledgerEntry);
    });

    test('AC: new SHA, differential red on the last-green build -> failure predates change -> maintenance', function() {
        var v = triage.triageFailure(Object.assign({}, validated, { differential: 'red' }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'failure-predates-change');
    });

    test('new SHA, differential unavailable -> request the scripted rerun, bug unchanged', function() {
        var v = triage.triageFailure(Object.assign({}, validated));
        assert.equal(v.action, triage.ACTION_DIFFERENTIAL);
        assert.equal(v.reason, 'rerun-requested-on-last-green-build');
    });

    test('AC: repeated earned regressions hit maxReworkRounds -> escalation, no infinite loop', function() {
        var v = triage.triageFailure(Object.assign({}, validated, {
            differential: 'green',
            redRounds: 2,
            maxReworkRounds: 2
        }));
        assert.equal(v.action, triage.ACTION_ESCALATE);
        assert.equal(v.reason, 'bounce-cap-reached');

        var below = triage.triageFailure(Object.assign({}, validated, {
            differential: 'green',
            redRounds: 1,
            maxReworkRounds: 2
        }));
        assert.equal(below.action, triage.ACTION_BOUNCE);
    });

    test('AC: a sibling (verifies another bug) never bounces this bug — owner-notified maintenance', function() {
        var sibling = Object.assign({}, validated, { role: triage.ROLE_SIBLING, differential: 'green' });
        assert.equal(triage.triageFailure(sibling).action, triage.ACTION_MAINTENANCE);
        var siblingFlaky = Object.assign({}, validated, {
            role: triage.ROLE_SIBLING,
            current: { sha: 'sha-green', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' }
        });
        assert.equal(triage.triageFailure(siblingFlaky).action, triage.ACTION_MAINTENANCE);
    });
});

suite('tcTriage: own-oracle and fresh TC failures — rework first', function() {

    test('AC: fresh TC red on first run -> TC rework; bug state unchanged', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-9',
            role: triage.ROLE_OWN,
            validated: false,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: null
        });
        assert.equal(v.action, triage.ACTION_REWORK);
        assert.equal(v.reason, 'fresh-tc-first-run-validation');
    });

    test('fresh guard red routes to rework too — a fresh TC cannot bounce by construction', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-10',
            role: triage.ROLE_GUARD,
            validated: false,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: null
        });
        assert.equal(v.action, triage.ACTION_REWORK);
    });

    // gh-1354: a validated own-oracle red takes the mechanical table first —
    // on a changed build with no differential outcome the honest verdict is
    // the parked rerun request, not an unattributed rework lap.
    test('gh-1354: validated own-oracle red on a new build parks the differential rerun before any rework', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-11',
            role: triage.ROLE_OWN,
            validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-old', envFingerprint: 'env-1' }
        });
        assert.equal(v.action, triage.ACTION_DIFFERENTIAL);
        assert.equal(v.reason, 'rerun-requested-on-last-green-build');
        assert.ok(v.ledgerEntry);
    });

    test('own-oracle red + AC violated -> bounce, bounded by the rework cap', function() {
        var base = {
            tcKey: 'TS-11',
            role: triage.ROLE_OWN,
            validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-old', envFingerprint: 'env-1' },
            maxReworkRounds: 2
        };
        assert.equal(triage.triageFailure(Object.assign({}, base, { acVerdict: 'violated', redRounds: 0 })).action, triage.ACTION_BOUNCE);
        assert.equal(triage.triageFailure(Object.assign({}, base, { acVerdict: 'violated', redRounds: 2 })).action, triage.ACTION_ESCALATE);
    });

    test('rework leg says the AC is intact -> the TC misencodes the requirement -> maintenance', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-11',
            role: triage.ROLE_OWN,
            validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-old', envFingerprint: 'env-1' },
            acVerdict: 'intact'
        });
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'tc-misencodes-ac');
    });

    test('fresh TC + rework cap exhausted -> unfixable-in-rework maintenance (never a bounce)', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-9',
            role: triage.ROLE_OWN,
            validated: false,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: null,
            acVerdict: null,
            redRounds: 3,
            maxReworkRounds: 2
        });
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'unfixable-in-rework');
    });
});

suite('tcTriage: verdict evidence + comments', function() {

    test('verdict carries the tcKey, role and the fingerprint evidence', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-3',
            role: triage.ROLE_GUARD,
            validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-7' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' },
            differential: 'green',
            errorClass: 'assertion',
            testPath: 'testing/tests/TS-3/test_guard.py'
        });
        assert.equal(v.tcKey, 'TS-3');
        assert.equal(v.role, triage.ROLE_GUARD);
        assert.equal(v.evidence.lastGreenSha, 'sha-green');
        assert.equal(v.evidence.sha, 'sha-new');
        assert.equal(v.evidence.errorClass, 'assertion');
        assert.equal(v.evidence.testPath, 'testing/tests/TS-3/test_guard.py');
    });

    test('bounce comment names the TC and the differential evidence', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-4',
            role: triage.ROLE_GUARD,
            validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' },
            differential: 'green',
            failureSummary: 'cart total wrong'
        });
        var comment = triage.buildBounceComment([v]);
        assert.contains(comment, 'TS-4');
        assert.contains(comment, 'sha-green');
        assert.contains(comment, 'cart total wrong');
        assert.contains(comment, 'Differential');
    });

    test('triage comment reports routed findings without demanding action', function() {
        var routed = triage.triageFailure({
            tcKey: 'TS-5',
            role: triage.ROLE_GUARD,
            validated: true,
            current: { sha: 'sha-green', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' }
        });
        var comment = triage.buildTriageComment([routed]);
        assert.contains(comment, 'TS-5');
        assert.contains(comment, 'maintenance');
        assert.notContains(comment, 'Bug Fix Did Not Pass');
    });

    test('escalation comment names the cap and stays informational', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-6',
            role: triage.ROLE_GUARD,
            validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' },
            differential: 'green',
            redRounds: 2,
            maxReworkRounds: 2
        });
        var comment = triage.buildEscalationComment([v]);
        assert.contains(comment, 'TS-6');
        assert.contains(comment, 'escalat');
    });
});

suite('tcTriage: missing fingerprint evidence never defaults to flaky (gh-1329 review)', function() {

    var validatedGuard = {
        tcKey: 'TS-20',
        role: triage.ROLE_GUARD,
        validated: true,
        current: { sha: 'sha-green', envFingerprint: null },
        lastGreen: { sha: 'sha-green', envFingerprint: null },
        maxReworkRounds: 2,
        redRounds: 0
    };

    test('AC: same-build red with NO env fingerprints on either side is NOT auto-flaky — the differential rerun must attribute it', function() {
        var v = triage.triageFailure(Object.assign({}, validatedGuard, {
            current: { sha: 'sha-green', envFingerprint: null },
            lastGreen: { sha: 'sha-green', envFingerprint: null }
        }));
        assert.equal(v.action, triage.ACTION_DIFFERENTIAL);
        assert.equal(v.reason, 'rerun-requested-on-last-green-build');
    });

    test('AC: same-build red with a fingerprint on only ONE side is not proven flaky either', function() {
        var v = triage.triageFailure(Object.assign({}, validatedGuard, {
            current: { sha: 'sha-green', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: null }
        }));
        assert.equal(v.action, triage.ACTION_DIFFERENTIAL);
        assert.notEqual(v.reason, 'flaky-same-build');
    });

    test('same-build red with BOTH fingerprints equal stays flaky-same-build (evidence, not default)', function() {
        var v = triage.triageFailure(Object.assign({}, validatedGuard, {
            current: { sha: 'sha-green', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' }
        }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'flaky-same-build');
    });

    test('same-build red with BOTH fingerprints differing stays environment-shift', function() {
        var v = triage.triageFailure(Object.assign({}, validatedGuard, {
            current: { sha: 'sha-green', envFingerprint: 'env-2' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' }
        }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'environment-shift');
    });
});

// ── gh-1345: the scripted differential outcome (dispatcher continuation) ─────

suite('tcTriage: triageDifferentialOutcome — the dispatcher continuation', function() {

    function dispatcherInput(overrides) {
        return Object.assign({
            tcKey: 'TS-7',
            role: triage.ROLE_GUARD,
            differential: 'green',
            redRounds: 0,
            maxReworkRounds: 2,
            errorClass: 'assertion',
            testPath: 'testing/tests/TS-7/test.py'
        }, overrides || {});
    }

    test('differential RED on the old build: the failure predates the change -> maintenance', function() {
        var v = triage.triageDifferentialOutcome(dispatcherInput({ differential: 'red' }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'failure-predates-change');
        assert.equal(v.evidence.differential, 'red');
        assert.ok(v.ledgerEntry);
    });

    test('differential GREEN on the old build: earned bounce with evidence', function() {
        var v = triage.triageDifferentialOutcome(dispatcherInput({ differential: 'green' }));
        assert.equal(v.action, triage.ACTION_BOUNCE);
        assert.equal(v.reason, 'regression-from-change-range');
        assert.equal(v.evidence.differential, 'green');
        assert.ok(v.ledgerEntry);
    });

    test('differential GREEN at the bounce cap escalates instead of looping', function() {
        var v = triage.triageDifferentialOutcome(dispatcherInput({ differential: 'green', redRounds: 2, maxReworkRounds: 2 }));
        assert.equal(v.action, triage.ACTION_ESCALATE);
        assert.equal(v.reason, 'bounce-cap-reached');
    });

    test('a SIBLING green-on-old never bounces THIS bug — owner-notified maintenance', function() {
        var v = triage.triageDifferentialOutcome(dispatcherInput({ role: triage.ROLE_SIBLING, differential: 'green' }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'sibling-regression-owner-notified');
    });

    test('a SIBLING red-on-old routes to maintenance like any red differential', function() {
        var v = triage.triageDifferentialOutcome(dispatcherInput({ role: triage.ROLE_SIBLING, differential: 'red' }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'failure-predates-change');
    });

    test('the verdict carries the request evidence (lastGreenSha etc.)', function() {
        var v = triage.triageDifferentialOutcome(dispatcherInput({
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' }
        }));
        assert.equal(v.evidence.sha, 'sha-new');
        assert.equal(v.evidence.lastGreenSha, 'sha-green');
        assert.equal(v.evidence.envFingerprint, 'env-1');
        assert.equal(v.evidence.lastGreenEnvFingerprint, 'env-1');
    });
});

// ── gh-1354: validated own-oracle reds take the mechanical table first ───────
//
// Pre-gh-1354 a validated own-oracle red entered triageAcGated directly:
// retryGreen, the fingerprint lookup and the differential rerun were never
// consulted for the bug's own oracle. F1: an environment shift (same build
// SHA, changed env fingerprint) reworked forever — no AC verdict can express
// "the world moved". F2: null-verdict rework laps grew redRounds unchecked.

suite('gh-1354: validated own-oracle — the mechanical table first (F1)', function() {

    var ownValidated = {
        tcKey: 'TS-30',
        role: triage.ROLE_OWN,
        validated: true,
        current: { sha: 'sha-green', envFingerprint: 'env-2' },
        lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' },
        maxReworkRounds: 2,
        redRounds: 0
    };

    test('AC1: same build + changed env fingerprint -> environment-shift maintenance (no rework, no bounce)', function() {
        var v = triage.triageFailure(Object.assign({}, ownValidated, { acVerdict: null }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'environment-shift');
        assert.ok(v.ledgerEntry, 'the environment-shift finding lands in the maintenance ledger');
    });

    test('AC1: the env-shift route fires even with an AC verdict in hand — mechanical evidence wins', function() {
        var v = triage.triageFailure(Object.assign({}, ownValidated, { acVerdict: 'violated' }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'environment-shift');
    });

    test('AC1: the environment-shift reason is reachable with NO acVerdict field at all', function() {
        var v = triage.triageFailure(Object.assign({}, ownValidated));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'environment-shift');
    });

    test('same build + both fingerprints proven equal -> flaky-same-build maintenance (the table is mechanical)', function() {
        var v = triage.triageFailure(Object.assign({}, ownValidated, {
            current: { sha: 'sha-green', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' }
        }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'flaky-same-build');
    });

    test('AC4: retry green on own oracle -> ACTION_NONE, no ledger entry (guards had this; own oracle joins)', function() {
        var v = triage.triageFailure(Object.assign({}, ownValidated, {
            current: { sha: 'sha-green', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' },
            retryGreen: true
        }));
        assert.equal(v.action, triage.ACTION_NONE);
        assert.notOk(v.ledgerEntry);
    });
});

suite('gh-1354: validated own-oracle — the unattributed state (F2 cap)', function() {

    var ownBuildChanged = {
        tcKey: 'TS-31',
        role: triage.ROLE_OWN,
        validated: true,
        current: { sha: 'sha-new', envFingerprint: 'env-1' },
        lastGreen: { sha: 'sha-old', envFingerprint: 'env-1' },
        maxReworkRounds: 2
    };

    test('AC2: null AC verdict at redRounds >= maxReworkRounds -> owner escalation, no further REWORK', function() {
        var v = triage.triageFailure(Object.assign({}, ownBuildChanged, { acVerdict: null, redRounds: 2 }));
        assert.equal(v.action, triage.ACTION_ESCALATE);
        assert.equal(v.reason, 'null-ac-verdict-cap-reached');
        assert.ok(v.ledgerEntry, 'the escalation carries a ledger entry');
    });

    test('AC2: below the cap the same shape stays parked (the dispatcher attributes it)', function() {
        var v = triage.triageFailure(Object.assign({}, ownBuildChanged, { acVerdict: null, redRounds: 1 }));
        assert.equal(v.action, triage.ACTION_DIFFERENTIAL);
        assert.equal(v.reason, 'rerun-requested-on-last-green-build');
    });

    test('AC2: the same-build unproven-fingerprint park is capped too', function() {
        var unproven = Object.assign({}, ownBuildChanged, {
            current: { sha: 'sha-old', envFingerprint: null },
            lastGreen: { sha: 'sha-old', envFingerprint: null },
            acVerdict: null
        });
        assert.equal(triage.triageFailure(Object.assign({}, unproven, { redRounds: 0 })).action, triage.ACTION_DIFFERENTIAL);
        var atCap = triage.triageFailure(Object.assign({}, unproven, { redRounds: 3 }));
        assert.equal(atCap.action, triage.ACTION_ESCALATE);
        assert.equal(atCap.reason, 'null-ac-verdict-cap-reached');
    });

    test('guards keep parking at the cap — the dispatcher owns their continuation (unchanged)', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-32',
            role: triage.ROLE_GUARD,
            validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-old', envFingerprint: 'env-1' },
            acVerdict: null,
            redRounds: 5,
            maxReworkRounds: 2
        });
        assert.equal(v.action, triage.ACTION_DIFFERENTIAL);
        assert.equal(v.reason, 'rerun-requested-on-last-green-build');
    });
});

suite('gh-1354: validated own-oracle — product-side attribution hands to the AC re-check', function() {

    var ownProductSide = {
        tcKey: 'TS-33',
        role: triage.ROLE_OWN,
        validated: true,
        current: { sha: 'sha-new', envFingerprint: 'env-1' },
        lastGreen: { sha: 'sha-old', envFingerprint: 'env-1' },
        differential: 'green',
        maxReworkRounds: 2
    };

    test('AC3: differential green + AC violated -> the earned bounce (AC-gated final bounce, evidence intact)', function() {
        var v = triage.triageFailure(Object.assign({}, ownProductSide, { acVerdict: 'violated', redRounds: 0 }));
        assert.equal(v.action, triage.ACTION_BOUNCE);
        assert.equal(v.reason, 'acceptance-criteria-violated');
        assert.equal(v.evidence.differential, 'green');
        assert.ok(v.ledgerEntry);
    });

    test('AC3: differential green + AC violated at the cap -> escalation (the bounce stays bounded)', function() {
        var v = triage.triageFailure(Object.assign({}, ownProductSide, { acVerdict: 'violated', redRounds: 2 }));
        assert.equal(v.action, triage.ACTION_ESCALATE);
        assert.equal(v.reason, 'bounce-cap-reached');
    });

    test('differential green + AC intact -> the TC misencodes the AC -> maintenance', function() {
        var v = triage.triageFailure(Object.assign({}, ownProductSide, { acVerdict: 'intact' }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'tc-misencodes-ac');
    });

    test('differential green + null AC verdict -> the AC re-check rework below the cap', function() {
        var v = triage.triageFailure(Object.assign({}, ownProductSide, { acVerdict: null, redRounds: 0 }));
        assert.equal(v.action, triage.ACTION_REWORK);
        assert.equal(v.reason, 'own-oracle-ac-recheck');
    });

    test('F2: differential green + null AC verdict at the cap -> escalation, never another REWORK lap', function() {
        var v = triage.triageFailure(Object.assign({}, ownProductSide, { acVerdict: null, redRounds: 2 }));
        assert.equal(v.action, triage.ACTION_ESCALATE);
        assert.equal(v.reason, 'null-ac-verdict-cap-reached');
    });

    test('AC3: differential red -> failure predates the change -> maintenance (the AC claim cannot outvote evidence)', function() {
        var v = triage.triageFailure(Object.assign({}, ownProductSide, { differential: 'red', acVerdict: 'violated' }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'failure-predates-change');
    });

    test('guards keep the direct earned bounce on differential green (unchanged)', function() {
        var v = triage.triageFailure(Object.assign({}, ownProductSide, {
            role: triage.ROLE_GUARD, acVerdict: 'violated', redRounds: 0
        }));
        assert.equal(v.action, triage.ACTION_BOUNCE);
        assert.equal(v.reason, 'regression-from-change-range');
    });
});

suite('gh-1354: triageDifferentialOutcome hardened — only green|red decide', function() {

    function ownDispatcherInput(overrides) {
        return Object.assign({
            tcKey: 'TS-34',
            role: triage.ROLE_OWN,
            differential: 'green',
            redRounds: 0,
            maxReworkRounds: 2,
            errorClass: 'assertion',
            testPath: 'testing/tests/TS-34/test.py'
        }, overrides || {});
    }

    test('AC5: own oracle + unavailable -> re-request the rerun, never bounce or rework', function() {
        var v = triage.triageDifferentialOutcome(ownDispatcherInput({ differential: 'unavailable' }));
        assert.equal(v.action, triage.ACTION_DIFFERENTIAL);
        assert.equal(v.reason, 'rerun-requested-on-last-green-build');
    });

    test('AC5: guard + unavailable -> re-request too (the parked state, not a green)', function() {
        var v = triage.triageDifferentialOutcome(ownDispatcherInput({
            role: triage.ROLE_GUARD, differential: 'unavailable'
        }));
        assert.equal(v.action, triage.ACTION_DIFFERENTIAL);
        assert.notEqual(v.action, triage.ACTION_BOUNCE);
    });

    test('AC5: a missing or empty differential outcome re-requests (multi-value hardening)', function() {
        assert.equal(triage.triageDifferentialOutcome(ownDispatcherInput({ differential: null })).action, triage.ACTION_DIFFERENTIAL);
        assert.equal(triage.triageDifferentialOutcome(ownDispatcherInput({ differential: undefined })).action, triage.ACTION_DIFFERENTIAL);
        assert.equal(triage.triageDifferentialOutcome(ownDispatcherInput({ differential: '' })).action, triage.ACTION_DIFFERENTIAL);
    });

    test('own oracle + green continuation (dispatcher has no AC verdict) -> rework handoff below the cap', function() {
        var v = triage.triageDifferentialOutcome(ownDispatcherInput({ differential: 'green' }));
        assert.equal(v.action, triage.ACTION_REWORK);
        assert.equal(v.reason, 'own-oracle-ac-recheck');
        assert.equal(v.evidence.differential, 'green');
    });

    test('F2: own oracle + green continuation at the cap -> escalation', function() {
        var v = triage.triageDifferentialOutcome(ownDispatcherInput({ differential: 'green', redRounds: 2 }));
        assert.equal(v.action, triage.ACTION_ESCALATE);
        assert.equal(v.reason, 'null-ac-verdict-cap-reached');
    });

    test('own oracle + red continuation -> maintenance (same as guards)', function() {
        var v = triage.triageDifferentialOutcome(ownDispatcherInput({ differential: 'red' }));
        assert.equal(v.action, triage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'failure-predates-change');
    });
});
