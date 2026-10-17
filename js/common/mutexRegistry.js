/**
 * Mutex registry reconciliation + validation-run conclusion mapping
 * (gh-1000 — "Phantom ai_validating mutex holder blocks the whole agents
 * validation queue").
 *
 * Live IstiN/dmtools-agents 2026-10-17 ~19:08Z, two divergences wedged the
 * queue at once:
 *
 *   (1) PHANTOM HOLDER — the mutex scan reported `slots 1/1 taken` on every
 *       SM tick while NO open PR carried the ai_validating label and the
 *       published factory state showed `lanes.validating: []`. The holder
 *       set M was read from the provider's per-tick ioCache and never
 *       reconciled against the live label layer: a holder that vanished
 *       from GitHub truth (arm strip racing the cached list) stayed a
 *       phantom turnstile — every candidate logged
 *       `🔒 mutex "ai_validating" slots 1/1 taken — candidate pr-N defers`
 *       and no validation ever armed.
 *   (2) CANCELLED ≠ VERDICT — a validation run concluded CANCELLED
 *       (gh-748 kicker/dispatch race) was treated as concluded-with-
 *       verdict: the run died pre-materialization, so no check context
 *       read CANCELED, `rerun_cancelled_checks` answered "nothing to
 *       rerun", the required check never re-reported and the merge gate
 *       refused forever (guest PR — no machine push can escape, gh-757).
 *
 * This module is the pure half of the fix:
 *
 *   derive(registry, liveHolders)  — I1 reconciliation: M is DERIVED from
 *                                    the label layer, never primary. Any
 *                                    registry entry absent from the live
 *                                    label layer is a phantom (including
 *                                    the recorded 19:08Z shape: registry
 *                                    1/1, labels ∅ → ∅ + phantom flagged).
 *   reconcile(state, live, nowMs)  — I2 self-heal with alarm: phantoms are
 *                                    dropped in the same tick, an alarm
 *                                    record lands, mutexSelfHeals /
 *                                    phantomHolderTicks counters move;
 *                                    ≥2 consecutive phantom ticks IS the
 *                                    alarm condition the card demands.
 *   tick events + mergeSnapshot     — per-tick accumulator (one SM process
 *                                    = one tick) and the carry-merge into
 *                                    the factory-state `mutex` block
 *                                    (metrics: mutex_self_heals /
 *                                    phantom_holder_ticks, second tier).
 *   conclusionMapping(conclusion)  — AC3/UT-2 the run-conclusion semantics:
 *                                    success/failure → verdict; cancelled/
 *                                    timed_out → NO verdict, re-dispatch
 *                                    (I3); unknown → null (caller keeps
 *                                    its fail-open path).
 *   isGhostCancelProbe(probe)      — the rerun_cancelled_checks ghost
 *                                    predicate: newest dispatched run
 *                                    completed cancelled/timed_out with
 *                                    nothing active on the head → the
 *                                    machine re-dispatches (never "nothing
 *                                    to rerun"); the fresh-cancel
 *                                    visibility grace (probe.active, gh-755)
 *                                    suppresses.
 *
 * Scope note (single-writer rule): derive() reconciles against the LABEL
 * LAYER (L) — GitHub truth. The RUN-STATE conjunct of the card's
 * derive(M) = { pr | L[pr]=armed ∧ run not concluded } is owned by the
 * gh-821 zombie liveness sweep (js/common/validationLiveness.js): a labeled
 * holder whose run concluded is a live-label fact the sweeper re-dispatches
 * or parks on its own query. This module never touches PRs at large — the
 * subject of every verb is the mutex registry entry / the run record.
 *
 * Pure functions, no tool globals — githubSource/smAgent wire the
 * transport, tests inject nothing. CommonJS module like every other js/
 * module. GraalJS rules apply: var + plain functions only.
 */

'use strict';

var MAX_ALARMS = 20;

// ── I1 — derive(M): reconciliation from the label layer ─────────────────────

function normalizeHolder(h) {
    if (h && typeof h === 'object') {
        var n = h.pr || h.prNumber || h.number || 0;
        return Math.floor(Number(n)) || 0;
    }
    var m = Math.floor(Number(h));
    return isNaN(m) ? 0 : m;
}

/**
 * Reconcile a mutex registry against the live label layer.
 * registry / liveHolders: arrays of PR numbers or {pr|prNumber|number}.
 * Returns { registry: kept, phantoms: dropped } — both number arrays,
 * order-preserving, duplicates collapsed by the live-set membership test
 * (a holder is a holder; the caller counts slots).
 */
function derive(registry, liveHolders) {
    var live = {};
    (liveHolders || []).forEach(function (h) {
        var n = normalizeHolder(h);
        if (n) live[n] = true;
    });
    var kept = [];
    var seen = {};
    var phantoms = [];
    (registry || []).forEach(function (h) {
        var n = normalizeHolder(h);
        if (!n || seen[n]) return;
        seen[n] = true;
        if (live[n]) kept.push(n);
        else phantoms.push(n);
    });
    return { registry: kept, phantoms: phantoms };
}

// ── I2 — reconcile: self-heal with alarm, tick counters ─────────────────────

function iso(nowMs) {
    try { return new Date(nowMs).toISOString(); }
    catch (e) { return String(nowMs); }
}

function initialState(nowMs) {
    return {
        registry: [],
        mutexSelfHeals: 0,
        phantomHolderTicks: 0,
        consecutivePhantomTicks: 0,
        alarms: [],
        sinceMs: nowMs || null
    };
}

/**
 * One reconciliation tick over the persistent state.
 *   healed  — phantoms were found and dropped (the registry is corrected
 *             IN THE SAME TICK — a queued candidate may arm immediately).
 *   alarm   — the alarm record emitted this tick (null when consistent).
 * Counters: mutexSelfHeals is cumulative; phantomHolderTicks is cumulative
 * across the state's lifetime; consecutivePhantomTicks resets on any
 * consistent tick — ≥2 consecutive is itself the alarm condition.
 */
function reconcile(state, liveHolders, nowMs) {
    var s = (state && typeof state === 'object') ? state : initialState(nowMs);
    var rec = derive(s.registry, liveHolders);
    var out = {
        state: {
            registry: rec.registry,
            mutexSelfHeals: Math.floor(Number(s.mutexSelfHeals)) || 0,
            phantomHolderTicks: Math.floor(Number(s.phantomHolderTicks)) || 0,
            consecutivePhantomTicks: 0,
            alarms: Array.isArray(s.alarms) ? s.alarms.slice() : [],
            sinceMs: (s.sinceMs !== undefined) ? s.sinceMs : (nowMs || null)
        },
        healed: false,
        alarm: null
    };
    if (rec.phantoms.length) {
        out.healed = true;
        out.alarm = {
            type: 'phantom_mutex_holder',
            holders: rec.phantoms,
            at: iso(nowMs)
        };
        out.state.mutexSelfHeals++;
        out.state.consecutivePhantomTicks =
            (Math.floor(Number(s.consecutivePhantomTicks)) || 0) + 1;
        out.state.phantomHolderTicks++;
        out.state.alarms.push(out.alarm);
        if (out.state.alarms.length > MAX_ALARMS) {
            out.state.alarms = out.state.alarms.slice(-MAX_ALARMS);
        }
    } else {
        out.state.consecutivePhantomTicks = 0;
    }
    return out;
}

// ── Per-tick events + factory-state carry ────────────────────────────────────
//
// One SM process = one tick, so the accumulator is module-level and simply
// read (never reset mid-tick) at publish time; resetTickEvents() exists for
// tests and for any harness that reuses the engine across ticks.

var _tickEvents = { selfHeals: 0, phantomHolders: [], alarms: [] };

/**
 * Record one phantom self-heal (the githubSource query-time reconciliation
 * calls this when a live label-layer re-read diverges from the cached
 * holder set). label = the mutex label name; holders = phantom PR numbers.
 */
function recordPhantomHeal(label, holders, repoInfo, nowMs) {
    _tickEvents.selfHeals++;
    (_tickEvents.alarms || []).push({
        type: 'phantom_mutex_holder',
        label: String(label || ''),
        holders: (holders || []).slice(),
        repo: repoInfo ? (repoInfo.owner + '/' + repoInfo.repo) : null,
        at: iso(nowMs || Date.now())
    });
    (holders || []).forEach(function (h) {
        _tickEvents.phantomHolders.push(normalizeHolder(h));
    });
}

function currentTickEvents() {
    return {
        selfHeals: _tickEvents.selfHeals,
        phantomHolders: _tickEvents.phantomHolders.slice(),
        alarms: _tickEvents.alarms.slice()
    };
}

function resetTickEvents() {
    _tickEvents = { selfHeals: 0, phantomHolders: [], alarms: [] };
}

/**
 * Merge this tick's events over the previously published factory-state
 * mutex block → the block published THIS tick.
 *   mutexSelfHeals     — cumulative across snapshots.
 *   phantomHolderTicks — the consecutive-tick phantom count: events in
 *                        this tick → prev + 1; a clean tick → 0.
 *   alarms             — rolling tail, capped at MAX_ALARMS.
 * prev may be null/absent (pre-gh-1000 snapshots).
 */
function mergeSnapshot(prev, events, nowMs) {
    var p = (prev && typeof prev === 'object') ? prev : {};
    var e = events || { selfHeals: 0, alarms: [] };
    var alarms = (Array.isArray(p.alarms) ? p.alarms.slice() : [])
        .concat(e.alarms || []);
    if (alarms.length > MAX_ALARMS) alarms = alarms.slice(-MAX_ALARMS);
    return {
        mutexSelfHeals: (Math.floor(Number(p.mutexSelfHeals)) || 0) +
            (Math.floor(Number(e.selfHeals)) || 0),
        phantomHolderTicks: (Math.floor(Number(e.selfHeals)) || 0) > 0
            ? (Math.floor(Number(p.phantomHolderTicks)) || 0) + 1
            : 0,
        alarms: alarms
    };
}

// ── AC3/I3 — run-conclusion mapping: CANCELLED carries no verdict ───────────

/**
 * The conclusion semantics the card asserts (UT-2):
 *   success    → { verdict: 'green', redispatch: false } (latch, unarm)
 *   failure    → { verdict: 'red',   redispatch: false } (fail path)
 *   cancelled  → { verdict: null,    redispatch: true  } (NO verdict —
 *   canceled      the record returns to not-dispatched and re-dispatches,
 *   timed_out     same head, gh-748 dedupe; timed_out: same as cancelled)
 *   anything else / absent → null (caller keeps its fail-open path).
 */
function conclusionMapping(conclusion) {
    var c = String(conclusion == null ? '' : conclusion).toLowerCase();
    if (c === 'success') return { verdict: 'green', redispatch: false };
    if (c === 'failure') return { verdict: 'red', redispatch: false };
    if (c === 'cancelled' || c === 'canceled') return { verdict: null, redispatch: true };
    if (c === 'timed_out') return { verdict: null, redispatch: true };
    return null;
}

/**
 * The rerun_cancelled_checks ghost predicate (AC3): the check-rollup found
 * ZERO CANCELED contexts, but the newest DISPATCHED VALIDATION run on the
 * head completed cancelled/timed_out with nothing active on the head — the
 * run died pre-materialization (gh-748 ghost class), so no context exists
 * to `gh run rerun`; the machine must re-dispatch fresh CI on the same
 * head instead of answering "nothing to rerun".
 *   probe.active === true → the fresh-cancel visibility grace (gh-755) or
 *   an in-flight run owns the head → NOT a ghost here.
 * Degenerate probes fail CLOSED (false) — the caller keeps its skip path.
 */
function isGhostCancelProbe(probe) {
    if (!probe || probe.active === true) return false;
    var newest = probe.newest;
    if (!newest || newest.status !== 'completed') return false;
    var m = conclusionMapping(newest.conclusion);
    return !!(m && m.redispatch === true);
}

module.exports = {
    derive: derive,
    reconcile: reconcile,
    initialState: initialState,
    recordPhantomHeal: recordPhantomHeal,
    currentTickEvents: currentTickEvents,
    resetTickEvents: resetTickEvents,
    mergeSnapshot: mergeSnapshot,
    conclusionMapping: conclusionMapping,
    isGhostCancelProbe: isGhostCancelProbe,
    MAX_ALARMS: MAX_ALARMS
};
