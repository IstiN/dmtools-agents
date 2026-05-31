/**
 * Recover Failed Test Cases after bug triage.
 *
 * If a Failed TC already has linked non-Done Bugs, it must not stay in Failed
 * waiting for bug_creation again. Move it to Bug To Fix while any linked bug is
 * still active. Done Bugs are historical context only; they must not suppress
 * new bug creation.
 */

const { STATUSES } = require('./config.js');

function removeLabel(ticketKey, label) {
    if (!ticketKey || !label) return;
    try {
        jira_remove_label({ key: ticketKey, label: label });
        console.log('Removed label:', label);
    } catch (e) {}
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        throw new Error('params.ticket.key is missing');
    }

    console.log('=== Failed TC bug status recovery for', ticketKey, '===');

    var linkedBugs = jira_search_by_jql({
        jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = Bug AND status not in (Done)',
        maxResults: 50
    }) || [];

    if (linkedBugs.length === 0) {
        console.log('No linked non-Done Bugs found for', ticketKey);
        // The old single bug_creation rule is disabled, but its trigger label
        // can remain on Failed TCs and exclude them from bulk_bugs_creation JQL.
        // Clear only that stale single-run label so the active bulk path can
        // pick the TC up on the next SM pass.
        removeLabel(ticketKey, 'sm_bug_creation_triggered');
        return { success: true, action: 'released_for_bulk_bug_creation', ticketKey: ticketKey };
    }

    jira_move_to_status({ key: ticketKey, statusName: STATUSES.BUG_TO_FIX });
    console.log('Moved', ticketKey, 'to', STATUSES.BUG_TO_FIX);

    removeLabel(ticketKey, 'sm_bug_creation_triggered');
    removeLabel(ticketKey, 'sm_bulk_bugs_creation_triggered');
    removeLabel(ticketKey, 'sm_test_automation_triggered');

    jira_post_comment({
        key: ticketKey,
        comment: 'h3. 🐛 Linked Non-Done Bug Found — Moved to Bug To Fix\n\n' +
            'This failed test case already has linked non-Done Bug issue(s), so it was moved to *' +
            STATUSES.BUG_TO_FIX + '* instead of staying in *Failed* and re-running bug creation.'
    });

    return {
        success: true,
        action: 'moved_to_bug_to_fix',
        ticketKey: ticketKey,
        linkedBugs: linkedBugs.length
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
