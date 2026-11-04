/**
 * Unit tests for js/common/tcAlternation.js — the gh-1331 cross-lap TC
 * alternation detector and bounce suppression.
 *
 * The gh-1331 pathology: two TCs pin incompatible expectations. Under
 * gh-1329's per-event triage every bounce is individually earned while the
 * system ping-pongs forever — each TC's red streak stays at 1 (a green
 * separates its reds), so the bounce cap never triggers. The detector keeps
 * the per-TC run history (beside lastGreenSha, in the run registry), finds
 * the trade signature (the same pair trading red/green across >=2 builds
 * without a stable green), marks the pair contradictory-or-flaky, suppresses
 * further earned bounces and presents both pinned behaviors to the owner —
 * async, one escalation per pair.
 */

var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}));
var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({
    './machineAuthor.js': machineAuthor
}));
var registry = loadModule('js/common/tcRunRegistry.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts
}));
var tcLedger = loadModule('js/common/tcMaintenanceLedger.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts
}));
var alt = loadModule('js/common/tcAlternation.js', makeRequire({
    './tcRunRegistry.js': registry,
    './tcMaintenanceLedger.js': tcLedger
}));

// ── fixtures ─────────────────────────────────────────────────────────────────

/** The canonical alternation history: A green@S1, A red@S2 (lap1), B green@S1, B red@S3 (lap2). */
function tradingRegistry() {
    var r = registry.emptyRegistry();
    r = registry.recordGreen(r, 'TS-A', { sha: 'S1', envFingerprint: 'env', role: 'regression-guard' });
    r = registry.recordGreen(r, 'TS-B', { sha: 'S1', envFingerprint: 'env', role: 'regression-guard' });
    r = registry.recordFailure(r, 'TS-A', { sha: 'S2', verdict: 'bounce', role: 'regression-guard' });
    r = registry.recordGreen(r, 'TS-B', { sha: 'S2', envFingerprint: 'env', role: 'regression-guard' });
    r = registry.recordFailure(r, 'TS-B', { sha: 'S3', verdict: 'bounce', role: 'regression-guard' });
    return r;
}

function greenRun(r, tcKey, sha) {
    return registry.recordGreen(r, tcKey, { sha: sha, envFingerprint: 'env', role: 'regression-guard' });
}

function redRun(r, tcKey, sha) {
    return registry.recordFailure(r, tcKey, { sha: sha, verdict: 'bounce', role: 'regression-guard' });
}

function ledgerWithBounceFinding(tcKey, opts) {
    opts = opts || {};
    var l = tcLedger.emptyLedger();
    var verdict = {
        tcKey: tcKey,
        role: 'regression-guard',
        action: opts.resolved ? 'maintenance' : 'bounce',
        reason: 'regression-from-change-range',
        ledgerEntry: {
            tcKey: tcKey,
            role: 'regression-guard',
            verdict: opts.resolved ? 'maintenance' : 'bounce',
            reason: 'regression-from-change-range',
            evidence: {
                sha: opts.sha || 'S3',
                envFingerprint: 'env',
                lastGreenSha: opts.lastGreenSha || 'S1',
                lastGreenEnvFingerprint: 'env',
                testPath: 'testing/tests/' + tcKey + '/test.py',
                errorClass: 'assertion'
            }
        },
        evidence: {
            sha: opts.sha || 'S3',
            lastGreenSha: opts.lastGreenSha || 'S1',
            testPath: 'testing/tests/' + tcKey + '/test.py',
            errorClass: 'assertion'
        }
    };
    l = tcLedger.appendFinding(l, tcLedger.findingFromVerdict(verdict, {}));
    if (opts.resolved) {
        l = tcLedger.resolveFindings(l, tcLedger.openFindings(l).map(function(f) { return f.id; }), 'sweep');
    }
    return l;
}

function ledgerWithDevClaim(tcKey, sha) {
    return tcLedger.appendFinding(tcLedger.emptyLedger(), tcLedger.findingFromDevClaim({
        tcKey: tcKey, claimedVerdict: 'stale-guard', reason: 'guard pins the old behavior',
        testPath: 'testing/tests/' + tcKey + '/test.py', sha: sha
    }, {}));
}

// ── detection ────────────────────────────────────────────────────────────────

suite('tcAlternation: the trade signature', function() {

    test('AC: a pair trading red/green across two builds without a stable green is detected', function() {
        var d = alt.detectAlternation(tradingRegistry(), 'TS-A', 'TS-B');
        assert.ok(d, 'the flip is detected');
        assert.equal(d.holderNow, 'TS-B', 'the newest trade holds B red');
        assert.equal(d.holderPrev, 'TS-A');
        assert.equal(d.pairKey, 'TS-A|TS-B');
        assert.equal(d.state, 'contradictory-or-flaky');
        assert.equal(d.trades.length, 2);
    });

    test('a stable green between the trades breaks the chain — no detection', function() {
        var r = registry.emptyRegistry();
        r = redRun(r, 'TS-A', 'S1');
        r = greenRun(r, 'TS-B', 'S1');
        r = greenRun(r, 'TS-A', 'S2');
        r = greenRun(r, 'TS-B', 'S2'); // both green on S2 — the fix worked
        r = redRun(r, 'TS-B', 'S3');
        r = greenRun(r, 'TS-A', 'S3');
        assert.equal(alt.detectAlternation(r, 'TS-A', 'TS-B'), null,
            'the red after a stable green is a new episode, not a trade');
    });

    test('a same-holder sequence is not a trade (one TC failing repeatedly)', function() {
        var r = registry.emptyRegistry();
        r = redRun(r, 'TS-A', 'S1');
        r = greenRun(r, 'TS-B', 'S1');
        r = redRun(r, 'TS-A', 'S2');
        r = greenRun(r, 'TS-B', 'S2');
        assert.equal(alt.detectAlternation(r, 'TS-A', 'TS-B'), null,
            'A failing twice while B holds is not alternation');
    });

    test('a single trade is not enough (needs >=2 laps)', function() {
        var r = registry.emptyRegistry();
        r = greenRun(r, 'TS-A', 'S1');
        r = greenRun(r, 'TS-B', 'S1');
        r = redRun(r, 'TS-A', 'S2');
        r = greenRun(r, 'TS-B', 'S2');
        assert.equal(alt.detectAlternation(r, 'TS-A', 'TS-B'), null);
    });

    test('a build where BOTH members are red is neutral: neither a trade nor a chain break', function() {
        var r = registry.emptyRegistry();
        r = redRun(r, 'TS-A', 'S1');
        r = greenRun(r, 'TS-B', 'S1');
        r = redRun(r, 'TS-A', 'S2');
        r = redRun(r, 'TS-B', 'S2'); // both red on S2
        r = redRun(r, 'TS-B', 'S3');
        r = greenRun(r, 'TS-A', 'S3');
        var d = alt.detectAlternation(r, 'TS-A', 'TS-B');
        assert.ok(d, 'the both-red lap does not reset the chain');
        assert.equal(d.holderNow, 'TS-B');
        assert.equal(d.holderPrev, 'TS-A');
    });

    test('a member with no run on a build counts as not-red (the trade still shows)', function() {
        var r = registry.emptyRegistry();
        r = greenRun(r, 'TS-A', 'S1');
        r = greenRun(r, 'TS-B', 'S1');
        r = redRun(r, 'TS-A', 'S2');
        // TS-B has no run on S2 (its entry is processed later in the same lap)
        var d = alt.detectAlternation(r, 'TS-A', 'TS-B');
        assert.equal(d, null, 'a single trade with the partner still unrun is not a flip yet');
        r = greenRun(r, 'TS-B', 'S3');
        r = redRun(r, 'TS-B', 'S4');
        // now: S4 B red (A unrun -> not red), S2 A red (B unrun -> not red) -> flip
        d = alt.detectAlternation(r, 'TS-A', 'TS-B');
        assert.ok(d, 'the flip is visible from the run histories alone');
        assert.equal(d.holderNow, 'TS-B');
    });

    test('runs without a build sha never classify (no collapsed null-sha buckets)', function() {
        var r = registry.emptyRegistry();
        r = greenRun(r, 'TS-A', 'S1');
        r = greenRun(r, 'TS-B', 'S1');
        r = registry.recordFailure(r, 'TS-A', { sha: null, verdict: 'bounce' });
        r = registry.recordFailure(r, 'TS-B', { sha: null, verdict: 'bounce' });
        assert.equal(alt.detectAlternation(r, 'TS-A', 'TS-B'), null,
            'sha-less reds cannot fabricate trades');
    });
});

suite('tcAlternation: pair scan', function() {

    test('scanAlternations finds the trading pair among many TCs', function() {
        var r = tradingRegistry();
        r = greenRun(r, 'TS-C', 'S1');
        var found = alt.scanAlternations(r);
        assert.equal(found.length, 1);
        assert.equal(found[0].pairKey, 'TS-A|TS-B');
    });

    test('scanAlternations for one TC only returns pairs covering it', function() {
        var found = alt.scanAlternations(tradingRegistry(), 'TS-A');
        assert.equal(found.length, 1);
        assert.equal(found[0].pairKey, 'TS-A|TS-B');
        assert.equal(alt.scanAlternations(tradingRegistry(), 'TS-C').length, 0);
    });
});

// ── pair records: mark once, escalate once ───────────────────────────────────

suite('tcAlternation: conflict records (one escalation per pair)', function() {

    test('AC: recordConflicts marks a NEW pair with both pinned behaviors + AC refs', function() {
        var evidence = {};
        var metaOf = function(tcKey) {
            return {
                verifies: 'BUG-' + tcKey,
                testPath: 'testing/tests/' + tcKey + '/test.py',
                failureSummary: tcKey + ' assertion',
                lastGreenSha: 'S1'
            };
        };
        var res = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', metaOf);
        assert.equal(res.added.length, 1);
        var record = res.registry.pairs['TS-A|TS-B'];
        assert.equal(record.state, 'contradictory-or-flaky');
        assert.equal(record.holderNow, 'TS-B');
        assert.equal(record.holderPrev, 'TS-A');
        assert.equal(record.detectedAt, '2026-01-02T00:00:00.000Z');
        assert.equal(record.members['TS-A'].verifies, 'BUG-TS-A', 'the AC reference is snapshotted');
        assert.equal(record.members['TS-B'].lastGreenSha, 'S1');
    });

    test('an already-marked pair is not re-added (one escalation per pair)', function() {
        var first = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', function() { return null; });
        var second = alt.recordConflicts(first.registry, alt.scanAlternations(first.registry), '2026-01-03T00:00:00.000Z', function() { return null; });
        assert.equal(second.added.length, 0, 'the pair record stands — no second escalation');
        assert.equal(second.registry.pairs['TS-A|TS-B'].detectedAt, '2026-01-02T00:00:00.000Z');
    });

    test('openConflictFor covers both members of the pair', function() {
        var res = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', function() { return null; });
        assert.equal(alt.openConflictFor(res.registry, 'TS-A').pairKey, 'TS-A|TS-B');
        assert.equal(alt.openConflictFor(res.registry, 'TS-B').pairKey, 'TS-A|TS-B');
        assert.equal(alt.openConflictFor(res.registry, 'TS-C'), null);
        assert.equal(alt.openConflictFor(registry.emptyRegistry(), 'TS-A'), null);
    });

    test('AC: the member snapshot is marker-hygiene capped (the record lives in the persistent registry marker)', function() {
        var huge = new Array(2001).join('x');
        var res = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', function() {
            return { verifies: 'BUG-1', testPath: 'p.py', failureSummary: huge, lastGreenSha: 'S1' };
        });
        var meta = res.registry.pairs['TS-A|TS-B'].members['TS-A'];
        assert.ok(meta.failureSummary.length <= 500, 'the snapshot is capped like the ledger notes, got ' + meta.failureSummary.length);
        assert.equal(res.registry.pairs['TS-A|TS-B'].members['TS-B'].failureSummary, null, 'a missing summary stays null');
    });
});

// ── reconciliation: a stable green resolves the conflict ─────────────────────

suite('tcAlternation: resolution re-enables normal triage', function() {

    function markedRegistry() {
        var res = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', function() { return null; });
        return res.registry;
    }

    test('AC: both members green on the same build clears the conflict', function() {
        var r = greenRun(markedRegistry(), 'TS-A', 'S4');
        r = greenRun(r, 'TS-B', 'S4');
        var rec = alt.reconcileConflicts(r, '2026-01-04T00:00:00.000Z');
        assert.equal(rec.pairs['TS-A|TS-B'], undefined, 'the pair record is gone — normal triage re-enabled');
        assert.equal(alt.openConflictFor(rec, 'TS-A'), null);
    });

    test('the conflict stands while one member is still red or the builds differ', function() {
        var r = greenRun(markedRegistry(), 'TS-A', 'S4');
        r = greenRun(r, 'TS-B', 'S5'); // different build
        assert.ok(alt.reconcileConflicts(r).pairs['TS-A|TS-B'], 'different builds — not a stable green');
        var r2 = greenRun(markedRegistry(), 'TS-A', 'S4');
        r2 = redRun(r2, 'TS-B', 'S4');
        assert.ok(alt.reconcileConflicts(r2).pairs['TS-A|TS-B'], 'a red member keeps the conflict');
    });

    test('after a resolution a fresh trade flip is detected and re-marked (new escalation)', function() {
        var r = greenRun(markedRegistry(), 'TS-A', 'S4');
        r = greenRun(r, 'TS-B', 'S4');
        r = alt.reconcileConflicts(r);
        r = redRun(r, 'TS-A', 'S5');
        r = greenRun(r, 'TS-B', 'S5');
        r = greenRun(r, 'TS-A', 'S6');
        r = redRun(r, 'TS-B', 'S6');
        var found = alt.scanAlternations(r);
        assert.equal(found.length, 1, 'the conflict is over — the signature detects again');
        var res = alt.recordConflicts(r, found, '2026-01-05T00:00:00.000Z', function() { return null; });
        assert.equal(res.added.length, 1, 'a resolved pair can be re-marked once');
    });
});

// ── bounce suppression (the three anchors) ───────────────────────────────────

suite('tcAlternation: bounce suppression anchors', function() {

    test('AC: an open contradictory pair suppresses the bounce (sha-independent)', function() {
        var res = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', function() { return null; });
        var s = alt.bounceSuppression(res.registry, tcLedger.emptyLedger(), 'TS-B', 'S3', 'S4');
        assert.ok(s);
        assert.equal(s.kind, 'contradictory-pair');
        assert.equal(s.pairKey, 'TS-A|TS-B');
    });

    test('AC: a prior earned bounce on the same SHA range suppresses the re-bounce', function() {
        var r = tradingRegistry();
        r = registry.recordBounce(r, 'TS-B', { at: '2026-01-02T00:00:00.000Z', lastGreenSha: 'S1', kind: 'earned' });
        var s = alt.bounceSuppression(r, tcLedger.emptyLedger(), 'TS-B', 'S1', 'S4');
        assert.ok(s, 'same range anchor — the bounce already happened once');
        assert.equal(s.kind, 'prior-bounce-same-range');
        assert.equal(alt.bounceSuppression(r, tcLedger.emptyLedger(), 'TS-B', 'S9', 'S10'), null,
            'a different range (the guard went green in between) bounces normally');
    });

    test('AC: an open ledger item (bounce finding / dev claim) on the same SHA range suppresses', function() {
        var l = ledgerWithBounceFinding('TS-B', { lastGreenSha: 'S1' });
        var s = alt.bounceSuppression(registry.emptyRegistry(), l, 'TS-B', 'S1', 'S3');
        assert.ok(s);
        assert.equal(s.kind, 'open-ledger-item');
        assert.equal(s.reason, 'bounce');
    });

    test('a resolved ledger item or a different range does not suppress', function() {
        var l = ledgerWithBounceFinding('TS-B', { lastGreenSha: 'S1', resolved: true });
        assert.equal(alt.bounceSuppression(registry.emptyRegistry(), l, 'TS-B', 'S1', 'S3'), null,
            'a resolved finding no longer anchors');
        var l2 = ledgerWithBounceFinding('TS-B', { lastGreenSha: 'S1' });
        assert.equal(alt.bounceSuppression(registry.emptyRegistry(), l2, 'TS-B', 'S9', 'S10'), null,
            'a finding from another range does not anchor');
    });

    test('a dev-filed test_suspected claim on the same build suppresses', function() {
        var l = ledgerWithDevClaim('TS-B', 'S3');
        var s = alt.bounceSuppression(registry.emptyRegistry(), l, 'TS-B', null, 'S3');
        assert.ok(s, 'the claim carries the failing build sha — same range anchor');
        assert.equal(s.kind, 'open-ledger-item');
        assert.equal(s.source, 'dev');
    });

    test('plain maintenance findings never anchor (a flaked guard must still earn its bounce)', function() {
        var l = ledgerWithBounceFinding('TS-B', { lastGreenSha: 'S1', resolved: false, verdictAction: 'maintenance' });
        // rewrite the finding to a plain maintenance verdict
        var f = tcLedger.openFindings(l)[0];
        f.verdict = 'maintenance';
        f.reason = 'flaky-same-build';
        assert.equal(alt.bounceSuppression(registry.emptyRegistry(), l, 'TS-B', 'S1', 'S3'), null,
            'flaky/maintenance findings are not bounce anchors');
    });

    test('no range and no build sha matches nothing', function() {
        var l = ledgerWithBounceFinding('TS-B', { lastGreenSha: 'S1' });
        assert.equal(alt.bounceSuppression(registry.emptyRegistry(), l, 'TS-B', null, null), null);
        assert.equal(alt.bounceSuppression(registry.emptyRegistry(), tcLedger.emptyLedger(), 'TS-B', null, null), null);
    });

    test('AC: a finding refreshed by its own suppression still owns the failure (the anchor must not disarm)', function() {
        var l = ledgerWithBounceFinding('TS-B', { lastGreenSha: 'S1' });
        // the suppressed lap rewrote the finding (suppressedVerdict): the
        // verdict became maintenance, the reason names the suppression.
        var f = tcLedger.openFindings(l)[0];
        f.verdict = 'maintenance';
        f.reason = 'suppressed-prior-bounce-same-range';
        // the registry carries NO bounce anchor (a pre-gh-1331 marker or a
        // failed marker post) — the ledger anchor is the only line of defense.
        var s = alt.bounceSuppression(registry.emptyRegistry(), l, 'TS-B', 'S1', 'S3');
        assert.ok(s, 'a later lap must not re-bounce — the anchor survives its own verdict rewrite');
        assert.equal(s.kind, 'open-ledger-item');
    });
});

// ── the verdict conversion + the escalation surface ──────────────────────────

suite('tcAlternation: suppressed verdict + the owner escalation', function() {

    function bounceVerdict() {
        return {
            tcKey: 'TS-B',
            role: 'regression-guard',
            action: 'bounce',
            reason: 'regression-from-change-range',
            redRounds: 1,
            maxReworkRounds: 2,
            evidence: { sha: 'S4', envFingerprint: 'env', lastGreenSha: 'S1', lastGreenEnvFingerprint: 'env' },
            ledgerEntry: {
                id: null, tcKey: 'TS-B', role: 'regression-guard', verdict: 'bounce',
                reason: 'regression-from-change-range',
                evidence: { sha: 'S4', lastGreenSha: 'S1' }
            }
        };
    }

    test('suppressedVerdict converts the bounce into a test-side maintenance route', function() {
        var v = alt.suppressedVerdict(bounceVerdict(), { kind: 'contradictory-pair', pairKey: 'TS-A|TS-B' });
        assert.equal(v.action, 'maintenance', 'the bug is NOT re-bounced');
        assert.equal(v.reason, 'suppressed-contradictory-pair');
        assert.equal(v.tcKey, 'TS-B');
        assert.equal(v.evidence.lastGreenSha, 'S1', 'the attribution evidence is kept');
        assert.equal(v.ledgerEntry.verdict, 'maintenance', 'the ledger finding records the suppression');
        assert.equal(v.ledgerEntry.reason, 'suppressed-contradictory-pair');
        assert.equal(v.ledgerEntry.evidence.lastGreenSha, 'S1');
    });

    test('each suppression kind names itself', function() {
        assert.equal(alt.suppressedVerdict(bounceVerdict(), { kind: 'open-ledger-item' }).reason, 'suppressed-open-ledger-item');
        assert.equal(alt.suppressedVerdict(bounceVerdict(), { kind: 'prior-bounce-same-range' }).reason, 'suppressed-prior-bounce-same-range');
    });

    test('AC: the escalation presents both pinned behaviors + their AC references, async', function() {
        var res = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', function(tcKey) {
            return {
                verifies: tcKey === 'TS-A' ? 'BUG-1' : 'BUG-2',
                testPath: 'testing/tests/' + tcKey + '/test.py',
                failureSummary: tcKey + ' expects the old layout'
            };
        });
        var comment = alt.buildConflictComment(res.added[0], function() { return null; });
        assert.contains(comment, 'gh-1331');
        assert.contains(comment, 'TS-A');
        assert.contains(comment, 'TS-B');
        assert.contains(comment, 'BUG-1', 'the AC reference of the first pinned behavior');
        assert.contains(comment, 'BUG-2', 'the AC reference of the second pinned behavior');
        assert.contains(comment, 'testing/tests/TS-A/test.py');
        assert.contains(comment, 'contradictory-or-flaky');
        assert.contains(comment, 'suppressed', 'bounces for the pair are suppressed');
        assert.contains(comment, 'same build', 'the resolution: a stable green re-enables triage');
        assert.notContains(comment, 'undefined', 'missing metadata degrades to empty, never the string undefined');
    });

    test('the record snapshot feeds the escalation when the resolver has nothing', function() {
        var res = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', function(tcKey) {
            return { verifies: 'BUG-X', testPath: 'testing/tests/' + tcKey + '/test.py', lastGreenSha: 'S1' };
        });
        var comment = alt.buildConflictComment(res.added[0], function() { return null; });
        assert.contains(comment, 'BUG-X');
        assert.contains(comment, 'S1');
    });

    test('the pair record round-trips through the registry marker', function() {
        var res = alt.recordConflicts(tradingRegistry(), alt.scanAlternations(tradingRegistry()), '2026-01-02T00:00:00.000Z', function() {
            return { verifies: 'BUG-X', testPath: 'p.py', lastGreenSha: 'S1' };
        });
        var marker = registry.buildRegistryMarker(res.registry);
        var parsed = registry.latestRegistry([{ body: marker, user: { login: 'ai-teammate' } }], { authorLogins: ['ai-teammate'] });
        var restored = alt.openConflictFor(parsed.registry, 'TS-A');
        assert.ok(restored, 'the pair record survives the marker round-trip');
        assert.equal(restored.record.members['TS-A'].verifies, 'BUG-X');
    });
});
