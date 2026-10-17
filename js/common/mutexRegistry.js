'use strict';

// gh-1000 — phantom ai_validating mutex holder + cancelled-run conclusion
// mapping. Pure module: NO tool globals, NO fs, NO gh — the wiring points
// own I/O (githubSource re-derives holders against a live list_prs re-read
// on a full-slot defer; smAgent rerun_cancelled_checks probes the head
// workflow runs). The card's contract (AC1/AC2/AC3, I1–I5):
//
//   M = { pr in open PRs | L[pr] = armed ∧ run(pr) not concluded }
//
// The run-state conjunct stays with the gh-821 liveness sweep (single-
// writer rule); this module reconciles the label layer only.

var MAX_ALARMS = 5;
var PHANTOM_ALARM_CAP = 3;
var FRESH_CANCEL_GRACE_MS = 15 * 60 * 1000; // gh-755 — do not re-dispatch a cancel still within its visibility grace

function num(v) {
    var n = Math.floor(Number(v));
    return (typeof n === 'number' && !isNaN(n) && n >= 0) ? n : 0;
}

function str(v) {
    return (typeof v === 'string' && v) ? v : '';
}

// ── I1 — derive(M): reconciliation from the label layer ─────────────────────

function normalizeHolder(h) {
    if (h === null || h === undefined) return 0;
    if (typeof h === 'number') return Math.floor(h);
    if (typeof h === 'string') {
        var n = parseInt(h, 10);
        return isNaN(n) ? 0 : n;
    }
    if (typeof h === 'object') {
        return normalizeHolder(h.prNumber !== undefined ? h.prNumber
            : (h.number !== undefined ? h.number : h.pr));
    }
    return 0;
}

function uniquePositive(list) {
    var seen = {};
    var out = [];
    (list || []).forEach(function (h) {
        var n = normalizeHolder(h);
        if (n > 0 && !seen[n]) {
            seen[n] = true;
            out.push(n);
        }
    });
    return out;
}

/**
 * Reconcile a candidate holder list against the live label layer.
 *   holders        — candidate mutex holders (numbers or PR items)
 *   liveItems      — live open-PR items (label arrays)
 *   isRunConcluded — fn(number) → true when the PR's run already concluded
 *                    (the gh-821 liveness conjunct; pass noCompletedRuns
 *                    when no run-state source exists at the call site)
 * The armed layer counts first: a PR whose label layer shows the mutex
 * armed is a holder even if missing from the candidate list.
 */
function derive(holders, liveItems, isRunConcluded, repo, nowIso) {
    var concluded = (typeof isRunConcluded === 'function') ? isRunConcluded : function () { return false; };
    var labelHolders = [];
    (liveItems || []).forEach(function (it) {
        var labels = (it && it.labels) || [];
        if (labels.indexOf('ai_validating') !== -1) labelHolders.push(it.number);
    });
    var cand = uniquePositive(holders);
    var candSet = {};
    cand.forEach(function (n) { candSet[n] = true; });
    var labelSet = {};
    labelHolders.forEach(function (n) { labelSet[n] = true; });
    var phantoms = [];
    var armedExtra = [];
    labelHolders.forEach(function (n) {
        if (!candSet[n]) armedExtra.push(n);
    });
    var merged = uniquePositive(cand.concat(labelHolders));
    // The card's contract: M = { pr | L[pr]=armed ∧ run(pr) not concluded }.
    // A candidate the live label layer does NOT show armed is not a holder —
    // that divergence IS the phantom class (live 19:08Z: registry said 1/1,
    // the label layer said none).
    var liveHolders = merged.filter(function (n) {
        if (!labelSet[n]) {
            if (candSet[n]) phantoms.push(n);
            return false;
        }
        if (concluded(n)) {
            // label still on, run concluded → the label layer does not
            // confirm; it is a phantom source, not a holder
            if (candSet[n]) phantoms.push(n);
            return false;
        }
        return true;
    });
    return {
        holders: liveHolders,
        phantoms: phantoms,
        armedExtra: armedExtra,
        repo: repo || null,
        at: nowIso || null
    };
}

// ── I2 — reconcile: self-heal with alarm, tick counters ─────────────────────

function defaultState() {
    return { mutexSelfHeals: 0, phantomHolderTicks: 0, consecutivePhantomTicks: 0, alarms: [] };
}

/**
 * Compare a cached registry snapshot against a freshly derived live one.
 * Divergence ⇒ self-heal: corrected holders + alarm record + tick counters.
 */
function reconcile(cachedSnapshot, liveSnapshot) {
    var cached = (cachedSnapshot && cachedSnapshot.holders) || [];
    var live = (liveSnapshot && liveSnapshot.holders) || [];
    var liveSet = {};
    live.forEach(function (n) { liveSet[n] = true; });
    var divergent = cached.some(function (n) { return !liveSet[n]; }) ||
        live.some(function (n) { return cached.indexOf(n) === -1; });
    if (!divergent) {
        return {
            selfHealed: false,
            holders: live.slice(),
            alarm: null,
            mutexSelfHeals: 0,
            phantomHolderTicks: 0,
            consecutivePhantomTicks: 0
        };
    }
    var alarm = {
        type: 'phantom_mutex_holder',
        label: 'ai_validating',
        repo: (liveSnapshot && liveSnapshot.repo) || (cachedSnapshot && cachedSnapshot.repo) || null,
        holders: { cached: cached, live: live },
        at: (liveSnapshot && liveSnapshot.at) || null
    };
    return {
        selfHealed: true,
        holders: live,
        alarm: alarm,
        mutexSelfHeals: 1,
        phantomHolderTicks: 1,
        consecutivePhantomTicks: 1
    };
}

// ── Per-tick events + factory-state carry (second tier) ─────────────────────

function emptyTickEvents() {
    return { mutexSelfHeals: 0, phantomHolderTicks: 0, consecutivePhantomTicks: 0, alarm: null };
}

/**
 * Record one self-heal event for the current tick. Alarm records cap at
 * PHANTOM_ALARM_CAP per holder signature (a flapping registry must not
 * grow state unbounded).
 */
function recordPhantomHeal(state, label, cachedHolders, liveHolders, atIso) {
    var s = state || defaultState();
    var sig = uniquePositive(cachedHolders).join(',');
    var alarms = (s.alarms || []).filter(function (a) {
        return !((a.holders && String(a.holders.cached || '') === sig));
    });
    alarms.push({
        type: 'phantom_mutex_holder',
        label: str(label) || 'ai_validating',
        holders: { cached: uniquePositive(cachedHolders), live: uniquePositive(liveHolders) },
        at: str(atIso)
    });
    while (alarms.length > MAX_ALARMS) alarms.shift();
    return {
        mutexSelfHeals: num(s.mutexSelfHeals) + 1,
        phantomHolderTicks: num(s.phantomHolderTicks) + 1,
        consecutivePhantomTicks: num(s.consecutivePhantomTicks) + 1,
        alarms: alarms
    };
}

/**
 * Merge per-tick events into the published factory-state mutex block.
 * Counter keys never carry negative or NaN values; absent both sides the
 * snapshot stays absent (additive only).
 */
function mergeSnapshot(prev, events) {
    var p = (prev && typeof prev === 'object') ? prev : {};
    var e = (events && typeof events === 'object') ? events : {};
    var out = {
        mutexSelfHeals: num(p.mutexSelfHeals) + num(e.mutexSelfHeals),
        phantomHolderTicks: num(p.phantomHolderTicks) + num(e.phantomHolderTicks),
        consecutivePhantomTicks: num(p.consecutivePhantomTicks) + num(e.consecutivePhantomTicks),
        alarms: []
    };
    var seen = {};
    (p.alarms || []).concat(e.alarm ? [e.alarm] : []).forEach(function (a) {
        if (!a) return;
        var key = str(a.type) + '|' + String(a.holders && a.holders.cached) + '|' + str(a.at);
        if (seen[key]) return;
        seen[key] = true;
        out.alarms.push(a);
    });
    while (out.alarms.length > MAX_ALARMS) out.alarms.shift();
    return out;
}

// ── AC3/I3 — run-conclusion mapping: CANCELLED carries no verdict ───────────

/**
 * Map a run conclusion to the card's verdict vocabulary. CANCELLED /
 * TIMED_OUT deliberately carry NO verdict (gh-755 parity): the run died
 * without a signal, the arm must re-dispatch, nothing may read the
 * conclusion as red (fail-validation owns red).
 */
function conclusionMapping(conclusion) {
    switch (String(conclusion || '').toLowerCase()) {
        case 'success': return { verdict: 'success', reDispatch: false };
        case 'failure': return { verdict: 'failure', reDispatch: false };
        case 'cancelled':
        case 'canceled':
        case 'timed_out': return { verdict: null, reDispatch: true };
        default: return null; // null/unknown — caller keeps waiting
    }
}

var ACTIVE_STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

/**
 * The rerun_cancelled_checks ghost-cancel predicate (AC3): the newest
 * dispatched run on the head concluded cancelled/timed_out AND nothing is
 * active on the head AND the newest terminal conclusion is not still
 * inside its fresh-cancel visibility grace (gh-755). Runs are newest-
 * first; a failed probe (null) reads as no ghost — fail closed.
 */
function isGhostCancelProbe(runs, nowMs) {
    var list = (runs || []).filter(function (r) { return r && typeof r === 'object'; });
    var terminal = list.filter(function (r) { return ACTIVE_STATUSES.indexOf(String(r.status || '')) === -1; });
    if (!terminal.length) return { isGhostCancel: false, reason: 'no-terminal-run' };
    var newest = terminal[0];
    var map = conclusionMapping(newest.conclusion);
    var canceled = map && map.reDispatch === true;
    if (!canceled) return { isGhostCancel: false, reason: 'newest-not-cancelled', conclusion: newest.conclusion };
    var active = list.some(function (r) { return ACTIVE_STATUSES.indexOf(String(r.status || '')) !== -1; });
    if (active) return { isGhostCancel: false, reason: 'active-run-on-head' };
    var updatedAt = Date.parse(newest.updatedAt || newest.updated_at || '') || 0;
    var now = (nowMs === null || nowMs === undefined) ? Date.now() : nowMs;
    if (updatedAt && (now - updatedAt) < FRESH_CANCEL_GRACE_MS) {
        return { isGhostCancel: false, reason: 'within-fresh-cancel-grace', updatedAt: updatedAt };
    }
    return {
        isGhostCancel: true,
        runId: newest.id || null,
        runNumber: newest.runNumber || newest.run_number || null,
        conclusion: newest.conclusion,
        updatedAt: updatedAt || null
    };
}

// The derive() run-state conjunct placeholder for call sites without a
// run-state source: the gh-821 liveness sweep owns run state (AC1 note).

function noCompletedRuns() { return false; }

module.exports = {
    MAX_ALARMS: MAX_ALARMS,
    PHANTOM_ALARM_CAP: PHANTOM_ALARM_CAP,
    FRESH_CANCEL_GRACE_MS: FRESH_CANCEL_GRACE_MS,
    derive: derive,
    reconcile: reconcile,
    recordPhantomHeal: recordPhantomHeal,
    mergeSnapshot: mergeSnapshot,
    conclusionMapping: conclusionMapping,
    isGhostCancelProbe: isGhostCancelProbe,
    noCompletedRuns: noCompletedRuns
};
