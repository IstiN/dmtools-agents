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
    return Math.max(0, Math.floor(Number(v)) || 0);
}

function str(v) {
    return (typeof v === 'string' && v) ? v : '';
}

// ── I1 — derive(M): reconciliation from the label layer ─────────────────────

function holderFromObject(h) {
    if (h.prNumber !== undefined) return normalizeHolder(h.prNumber);
    if (h.number !== undefined) return normalizeHolder(h.number);
    return normalizeHolder(h.pr);
}

function normalizeHolder(h) {
    if (h === null || h === undefined) return 0;
    if (typeof h === 'number') return Math.floor(h);
    if (typeof h === 'string') {
        var n = parseInt(h, 10);
        return isNaN(n) ? 0 : n;
    }
    if (typeof h === 'object') return holderFromObject(h);
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
function labelHoldersOf(liveItems) {
    var out = [];
    (liveItems || []).forEach(function (it) {
        var labels = (it && it.labels) || [];
        if (labels.indexOf('ai_validating') !== -1) {
            // Tolerant of both payload shapes: the github_list_prs carrier
            // uses `number`, the githubSource query items use `prNumber` —
            // a strict `it.number` read silently emptied the cached leg in
            // production (pinned by the IT-1 rework tests).
            out.push(it.number !== undefined ? it.number : it.prNumber);
        }
    });
    return out;
}

function setOf(list) {
    var s = {};
    list.forEach(function (n) { s[n] = true; });
    return s;
}

function armedExtrasOf(labelHolders, candSet) {
    var out = [];
    labelHolders.forEach(function (n) {
        if (!candSet[n]) out.push(n);
    });
    return out;
}

// The card's contract: M = { pr | L[pr]=armed ∧ run(pr) not concluded }.
// A candidate the live label layer does NOT show armed is not a holder —
// that divergence IS the phantom class (live 19:08Z: registry said 1/1,
// the label layer said none).
function liveHoldersOf(merged, labelSet, candSet, concluded, phantoms) {
    return merged.filter(function (n) {
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
}

function derive(holders, liveItems, isRunConcluded, repo, nowIso) {
    var concluded = (typeof isRunConcluded === 'function') ? isRunConcluded : function () { return false; };
    var labelHolders = labelHoldersOf(liveItems);
    var cand = uniquePositive(holders);
    var candSet = setOf(cand);
    var phantoms = [];
    var merged = uniquePositive(cand.concat(labelHolders));
    return {
        holders: liveHoldersOf(merged, setOf(labelHolders), candSet, concluded, phantoms),
        phantoms: phantoms,
        armedExtra: armedExtrasOf(labelHolders, candSet),
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
function snapshotsDiverge(cached, live) {
    var liveSet = setOf(live);
    return cached.some(function (n) { return !liveSet[n]; }) ||
        live.some(function (n) { return cached.indexOf(n) === -1; });
}

function noDivergenceResult(live) {
    return {
        selfHealed: false,
        holders: live.slice(),
        alarm: null,
        mutexSelfHeals: 0,
        phantomHolderTicks: 0,
        consecutivePhantomTicks: 0
    };
}

function phantomAlarmOf(liveSnapshot, cachedSnapshot, cached, live) {
    return {
        type: 'phantom_mutex_holder',
        // Human-readable pair for log lines and factory-state consumers
        // (the rework thread pinned the self-heal alarm logging as
        // "undefined — undefined" — every alarm record carries them).
        title: 'phantom_mutex_holder',
        detail: 'cached ai_validating holders diverge from the live label layer',
        label: 'ai_validating',
        repo: (liveSnapshot && liveSnapshot.repo) || (cachedSnapshot && cachedSnapshot.repo) || null,
        holders: { cached: cached, live: live },
        at: (liveSnapshot && liveSnapshot.at) || null
    };
}

function reconcile(cachedSnapshot, liveSnapshot) {
    var cached = (cachedSnapshot && cachedSnapshot.holders) || [];
    var live = (liveSnapshot && liveSnapshot.holders) || [];
    if (!snapshotsDiverge(cached, live)) return noDivergenceResult(live);
    return {
        selfHealed: true,
        holders: live,
        alarm: phantomAlarmOf(liveSnapshot, cachedSnapshot, cached, live),
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
 * grow state unbounded) — the signature cap is enforced by
 * capAlarmsPerSignature, the total tail by MAX_ALARMS.
 */
function alarmSignatureOf(a) {
    return String(a && a.holders && a.holders.cached || '');
}

// Keep at most PHANTOM_ALARM_CAP (newest) records per holder signature —
// oldest beyond the cap drop first (the tail's shift() semantics).
function capAlarmsPerSignature(alarms) {
    var counts = {};
    var out = [];
    var list = (alarms || []).slice();
    for (var i = list.length - 1; i >= 0; i--) {
        var a = list[i];
        if (!a) continue;
        var sig = alarmSignatureOf(a);
        counts[sig] = (counts[sig] || 0) + 1;
        if (counts[sig] <= PHANTOM_ALARM_CAP) out.unshift(a);
    }
    return out;
}

function recordPhantomHeal(state, label, cachedHolders, liveHolders, atIso) {
    var s = state || defaultState();
    var sig = uniquePositive(cachedHolders).join(',');
    var alarms = (s.alarms || []).filter(function (a) {
        return !((a.holders && String(a.holders.cached || '') === sig));
    });
    alarms.push({
        type: 'phantom_mutex_holder',
        title: 'phantom_mutex_holder',
        detail: 'cached ai_validating holders diverge from the live label layer',
        label: str(label) || 'ai_validating',
        holders: { cached: uniquePositive(cachedHolders), live: uniquePositive(liveHolders) },
        at: str(atIso)
    });
    alarms = capAlarmsPerSignature(alarms);
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
function alarmKey(a) {
    return str(a.type) + '|' + String(a.holders && a.holders.cached) + '|' + str(a.at);
}

function appendDedupedAlarms(out, alarms) {
    var seen = {};
    var deduped = [];
    alarms.forEach(function (a) {
        if (!a) return;
        var key = alarmKey(a);
        if (seen[key]) return;
        seen[key] = true;
        deduped.push(a);
    });
    // Same contract as recordPhantomHeal: per-signature cap first, then
    // the total tail cap (newest kept).
    deduped = capAlarmsPerSignature(deduped);
    deduped.forEach(function (a) { out.push(a); });
    while (out.length > MAX_ALARMS) out.shift();
}

function mergeSnapshot(prev, events) {
    var p = (prev && typeof prev === 'object') ? prev : {};
    var e = (events && typeof events === 'object') ? events : {};
    var out = {
        mutexSelfHeals: num(p.mutexSelfHeals) + num(e.mutexSelfHeals),
        phantomHolderTicks: num(p.phantomHolderTicks) + num(e.phantomHolderTicks),
        consecutivePhantomTicks: num(p.consecutivePhantomTicks) + num(e.consecutivePhantomTicks),
        alarms: []
    };
    appendDedupedAlarms(out.alarms, (p.alarms || []).concat(e.alarm ? [e.alarm] : []));
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
function isActiveRun(r) {
    return ACTIVE_STATUSES.indexOf(String(r.status || '')) !== -1;
}

function validRuns(runs) {
    return (runs || []).filter(function (r) { return r && typeof r === 'object'; });
}

function terminalRunsOf(list) {
    return list.filter(function (r) { return !isActiveRun(r); });
}

function isReDispatchable(conclusion) {
    var map = conclusionMapping(conclusion);
    return !!(map && map.reDispatch === true);
}

function probeTimesOf(newest, nowMs) {
    var updatedAt = Date.parse(newest.updatedAt || newest.updated_at || '') || 0;
    var now = (nowMs === null || nowMs === undefined) ? Date.now() : nowMs;
    return { updatedAt: updatedAt, now: now };
}

function withinFreshCancelGrace(updatedAt, now) {
    return !!updatedAt && (now - updatedAt) < FRESH_CANCEL_GRACE_MS;
}

function ghostCancelResult(newest, updatedAt) {
    return {
        isGhostCancel: true,
        runId: newest.id || null,
        runNumber: newest.runNumber || newest.run_number || null,
        conclusion: newest.conclusion,
        updatedAt: updatedAt || null
    };
}

function isGhostCancelProbe(runs, nowMs) {
    var list = validRuns(runs);
    var terminal = terminalRunsOf(list);
    if (!terminal.length) return { isGhostCancel: false, reason: 'no-terminal-run' };
    var newest = terminal[0];
    if (!isReDispatchable(newest.conclusion)) {
        return { isGhostCancel: false, reason: 'newest-not-cancelled', conclusion: newest.conclusion };
    }
    if (list.some(isActiveRun)) return { isGhostCancel: false, reason: 'active-run-on-head' };
    var times = probeTimesOf(newest, nowMs);
    if (withinFreshCancelGrace(times.updatedAt, times.now)) {
        return { isGhostCancel: false, reason: 'within-fresh-cancel-grace', updatedAt: times.updatedAt };
    }
    return ghostCancelResult(newest, times.updatedAt);
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
