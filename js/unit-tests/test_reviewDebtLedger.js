/**
 * Unit tests: js/common/reviewDebtLedger.js — the review-side debt ledger
 * (gh-1352 scope 4, the second ledger consumer).
 *
 * Triage-deferred review findings (`deferred: #ledger` — scope 2's tag)
 * become finding-level ledger entries keyed by the #1332 finding identity
 * (hash(file + normalized claim + severity class)); the shared ledger core
 * (ledgerCore.js) owns the lifecycle and the batched-sweep trigger
 * (>=10 open items or oldest >=30 days -> ONE batched test/comment-fix PR;
 * stale items are re-validated and dropped with a note).
 */
/* global suite, test, assert, loadModule, makeRequire */

function mod() {
    var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({
        './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}))
    }));
    var findingRegistry = loadModule('js/common/findingRegistry.js', makeRequire({
        './reviewVerdicts.js': reviewVerdicts
    }));
    return loadModule('js/common/reviewDebtLedger.js', makeRequire({
        './reviewVerdicts.js': reviewVerdicts,
        './findingRegistry.js': findingRegistry,
        './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({}))
    }), {});
}

function machineComment(payload) {
    return { body: payload, user: { login: 'ai-teammate' } };
}

var ALLOW = { authorLogins: ['ai-teammate'] };

function marker(l) {
    return mod().buildDebtMarker(l);
}

function ledgerWithThread(thread, over) {
    var m = mod();
    var l = m.appendDebtFinding(m.emptyLedger(), thread);
    return over ? m.appendDebtFinding(l, over) : l;
}

function thread(over) {
    var t = { threadId: 9001, path: 'js/common/mergeState.js', claim: 'nothing validates the merge state token',
              severityClass: 'SUGGESTION', tier: 'NIT', threadUrl: 'https://x/pull/9#discussion_r9001' };
    for (var k in (over || {})) t[k] = over[k];
    return t;
}

suite('reviewDebtLedger — findings keyed by the #1332 identity', function () {
    test('a deferred thread appends with the findingRegistry identity + evidence', function () {
        var l = ledgerWithThread(thread());
        assert.equal(l.findings.length, 1);
        var f = l.findings[0];
        assert.equal(f.status, 'open');
        assert.ok(f.id, 'the identity is stamped');
        assert.equal(f.id, mod().debtIdentity(f.file, f.claim, f.severityClass));
        assert.equal(f.tier, 'NIT');
        assert.equal(f.originThread, 9001);
        assert.ok(f.deferredAt, 'the deferral is timestamped');
    });

    test('the same identity refreshes (occurrences++) instead of duplicating', function () {
        var l = ledgerWithThread(thread(), thread({ threadId: 9002 }));
        assert.equal(l.findings.length, 1);
        assert.equal(l.findings[0].occurrences, 2);
        assert.equal(l.findings[0].originThread, 9002, 'the latest pointer wins');
    });

    test('a re-occurrence REOPENS a resolved (swept) finding', function () {
        var m = mod();
        var l = ledgerWithThread(thread());
        l = m.resolveDebtFindings(l, [l.findings[0].id], 'sweep-PR-12');
        assert.equal(l.findings[0].status, 'resolved');
        var again = m.appendDebtFinding(l, thread({ threadId: 9003 }));
        assert.equal(again.findings[0].status, 'open');
        assert.equal(again.findings[0].occurrences, 2);
    });

    test('different files/claims stay distinct (2+ entries)', function () {
        var l = ledgerWithThread(thread(), thread({ path: 'js/smAgent.js', claim: 'labels race the arm' }));
        assert.equal(l.findings.length, 2);
    });

    test('free text is truncated (marker hygiene) and the ledger round-trips the marker', function () {
        var m = mod();
        var t = thread({ claim: 'x' });
        for (var i = 0; i < 300; i++) t.claim += ' y';
        var l = m.appendDebtFinding(m.emptyLedger(), t);
        var parsed = m.parseDebtComments([machineComment(marker(l))], ALLOW);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].ledger.findings[0].claim.length, 500);
    });

    test('no machine identity trusts nothing (fail closed)', function () {
        var l = ledgerWithThread(thread());
        assert.deepEqual(mod().parseDebtComments([machineComment(marker(l))], {}), []);
    });

    test('untrusted authors are invisible', function () {
        var l = ledgerWithThread(thread());
        assert.deepEqual(mod().parseDebtComments(
            [{ body: marker(l), user: { login: 'rand-o' } }], ALLOW), []);
    });
});

suite('reviewDebtLedger — the batched sweep trigger (>=10 open or oldest >=30d)', function () {
    test('under both bounds the sweep is not due', function () {
        var d = mod().sweepDue(ledgerWithThread(thread()));
        assert.equal(d.due, false);
        assert.equal(d.open, 1);
    });

    test('10 open deferred findings trigger the batch sweep', function () {
        var m = mod();
        var l = m.emptyLedger();
        for (var i = 0; i < 10; i++) {
            l = m.appendDebtFinding(l, thread({ threadId: 9100 + i, claim: 'claim ' + i }));
        }
        var d = m.sweepDue(l);
        assert.equal(d.due, true);
        assert.equal(d.open, 10);
        assert.contains(d.reason, '10 open');
    });

    test('resolved items do not feed the trigger', function () {
        var m = mod();
        var l = m.emptyLedger();
        var ids = [];
        for (var i = 0; i < 12; i++) {
            l = m.appendDebtFinding(l, thread({ threadId: 9100 + i, claim: 'claim ' + i }));
            ids.push(l.findings[i].id);
        }
        l = m.resolveDebtFindings(l, ids, 'sweep-PR-12');
        assert.equal(m.sweepDue(l).due, false);
    });

    test('a 30-day-old open item triggers the sweep on its own', function () {
        var m = mod();
        var l = m.appendDebtFinding(m.emptyLedger(), thread({ at: '2026-10-01T00:00:00.000Z' }));
        var d = m.sweepDue(l, '2026-11-05T00:00:00.000Z');
        assert.equal(d.due, true);
        assert.equal(d.oldestAgeDays, 35);
    });

    test('staleFindings names the re-validation candidates past the age bound', function () {
        var m = mod();
        var l = m.appendDebtFinding(m.emptyLedger(), thread({ at: '2026-10-01T00:00:00.000Z', claim: 'stale one' }));
        l = m.appendDebtFinding(l, thread({ path: 'js/smAgent.js', claim: 'fresh one', at: '2026-11-04T00:00:00.000Z' }));
        var stale = m.staleDebtFindings(l, '2026-11-05T00:00:00.000Z');
        assert.equal(stale.length, 1);
        assert.contains(stale[0].claim, 'stale one');
    });

    test('dropDebtFindings resolves stale items WITH the re-validation note', function () {
        var m = mod();
        var l = ledgerWithThread(thread());
        var dropped = m.dropDebtFindings(l, [l.findings[0].id], 'sweep: re-validated against HEAD',
            'the guarded path moved to reviewPolicy.js');
        assert.equal(dropped.findings[0].status, 'resolved');
        assert.equal(dropped.findings[0].resolvedVia, 'sweep: re-validated against HEAD');
        assert.contains(dropped.findings[0].dropNote, 'reviewPolicy.js');
    });

    test('resolveDebtFindings ignores unknown ids (append-only evidence)', function () {
        var l = ledgerWithThread(thread());
        var done = mod().resolveDebtFindings(l, ['zz'], 'ghost');
        assert.equal(done.findings[0].status, 'open');
    });
});

suite('reviewDebtLedger — the async owner digest', function () {
    test('empty ledger -> the explicit clear line', function () {
        assert.contains(mod().buildDebtDigest(mod().emptyLedger()), 'no deferred review findings');
    });

    test('one section per open finding, count + age + the sweep promise; never a blocking ask', function () {
        var m = mod();
        var l = m.appendDebtFinding(m.emptyLedger(), thread({ at: '2026-10-01T00:00:00.000Z' }));
        l = m.appendDebtFinding(l, thread({ path: 'js/smAgent.js', claim: 'labels race the arm', tier: 'SUGGESTION' }));
        var d = m.buildDebtDigest(l, '2026-11-05T00:00:00.000Z');
        assert.contains(d, '2 deferred review findings');
        assert.contains(d, 'mergeState.js');
        assert.contains(d, 'smAgent.js');
        assert.contains(d, '35d');
        assert.contains(d, 'batched');
        assert.contains(d, 'No action is required');
    });
});
