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

    test('own-oracle red routes to the AC re-check (rework) before any bounce', function() {
        var v = triage.triageFailure({
            tcKey: 'TS-11',
            role: triage.ROLE_OWN,
            validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-old', envFingerprint: 'env-1' }
        });
        assert.equal(v.action, triage.ACTION_REWORK);
        assert.equal(v.reason, 'own-oracle-ac-recheck');
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
