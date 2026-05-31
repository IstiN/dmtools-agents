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
const { STATUSES, LABELS } = require('./config.js');

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

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var config = configLoader.loadProjectConfig(params.jobParams || params || {});

    if (!ticketKey) {
        console.error('No ticket key found');
        return { success: false, error: 'missing ticket key' };
    }

    console.log('Recovering stuck Test Case:', ticketKey);

    var scm = scmModule.createScm(config);
    var pr = findPRForTicket(scm, ticketKey);

    if (!pr) {
        console.log('No open PR found for', ticketKey, '— moving back to Backlog');
        try {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.BACKLOG });
            console.log('✅ Moved', ticketKey, 'to Backlog');
        } catch (e) {
            console.error('Failed to move to Backlog:', e);
        }
        // Remove automation label so SM can re-trigger
        try { jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' }); } catch (e) {}
        jira_post_comment({
            key: ticketKey,
            comment: '🔄 *Recovery*: Test Case was stuck in "In Development" with no open PR. Moved back to Backlog for re-automation.'
        });
        return { success: true, action: 'moved_to_backlog', ticketKey: ticketKey };
    }

    console.log('Found open PR #' + pr.number + ': ' + pr.title);

    // Get detailed PR info to check merge state
    var prDetail;
    try {
        prDetail = scm.getPr(pr.number);
    } catch (e) {
        console.error('Failed to get PR details:', e);
        prDetail = pr;
    }

    var mergeableState = prDetail && (prDetail.mergeable_state || prDetail.mergeableState || '');
    var mergeable = prDetail && prDetail.mergeable;
    console.log('PR #' + pr.number + ' mergeable=' + mergeable + ' state=' + mergeableState);

    if (mergeableState === 'dirty' || mergeableState === 'conflicting' || mergeable === false) {
        console.log('PR has conflicts — moving ticket to In Rework');
        try {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REWORK });
            console.log('✅ Moved', ticketKey, 'to In Rework');
        } catch (e) {
            console.error('Failed to move to In Rework:', e);
        }
        // Remove stale labels so rework agent can pick it up
        try { jira_remove_label({ key: ticketKey, label: 'sm_test_rework_triggered' }); } catch (e) {}
        try { jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' }); } catch (e) {}
        jira_post_comment({
            key: ticketKey,
            comment: '🔄 *Recovery*: Test Case was stuck in "In Development" with a conflicting PR #' + pr.number + '. Moved to In Rework for conflict resolution.'
        });
        return { success: true, action: 'moved_to_rework', ticketKey: ticketKey, prNumber: pr.number };
    }

    // PR is clean/mergeable — move to In Review - Passed for review
    console.log('PR looks clean — moving ticket to In Review - Passed');
    try {
        jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REVIEW_PASSED });
        console.log('✅ Moved', ticketKey, 'to In Review - Passed');
    } catch (e) {
        console.error('Failed to move to In Review - Passed:', e);
    }
    try { jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' }); } catch (e) {}
    jira_post_comment({
        key: ticketKey,
        comment: '🔄 *Recovery*: Test Case was stuck in "In Development" with clean PR #' + pr.number + '. Moved to In Review - Passed for code review.'
    });
    return { success: true, action: 'moved_to_review', ticketKey: ticketKey, prNumber: pr.number };
}

module.exports = { action };
