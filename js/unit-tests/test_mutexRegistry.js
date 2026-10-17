/**
 * Unit tests for js/common/mutexRegistry.js — the phantom-mutex
 * reconciliation + cancelled-run conclusion mapping (gh-1000).
 *
 * Bug (live IstiN/dmtools-agents 2026-10-17 ~19:08Z): the ai_validating
 * mutex registry reported `slots 1/1 taken` on every SM tick while NO open
 * PR carried the label and factory state showed `lanes.validating: []` —
 * every candidate deferred on an unresolvable (phantom) holder and no
 * validation ever armed. Simultaneously a validation run concluded
 * CANCELLED (gh-748 kicker/dispatch race) was treated as concluded-with-
 * verdict: `no context reads CANCELLED on 242557c — nothing to rerun`, the
 * required check never re-reported, the merge gate refused, and the guest
 * PR could never escape (no machine push, gh-757).
 *
 * Coverage (ticket test plan UT-1..2 → AC1, AC2, AC3):
 *   derive            — pure reconciliation registry-vs-label-layer,
 *                       incl. the recorded live 19:08Z shape (registry
 *                       says 1/1, labels say none → ∅ + phantom flagged)
 *   reconcile         — tick state machine: self-heal + alarm record (I2),
 *                       phantomHolderTicks / consecutivePhantomTicks
 *                       counters, alarm cap
 *   tick events       — per-tick accumulator + mergeSnapshot carry across
 *                       ticks (factory-state counters, second tier)
 *   conclusionMapping — success/failure → verdict; cancelled/timed_out →
 *                       NO verdict + re-dispatch (I3); unknown → null
 *   isGhostCancelProbe— the rerun_cancelled_checks ghost-cancel predicate:
 *                       a completed-canceled NEWEST dispatched run with
 *                       nothing active on the head re-dispatches; the
 *                       fresh-cancel visibility grace does not (gh-755)
 *
 * Pure module — no tool globals; loadModule with no mocks.
 */

var assert = globalThis.assert;

var reg = loadModule('js/common/mutexRegistry.js', makeRequire({}), {});

var T0 = Date.parse('2026-10-17T19:08:00Z');

// ── derive: pure reconciliation (AC1) ───────────────────────────────────────

suite('mutexRegistry derive — reconciliation from the label layer', function () {
    test('the recorded live 19:08Z shape: registry 1/1, label layer ∅ → ∅ + phantom flagged (AC1)', function () {
        // Fixture from the incident: the cached/registry view reports
        // pr-997 holding ai_validating; the label layer (and factory
        // lanes.validating) says nobody holds it.
        var out = reg.derive([997], []);
        assert.equal(out.registry.length, 0);
        assert.deepEqual(out.phantoms, [997]);
    });

    test('a holder still present in the label layer is kept, not flagged (E1 healthy arm)', function () {
        var out = reg.derive([997], [997]);
        assert.deepEqual(out.registry, [997]);
        assert.deepEqual(out.phantoms, []);
    });

    test('multi-holder: only the diverged entries are phantoms', function () {
        var out = reg.derive([983, 992, 999], [992, 999]);
        assert.deepEqual(out.registry, [992, 999]);
        assert.deepEqual(out.phantoms, [983]);
    });

    test('object-shaped holders ({pr: n}) normalize to numbers', function () {
        var out = reg.derive([{ pr: 997, label: 'ai_validating' }], []);
        assert.deepEqual(out.phantoms, [997]);
    });

    test('empty registry is trivially consistent', function () {
        var out = reg.derive([], [997]);
        assert.deepEqual(out.registry, []);
        assert.deepEqual(out.phantoms, []);
    });
});

// ── reconcile: tick state machine — self-heal + alarm (I2, AC2) ─────────────

suite('mutexRegistry reconcile — self-heal with alarm, tick counters', function () {
    test('phantom on tick 1: healed, alarm record lands, counters start at 1', function () {
        var s = reg.initialState(T0);
        s.registry = [997]; // the cached/registry view reports pr-997 armed
        var out = reg.reconcile(s, [], T0);
        assert.equal(out.healed, true);
        assert.ok(out.alarm, 'an alarm record is emitted');
        assert.equal(out.alarm.type, 'phantom_mutex_holder');
        assert.deepEqual(out.alarm.holders, [997]);
        assert.equal(out.state.mutexSelfHeals, 1);
        assert.equal(out.state.phantomHolderTicks, 1);
        assert.equal(out.state.consecutivePhantomTicks, 1);
        assert.equal(out.state.alarms.length, 1);
        assert.equal(out.state.registry.length, 0);
    });

    test('phantom again on tick 2: counters increment (≥2 consecutive ticks = the alarm condition)', function () {
        var s = reg.initialState(T0);
        s.registry = [997];
        var t1 = reg.reconcile(s, [], T0);
        // Tick 2: the registry got re-polluted with the same phantom
        // (the stale view is re-read at the top of every tick).
        var rePolluted = reg.initialState(T0);
        rePolluted.registry = [997]; // re-polluted
        rePolluted.mutexSelfHeals = t1.state.mutexSelfHeals;
        rePolluted.phantomHolderTicks = t1.state.phantomHolderTicks;
        rePolluted.consecutivePhantomTicks = t1.state.consecutivePhantomTicks;
        rePolluted.alarms = t1.state.alarms.slice();
        var t2 = reg.reconcile(rePolluted, [], T0 + 60000);
        assert.equal(t2.healed, true);
        assert.equal(t2.state.mutexSelfHeals, 2);
        assert.equal(t2.state.phantomHolderTicks, 2);
        assert.equal(t2.state.consecutivePhantomTicks, 2);
        assert.equal(t2.state.alarms.length, 2);
    });

    test('clean tick resets the consecutive counter but keeps the cumulative self-heal count', function () {
        var t1 = reg.reconcile(reg.initialState(T0), [], T0);
        var t2 = reg.reconcile(t1.state, [997], T0 + 60000);
        assert.equal(t2.healed, false);
        assert.equal(t2.alarm, null);
        assert.equal(t2.state.consecutivePhantomTicks, 0);
        assert.equal(t2.state.phantomHolderTicks, t1.state.phantomHolderTicks);
        assert.equal(t2.state.mutexSelfHeals, 1);
        assert.deepEqual(t2.state.registry, [997]);
    });

    test('alarm records are capped (a flapping registry cannot grow state unbounded)', function () {
        var s = reg.initialState(T0);
        var out = null;
        for (var i = 0; i < 30; i++) {
            s.registry = [997]; // re-polluted every tick
            out = reg.reconcile(s, [], T0 + i * 60000);
            s = out.state;
        }
        assert.ok(s.alarms.length <= 20, 'alarms capped, got ' + s.alarms.length);
    });

    test('null/undefined state degrades to a fresh state (fail-open, never a throw)', function () {
        var out = reg.reconcile(null, [], T0);
        assert.equal(out.healed, true);
        assert.equal(out.state.mutexSelfHeals, 1);
    });
});

// ── tick events + snapshot merge (factory-state metrics, second tier) ───────

suite('mutexRegistry tick events — factory-state counter carry', function () {
    test('recordPhantomHeal accumulates per-tick events; mergeSnapshot carries counters across ticks', function () {
        reg.resetTickEvents();
        reg.recordPhantomHeal('ai_validating', [997], { owner: 'IstiN', repo: 'dmtools-agents' }, T0);
        var events = reg.currentTickEvents();
        assert.equal(events.selfHeals, 1);
        assert.equal(events.alarms.length, 1);
        assert.equal(events.alarms[0].holders[0], 997);
        // The snapshot the factory published last tick carried no mutex
        // block (pre-gh-1000) → counters start from zero.
        var snap = reg.mergeSnapshot(null, events, T0);
        assert.equal(snap.mutexSelfHeals, 1);
        assert.equal(snap.phantomHolderTicks, 1);
        // Next tick: the published snapshot carries the block; a clean
        // tick zeroes the consecutive counter (phantom healed for good).
        var clean = reg.mergeSnapshot(snap, reg.currentTickEvents(), T0 + 60000);
        assert.equal(clean.mutexSelfHeals, 1);
        assert.equal(clean.phantomHolderTicks, 0);
        // Two ticks later another phantom: cumulative self-heals add,
        // consecutive counter restarts at 1.
        reg.resetTickEvents();
        reg.recordPhantomHeal('ai_validating', [983], { owner: 'IstiN', repo: 'dmtools-agents' }, T0 + 120000);
        var again = reg.mergeSnapshot(clean, reg.currentTickEvents(), T0 + 120000);
        assert.equal(again.mutexSelfHeals, 2);
        assert.equal(again.phantomHolderTicks, 1);
        reg.resetTickEvents();
    });

    test('mergeSnapshot keeps at most MAX_ALARMS alarm records', function () {
        var prev = { mutexSelfHeals: 5, phantomHolderTicks: 2, alarms: [] };
        for (var i = 0; i < 25; i++) prev.alarms.push({ type: 'phantom_mutex_holder', holders: [i] });
        reg.resetTickEvents();
        reg.recordPhantomHeal('ai_validating', [997], null, T0);
        var snap = reg.mergeSnapshot(prev, reg.currentTickEvents(), T0);
        assert.ok(snap.alarms.length <= 20);
        assert.equal(snap.mutexSelfHeals, 6);
        reg.resetTickEvents();
    });
});

// ── conclusionMapping — CANCELLED carries no verdict (AC3 / I3, UT-2) ───────

suite('mutexRegistry conclusionMapping — run-conclusion semantics', function () {
    test('success/failure are verdicts (latched, consumed as today)', function () {
        assert.deepEqual(reg.conclusionMapping('success'), { verdict: 'green', redispatch: false });
        assert.deepEqual(reg.conclusionMapping('failure'), { verdict: 'red', redispatch: false });
    });

    test('CANCELLED is NO verdict — the record returns to not-dispatched and re-dispatches (I3)', function () {
        assert.deepEqual(reg.conclusionMapping('cancelled'), { verdict: null, redispatch: true });
        assert.deepEqual(reg.conclusionMapping('canceled'), { verdict: null, redispatch: true });
    });

    test('timed_out is NO verdict — same handling as CANCELLED (capability surface)', function () {
        assert.deepEqual(reg.conclusionMapping('timed_out'), { verdict: null, redispatch: true });
    });

    test('unknown/absent conclusions map to null (caller keeps its fail-open path)', function () {
        assert.equal(reg.conclusionMapping('action_required'), null);
        assert.equal(reg.conclusionMapping(null), null);
        assert.equal(reg.conclusionMapping(''), null);
    });
});

suite('mutexRegistry isGhostCancelProbe — the rerun_cancelled_checks ghost branch (AC3)', function () {
    var OLD = Date.parse('2026-10-17T18:00:00Z');

    test('newest dispatched run completed CANCELLED with nothing active → ghost: re-dispatch', function () {
        var probe = {
            active: false,
            newest: { status: 'completed', conclusion: 'cancelled', updated_at: new Date(OLD).toISOString() }
        };
        assert.equal(reg.isGhostCancelProbe(probe), true);
    });

    test('timed_out newest dispatched run → same re-dispatch obligation', function () {
        var probe = {
            active: false,
            newest: { status: 'completed', conclusion: 'timed_out', updated_at: new Date(OLD).toISOString() }
        };
        assert.equal(reg.isGhostCancelProbe(probe), true);
    });

    test('a FRESH cancellation (still inside the visibility grace → probe.active) does NOT re-dispatch here (gh-755)', function () {
        var probe = {
            active: true,
            newest: { status: 'completed', conclusion: 'cancelled', updated_at: new Date().toISOString() }
        };
        assert.equal(reg.isGhostCancelProbe(probe), false);
    });

    test('a live verdict (green/red) is never a ghost', function () {
        assert.equal(reg.isGhostCancelProbe({
            active: false,
            newest: { status: 'completed', conclusion: 'success', updated_at: new Date(OLD).toISOString() }
        }), false);
        assert.equal(reg.isGhostCancelProbe({
            active: false,
            newest: { status: 'completed', conclusion: 'failure', updated_at: new Date(OLD).toISOString() }
        }), false);
    });

    test('degenerate probes fail closed (no ghost → the caller keeps its skip path)', function () {
        assert.equal(reg.isGhostCancelProbe(null), false);
        assert.equal(reg.isGhostCancelProbe({}), false);
        assert.equal(reg.isGhostCancelProbe({ active: false, newest: null }), false);
        assert.equal(reg.isGhostCancelProbe({
            active: false,
            newest: { status: 'queued', conclusion: null }
        }), false);
    });
});
