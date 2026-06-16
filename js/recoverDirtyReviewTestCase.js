/**
 * recoverDirtyReviewTestCase.js
 *
 * Local-execution recovery for Test Cases stuck in code review because the
 * underlying test-automation PR has become dirty (merge conflicts with main).
 *
 * The normal flow is:
 *   In Review - Passed/Failed -> pr_test_automation_review -> pr_approved -> merge
 *
 * When the PR is dirty, merge is impossible and review cannot complete. This
 * handler detects a dirty/conflicting PR and moves the ticket to "In Rework"
 * so the dedicated pr_test_automation_rework agent resolves the conflicts.
 */

var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
var { STATUSES } = require('./config.js');

function findOpenPRForTicket(scm, ticketKey) {
    try {
        var prList = scm.listPrs('open');
        return (Array.isArray(prList) ? prList : []).find(function(pr) {
            var titleMatch = pr.title && pr.title.indexOf(ticketKey) !== -1;
            var branchMatch = pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1;
            return titleMatch || branchMatch;
        }) || null;
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

    console.log('Recovering dirty-review Test Case:', ticketKey);

    var scm = scmModule.createScm(config);
    var pr = findOpenPRForTicket(scm, ticketKey);

    if (!pr) {
        console.log('No open PR found for', ticketKey, '— nothing to recover');
        return { success: true, action: 'no_pr', ticketKey: ticketKey };
    }

    console.log('Found open PR #' + pr.number + ': ' + pr.title);

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

    var isDirty = mergeableState === 'dirty' || mergeableState === 'conflicting' || mergeable === false;
    if (!isDirty) {
        console.log('PR #' + pr.number + ' is clean — no recovery needed');
        return { success: true, action: 'clean', ticketKey: ticketKey, prNumber: pr.number };
    }

    console.log('PR #' + pr.number + ' is dirty — moving ticket to In Rework for conflict resolution');
    try {
        jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REWORK });
        console.log('Moved', ticketKey, 'to In Rework');
    } catch (e) {
        console.error('Failed to move to In Rework:', e);
        return { success: false, error: e.toString(), ticketKey: ticketKey, prNumber: pr.number };
    }

    // Remove stale labels so the rework agent can pick it up
    try { jira_remove_label({ key: ticketKey, label: 'sm_test_rework_triggered' }); } catch (e) {}
    try { jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' }); } catch (e) {}
    try { jira_remove_label({ key: ticketKey, label: 'sm_test_review_triggered' }); } catch (e) {}

    try {
        jira_post_comment({
            key: ticketKey,
            comment: '🔄 *Recovery*: Test Case PR #' + pr.number + ' became dirty while in code review. Moved to In Rework so the test-automation rework agent can resolve the merge conflicts.'
        });
    } catch (e) {
        console.warn('Failed to post recovery comment:', e);
    }

    return { success: true, action: 'moved_to_rework', ticketKey: ticketKey, prNumber: pr.number };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
