/**
 * branchLegGuard.js — gh-1028 branch-keyed in-flight leg probe (pure side).
 *
 * Live evidence (dmtools-agents PR #1017 / gh-1000, 2026-10-18 08:04–08:09Z):
 * ONE rework cycle got TWO concurrent rework legs —
 *   run 39110030366 (08:04:12Z, PR-armed from rework-on-label) — its factory
 *     run title 'workflow_dispatch # rework' carries NO anchor token, so
 *     the title guards (gh-715 cross-anchor, gh-944 '#<n>' tokens) were
 *     blind to it from the issue-armed path;
 *   run 39110364398 (08:09:31Z, issue-armed from rework-on-red-ci) — between
 *     the dispatches the first leg pushed and the head moved
 *     (c2e0d28f → 94988905), so the gh-806 (pr, head) latch keyed a NEW
 *     head and never suppressed the second arm.
 * Both legs checkout/rewrite the same branch concurrently → token waste ×2
 * and a push race (the second pusher lands on a moved checkout).
 *
 * This module is the missing probe: the leg workflow dispatched with
 * workflowRef={branch} lands ON the PR branch and is the branch's SINGLE
 * WRITER — so an ACTIVE run of the leg workflow whose head_branch IS the
 * dispatch branch, REGARDLESS of head_sha, means the branch is owned and
 * no second leg may be dispatched onto it. Both rework dispatch arms
 * (issue-anchored rework-on-red-ci and PR-anchored rework-on-label) flow
 * through smAgent.triggerWorkflow, so one gate there covers both paths —
 * AC1 (one leg per PR per rework cycle) and AC2 (a head move between
 * dispatches does not bypass the probe) by construction.
 *
 * Pure functions, no tool globals — smAgent wires the transport (the
 * scm.listWorkflowRuns per-status fan-out), tests inject nothing.
 * GraalJS-clean: var + plain functions, JSON-safe data only.
 */

'use strict';

// The rework/review/dev leg workflow — the same default the dispatch side
// (smAgent triggerWorkflow) and the gh-806 latch use.
var DEFAULT_LEG_WORKFLOW = 'ai-teammate.yml';

// Active-state vocabulary — one list, the validationLiveness shape the rest
// of the engine already uses.
var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending'];

// gh-806-adjacent stale bound for NON-running active states: a run stuck
// 'queued' (never materialized, superseded in the concurrency group, dead
// runner) for longer than this owns nothing — the dead dispatch self-heals
// and the next arm may fire. Mirrors smAgent's
// STALE_NON_RUNNING_WORKFLOW_MS (6h). in_progress runs NEVER age out here:
// a live leg owns the branch past any window.
var DEFAULT_STALE_NON_RUNNING_MS = 6 * 60 * 60 * 1000;

function workflowFileOf(opts) {
    var wf = opts && opts.workflowFile;
    return (wf && typeof wf === 'string') ? wf : DEFAULT_LEG_WORKFLOW;
}

/**
 * True when the run belongs to the leg workflow (path ends with
 * '/<workflowFile>') — reworkLatch.isLegRun parity: validation CI or
 * kicker runs on the same branch must never influence the guard.
 */
function isLegRun(run, workflowFile) {
    if (!run) return false;
    var suffix = '/' + String(workflowFile || DEFAULT_LEG_WORKFLOW);
    var path = String(run.path || '');
    return path.length >= suffix.length &&
        path.slice(path.length - suffix.length) === suffix;
}

function isActiveStatus(status) {
    return ACTIVE_RUN_STATES.indexOf(status) !== -1;
}

function runTimestampMs(run) {
    var value = run && (run.updated_at || run.created_at);
    if (!value) return null;
    var ms = Date.parse(String(value));
    return isNaN(ms) ? null : ms;
}

/**
 * Non-in_progress active state aged past the stale bound — a queued/waiting/
 * pending run whose last timestamp is older than staleNonRunningMs. An
 * in_progress run is never stale here (the caller gates on that).
 */
function isStaleNonRunning(run, nowMs, staleMs) {
    if (run && run.status === 'in_progress') return false;
    var ts = runTimestampMs(run);
    if (ts === null || nowMs === null) return false;
    return (nowMs - ts) > staleMs;
}

/**
 * Exact branch match, type-tolerant (REST payloads carry strings, some
 * bridges coerce). A run without head_branch never matches — the title-
 * only run payloads the budget probes consume stay inert.
 */
function matchesBranch(run, branch) {
    if (!run || run.head_branch === undefined || run.head_branch === null) return false;
    return String(run.head_branch) === String(branch);
}

/**
 * THE GATE (gh-1028): is a leg in flight on `branch`? True iff some run is
 *   - an ACTIVE status (queued/in_progress/waiting/pending), not a stale
 *     non-running zombie (aged out past staleNonRunningMs; in_progress
 *     never ages out);
 *   - a run of the leg workflow (path suffix);
 *   - on EXACTLY this branch (head_branch equality) — REGARDLESS of
 *     head_sha, so a head move between dispatches cannot bypass it (AC2).
 *
 * opts: workflowFile (default ai-teammate.yml), staleNonRunningMs
 * (default 6h), nowMs (default Date.now()). A caller without a clock
 * degrades to fail-closed: without nowMs no run can be proven stale, so
 * every active run counts — one deferred dispatch beats a stacked leg.
 */
function staleMsOf(opts) {
    return (opts && typeof opts.staleNonRunningMs === 'number' && opts.staleNonRunningMs > 0)
        ? opts.staleNonRunningMs : DEFAULT_STALE_NON_RUNNING_MS;
}

function nowMsOf(opts) {
    return (opts && typeof opts.nowMs === 'number' && !isNaN(opts.nowMs))
        ? opts.nowMs : null;
}

/** One run owns the branch: active, non-stale, the leg workflow, on-branch. */
function legRunOwnsBranch(run, branch, workflowFile, nowMs, staleMs) {
    if (!run || !isActiveStatus(run.status)) return false;
    if (run.status !== 'in_progress' && nowMs !== null &&
        isStaleNonRunning(run, nowMs, staleMs)) return false;
    return isLegRun(run, workflowFile) && matchesBranch(run, branch);
}

function hasActiveLegRunOnBranch(runs, branch, opts) {
    if (!branch || typeof branch !== 'string' || !Array.isArray(runs)) return false;
    var workflowFile = workflowFileOf(opts);
    var staleMs = staleMsOf(opts);
    var nowMs = nowMsOf(opts);
    for (var i = 0; i < runs.length; i++) {
        if (legRunOwnsBranch(runs[i], branch, workflowFile, nowMs, staleMs)) return true;
    }
    return false;
}

// ── gh-1075 fork reroute: the pull-keyed leg probe ──────────────────────────
// A rerouted fork-PR dispatch lands on the base machine ref ('main'), so the
// run's head_branch is 'main' — SHARED by every fork dispatch in the repo.
// Keying the gh-1028 probe on 'main' would serialize unrelated fork legs,
// and keying it on refs/pull/<N>/head matches nothing (GitHub records the
// DISPATCH ref as head_branch, never the checkout plan). The per-PR
// discriminator is the run-title pr anchor: the leg workflow's run-name
// renders '▶ <leg> (SM) · pr-<N>' whenever inputs.pr is set — which the
// gh-1075 fork path ALWAYS backfills. Forward-compat: a run whose
// head_branch IS the pull ref (a leg dispatched directly on it) also
// counts.

// The always-fetchable head of PR <N> on the base repo (forkDispatch.
// pullHeadRef parity — kept as a literal here to keep this module
// dependency-free).
function pullHeadRefOf(prNumber) {
    return 'refs/pull/' + prNumber + '/head';
}

// Whole-token 'pr-<N>' search in a run title ('▶ rework (SM) · pr-1591').
// Boundary rules mirror smAgent.stubAnchorMatches: a trailing key char
// (digit/'-') rejects ('pr-1591' never matches 'pr-15910'), and a
// letter/'-' prefix rejects ('pr-1591' never matches 'gh-pr-1591-x').
function titleHasPrToken(title, prNumber) {
    var s = String(title || '');
    var token = '[REDACTED:Sensitive Value]' + prNumber;
    var from = 0;
    while (from <= s.length - token.length) {
        var idx = s.indexOf(token, from);
        if (idx === -1) break;
        var next = s.charAt(idx + token.length);
        var prev = idx > 0 ? s.charAt(idx - 1) : '';
        var nextOk = !((next >= '0' && next <= '9') || next === '-');
        var prevOk = !((prev >= 'a' && prev <= 'z') || (prev >= 'A' && prev <= 'Z') ||
            (prev >= '0' && prev <= '9') || prev === '-' || prev === '#');
        if (nextOk && prevOk) return true;
        from = idx + 1;
    }
    return false;
}

function runTitleOf(run) {
    return (run && (run.display_title || run.displayTitle || run.name)) || '';
}

/** One run owns the PR's fork head: active, non-stale, the leg workflow,
 * and (head_branch IS the pull ref OR the title carries the pr anchor). */
function legRunOwnsPull(run, prNumber, workflowFile, nowMs, staleMs) {
    if (!run || !isActiveStatus(run.status)) return false;
    if (run.status !== 'in_progress' && nowMs !== null &&
        isStaleNonRunning(run, nowMs, staleMs)) return false;
    if (!isLegRun(run, workflowFile)) return false;
    if (matchesBranch(run, pullHeadRefOf(prNumber))) return true;
    return titleHasPrToken(runTitleOf(run), prNumber);
}

/** THE FORK GATE (gh-1075): is a leg in flight for THIS PR's fork head?
 * Same active/stale/workfile vocabulary as hasActiveLegRunOnBranch; the
 * match keys on the pull ref or the run-title pr anchor instead of the
 * branch name. opts identical to hasActiveLegRunOnBranch. */
function hasActiveLegRunForPull(runs, prNumber, opts) {
    if (!prNumber || !Array.isArray(runs)) return false;
    var workflowFile = workflowFileOf(opts);
    var staleMs = staleMsOf(opts);
    var nowMs = nowMsOf(opts);
    for (var i = 0; i < runs.length; i++) {
        if (legRunOwnsPull(runs[i], prNumber, workflowFile, nowMs, staleMs)) return true;
    }
    return false;
}

module.exports = {
    DEFAULT_LEG_WORKFLOW: DEFAULT_LEG_WORKFLOW,
    ACTIVE_RUN_STATES: ACTIVE_RUN_STATES,
    DEFAULT_STALE_NON_RUNNING_MS: DEFAULT_STALE_NON_RUNNING_MS,
    isLegRun: isLegRun,
    isActiveStatus: isActiveStatus,
    isStaleNonRunning: isStaleNonRunning,
    matchesBranch: matchesBranch,
    legRunOwnsBranch: legRunOwnsBranch,
    hasActiveLegRunOnBranch: hasActiveLegRunOnBranch
};
