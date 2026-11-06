/**
 * gh-1369: the terminal-PR guard for the rework-arming and reconcile paths.
 *
 * A MERGED or CLOSED PR is terminal — no machine leg can change it, so every
 * writer of machine rework state (the arm_rework action, the gh-840 restore
 * sweep, the gh-807 verdict reconcile) must exit BEFORE stamping labels or
 * comments. Live pathology (dmtools-agents PR #1368, 2026-11-05): the review
 * left 6 open non-gating threads; GitHub does not auto-resolve threads on
 * merge, so the rework-arming watcher stamped agent:rework on the MERGED PR
 * and armed a rework leg against shipped code.
 *
 * Pure module — no dmtools globals, JSON-safe in/out, trivially unit-tested.
 *
 * Fail-open doctrine: an unknown/absent state (a broken probe, a legacy
 * payload without `state`) is NOT terminal — the guards keep the legacy
 * semantics instead of silently disarming working paths.
 */

/**
 * Normalize a raw REST PR state string to the uppercase comparison form.
 * Returns the uppercased string, or null for anything non-string/empty —
 * callers must treat null as "unknown", never as a state.
 */
function normalizePrState(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    return raw.toUpperCase();
}

/**
 * Is this PR in a terminal state (merged or closed)?
 *
 * @param {string|null} rawState - the PR's `state` field (any case), or null
 * @param {boolean|null} rawMerged - the PR's `merged` flag, or null/undefined
 * @returns {boolean} true ONLY for a provably terminal PR; false (fail-open)
 *   when the state is unknown.
 */
function isTerminalPrState(rawState, rawMerged) {
    if (rawMerged === true) return true;
    var state = normalizePrState(rawState);
    if (!state) return false;
    return state === 'CLOSED' || state === 'MERGED';
}

module.exports = {
    normalizePrState: normalizePrState,
    isTerminalPrState: isTerminalPrState
};
