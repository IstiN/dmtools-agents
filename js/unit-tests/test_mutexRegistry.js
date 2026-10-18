'use strict';

/**
 * Unit tests for js/common/mutexRegistry.js — gh-1000 phantom-mutex
 * reconciliation + cancelled-run conclusion mapping.
 *
 * Pure module: no tool globals, loadModule with an empty require map.
 * Covers the ticket test plan UT-1..UT-2: AC1, AC2, AC3 + I1, I2, I3
 * (I4 authorship-blindness is a property of the smAgent dispatch site,
 * asserted here at the mapping level).
 */

var assert = globalThis.assert;

var registry = loadModule('js/common/mutexRegistry.js', makeRequire({}), {});

var T0 = '2026-10-17T19:08:00Z';
var T1 = '2026-10-17T20:15:00Z';

function item(number, labels) {
    return { number: number, labels: labels || [] };
}

function run(status, conclusion, extra) {
    var r = { status: status };
    if (conclusion !== undefined) r.conclusion = conclusion;
    if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
    return r;
}

suite('mutexRegistry derive — reconciliation from the label layer (AC1, I1)', function () {
    test('cached holder missing from the live label layer is dropped and flagged a phantom', function () {
        var out = registry.derive([997], [item(997, []), item(998, [])], registry.noCompletedRuns, 'o/r', T0);
        assert.deepEqual(out.holders, []);
        assert.deepEqual(out.phantoms, [997]);
    });

    test('live label layer confirms a cached holder (arm visible on both sides)', function () {
        var out = registry.derive([997], [item(997, ['ai_validating'])], registry.noCompletedRuns, 'o/r', T0);
        assert.deepEqual(out.holders, [997]);
        assert.deepEqual(out.phantoms, []);
    });

    test('a PR armed in the live label layer but missing from the cached list still counts (armed layer first)', function () {
        var out = registry.derive([], [item(991, ['ai_validating']), item(992, [])], registry.noCompletedRuns, 'o/r', T0);
        assert.deepEqual(out.holders, [991]);
        assert.deepEqual(out.armedExtra, [991]);
    });

    test('run-state conjunct: label on but run concluded → not a holder (gh-821 sweep owns run state)', function () {
        var out = registry.derive(
            [997],
            [item(997, ['ai_validating'])],
            function () { return true; },
            'o/r', T0);
        assert.deepEqual(out.holders, []);
        assert.deepEqual(out.phantoms, [997]);
    });

    test('non-holder PRs and duplicate entries do not pollute the holder set', function () {
        var out = registry.derive(
            [997, 997, 998],
            [item(997, ['ai_validating']), item(998, ['review']), item(999, [])],
            registry.noCompletedRuns, 'o/r', T0);
        assert.deepEqual(out.holders, [997]);
    });
});

suite('mutexRegistry reconcile — self-heal with alarm, tick counters (AC2, I2)', function () {
    test('cached-vs-live divergence self-heals: corrected holders + alarm record', function () {
        // The cached registry view says pr-997 holds; the live re-read
        // (label layer) says nobody does — the recorded 19:08Z shape.
        var cached = { holders: [997], repo: 'o/r', at: T0 };
        var live = { holders: [], repo: 'o/r', at: T1 };
        var out = registry.reconcile(cached, live);
        assert.equal(out.selfHealed, true);
        assert.deepEqual(out.holders, []);
        assert.equal(out.alarm.type, 'phantom_mutex_holder');
        assert.equal(out.alarm.label, 'ai_validating');
        assert.equal(out.alarm.holders.cached[0], 997);
        assert.equal(out.alarm.at, T1);
    });

    test('consistent cached and live snapshots produce no self-heal and no alarm', function () {
        var cached = registry.derive([997], [item(997, ['ai_validating'])], registry.noCompletedRuns, 'o/r', T0);
        var live = registry.derive([997], [item(997, ['ai_validating'])], registry.noCompletedRuns, 'o/r', T1);
        var out = registry.reconcile(cached, live);
        assert.equal(out.selfHealed, false);
        assert.ok(!out.alarm);
        assert.equal(out.mutexSelfHeals || 0, 0);
    });

    test('healed holder set is authoritative immediately: a queued candidate may arm in the same tick (AC2)', function () {
        // Live layer: 997 gone, 998 genuinely armed. The corrected set must
        // be exactly the live holders — queryPrs re-derives slots from it.
        var cached = registry.derive([997], [item(997, [])], registry.noCompletedRuns, 'o/r', T0);
        var live = registry.derive([998], [item(998, ['ai_validating'])], registry.noCompletedRuns, 'o/r', T1);
        var out = registry.reconcile(cached, live);
        assert.equal(out.selfHealed, true);
        assert.deepEqual(out.holders, [998]);
    });

    test('clean tick resets the consecutive counter but keeps the cumulative self-heal count', function () {
        // Tick 1: cached says 997 holds, live says nobody (phantom heal).
        var healed = registry.reconcile({ holders: [997], at: T0 }, { holders: [], at: T0 });
        assert.equal(healed.selfHealed, true);
        assert.equal(healed.mutexSelfHeals, 1);
        assert.equal(healed.consecutivePhantomTicks, 1);
        // Tick 2 is clean: no new events, no self-heal.
        var empty = { holders: [], at: T1 };
        var clean = registry.reconcile(empty, empty);
        assert.equal(clean.selfHealed, false);
        assert.equal(clean.mutexSelfHeals, 0);
    });

    test('null/undefined state degrades to a fresh state (fail-open, never a throw)', function () {
        var out = registry.reconcile(null, null);
        assert.equal(out.selfHealed, false);
        var out2 = registry.reconcile(undefined, { holders: [997] });
        assert.equal(out2.selfHealed, true);
        assert.deepEqual(out2.holders, [997]);
    });
});

suite('mutexRegistry tick events — factory-state counter carry (second tier)', function () {
    test('recordPhantomHeal accumulates per-tick events; mergeSnapshot carries counters across ticks', function () {
        var s1 = registry.recordPhantomHeal(null, 'ai_validating', [997], [], T1);
        assert.equal(s1.mutexSelfHeals, 1);
        assert.equal(s1.phantomHolderTicks, 1);
        assert.equal(s1.alarms.length, 1);
        // Next tick: another heal — merge over the previous snapshot.
        var s2 = registry.recordPhantomHeal(s1, 'ai_validating', [998], [], T1);
        var snap = registry.mergeSnapshot(s1, { mutexSelfHeals: 1, phantomHolderTicks: 1, consecutivePhantomTicks: 1, alarm: s2.alarms[0] });
        assert.equal(snap.mutexSelfHeals, 2);
        assert.equal(snap.phantomHolderTicks, 2);
    });

    test('mergeSnapshot keeps at most MAX_ALARMS alarm records', function () {
        var snap = null;
        for (var i = 0; i < 10; i++) {
            var st = registry.recordPhantomHeal(snap, 'ai_validating', [900 + i], [], T1);
            snap = registry.mergeSnapshot(snap, { mutexSelfHeals: 1, phantomHolderTicks: 1, consecutivePhantomTicks: 1, alarm: st.alarms[st.alarms.length - 1] });
        }
        assert.ok(snap.alarms.length <= registry.MAX_ALARMS);
        assert.equal(snap.alarms.length, registry.MAX_ALARMS);
    });

    test('PHANTOM_ALARM_CAP is enforced per holder signature (newest kept), total cap still MAX_ALARMS', function () {
        // The rework thread pinned PHANTOM_ALARM_CAP as dead: declared,
        // documented, never used. One signature flapping 5× must keep only
        // the newest 3 records FOR THAT SIGNATURE — and the per-signature
        // cap must also hold on the mergeSnapshot (published tail) path.
        var snap = null;
        for (var i = 1; i <= 5; i++) {
            var st = registry.recordPhantomHeal(snap, 'ai_validating', [997], [], '2026-10-17T19:0' + i + ':00Z');
            snap = registry.mergeSnapshot(snap, { mutexSelfHeals: 1, phantomHolderTicks: 1, consecutivePhantomTicks: 1, alarm: st.alarms[st.alarms.length - 1] });
        }
        var sigAlarms = snap.alarms.filter(function (a) {
            return String(a.holders && a.holders.cached) === '997';
        });
        assert.equal(sigAlarms.length, registry.PHANTOM_ALARM_CAP,
            'at most PHANTOM_ALARM_CAP records for one holder signature');
        assert.equal(sigAlarms[sigAlarms.length - 1].at, '2026-10-17T19:05:00Z',
            'the NEWEST records survive the cap');
    });

    test('reconcile alarms carry a human-readable title/detail pair (no "undefined — undefined")', function () {
        var cached = registry.derive([997], [item(997, ['ai_validating'])], registry.noCompletedRuns, 'o/r', T0);
        var live = registry.derive([997], [item(997, [])], registry.noCompletedRuns, 'o/r', T1);
        var out = registry.reconcile(cached, live);
        assert.equal(out.selfHealed, true);
        assert.equal(typeof out.alarm.title, 'string');
        assert.ok(out.alarm.title.length > 0);
        assert.equal(typeof out.alarm.detail, 'string');
        assert.ok(out.alarm.detail.length > 0);
    });

    test('derive reads the holder number from prNumber-shaped items too (githubSource query items)', function () {
        // queryPrs items carry prNumber (not number) — a strict it.number
        // read silently emptied the cached leg in production (pinned by the
        // IT-1 rework tests driving the real queryPrs path).
        var items = [{ prNumber: 997, labels: ['ai_validating'] }];
        var out = registry.derive([997], items, registry.noCompletedRuns, 'o/r', T0);
        assert.deepEqual(out.holders, [997], 'prNumber-shaped items confirm the holder');
        var noHolder = registry.derive([997], [{ prNumber: 997, labels: ['other'] }], registry.noCompletedRuns, 'o/r', T0);
        assert.deepEqual(noHolder.holders, [], 'prNumber-shaped item WITHOUT the label does not confirm');
    });
});

suite('mutexRegistry conclusionMapping — CANCELLED carries no verdict (I3, gh-755 parity)', function () {
    test('success and failure map to verdicts without re-dispatch', function () {
        var ok = registry.conclusionMapping('success');
        assert.equal(ok.verdict, 'success');
        assert.equal(ok.reDispatch, false);
        var bad = registry.conclusionMapping('failure');
        assert.equal(bad.verdict, 'failure');
        assert.equal(bad.reDispatch, false);
    });

    test('cancelled and timed_out carry NO verdict and require re-dispatch', function () {
        var c = registry.conclusionMapping('cancelled');
        assert.equal(c.verdict, null);
        assert.equal(c.reDispatch, true);
        var t = registry.conclusionMapping('timed_out');
        assert.equal(t.verdict, null);
        assert.equal(t.reDispatch, true);
    });

    test('unknown or absent conclusion maps to null — caller keeps waiting', function () {
        assert.equal(registry.conclusionMapping(null), null);
        assert.equal(registry.conclusionMapping(''), null);
        assert.equal(registry.conclusionMapping('weird'), null);
    });
});

suite('mutexRegistry isGhostCancelProbe — rerun_cancelled_checks predicate (AC3)', function () {
    var NOW = Date.parse('2026-10-17T21:00:00Z');

    test('ghost cancel: newest dispatched run completed cancelled, nothing active, grace elapsed → re-dispatch', function () {
        var runs = [
            run('completed', 'cancelled', { id: 11, updatedAt: '2026-10-17T20:30:00Z' }),
            run('completed', 'success', { id: 10, updatedAt: '2026-10-17T19:00:00Z' })
        ];
        var out = registry.isGhostCancelProbe(runs, NOW);
        assert.equal(out.isGhostCancel, true);
        assert.equal(out.runId, 11);
        assert.equal(out.conclusion, 'cancelled');
    });

    test('a failed/blue newest run is not a ghost cancel', function () {
        var runs = [run('completed', 'success', { id: 12, updatedAt: '2026-10-17T20:30:00Z' })];
        assert.equal(registry.isGhostCancelProbe(runs, NOW).isGhostCancel, false);
    });

    test('an active run on the head suppresses the probe (state about to move)', function () {
        var runs = [
            run('in_progress', null, { id: 13 }),
            run('completed', 'cancelled', { id: 11, updatedAt: '2026-10-17T20:30:00Z' })
        ];
        var out = registry.isGhostCancelProbe(runs, NOW);
        assert.equal(out.isGhostCancel, false);
        assert.equal(out.reason, 'active-run-on-head');
    });

    test('a cancel still inside the fresh-cancel grace does NOT re-dispatch (gh-755 visibility window)', function () {
        var runs = [run('completed', 'cancelled', { id: 14, updatedAt: '2026-10-17T20:55:00Z' })];
        var out = registry.isGhostCancelProbe(runs, NOW);
        assert.equal(out.isGhostCancel, false);
        assert.equal(out.reason, 'within-fresh-cancel-grace');
    });

    test('empty or null rollup reads as no ghost — fail closed, never a throw', function () {
        assert.equal(registry.isGhostCancelProbe([], NOW).isGhostCancel, false);
        assert.equal(registry.isGhostCancelProbe(null, NOW).isGhostCancel, false);
        assert.equal(registry.isGhostCancelProbe(undefined, NOW).isGhostCancel, false);
    });
});

suite('mutexRegistry holder normalization — object shapes (AC1 edge)', function () {
    test('PR-item holder objects resolve via prNumber / number / pr', function () {
        var out = registry.derive(
            [{ prNumber: 997 }, { number: 998 }, { pr: 999 }],
            [item(997, ['ai_validating']), item(998, ['ai_validating']), item(999, ['ai_validating'])],
            registry.noCompletedRuns, 'o/r', T0);
        assert.deepEqual(out.holders, [997, 998, 999]);
        assert.deepEqual(out.phantoms, []);
    });

    test('garbage holder entries (null, NaN-string, empty object) drop out', function () {
        var out = registry.derive(
            [null, 'junk', {}, 0, -3],
            [item(997, ['ai_validating'])],
            registry.noCompletedRuns, 'o/r', T0);
        assert.deepEqual(out.holders, [997], 'armed layer first — the live label still counts');
    });
});
