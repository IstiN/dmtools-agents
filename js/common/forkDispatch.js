/**
 * Fork-PR dispatch contract (gh-1075) — the pure half of the SM's
 * cross-repo dispatch lane.
 *
 * Live fa PR #1591 (YuryBY fork) 2026-10-19T06:16Z: `pr-1591 dispatch
 * dead-head (5/3 no-ref failures on fix/android-dap-home-sandbox) —
 * validation_failed park`. The fork branch NEVER exists in the base repo,
 * so a `workflow_dispatch` with `ref: <fork-branch>` answers 422 "No ref
 * found" on EVERY tick — the gh-922 no-ref bookkeeping (correct for
 * same-repo heads) accumulated markers and parked a perfectly live PR: a
 * fork PR was permanently undispatchable and every guest contribution
 * dead-ended there. The third fork-blind lane after #1057 (park oracle)
 * and #1070 (silent-update).
 *
 * The contract (owner ask, v1):
 *
 *   dispatchPlan(expandedRef, item, baseOwner, baseRepo) — UT-1/AC1: a
 *      HEAD-TARGETED dispatch (the rule expanded `workflowRef={branch}`
 *      onto the item's branch) for a CROSS-REPO PR reroutes onto the base
 *      repo's standard machine ref and carries a `refs/pull/<N>/head`
 *      checkout plan — the pull ref is always fetchable on the base repo,
 *      even when the fork branch is deleted. Same-repo PRs (and rules
 *      that never targeted the head) return the plan UNCHANGED — today's
 *      `ref: <branch>` dispatch is the regression guard.
 *   classifyForkNoRef(pullRefFetchable) — UT-2: the fork head's liveness
 *      oracle is the pull ref (#1057), never the branch name. A 422 naming
 *      a fork branch with a FETCHABLE pull ref is NOT head-dead (AC2 — no
 *      trigger-failure markers, no park); an UNFETCHABLE pull ref is a
 *      genuinely dead head (AC3 — parks via the existing gh-922 no-ref
 *      path, keyed on the pull ref).
 *
 * Pure functions, no tool globals — smAgent wires the transport (the
 * ls-remote pull-ref probe and the dispatch), tests inject nothing.
 * CommonJS module like every other js/ module. GraalJS rules apply:
 * var + plain functions only.
 */

'use strict';

var validationLivenessModule = require('./validationLiveness.js');

// The base repo's standard machine ref — the SM's universal dispatch
// fallback (smAgent triggerWorkflow: `rule.workflowRef || 'main'`). A
// fork-PR leg runs the BASE repo's workflow copy (untrusted fork code is
// never executed — non-goal of the card), so the dispatch ref only needs
// to resolve in the base repo.
var BASE_MACHINE_REF = 'main';

// The always-fetchable head of PR <N> on the base repo — GitHub serves
// refs/pull/<N>/head regardless of where the fork branch lives or whether
// it still exists at all (gh-1057's oracle, now the checkout plan).
function pullHeadRef(prNumber) {
    return 'refs/pull/' + prNumber + '/head';
}

// The head repository as an 'owner/repo' full name when (and only when)
// the PR is CROSS-REPO. Delegates to the ONE shared gh-1070 resolver
// (validationLiveness.forkHeadFull): case-insensitive same-repo compare
// (config casing vs API casing must never reclassify a same-repo PR as a
// fork), null/malformed headRepo fails closed to same-repo (the base
// probe — a deleted fork's REST payload carries head.repo:null, exactly
// the genuinely-dead-head shape AC3 parks through the pull-ref probe).
function forkFullOf(item, baseOwner, baseRepo) {
    var head = item && (item.headRepo || (item.pr && item.pr.headRepo));
    return validationLivenessModule.forkHeadFull(head, baseOwner, baseRepo);
}

// UT-1 / AC1 — the dispatch plan for one candidate. `expandedRef` is the
// rule's workflowRef AFTER placeholder expansion ({branch}/{prNumber});
// `item` is the normalized source item (githubSource shape: prNumber,
// branch, headRepo). Returns { ref, checkoutRef } — checkoutRef is null
// whenever the plan is unchanged (same-repo PR, non-head-targeted rule,
// missing head data), so the caller adds NO new inputs on those paths.
function dispatchPlan(expandedRef, item, baseOwner, baseRepo) {
    var plan = { ref: String(expandedRef == null ? '' : expandedRef), checkoutRef: null };
    if (!item || !item.branch || !item.prNumber) return plan;
    // Only a dispatch that TARGETED the item's head ref reroutes: a
    // 'main'-ref (or '{prNumber}') rule dispatches where it always did.
    if (plan.ref !== String(item.branch)) return plan;
    if (!forkFullOf(item, baseOwner, baseRepo)) return plan; // same-repo regression guard
    plan.ref = BASE_MACHINE_REF;
    plan.checkoutRef = pullHeadRef(item.prNumber);
    return plan;
}

// UT-2 / AC2+AC3 — the no-ref verdict for a CROSS-REPO head. Reached only
// when the raw error already classified 'no-ref' (triggerFailures.
// classifyTriggerError); `pullRefFetchable` is the refs/pull/<N>/head
// probe result. The branch name is never the oracle for forks: it may
// exist on the fork while the PR is live, and it may be absent in the
// base repo while the PR is live — only the pull ref tells the truth.
//   'live' — fetchable: NOT head-dead; the SM records nothing (AC2).
//   'dead' — unfetchable: the fork is gone entirely; the caller runs the
//            existing gh-922 marker+park path keyed on the pull ref (AC3).
function classifyForkNoRef(pullRefFetchable) {
    return pullRefFetchable ? 'live' : 'dead';
}

module.exports = {
    BASE_MACHINE_REF: BASE_MACHINE_REF,
    pullHeadRef: pullHeadRef,
    forkFullOf: forkFullOf,
    dispatchPlan: dispatchPlan,
    classifyForkNoRef: classifyForkNoRef
};
