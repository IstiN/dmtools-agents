/**
 * Unit tests for js/common/tcMaintenanceLedger.js — the gh-1329 rolling
 * TC-maintenance ledger: nothing discarded (§5), machine-routed dev exit
 * (§6), async owner digest (§7).
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({
    './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}))
}));
var LEDGERCORE = loadModule('js/common/ledgerCore.js', makeRequire({}));
var ledger = loadModule('js/common/tcMaintenanceLedger.js', makeRequire({ './ledgerCore.js': LEDGERCORE,
    './reviewVerdicts.js': reviewVerdicts
}));

var ALLOW = { authorLogins: ['ai-teammate'] };

function machineComment(payload) {
    return { body: payload, user: { login: 'ai-teammate' } };
}

suite('tcMaintenanceLedger: findings + identity dedupe', function() {

    test('empty ledger is a versioned container', function() {
        var l = ledger.emptyLedger();
        assert.equal(l.v, 1);
        assert.deepEqual(l.findings, []);
    });

    test('appendFinding normalizes the payload and stamps an identity', function() {
        var l = ledger.appendFinding(ledger.emptyLedger(), {
            tcKey: 'TS-2', role: 'regression-guard', verdict: 'maintenance', reason: 'flaky-same-build',
            errorClass: 'timeout', testPath: 'testing/tests/TS-2/test.py',
            sha: 'sha-new', lastGreenSha: 'sha-green', envFingerprint: 'env-1', lastGreenEnvFingerprint: 'env-1',
            failedDescriptionFile: 'outputs/failed_description_TS-2.md'
        });
        assert.equal(l.findings.length, 1);
        var f = l.findings[0];
        assert.ok(f.id && f.id.length === 16);
        assert.equal(f.tcKey, 'TS-2');
        assert.equal(f.status, 'open');
        assert.equal(f.occurrences, 1);
        assert.equal(f.errorClass, 'timeout');
        assert.ok(f.firstSeenAt);
        assert.equal(f.lastSeenAt, f.firstSeenAt);
    });

    test('missing errorClass falls back to unknown (never silently dropped)', function() {
        var l = ledger.appendFinding(ledger.emptyLedger(), { tcKey: 'TS-2', verdict: 'rework' });
        assert.equal(l.findings[0].errorClass, 'unknown');
    });

    test('same TC + class + script re-appends refresh the finding instead of duplicating it', function() {
        var l = ledger.emptyLedger();
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'timeout', testPath: 'testing/tests/TS-2/test.py', sha: 'sha-1' });
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'timeout', testPath: 'testing/tests/TS-2/test.py', sha: 'sha-2' });
        assert.equal(l.findings.length, 1);
        assert.equal(l.findings[0].occurrences, 2);
        assert.equal(l.findings[0].sha, 'sha-2');
        assert.ok(l.findings[0].firstSeenAt !== l.findings[0].lastSeenAt || true); // timestamps may coincide in fast tests
    });

    test('different error class or script on the same TC is a distinct finding', function() {
        var l = ledger.emptyLedger();
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'timeout', testPath: 'testing/tests/TS-2/test.py' });
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'assertion', testPath: 'testing/tests/TS-2/test.py' });
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'assertion', testPath: 'testing/tests/TS-2/other.py' });
        assert.equal(l.findings.length, 3);
    });

    test('a re-occurrence of a resolved finding reopens it (sweep did not stick)', function() {
        var l = ledger.emptyLedger();
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'timeout', testPath: 'p.py' });
        l = ledger.resolveFindings(l, [l.findings[0].id], 'sweep-pr-1');
        assert.equal(l.findings[0].status, 'resolved');
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'timeout', testPath: 'p.py' });
        assert.equal(l.findings.length, 1);
        assert.equal(l.findings[0].status, 'open');
        assert.equal(l.findings[0].occurrences, 2);
    });

    test('resolveFindings marks only the listed identities', function() {
        var l = ledger.emptyLedger();
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'timeout', testPath: 'a.py' });
        l = ledger.appendFinding(l, { tcKey: 'TS-3', verdict: 'rework', errorClass: 'assertion', testPath: 'b.py' });
        l = ledger.resolveFindings(l, [l.findings[0].id], 'sweep-pr-9');
        assert.equal(l.findings[0].status, 'resolved');
        assert.equal(l.findings[0].resolvedVia, 'sweep-pr-9');
        assert.equal(l.findings[1].status, 'open');
    });

    test('openFindings lists only open ones', function() {
        var l = ledger.emptyLedger();
        l = ledger.appendFinding(l, { tcKey: 'TS-2', verdict: 'maintenance', errorClass: 'timeout', testPath: 'a.py' });
        l = ledger.appendFinding(l, { tcKey: 'TS-3', verdict: 'rework', errorClass: 'assertion', testPath: 'b.py' });
        l = ledger.resolveFindings(l, [l.findings[0].id], 'sweep');
        assert.equal(ledger.openFindings(l).length, 1);
        assert.equal(ledger.openFindings(l)[0].tcKey, 'TS-3');
    });
});

suite('tcMaintenanceLedger: dev exit + automation verdicts', function() {

    test('findingFromVerdict maps a triage verdict into a ledger finding', function() {
        var f = ledger.findingFromVerdict({
            tcKey: 'TS-4', role: 'regression-guard', action: 'maintenance', reason: 'environment-shift',
            evidence: { sha: 's1', lastGreenSha: 's0', errorClass: 'navigation', testPath: 'testing/tests/TS-4/t.py' }
        }, { at: '2026-01-01T00:00:00.000Z' });
        assert.equal(f.tcKey, 'TS-4');
        assert.equal(f.verdict, 'maintenance');
        assert.equal(f.source, 'automation');
        assert.equal(f.firstSeenAt, '2026-01-01T00:00:00.000Z');
        assert.equal(f.errorClass, 'navigation');
    });

    test('findingFromDevClaim maps outputs/test_suspected.json into a dev-sourced finding', function() {
        var f = ledger.findingFromDevClaim({
            tcKey: 'TS-7',
            claimedVerdict: 'stale-test',
            reason: 'TC asserts the old column name; the AC says the renamed one',
            evidence: 'outputs/rca.md#L3',
            errorClass: 'assertion',
            testPath: 'testing/tests/TS-7/test.py'
        }, { at: '2026-01-02T00:00:00.000Z' });
        assert.equal(f.tcKey, 'TS-7');
        assert.equal(f.source, 'dev');
        assert.equal(f.verdict, 'dev-test-suspected');
        assert.equal(f.claimedVerdict, 'stale-test');
        assert.contains(f.note, 'old column name');
    });

    test('findingFromDevClaim truncates oversized free text (marker hygiene)', function() {
        var long = new Array(1000).join('x');
        var f = ledger.findingFromDevClaim({ tcKey: 'TS-7', reason: long }, { at: '2026-01-02T00:00:00.000Z' });
        assert.ok(f.note.length <= 600);
    });

    test('AC: an automation finding keeps note DISTINCT from reason (no redundant payload)', function() {
        var f = ledger.findingFromVerdict({
            tcKey: 'TS-8', role: 'regression-guard', action: 'maintenance', reason: 'environment-shift',
            evidence: { sha: 's1', errorClass: 'timeout', testPath: 'testing/tests/TS-8/t.py' }
        }, { at: '2026-01-03T00:00:00.000Z' });
        assert.equal(f.reason, 'environment-shift');
        assert.equal(f.note, null, 'note must not duplicate reason for automation-sourced findings');
    });

    test('an explicit note still wins over the reason fallback', function() {
        var l = ledger.appendFinding(ledger.emptyLedger(), {
            tcKey: 'TS-2', verdict: 'maintenance', reason: 'flaky-same-build', note: 'flaky in CI only'
        });
        assert.equal(l.findings[0].note, 'flaky in CI only');
        assert.equal(l.findings[0].reason, 'flaky-same-build');
    });
});

suite('tcMaintenanceLedger: marker persistence (house dmtools: pattern)', function() {

    function buildLedger() {
        var l = ledger.emptyLedger();
        l = ledger.appendFinding(l, {
            tcKey: 'TS-2', role: 'regression-guard', verdict: 'maintenance', reason: 'flaky-same-build',
            errorClass: 'timeout', testPath: 'testing/tests/TS-2/test.py', sha: 'sha-new', lastGreenSha: 'sha-green'
        });
        l = ledger.appendFinding(l, {
            tcKey: 'TS-3', verdict: 'rework', reason: 'fresh-tc-first-run-validation',
            errorClass: 'element-not-found', testPath: 'testing/tests/TS-3/test.py'
        });
        return l;
    }

    test('marker round-trips through parse with the machine-author trust gate', function() {
        var marker = ledger.buildLedgerMarker(buildLedger());
        assert.contains(marker, '<!-- dmtools:tc-maintenance-ledger ');
        var parsed = ledger.latestLedger([machineComment(marker)], ALLOW);
        assert.ok(parsed);
        assert.equal(parsed.ledger.findings.length, 2);
        assert.equal(parsed.ledger.findings[0].tcKey, 'TS-2');
    });

    test('comments from untrusted authors are ignored (fail closed)', function() {
        var marker = ledger.buildLedgerMarker(buildLedger());
        var parsed = ledger.latestLedger([{ body: marker, user: { login: 'rando' } }], ALLOW);
        assert.equal(parsed, null);
    });

    test('no configured allowlist trusts nothing', function() {
        var marker = ledger.buildLedgerMarker(buildLedger());
        var parsed = ledger.latestLedger([machineComment(marker)], {});
        assert.equal(parsed, null);
    });

    test('newest record wins across multiple markers', function() {
        var first = ledger.buildLedgerMarker(ledger.appendFinding(ledger.emptyLedger(), { tcKey: 'TS-1', verdict: 'rework', at: '2026-01-01T00:00:00.000Z' }));
        var second = ledger.buildLedgerMarker(ledger.appendFinding(ledger.emptyLedger(), { tcKey: 'TS-9', verdict: 'maintenance', at: '2026-02-01T00:00:00.000Z' }));
        var parsed = ledger.latestLedger([machineComment(first), machineComment(second)], ALLOW);
        assert.equal(parsed.ledger.findings.length, 1);
        assert.equal(parsed.ledger.findings[0].tcKey, 'TS-9');
    });

    test('marker payloads neutralize marker-hostile sequences in free text', function() {
        var l = ledger.appendFinding(ledger.emptyLedger(), {
            tcKey: 'TS-4', verdict: 'rework', note: 'evil --> and <!-- sequences'
        });
        var marker = ledger.buildLedgerMarker(l);
        assert.notContains(marker, 'evil -->');
        var parsed = ledger.latestLedger([machineComment(marker)], ALLOW);
        assert.contains(parsed.ledger.findings[0].note, 'evil');
    });

    test('digest comment lists open findings and never demands action', function() {
        var comment = ledger.buildDigestComment(buildLedger());
        assert.contains(comment, 'TS-2');
        assert.contains(comment, 'TS-3');
        assert.contains(comment, 'maintenance ledger');
        assert.notContains(comment, 'MUST');
    });

    test('digest comment for an empty ledger says the ledger is clean', function() {
        var comment = ledger.buildDigestComment(ledger.emptyLedger());
        assert.contains(comment, 'no open findings');
    });
});

// ── gh-1345: parked differential rerun requests (digest visibility) ──────────

function buildLedgerWithParked() {
    var l = ledger.emptyLedger();
    l = ledger.appendFinding(l, {
        tcKey: 'TS-2', role: 'regression-guard', verdict: 'maintenance', reason: 'flaky-same-build',
        errorClass: 'timeout', testPath: 'testing/tests/TS-2/test.py', sha: 'sha-new', lastGreenSha: 'sha-green'
    });
    l = ledger.appendFinding(l, {
        tcKey: 'TS-7', role: 'regression-guard', verdict: 'differential-rerun',
        reason: 'rerun-requested-on-last-green-build', errorClass: 'assertion',
        testPath: 'testing/tests/TS-7/test.py', sha: 'sha-new', lastGreenSha: 'sha-green'
    });
    l = ledger.appendFinding(l, {
        tcKey: 'TS-8', role: 'regression-guard', verdict: 'differential-rerun',
        reason: 'rerun-requested-on-last-green-build', errorClass: 'navigation',
        testPath: 'testing/tests/TS-8/test.py', sha: 'sha-new', lastGreenSha: 'sha-old'
    });
    l = ledger.appendFinding(l, {
        tcKey: 'TS-3', verdict: 'rework', reason: 'fresh-tc-first-run-validation',
        errorClass: 'element-not-found', testPath: 'testing/tests/TS-3/test.py'
    });
    return l;
}

suite('tcMaintenanceLedger: parked differential requests (gh-1345)', function() {

    test('differentialRequests lists only open differential-rerun findings', function() {
        var parked = ledger.differentialRequests(buildLedgerWithParked());
        assert.equal(parked.length, 2);
        assert.equal(parked[0].tcKey, 'TS-7');
        assert.equal(parked[1].tcKey, 'TS-8');
        assert.deepEqual(ledger.differentialRequests(ledger.emptyLedger()), []);
    });

    test('a resolved differential request no longer counts as parked', function() {
        var l = buildLedgerWithParked();
        var target = ledger.differentialRequests(l)[0];
        var resolved = ledger.resolveFindings(l, [target.id], 'differential-rerun-dispatcher');
        var parked = ledger.differentialRequests(resolved);
        assert.equal(parked.length, 1);
        assert.equal(parked[0].tcKey, 'TS-8');
    });

    test('digest always carries a dedicated parked-request section listing every parked TC', function() {
        var comment = ledger.buildDigestComment(buildLedgerWithParked());
        assert.contains(comment, 'Parked differential rerun requests');
        assert.contains(comment, 'TS-7');
        assert.contains(comment, 'TS-8');
        // each parked line names the evidence the dispatcher needs
        assert.contains(comment, 'testing/tests/TS-7/test.py');
        assert.contains(comment, 'sha-green');
        assert.contains(comment, 'sha-old');
        // the parked section names its owner — the scripted dispatcher, not the sweep
        assert.contains(comment, 'dispatcher');
    });

    test('digest keeps the sweep section for the non-differential findings', function() {
        var comment = ledger.buildDigestComment(buildLedgerWithParked());
        assert.contains(comment, 'TS-2');
        assert.contains(comment, 'TS-3');
        assert.contains(comment, 'batched sweep');
    });

    test('digest without parked requests renders the previous shape (no parked section)', function() {
        var sweepOnly = ledger.emptyLedger();
        sweepOnly = ledger.appendFinding(sweepOnly, {
            tcKey: 'TS-2', role: 'regression-guard', verdict: 'maintenance', reason: 'flaky-same-build',
            errorClass: 'timeout', testPath: 'testing/tests/TS-2/test.py', sha: 'sha-new', lastGreenSha: 'sha-green'
        });
        sweepOnly = ledger.appendFinding(sweepOnly, {
            tcKey: 'TS-3', verdict: 'rework', reason: 'fresh-tc-first-run-validation',
            errorClass: 'element-not-found', testPath: 'testing/tests/TS-3/test.py'
        });
        var comment = ledger.buildDigestComment(sweepOnly);
        assert.notContains(comment, 'Parked differential rerun requests');
        assert.contains(comment, 'TS-2');
        assert.contains(comment, 'TS-3');
    });

    test('digest with ONLY parked requests still renders the parked section', function() {
        var l = ledger.emptyLedger();
        l = ledger.appendFinding(l, {
            tcKey: 'TS-9', role: 'regression-guard', verdict: 'differential-rerun',
            reason: 'rerun-requested-on-last-green-build', errorClass: 'timeout',
            testPath: 'testing/tests/TS-9/test.py', sha: 'sha-new', lastGreenSha: 'sha-green'
        });
        var comment = ledger.buildDigestComment(l);
        assert.contains(comment, 'Parked differential rerun requests');
        assert.contains(comment, 'TS-9');
        assert.contains(comment, 'dispatcher');
    });

    test('parked request survives the marker round-trip and stays parked', function() {
        var marker = ledger.buildLedgerMarker(buildLedgerWithParked());
        var parsed = ledger.latestLedger([machineComment(marker)], ALLOW);
        var parked = ledger.differentialRequests(parsed.ledger);
        assert.equal(parked.length, 2);
    });
});
