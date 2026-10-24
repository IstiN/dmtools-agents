/**
 * legRunVocab.js — the leg-run freshness vocabulary shared by the
 * in-flight-leg probes (gh-1248 dedup): branchLegGuard (gh-1028 branch
 * gate), reworkLatch (gh-806 (pr, head) latch) and teammateEventDedup
 * (gh-1028 zombie parity). The three modules grew identical copies of
 * isLegRun / runTimestampMs / isStaleNonRunning / the fresh-active check;
 * they stay byte-exact here, with the ACTIVE_RUN_STATES list passed in by
 * the caller (reworkLatch/teammateEventDedup carry an extra 'requested'
 * state — that difference is load-bearing and stays per-caller).
 *
 * Pure module — no dmtools globals. GraalJS-clean (var + plain functions,
 * JSON-safe data only).
 */
'use strict';

// The rework/review/dev leg workflow — the same default the dispatch side
// (smAgent triggerWorkflow) uses.
var DEFAULT_LEG_WORKFLOW = 'ai-teammate.yml';

/**
 * True when the run belongs to the leg workflow (path ends with
 * '/<workflowFile>') — validation CI or kicker runs on the same branch
 * must never influence the guard.
 */
function isLegRun(run, workflowFile) {
    if (!run) return false;
    var suffix = '/' + String(workflowFile || DEFAULT_LEG_WORKFLOW);
    var path = String(run.path || '');
    return path.length >= suffix.length &&
        path.slice(path.length - suffix.length) === suffix;
}

/**
 * Run timestamp (updated_at wins over created_at) as epoch-ms; null when
 * the run carries no parsable timestamp.
 */
function runTimestampMs(run) {
    var value = run && (run.updated_at || run.created_at);
    if (!value) return null;
    var ms = Date.parse(String(value));
    return isNaN(ms) ? null : ms;
}

/**
 * gh-1028 zombie parity: a NON-in_progress run whose last timestamp is
 * older than the stale bound owns nothing. in_progress runs are never
 * stale here (the caller gates on that).
 */
function isStaleNonRunning(run, nowMs, staleMs) {
    if (run && run.status === 'in_progress') return false;
    var ts = runTimestampMs(run);
    if (ts === null || nowMs === null) return false;
    return (nowMs - ts) > staleMs;
}

/**
 * The shared freshness check of both gates: an ACTIVE run (membership in
 * the CALLER's activeStates list) that is not a stale non-running zombie.
 *
 * @param {Object} run         the workflow run payload
 * @param {string[]} activeStates the caller's ACTIVE_RUN_STATES vocabulary
 * @param {number|null} nowMs  epoch-ms reference time
 * @param {number} staleMs     stale bound for non-running active states
 */
function isFreshActiveRun(run, activeStates, nowMs, staleMs) {
    if (!run || !activeStates || activeStates.indexOf(run.status) === -1) return false;
    if (run.status !== 'in_progress' && nowMs !== null &&
        isStaleNonRunning(run, nowMs, staleMs)) return false;
    return true;
}

/**
 * Binds the freshness vocabulary to the caller's active-state list: one
 * factory call replaces the per-module delegate wrapper blocks the three
 * sibling probes used to carry (gh-1248 dedup — those byte-identical
 * wrapper trios tripped the duplication gate). The returned probes close
 * over the given list; legRunVocab itself stays pure.
 */
function makeRunProbes(activeStates) {
    return {
        isActiveStatus: function(status) { return activeStates.indexOf(status) !== -1; },
        runTimestampMs: runTimestampMs,
        isStaleNonRunning: isStaleNonRunning,
        isFreshActiveRun: function(run, nowMs, staleMs) {
            return isFreshActiveRun(run, activeStates, nowMs, staleMs);
        }
    };
}

module.exports = {
    DEFAULT_LEG_WORKFLOW: DEFAULT_LEG_WORKFLOW,
    isLegRun: isLegRun,
    runTimestampMs: runTimestampMs,
    isStaleNonRunning: isStaleNonRunning,
    isFreshActiveRun: isFreshActiveRun,
    makeRunProbes: makeRunProbes
};
