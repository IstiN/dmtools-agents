/**
 * Trigger-failure bookkeeping (gh-922) — the pure half of the SM's
 * fail-open dispatch.
 *
 * Live IstiN/flutter_agent_harness pr-1615 (2026-10-16 13:5x–15:2xZ): a
 * priority_blocker PR whose head ref was deleted on the fork failed every
 * workflow dispatch with HTTP 422 "No ref found for: fix/…". The SM
 * re-selected the same dead head every tick, the dispatch slot died with
 * it, and six non-blocker PRs starved for hours. The fix is fail-open at
 * three layers (owner ask): a failed trigger must not consume the slot
 * (the engine loop already gives failed candidates no slot credit — the
 * source over-fetches the fallthrough candidates), a priority blocker
 * that cannot be dispatched yields the slot, and after
 * jobParams.triggerFailParkCap (default 3) consecutive no-ref failures on
 * one head the PR parks validation_failed with a restore/re-push comment.
 *
 * This module carries the durable-record vocabulary only:
 *
 *   classifyTriggerError(message) — 'no-ref' (non-retryable, head-dead:
 *      the GitHub workflow_dispatch 422 "No ref found for: refs/<ref>"
 *      shape) vs 'transient' (everything else — rate limits, 5xx, auth).
 *      Only no-ref failures are head-dead evidence; they drive the marker
 *      counter and the park. Transient failures must never park a PR (a
 *      temporary API outage would otherwise park the whole fleet).
 *   triggerFailMarks(bodies)      — aggregate marker lines over comment
 *      bodies → { <branch>: <max attempt N> } (the zombie-marker carrier
 *      pattern: per-head state in plain PR comments, zero infrastructure).
 *   triggerFailMarkerLine(...)    — the grep-able marker line itself:
 *         ⚠️ trigger-failed <branch> — attempt N/cap at <iso>
 *      Keyed by the head BRANCH name (git refs cannot contain spaces): a
 *      re-push recreates the branch with a new head and the existing
 *      sticky-park RESET probes (human push newer than the park,
 *      parked-head sha change) own the clear.
 *   capOf(jobParams)              — jobParams.triggerFailParkCap, default
 *      3; 'false'/0 disables the marker+park bookkeeping entirely (the
 *      fail-open slot yield in the engine is independent of it).
 *
 * Pure functions, no tool globals — smAgent wires the transport, tests
 * inject nothing. CommonJS module like every other js/ module. GraalJS
 * rules apply: var + plain functions only.
 */

'use strict';

/**
 * Classify a workflow-dispatch error message.
 *   'no-ref'    — the ref the dispatch targeted does not exist (deleted
 *                 fork branch): GitHub answers HTTP 422 with
 *                 "No ref found for: refs/<ref>". Non-retryable for this
 *                 candidate until the ref is restored — exactly the
 *                 head-dead evidence the marker counter accumulates.
 *   'transient' — anything else (rate limit, 5xx, auth, transient API
 *                 failure): the candidate stays queued, no markers, no
 *                 park.
 */
function classifyTriggerError(message) {
    var s = String(message == null ? '' : message);
    if (/no ref found/i.test(s)) return 'no-ref';
    if (/\b422\b/.test(s) && /ref/i.test(s)) return 'no-ref';
    return 'transient';
}

// One standalone PR comment per recorded failure, carrying the marker line
// the next tick's counter re-reads (failMarkerState / zombie-marker
// parity — the same single github_get_pr_comments fetch family):
//
//   ⚠️ trigger-failed <branch> — attempt N/cap at <iso>
//
// The branch name keys the count: the failures are consecutive for THAT
// head ref by construction (every tick re-fails until the ref is restored
// or the cap parks the PR).
var TRIGGER_FAIL_MARKER_RE = /\u26A0\uFE0F trigger-failed (\S+) \u2014 attempt (\d+)\/\d+ at (\S+)/g;

/**
 * Aggregate marker lines over comment bodies → { <branch>: <max N> }.
 * Malformed lines and other branches' markers are ignored; the highest
 * attempt number wins (duplicate markers never inflate the count).
 */
function triggerFailMarks(bodies) {
    var map = {};
    (bodies || []).forEach(function (body) {
        var s = String(body == null ? '' : body);
        TRIGGER_FAIL_MARKER_RE.lastIndex = 0;
        var m;
        while ((m = TRIGGER_FAIL_MARKER_RE.exec(s)) !== null) {
            var branch = m[1];
            var n = parseInt(m[2], 10) || 0;
            if (n > (map[branch] || 0)) map[branch] = n;
        }
    });
    return map;
}

/**
 * The marker line for THIS failure (count = prior + 1 — the caller holds
 * the already-read marks; no second comment fetch).
 */
function triggerFailMarkerLine(count, branch, cap, atIso) {
    return '\u26A0\uFE0F trigger-failed ' + branch +
        ' \u2014 attempt ' + count + '/' + cap + ' at ' + (atIso || '');
}

/**
 * The dead-head park threshold: 3 consecutive no-ref failures on one head
 * (gh-922 ask 3, "suggest 3"). jobParams.triggerFailParkCap tunes it per
 * deployment; 0 / negative / 'false' disables the marker+park bookkeeping
 * (the engine's fail-open slot yield is independent of this cap).
 */
function capOf(jobParams) {
    if (String((jobParams || {}).triggerFailParkCap) === 'false') return 0;
    var n = (jobParams || {}).triggerFailParkCap;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    if (typeof n !== 'number' || isNaN(n) || n <= 0) return 3;
    return Math.floor(n);
}

module.exports = {
    classifyTriggerError: classifyTriggerError,
    triggerFailMarks: triggerFailMarks,
    triggerFailMarkerLine: triggerFailMarkerLine,
    capOf: capOf,
    TRIGGER_FAIL_MARKER_RE: TRIGGER_FAIL_MARKER_RE
};
