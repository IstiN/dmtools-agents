/**
 * Unit tests: js/common/reviewVerdicts.js — machine-parseable review-verdict
 * records and their reconciliation (gh-807).
 *
 * Live forensics being replayed (L2 in the ticket's test plan): fa PR
 * #1428, 2026-10-09 — two review legs posted APPROVE (05:47:30Z) and
 * REQUEST_CHANGES (05:47:40Z) verdicts 97 seconds apart on the SAME head;
 * pr_approved + agent:rework ended up coexisting and nothing reconciled.
 *
 * Coverage:
 *   - the structured marker (AC4): round-trip, unbuildable records, and the
 *     hard rule that free-form verdict tokens in comments are INVISIBLE —
 *     no head-matching by comment text;
 *   - newest-wins per head with the exact AC1 conflict WARN;
 *   - the AC2 reconciliation decision (loser label, both carriers, comment
 *     citing both verdict sources);
 *   - the AC3 arming-side sticky-approval gate (APPROVE ⇒ no arm unless
 *     BLOCKING threads; fail-open without records).
 *
 * Uses: test(), suite(), assert — pure module, no dmtools globals.
 */
/* global suite, test, assert, loadModule, makeRequire */

suite('reviewVerdicts — marker protocol (gh-807 AC4)', function () {
    var rv = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});

    test('buildVerdictComment embeds the JSON payload in the structured marker', function () {
        var body = rv.buildVerdictComment({
            head: 'aaaabbbbccccddddeeeeffff0000111122223333',
            verdict: 'APPROVE',
            blocking: 0, important: 1, suggestions: 2,
            at: '2026-10-09T05:47:30.000Z',
            source: 'pr_review.json'
        });
        assert.ok(body.indexOf('<!-- dmtools:review-verdict ') === 0, 'marker prefix opens the comment');
        assert.ok(body.indexOf(' -->') !== -1, 'marker suffix closes the payload');
        assert.contains(body, '"head":"aaaabbbbccccddddeeeeffff0000111122223333"');
        assert.contains(body, '"verdict":"APPROVE"');
        assert.contains(body, '"blocking":0');
        assert.contains(body, '"at":"2026-10-09T05:47:30.000Z"');
        assert.contains(body, '"source":"pr_review.json"');
    });

    test('buildVerdictComment normalizes the verdict and rejects unpostable records', function () {
        assert.equal(
            rv.extractVerdictRecord(rv.buildVerdictComment({ head: 'abc', verdict: 'approve' })).verdict,
            'APPROVE', 'lowercase verdict normalizes to APPROVE');
        assert.notOk(rv.buildVerdictComment({ verdict: 'APPROVE' }),
            'no head → no record (a verdict without a head is the gh-807 pathology)');
        assert.notOk(rv.buildVerdictComment({ head: 'abc' }),
            'no verdict → no record');
        assert.notOk(rv.buildVerdictComment({ head: 'abc', verdict: 'LGTM' }),
            'verdict outside the protocol → no record');
    });

    test('parseVerdictRecords reads ONLY the marker — free-form verdict text is invisible (AC4)', function () {
        var comments = [
            { body: 'LGTM, approve this PR — REQUEST_CHANGES withdrawn, human says APPROVE!' },
            { body: '🤖 AI review returned REQUEST_CHANGES. See PR comments for details.' },
            { body: rv.MARKER_PREFIX + '{"head":"h1","verdict":"APPROVE","blocking":0,"important":0,"suggestions":1,"at":"2026-10-09T05:47:30.000Z","source":"pr_review.json"}' + rv.MARKER_SUFFIX }
        ];
        var records = rv.parseVerdictRecords(comments);
        assert.equal(records.length, 1, 'exactly the marker comment parses');
        assert.equal(records[0].verdict, 'APPROVE');
        assert.equal(records[0].head, 'h1');
        assert.equal(records[0].suggestions, 1, 'thread census rides the record');
    });

    test('parseVerdictRecords orders by the embedded timestamp, payload order breaks ties', function () {
        var records = rv.parseVerdictRecords([
            { body: rv.MARKER_PREFIX + '{"head":"h","verdict":"REQUEST_CHANGES","at":"2026-10-09T05:47:40.000Z","source":"x"}' + rv.MARKER_SUFFIX },
            { body: rv.MARKER_PREFIX + '{"head":"h","verdict":"APPROVE","at":"2026-10-09T05:47:30.000Z","source":"x"}' + rv.MARKER_SUFFIX },
            { body: rv.MARKER_PREFIX + '{"head":"h","verdict":"BLOCK","at":"","source":"x"}' + rv.MARKER_SUFFIX }
        ]);
        assert.deepEqual(
            records.map(function (r) { return r.verdict; }),
            ['BLOCK', 'APPROVE', 'REQUEST_CHANGES'],
            'no timestamp sinks first, then 05:47:30, then 05:47:40');
    });

    test('malformed markers (broken JSON, missing fields, bad verdict) never parse', function () {
        assert.notOk(rv.extractVerdictRecord('<!-- dmtools:review-verdict {not json} -->'));
        assert.notOk(rv.extractVerdictRecord('<!-- dmtools:review-verdict {"head":"h"} -->'));
        assert.notOk(rv.extractVerdictRecord('<!-- dmtools:review-verdict {"verdict":"APPROVE"} -->'));
        assert.notOk(rv.extractVerdictRecord('<!-- dmtools:review-verdict {"head":"h","verdict":"MAYBE"} -->'));
        assert.notOk(rv.extractVerdictRecord('<!-- dmtools:review-verdict {"head":"h","verdict":"APPROVE"}'));
    });
});

suite('reviewVerdicts — newest wins per head (gh-807 AC1)', function () {
    var rv = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});

    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function marker(head, verdict, at, census) {
        var payload = { head: head, verdict: verdict, at: at, source: 'pr_review.json' };
        if (census) {
            payload.blocking = census.blocking || 0;
            payload.important = census.important || 0;
            payload.suggestions = census.suggestions || 0;
        }
        return { body: rv.MARKER_PREFIX + JSON.stringify(payload) + rv.MARKER_SUFFIX };
    }

    test('the #1428 replay: APPROVE + REQUEST_CHANGES 97s apart on one head → newest wins, conflict reported', function () {
        var records = rv.parseVerdictRecords([
            marker(HEAD, 'APPROVE', '2026-10-09T05:47:30.000Z'),
            marker(HEAD, 'REQUEST_CHANGES', '2026-10-09T05:47:40.000Z')
        ]);
        var effective = rv.latestVerdictForHead(records, HEAD);
        assert.ok(effective, 'a verdict resolves');
        assert.equal(effective.record.verdict, 'REQUEST_CHANGES', 'the 05:47:40 leg wins');
        assert.equal(effective.record.at, '2026-10-09T05:47:40.000Z');
        assert.ok(effective.conflict, 'the contradiction is surfaced');
        assert.equal(effective.conflict.older.verdict, 'APPROVE');
        assert.equal(effective.conflict.newer.verdict, 'REQUEST_CHANGES');
    });

    test('the AC1 WARN names the head, both verdicts and newest-wins', function () {
        var logs = [];
        var fakeConsole = { log: function () {}, warn: function () { logs.push(Array.prototype.map.call(arguments, String).join(' ')); }, error: function () {} };
        var rvC = loadModule('js/common/reviewVerdicts.js', makeRequire({}), { console: fakeConsole });
        var records = rvC.parseVerdictRecords([
            marker(HEAD, 'APPROVE', '2026-10-09T05:47:30.000Z'),
            marker(HEAD, 'REQUEST_CHANGES', '2026-10-09T05:47:40.000Z')
        ]);
        rvC.latestVerdictForHead(records, HEAD);
        assert.equal(logs.length, 1, 'one WARN per resolution');
        assert.equal(logs[0],
            '⚠️ verdict conflict on ' + HEAD + ': APPROVE vs REQUEST_CHANGES — newest wins');
    });

    test('same verdict twice on one head is NOT a conflict (idempotent re-legs)', function () {
        var records = rv.parseVerdictRecords([
            marker(HEAD, 'APPROVE', '2026-10-09T05:47:30.000Z'),
            marker(HEAD, 'APPROVE', '2026-10-09T05:47:40.000Z')
        ]);
        var effective = rv.latestVerdictForHead(records, HEAD);
        assert.equal(effective.record.verdict, 'APPROVE');
        assert.notOk(effective.conflict, 'no contradiction → no conflict');
    });

    test('records for OTHER heads never bleed in; short/full sha forms match', function () {
        var OTHER = 'ffffffffeeeeeeeeddddddddcccccccc77777777';
        var records = rv.parseVerdictRecords([
            marker(OTHER, 'REQUEST_CHANGES', '2026-10-09T05:00:00.000Z'),
            marker(HEAD, 'APPROVE', '2026-10-09T05:47:30.000Z'),
            marker('bbbb0011', 'BLOCK', '2026-10-08T00:00:00.000Z')
        ]);
        var effective = rv.latestVerdictForHead(records, HEAD);
        assert.equal(effective.record.verdict, 'APPROVE', 'only this head\u2019s records count');
        assert.notOk(effective.conflict, 'the other head\u2019s REQUEST_CHANGES never bleeds in');
        // a record that pinned only the head's short sha still resolves
        assert.equal(rv.latestVerdictForHead(records, 'aaaabbbbccccdd').record.verdict, 'APPROVE');
    });

    test('no records for the head → null (the fail-open shape); no head → null', function () {
        var records = rv.parseVerdictRecords([marker('other', 'APPROVE', '2026-10-09T05:47:30.000Z')]);
        assert.equal(rv.latestVerdictForHead(records, HEAD), null);
        assert.equal(rv.latestVerdictForHead(records, null), null);
        assert.equal(rv.latestVerdictForHead([], HEAD), null);
    });
});

suite('reviewVerdicts — label reconciliation (gh-807 AC2)', function () {
    var rv = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});
    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function rec(verdict, at) {
        return { head: HEAD, verdict: verdict, blocking: 0, important: 0, suggestions: 0, at: at, source: 'pr_review.json' };
    }

    test('winner REQUEST_CHANGES → pr_approved is the loser', function () {
        assert.equal(rv.resolveLoserLabel('REQUEST_CHANGES'), 'pr_approved');
        assert.equal(rv.resolveLoserLabel('BLOCK'), 'pr_approved');
    });

    test('winner APPROVE → agent:rework is the loser', function () {
        assert.equal(rv.resolveLoserLabel('APPROVE'), 'agent:rework');
    });

    test('#1428 end state reconciles: newest REQUEST_CHANGES removes pr_approved from the PR', function () {
        var records = [rec('APPROVE', '2026-10-09T05:47:30.000Z'), rec('REQUEST_CHANGES', '2026-10-09T05:47:40.000Z')];
        var decision = rv.reconcileDecision(records, HEAD, {
            prHasApproved: true, prHasRework: false, issueHasRework: true
        });
        assert.ok(decision, 'a reconciliation is due');
        assert.equal(decision.loserLabel, 'pr_approved');
        assert.equal(decision.removeFromPr, true);
        assert.equal(decision.removeFromIssue, false, 'pr_approved never lives on the issue here');
        assert.contains(decision.comment, 'APPROVE at 2026-10-09T05:47:30.000Z (source: pr_review.json)',
            'the comment cites BOTH verdict sources');
        assert.contains(decision.comment, 'REQUEST_CHANGES at 2026-10-09T05:47:40.000Z (source: pr_review.json)');
        assert.contains(decision.comment, 'Newest wins: **REQUEST_CHANGES**');
        assert.contains(decision.comment, 'pr_approved');
    });

    test('APPROVE winner removes agent:rework from BOTH carriers', function () {
        var records = [rec('REQUEST_CHANGES', '2026-10-09T05:47:30.000Z'), rec('APPROVE', '2026-10-09T05:47:40.000Z')];
        var decision = rv.reconcileDecision(records, HEAD, {
            prHasApproved: true, prHasRework: true, issueHasRework: true
        });
        assert.equal(decision.loserLabel, 'agent:rework');
        assert.equal(decision.removeFromPr, true);
        assert.equal(decision.removeFromIssue, true);
        assert.contains(decision.comment, 'Newest wins: **APPROVE**');
        assert.contains(decision.comment, 'agent:rework');
        assert.contains(decision.comment, 'suggestions do not justify a rework arm');
    });

    test('consistent state → null (converged, the tick moves on)', function () {
        var records = [rec('APPROVE', '2026-10-09T05:47:40.000Z')];
        assert.equal(rv.reconcileDecision(records, HEAD,
            { prHasApproved: true, prHasRework: false, issueHasRework: false }), null,
            'approval stands, no rework label anywhere → nothing to do');
        var conflicting = [rec('APPROVE', '2026-10-09T05:47:30.000Z'), rec('REQUEST_CHANGES', '2026-10-09T05:47:40.000Z')];
        assert.equal(rv.reconcileDecision(conflicting, HEAD,
            { prHasApproved: false, prHasRework: false, issueHasRework: false }), null,
            'loser label nowhere present → nothing to do');
        assert.equal(rv.reconcileDecision([], HEAD, { prHasApproved: true }), null,
            'no records → fail open, no reconciliation');
    });
});

suite('reviewVerdicts — arming-side sticky approval (gh-807 AC3)', function () {
    var rv = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});
    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function rec(verdict, blocking) {
        return { head: HEAD, verdict: verdict, blocking: blocking || 0, important: 0, suggestions: 0,
                 at: '2026-10-09T05:47:40.000Z', source: 'pr_review.json' };
    }

    test('APPROVE with zero BLOCKING findings withholds the arm — suggestions never trigger rework', function () {
        var decision = rv.armReworkDecision([rec('APPROVE', 0)], HEAD);
        assert.equal(decision.arm, false);
        assert.equal(decision.reason, 'approve-verdict');
        // the gh-710 live shape: APPROVE with 5 new suggestion-tier threads
        var suggestionsOnly = rv.armReworkDecision(
            [{ head: HEAD, verdict: 'APPROVE', blocking: 0, important: 0, suggestions: 5,
               at: '2026-10-09T05:47:40.000Z', source: 'pr_review.json' }], HEAD);
        assert.equal(suggestionsOnly.arm, false, '5 suggestions + important 0 → still no arm');
    });

    test('APPROVE with BLOCKING threads still arms (the blocking-thread exception)', function () {
        var decision = rv.armReworkDecision([rec('APPROVE', 2)], HEAD);
        assert.equal(decision.arm, true);
        assert.equal(decision.reason, 'blocking-threads');
    });

    test('REQUEST_CHANGES / BLOCK effective verdicts arm', function () {
        assert.equal(rv.armReworkDecision([rec('REQUEST_CHANGES', 0)], HEAD).arm, true);
        assert.equal(rv.armReworkDecision([rec('BLOCK', 0)], HEAD).arm, true);
    });

    test('fail-open: no records for the head arms as before (pre-gh-807 PRs)', function () {
        var decision = rv.armReworkDecision([], HEAD);
        assert.equal(decision.arm, true);
        assert.equal(decision.reason, 'no-verdict-records');
        assert.equal(rv.armReworkDecision([rec('APPROVE', 0)], 'otherhead').arm, true);
    });

    test('newest leg decides the gate on a conflicting head', function () {
        var older = { head: HEAD, verdict: 'REQUEST_CHANGES', blocking: 1, important: 0, suggestions: 0,
                      at: '2026-10-09T05:47:30.000Z', source: 'pr_review.json' };
        var newer = { head: HEAD, verdict: 'APPROVE', blocking: 0, important: 0, suggestions: 3,
                      at: '2026-10-09T05:47:40.000Z', source: 'pr_review.json' };
        assert.equal(rv.armReworkDecision([older, newer], HEAD).arm, false,
            'APPROVE arrived second → the arm is withheld despite the older REQUEST_CHANGES');
        assert.equal(rv.armReworkDecision([newer, older], HEAD).arm, true,
            'REQUEST_CHANGES arrived second → the arm fires');
    });
});
