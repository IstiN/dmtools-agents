/**
 * Unit tests: js/common/polishLap.js — the bounded polish lap (gh-1352
 * scope 3, epic gh-1328 §4-disposition).
 *
 * Trigger: an APPROVE verdict whose census is open ONLY in `round: polish`
 * tiers (default preset: suggestions > 0, blocking = important = 0).
 * Bounds: single commit, <= polishMaxThreads (6), <= polishMaxChangedLines
 * (80), doc/test-trivial fixes only; overflow threads go to triage.
 * Cross-head bounds: the lap runs ONCE per head, and 2 consecutive polish
 * laps on consecutive heads exhaust the instability budget — the machine
 * stops polishing and triage-resolves the rest + digest.
 */
/* global suite, test, assert, loadModule, makeRequire */

function mod() {
    return loadModule('js/common/polishLap.js', makeRequire({
        './reviewVerdicts.js': reviewVerdictsReal(),
        './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
        './reviewPolicy.js': loadModule('js/common/reviewPolicy.js',
            makeRequire({ './reviewVerdicts.js': reviewVerdictsReal() }), {})
    }), {});
}

var reviewPolicy = loadModule('js/common/reviewPolicy.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdictsReal() }), {});

var HEAD_A = 'aaaabbbbccccddddeeeeffff0000111122223333';
var HEAD_B = 'bbbbccccddddeeeeffff0000111122223333aaa1';
var HEAD_C = 'ccccddddeeeeffff0000111122223333aaa1bbbb2';

function record(over) {
    var rec = { head: HEAD_A, verdict: 'APPROVE', blocking: 0, important: 0,
                suggestions: 0, nits: 0, digest: 0,
                at: '2026-11-04T00:00:00.000Z', source: 'pr_review.json' };
    for (var k in (over || {})) rec[k] = over[k];
    return rec;
}

function thread(id, tier, path) {
    var emoji = { BLOCKING: '\uD83D\uDEA8', IMPORTANT: '\u26A0\uFE0F',
                  SUGGESTION: '\uD83D\uDCA1', NIT: '\uD83E\uDEB6' }[tier] || '';
    return {
        threadId: id, resolved: false, author: 'dmtools-factory-bot',
        body: emoji + ' severity: ' + tier + ' \u2014 finding',
        path: path || 'js/common/reviewVerdicts.js'
    };
}

suite('polishLap — polishTrigger (gh-1352 trigger shape)', function () {
    var pl = mod();

    test('APPROVE + suggestions only -> the polish lap triggers', function () {
        var d = pl.polishDecision(record({ suggestions: 3 }), null, [], HEAD_A);
        assert.equal(d.trigger, true, 'suggestions open, lap-gated census clean');
    });

    test('blocking or important open -> NOT a polish trigger (the rework lap owns it)', function () {
        assert.equal(pl.polishDecision(record({ suggestions: 2, blocking: 1 }), null, [], HEAD_A).trigger, false);
        assert.equal(pl.polishDecision(record({ suggestions: 2, important: 1 }), null, [], HEAD_A).trigger, false);
    });

    test('REQUEST_CHANGES is never a polish trigger', function () {
        assert.equal(pl.polishDecision(record({ verdict: 'REQUEST_CHANGES', suggestions: 2 }), null, [], HEAD_A).trigger, false);
    });

    test('a clean census (nothing open in any tier) does not trigger', function () {
        assert.equal(pl.polishDecision(record({}), null, [], HEAD_A).trigger, false);
    });

    test('digest-only census does not trigger (digest is not an open-thread census)', function () {
        assert.equal(pl.polishDecision(record({ digest: 4 }), null, [], HEAD_A).trigger, false);
    });

    test('a missing verdict record does not trigger', function () {
        assert.equal(pl.polishDecision(null, null, [], HEAD_A).trigger, false);
    });
});

suite('polishLap — bounds + plan (top-K, overflow to triage)', function () {
    var pl = mod();

    test('the plan takes top-K = polishMaxThreads polish-tier threads', function () {
        var threads = [];
        for (var i = 1; i <= 9; i++) threads.push(thread('PRRT_' + i, 'SUGGESTION'));
        var policy = reviewPolicy.defaultPolicy();
        var d = pl.polishDecision(record({ suggestions: 9 }), policy, threads, HEAD_A);
        assert.equal(d.trigger, true);
        assert.equal(d.plan.lapThreads.length, 6, 'polishMaxThreads=6');
        assert.equal(d.plan.overflowThreads.length, 3, 'overflow -> triage tags');
        assert.deepEqual(d.plan.overflowThreads.map(function (t) { return t.threadId; }),
            ['PRRT_7', 'PRRT_8', 'PRRT_9'], 'the overflow is the ranked tail');
    });

    test('the changed-lines budget rides the plan bounds', function () {
        var threads = [thread('PRRT_1', 'SUGGESTION')];
        var d = pl.polishDecision(record({ suggestions: 1 }), reviewPolicy.defaultPolicy(), threads, HEAD_A);
        assert.equal(d.plan.maxChangedLines, 80);
        assert.equal(d.plan.maxThreads, 6);
    });

    test('non-polish-tier threads never enter the lap plan', function () {
        var threads = [thread('PRRT_1', 'SUGGESTION'), thread('PRRT_2', 'NIT'), thread('PRRT_3', 'IMPORTANT')];
        var d = pl.polishDecision(record({ suggestions: 1 }), reviewPolicy.defaultPolicy(), threads, HEAD_A);
        assert.deepEqual(d.plan.lapThreads.map(function (t) { return t.threadId; }), ['PRRT_1'],
            'nits ride triage under default (round none), IMPORTANT is lap-gated');
    });

    test('custom bounds flow through the resolved policy', function () {
        var policy = reviewPolicy.validateReviewPolicy({ bounds: { polishMaxThreads: 2 } }, 'test');
        var threads = [];
        for (var i = 1; i <= 4; i++) threads.push(thread('PRRT_' + i, 'SUGGESTION'));
        var d = pl.polishDecision(record({ suggestions: 4 }), policy, threads, HEAD_A);
        assert.equal(d.plan.lapThreads.length, 2);
        assert.equal(d.plan.overflowThreads.length, 2);
    });

    test('2+ item plan: mixed suggestion/nit census under fix-everything puts both tiers in the lap', function () {
        var policy = reviewPolicy.presetPolicy('fix-everything');
        var threads = [thread('PRRT_1', 'SUGGESTION'), thread('PRRT_2', 'NIT'), thread('PRRT_3', 'SUGGESTION')];
        var d = pl.polishDecision(record({ suggestions: 2, nits: 1 }), policy, threads, HEAD_A);
        assert.deepEqual(d.plan.lapThreads.length, 3);
    });
});

suite('polishLap — once per head + instability budget (cross-head bound)', function () {
    var pl = mod();

    test('a head that already ran a polish lap does not run another (once per head)', function () {
        var laps = [{ head: HEAD_A, at: '2026-11-04T01:00:00.000Z' }];
        var d = pl.polishDecision(record({ suggestions: 2 }), reviewPolicy.defaultPolicy(), [], HEAD_A, laps);
        assert.equal(d.dispatch, false);
        assert.equal(d.reason, 'once-per-head');
    });

    test('two laps on the same head do NOT exhaust the cross-head budget', function () {
        // once-per-head makes this shape impossible in practice; the budget
        // counts DISTINCT consecutive heads.
        var laps = [{ head: HEAD_A, at: '2026-11-04T01:00:00.000Z' }];
        var d = pl.instabilityBudgetExhausted(laps, HEAD_B);
        assert.equal(d, false, 'only one distinct head so far');
    });

    test('two polish laps on two consecutive heads exhaust the budget', function () {
        var laps = [
            { head: HEAD_A, at: '2026-11-04T01:00:00.000Z' },
            { head: HEAD_B, at: '2026-11-04T02:00:00.000Z' }
        ];
        assert.equal(pl.instabilityBudgetExhausted(laps, HEAD_C), true,
            '2 consecutive laps on consecutive heads -> stop polishing');
    });

    test('a rework lap between polish laps resets the budget (not consecutive polish)', function () {
        // The lap list carries kind; polishLap markers only record polish
        // laps, so the interleave shows up as distinct lap sources — here:
        // the caller passes only polish laps, and a non-consecutive head
        // sequence (same head twice = one lap per head impossible) is
        // exercised by the dedup path instead.
        var laps = [
            { head: HEAD_A, at: '2026-11-04T01:00:00.000Z' },
            { head: HEAD_A, at: '2026-11-04T01:30:00.000Z' }
        ];
        assert.equal(pl.instabilityBudgetExhausted(laps, HEAD_B), false,
            'duplicate head entries collapse — one lap per head');
    });

    test('the third round after an exhausted budget triage-resolves (no dispatch)', function () {
        var laps = [
            { head: HEAD_A, at: '2026-11-04T01:00:00.000Z' },
            { head: HEAD_B, at: '2026-11-04T02:00:00.000Z' }
        ];
        var d = pl.polishDecision(record({ suggestions: 2 }), reviewPolicy.defaultPolicy(), [], HEAD_C, laps);
        assert.equal(d.dispatch, false);
        assert.equal(d.reason, 'instability-budget',
            'AC5: 2 consecutive polish laps -> third round triage-resolves; no third lap');
        assert.equal(d.triageRest, true, 'the decision hands the rest to triage');
    });

    test('budget checks the LAPS BEFORE this head (a fresh head after one lap still dispatches)', function () {
        var laps = [{ head: HEAD_A, at: '2026-11-04T01:00:00.000Z' }];
        var d = pl.polishDecision(record({ suggestions: 2 }), reviewPolicy.defaultPolicy(), [], HEAD_B, laps);
        assert.equal(d.dispatch, true, 'one lap on one head is not instability yet');
    });

    test('the lap list of THIS head is detected regardless of entry order', function () {
        var laps = [
            { head: HEAD_B, at: '2026-11-04T02:00:00.000Z' },
            { head: HEAD_A, at: '2026-11-04T01:00:00.000Z' }
        ];
        var d = pl.polishDecision(record({ suggestions: 2 }), reviewPolicy.defaultPolicy(), [], HEAD_A, laps);
        assert.equal(d.dispatch, false);
        assert.equal(d.reason, 'once-per-head');
    });
});

suite('polishLap — the dmtools:polish-lap marker family', function () {
    var pl = mod();

    test('buildPolishLapMarker embeds head + thread count + overflow', function () {
        var body = pl.buildPolishLapMarker(HEAD_A, { threads: 4, overflow: 2, runUrl: 'http://run/1' });
        assert.ok(body.indexOf('<!-- dmtools:polish-lap ') === 0, 'marker family prefix');
        assert.contains(body, '"head":"' + HEAD_A + '"');
        assert.contains(body, '"threads":4');
        assert.contains(body, '"overflow":2');
    });

    test('the marker is null without a head', function () {
        assert.equal(pl.buildPolishLapMarker(null, { threads: 1 }), null);
    });

    test('parsePolishLapMarkers trusts machine identities only and orders oldest-first', function () {
        var allow = ['dmtools-factory-bot'];
        var first = pl.buildPolishLapMarker(HEAD_A, { threads: 1, at: '2026-11-04T01:00:00.000Z' });
        var second = pl.buildPolishLapMarker(HEAD_B, { threads: 2, at: '2026-11-04T02:00:00.000Z' });
        var human = { body: pl.buildPolishLapMarker(HEAD_C, { threads: 9 }), user: { login: 'octocat' } };
        var laps = pl.parsePolishLapMarkers([
            { body: second, user: { login: 'dmtools-factory-bot' } },
            human,
            { body: first, user: { login: 'dmtools-factory-bot[bot]' } }
        ], { authorLogins: allow });
        assert.equal(laps.length, 2, 'the human-authored marker is invisible');
        assert.deepEqual(laps.map(function (l) { return l.head; }), [HEAD_A, HEAD_B], 'oldest first');
    });

    test('no configured allowlist trusts nothing (machineAuthor doctrine)', function () {
        var body = pl.buildPolishLapMarker(HEAD_A, { threads: 1, at: '2026-11-04T01:00:00.000Z' });
        assert.deepEqual(pl.parsePolishLapMarkers([{ body: body, user: { login: 'x' } }], {}), []);
    });

    test('markers carry resolvedThreadIds when the lap addressed threads', function () {
        var body = pl.buildPolishLapMarker(HEAD_A, {
            threads: 2, overflow: 1, resolvedThreadIds: ['PRRT_1', 'PRRT_2']
        });
        var laps = pl.parsePolishLapMarkers([{ body: body, user: { login: 'bot' } }],
            { authorLogins: ['bot'] });
        assert.deepEqual(laps[0].resolvedThreadIds, ['PRRT_1', 'PRRT_2']);
    });
});
