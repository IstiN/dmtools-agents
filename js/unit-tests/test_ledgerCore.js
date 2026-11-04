/**
 * Unit tests: js/common/ledgerCore.js — the shared ledger+sweep pattern
 * (gh-1352 scope 4: the ledger machinery shipped in gh-1345/gh-1348's
 * tcMaintenanceLedger extracted so a second consumer — the review-side
 * debt ledger — reuses it without a third byte-identical copy).
 *
 * The TC ledger suite (test_tcMaintenanceLedger.js) pins the DELEGATING
 * behavior; this suite pins the core's own contract: shape, identity
 * refresh/reopen, resolution, the sweep trigger (>= batch or oldest >=
 * maxAgeDays) and the stale-drop with a note.
 */
/* global suite, test, assert, loadModule, makeRequire */

function core() {
    return loadModule('js/common/ledgerCore.js', makeRequire({}), {});
}

function finding(id, over) {
    var f = { id: id, status: 'open', firstSeenAt: '2026-11-01T00:00:00.000Z',
              lastSeenAt: '2026-11-01T00:00:00.000Z', occurrences: 1 };
    for (var k in (over || {})) f[k] = over[k];
    return f;
}

suite('ledgerCore — shape + identity append/refresh', function () {
    var lc = core();

    test('emptyLedger carries the version and an empty findings array', function () {
        var l = lc.emptyLedger(3);
        assert.equal(l.v, 3);
        assert.deepEqual(l.findings, []);
        assert.ok(l.at, 'a ledger is timestamped');
    });

    test('appendFinding pushes a new entry (identity miss)', function () {
        var l = lc.appendFinding(lc.emptyLedger(1), { id: 'aa', at: '2026-11-04T00:00:00.000Z' }, null);
        assert.equal(l.findings.length, 1);
        assert.equal(l.findings[0].id, 'aa');
        assert.equal(l.findings[0].occurrences, 1);
    });

    test('appendFinding refreshes an identity match: occurrences++ and lastSeenAt moves', function () {
        var seed = lc.appendFinding(lc.emptyLedger(1), { id: 'aa', at: '2026-11-01T00:00:00.000Z' }, null);
        var l = lc.appendFinding(seed, { id: 'aa', at: '2026-11-04T00:00:00.000Z' }, null);
        assert.equal(l.findings.length, 1, 'the same finding never duplicates');
        assert.equal(l.findings[0].occurrences, 2);
        assert.equal(l.findings[0].lastSeenAt, '2026-11-04T00:00:00.000Z');
        assert.equal(l.findings[0].firstSeenAt, '2026-11-01T00:00:00.000Z', 'firstSeen is immutable');
    });

    test('appendFinding REOPENS a resolved finding on re-occurrence (the sweep did not stick)', function () {
        var seed = lc.appendFinding(lc.emptyLedger(1), { id: 'aa', at: '2026-11-01T00:00:00.000Z' }, null);
        var resolved = lc.resolveFindings(seed, ['aa'], 'sweep-1');
        var l = lc.appendFinding(resolved, { id: 'aa', at: '2026-11-04T00:00:00.000Z' }, null);
        assert.equal(l.findings[0].status, 'open');
        assert.equal(l.findings[0].resolvedAt, null);
        assert.equal(l.findings[0].resolvedVia, null);
        assert.equal(l.findings[0].occurrences, 2);
    });

    test('appendFinding never mutates the input ledger', function () {
        var seed = lc.appendFinding(lc.emptyLedger(1), { id: 'aa', at: '2026-11-01T00:00:00.000Z' }, null);
        var before = JSON.stringify(seed);
        lc.appendFinding(seed, { id: 'aa', at: '2026-11-04T00:00:00.000Z' }, null);
        assert.equal(JSON.stringify(seed), before);
    });

    test('the evidence fields ride the refresh (latest evidence wins)', function () {
        var seed = lc.appendFinding(lc.emptyLedger(1),
            { id: 'aa', at: '2026-11-01T00:00:00.000Z', note: 'first', sha: 'a1' }, null);
        var l = lc.appendFinding(seed, { id: 'aa', at: '2026-11-04T00:00:00.000Z', note: 'second', sha: 'b2' }, null);
        assert.equal(l.findings[0].note, 'second');
        assert.equal(l.findings[0].sha, 'b2');
    });

    test('a 2+ finding ledger keeps distinct identities apart', function () {
        var l = lc.emptyLedger(1);
        l = lc.appendFinding(l, { id: 'aa', at: '2026-11-01T00:00:00.000Z' }, null);
        l = lc.appendFinding(l, { id: 'bb', at: '2026-11-02T00:00:00.000Z' }, null);
        l = lc.appendFinding(l, { id: 'aa', at: '2026-11-03T00:00:00.000Z' }, null);
        assert.equal(l.findings.length, 2);
        assert.deepEqual(l.findings.map(function (f) { return f.id; }), ['aa', 'bb']);
        assert.deepEqual(l.findings.map(function (f) { return f.occurrences; }), [2, 1]);
    });
});

suite('ledgerCore — resolution + open set', function () {
    var lc = core();

    test('resolveFindings marks the named identities resolved with the via receipt', function () {
        var l = lc.emptyLedger(1);
        l = lc.appendFinding(l, { id: 'aa', at: '2026-11-01T00:00:00.000Z' }, null);
        l = lc.appendFinding(l, { id: 'bb', at: '2026-11-01T00:00:00.000Z' }, null);
        var done = lc.resolveFindings(l, ['aa'], 'sweep-PR-9');
        assert.equal(done.findings[0].status, 'resolved');
        assert.equal(done.findings[0].resolvedVia, 'sweep-PR-9');
        assert.ok(done.findings[0].resolvedAt);
        assert.equal(done.findings[1].status, 'open', 'unnamed ids stay open');
    });

    test('resolveFindings ignores unknown ids (append-only evidence)', function () {
        var l = lc.appendFinding(lc.emptyLedger(1), { id: 'aa', at: '2026-11-01T00:00:00.000Z' }, null);
        var done = lc.resolveFindings(l, ['zz'], 'ghost');
        assert.equal(done.findings[0].status, 'open');
    });

    test('openFindings filters the open set', function () {
        var l = lc.appendFinding(lc.emptyLedger(1), { id: 'aa', at: '2026-11-01T00:00:00.000Z' }, null);
        l = lc.appendFinding(l, { id: 'bb', at: '2026-11-01T00:00:00.000Z' }, null);
        l = lc.resolveFindings(l, ['bb'], 'x');
        assert.deepEqual(lc.openFindings(l).map(function (f) { return f.id; }), ['aa']);
    });

    test('openFindings tolerates a shapeless ledger', function () {
        assert.deepEqual(lc.openFindings(null), []);
        assert.deepEqual(lc.openFindings({}), []);
    });
});

suite('ledgerCore — the sweep trigger (>= batch OR oldest >= maxAgeDays)', function () {
    var lc = core();
    var BOUNDS = { sweepBatch: 10, sweepMaxAgeDays: 30 };
    var NOW = Date.parse('2026-12-05T00:00:00.000Z');

    function ledgerWith(n, oldestAt) {
        var l = lc.emptyLedger(1);
        for (var i = 0; i < n; i++) {
            l = lc.appendFinding(l, { id: 'f' + i, at: i === 0 ? oldestAt : '2026-12-01T00:00:00.000Z' }, null);
        }
        return l;
    }

    test('below both triggers the sweep is not due', function () {
        var d = lc.sweepDecision(ledgerWith(3, '2026-12-01T00:00:00.000Z'), BOUNDS, NOW);
        assert.equal(d.due, false);
        assert.equal(d.open, 3);
    });

    test('>= sweepBatch open items -> due (the batch trigger)', function () {
        var d = lc.sweepDecision(ledgerWith(10, '2026-12-01T00:00:00.000Z'), BOUNDS, NOW);
        assert.equal(d.due, true);
        assert.contains(d.reason, '10 open');
    });

    test('oldest open item >= sweepMaxAgeDays -> due (the age trigger)', function () {
        var d = lc.sweepDecision(ledgerWith(2, '2026-11-01T00:00:00.000Z'), BOUNDS, NOW);
        assert.equal(d.due, true, '34 days old — past the 30-day bound');
        assert.contains(d.reason, '34');
    });

    test('resolved items do not count toward the batch trigger', function () {
        var l = ledgerWith(12, '2026-12-01T00:00:00.000Z');
        var ids = l.findings.map(function (f) { return f.id; });
        l = lc.resolveFindings(l, ids, 'sweep');
        var d = lc.sweepDecision(l, BOUNDS, NOW);
        assert.equal(d.due, false);
        assert.equal(d.open, 0);
    });

    test('an empty ledger is never due', function () {
        assert.equal(lc.sweepDecision(lc.emptyLedger(1), BOUNDS, NOW).due, false);
    });

    test('custom bounds flow through (batch 2)', function () {
        var d = lc.sweepDecision(ledgerWith(2, '2026-12-01T00:00:00.000Z'), { sweepBatch: 2, sweepMaxAgeDays: 30 }, NOW);
        assert.equal(d.due, true);
    });
});

suite('ledgerCore — stale revalidation (drop with a note)', function () {
    var lc = core();
    var BOUNDS = { sweepMaxAgeDays: 30 };
    var NOW = Date.parse('2026-12-05T00:00:00.000Z');

    test('staleFindings names the open items past the age bound', function () {
        var l = lc.emptyLedger(1);
        l = lc.appendFinding(l, { id: 'old', at: '2026-11-01T00:00:00.000Z' }, null);
        l = lc.appendFinding(l, { id: 'fresh', at: '2026-12-01T00:00:00.000Z' }, null);
        var stale = lc.staleFindings(l, BOUNDS, NOW);
        assert.deepEqual(stale.map(function (f) { return f.id; }), ['old']);
    });

    test('dropFindings resolves the stale set with the drop receipt + note', function () {
        var l = lc.emptyLedger(1);
        l = lc.appendFinding(l, { id: 'old', at: '2026-11-01T00:00:00.000Z' }, null);
        var dropped = lc.dropFindings(l, ['old'], 'sweep: re-validated against current code', 'the guarded behavior moved');
        assert.equal(dropped.findings[0].status, 'resolved');
        assert.equal(dropped.findings[0].resolvedVia, 'sweep: re-validated against current code');
        assert.equal(dropped.findings[0].dropNote, 'the guarded behavior moved');
    });

    test('a dropped finding that re-occurrences still reopens (evidence never dies)', function () {
        var l = lc.emptyLedger(1);
        l = lc.appendFinding(l, { id: 'old', at: '2026-11-01T00:00:00.000Z' }, null);
        var dropped = lc.dropFindings(l, ['old'], 'sweep', 'stale');
        var again = lc.appendFinding(dropped, { id: 'old', at: '2026-12-02T00:00:00.000Z' }, null);
        assert.equal(again.findings[0].status, 'open');
    });

    test('truncate caps marker-hostile free text', function () {
        assert.equal(lc.truncate('abcdef', 4), 'abcd');
        assert.equal(lc.truncate('ab', 4), 'ab');
        assert.equal(lc.truncate(null, 4), '');
    });

    test('firstDefined walks the source list in priority order', function () {
        assert.equal(lc.firstDefined({ a: '', b: 'x' }, ['a', 'b']), 'x');
        assert.equal(lc.firstDefined({ a: null, b: undefined }, ['a', 'b']), null);
    });
});
