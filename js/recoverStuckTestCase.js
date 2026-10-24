/**
 * recoverStuckTestCase.js
 *
 * Local-execution recovery for Test Cases stuck in "In Development".
 *
 * When test_case_automation creates a PR but the postJSAction fails to
 * transition the ticket (agent crash, timeout, etc.), the TC stays
 * in "In Development" with no SM rule to advance it.
 *
 * This handler:
 *  1. Looks for an open PR matching the ticket key.
 *  2. If PR exists and CONFLICTING → move ticket to "In Rework" so
 *     pr_test_automation_rework resolves the conflict.
 *  3. If PR exists and is mergeable/clean → move to "In Review - Passed"
 *     so the review agent picks it up.
 *  4. If no open PR exists → move back to "Backlog" and remove the
 *     sm_test_automation_triggered label so automation re-triggers.
 */

var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
const { LABELS } = require('./config.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackersModule = require('./common/trackers.js');

function findPRForTicket(scm, ticketKey) {
    try {
        var prList = scm.listPrs('open');
        var matched = (Array.isArray(prList) ? prList : []).find(function(pr) {
            var titleMatch = pr.title && pr.title.indexOf(ticketKey) !== -1;
            var branchMatch = pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1;
            return titleMatch || branchMatch;
        });
        return matched || null;
    } catch (e) {
        console.error('Failed to list PRs:', e);
        return null;
    }
}

// ── gh-1186: pure/decide helpers (extracted from action) ────────────────────

/**
 * Resolves the recovery context from params: ticket key, project config and
 * the tracker instance. Pure over params apart from the config/tracker loads.
 */
function resolveRecoveryContext(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var config = configLoader.loadProjectConfig(params.jobParams || params || {});
    var tracker = trackersModule.createTracker(config, (params.jobParams && params.jobParams.customParams) || params.customParams || {});
    return { ticketKey: ticketKey, config: config, jiraConfig: config.jira, tracker: tracker };
}

/**
 * PR details tolerant of provider errors: on failure the list PR itself is
 * used, so classification downstream still has the mergeable fields (missing
 * ones read as a clean PR).
 */
function fetchPrDetailSafe(scm, pr) {
    try {
        return scm.getPr(pr.number);
    } catch (e) {
        console.error('Failed to get PR details:', e);
        return pr;
    }
}

/**
 * Mergeable state as a string: snake_case (github) first, camelCase (ado)
 * fallback, '' when neither is present; null only without any PR detail.
 */
function mergeableStateOf(prDetail) {
    return prDetail && (prDetail.mergeable_state || prDetail.mergeableState || '');
}

/**
 * Pure conflict decision: the state names a conflict, or the provider
 * explicitly answered mergeable=false.
 */
function isConflictingPrState(mergeable, mergeableState) {
    return mergeableState === 'dirty' || mergeableState === 'conflicting' || mergeable === false;
}

// ── gh-1186: recovery outcomes (one per recovery branch) ────────────────────

/** No open PR — back to Backlog, automation label off so the SM re-triggers. */
function recoverWithoutOpenPr(ctx) {
    console.log('No open PR found for', ctx.ticketKey, '— moving back to Backlog');
    try {
        ctx.tracker.moveToStatus(ctx.ticketKey, ctx.jiraConfig.statuses.BACKLOG);
        console.log('✅ Moved', ctx.ticketKey, 'to Backlog');
    } catch (e) {
        console.error('Failed to move to Backlog:', e);
    }
    // Remove automation label so SM can re-trigger
    try { ctx.tracker.removeLabel(ctx.ticketKey, 'sm_test_automation_triggered'); } catch (e) {}
    ctx.tracker.postComment(ctx.ticketKey, '🔄 *Recovery*: Test Case was stuck in "In Development" with no open PR. Moved back to Backlog for re-automation.'
    );
    return { success: true, action: 'moved_to_backlog', ticketKey: ctx.ticketKey };
}

/** Conflicting PR — to In Rework so pr_test_automation_rework resolves it. */
function moveToReworkRecovery(ctx, pr) {
    console.log('PR has conflicts — moving ticket to In Rework');
    try {
        ctx.tracker.moveToStatus(ctx.ticketKey, ctx.jiraConfig.statuses.IN_REWORK);
        console.log('✅ Moved', ctx.ticketKey, 'to In Rework');
    } catch (e) {
        console.error('Failed to move to In Rework:', e);
    }
    // Remove stale labels so rework agent can pick it up
    try { ctx.tracker.removeLabel(ctx.ticketKey, 'sm_test_rework_triggered'); } catch (e) {}
    try { ctx.tracker.removeLabel(ctx.ticketKey, 'sm_test_automation_triggered'); } catch (e) {}
    ctx.tracker.postComment(ctx.ticketKey, '🔄 *Recovery*: Test Case was stuck in "In Development" with a conflicting PR #' + pr.number + '. Moved to In Rework for conflict resolution.'
    );
    return { success: true, action: 'moved_to_rework', ticketKey: ctx.ticketKey, prNumber: pr.number };
}

/**
 * Clean PR — to In Review - Passed (gh-916: tag-only stage fallback) for
 * code review, plus the token usage summary comments when any provider
 * wrote outputs/*_usage.json during the agent run.
 */
function moveToReviewRecovery(params, ctx, pr) {
    console.log('PR looks clean — moving ticket to In Review - Passed');
    try {
        // gh-916: IN_REVIEW_PASSED can be tag-only (restricted ADO workflows) — stage-label fallback.
        var moveResult = ctx.tracker.moveToStatusOrMark(ctx.ticketKey, ctx.jiraConfig.statuses.IN_REVIEW_PASSED, 'IN_REVIEW_PASSED');
        if (moveResult.moved || moveResult.marked) {
            console.log('✅ Moved', ctx.ticketKey, 'to In Review - Passed');
        }
    } catch (e) {
        console.error('Failed to move to In Review - Passed:', e);
    }
    try { ctx.tracker.removeLabel(ctx.ticketKey, 'sm_test_automation_triggered'); } catch (e) {}
    ctx.tracker.postComment(ctx.ticketKey, '🔄 *Recovery*: Test Case was stuck in "In Development" with clean PR #' + pr.number + '. Moved to In Review - Passed for code review.'
    );

    try {
        tokenUsageComment.postTokenUsageComments(ctx.ticketKey, { initiator: params.initiator, tracker: ctx.tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }

    return { success: true, action: 'moved_to_review', ticketKey: ctx.ticketKey, prNumber: pr.number };
}

function action(params) {
    var ctx = resolveRecoveryContext(params);

    if (!ctx.ticketKey) {
        console.error('No ticket key found');
        return { success: false, error: 'missing ticket key' };
    }

    console.log('Recovering stuck Test Case:', ctx.ticketKey);

    var scm = scmModule.createScm(ctx.config);
    var pr = findPRForTicket(scm, ctx.ticketKey);

    if (!pr) {
        return recoverWithoutOpenPr(ctx);
    }

    console.log('Found open PR #' + pr.number + ': ' + pr.title);

    // Get detailed PR info to check merge state
    var prDetail = fetchPrDetailSafe(scm, pr);

    var mergeableState = mergeableStateOf(prDetail);
    var mergeable = prDetail && prDetail.mergeable;
    console.log('PR #' + pr.number + ' mergeable=' + mergeable + ' state=' + mergeableState);

    if (isConflictingPrState(mergeable, mergeableState)) {
        return moveToReworkRecovery(ctx, pr);
    }

    // PR is clean/mergeable — move to In Review - Passed for review
    return moveToReviewRecovery(params, ctx, pr);
}

module.exports = {
    action: action,
    // gh-1186: helpers extracted from action — additive surface for unit tests.
    resolveRecoveryContext: resolveRecoveryContext,
    fetchPrDetailSafe: fetchPrDetailSafe,
    mergeableStateOf: mergeableStateOf,
    isConflictingPrState: isConflictingPrState,
    recoverWithoutOpenPr: recoverWithoutOpenPr,
    moveToReworkRecovery: moveToReworkRecovery,
    moveToReviewRecovery: moveToReviewRecovery
};
