/**
 * Check Bug To Fix Ready — postJSAction for bug_to_fix_check agent.
 *
 * Runs on every SM cycle for each Test Case in "Bug To Fix" status.
 * - Finds all linked Bugs.
 * - If all linked Bugs are in "Done" → moves TC to "Backlog" (ready for re-automation).
 * - Otherwise → removes the SM idempotency label so the check re-runs next cycle.
 */

const { STATUSES } = require('./config.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;

    function releaseLock() {
        if (ticketKey && removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('Released SM label — will re-check next cycle');
            } catch (e) {
                console.warn('Failed to remove SM label:', e);
            }
        }
    }

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Bug To Fix ready check for', ticketKey, '===');

        // Step 1: Find all linked Bugs for this TC
        const linkedBugs = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = Bug',
            maxResults: 50
        }) || [];

        const totalBugs = linkedBugs.length;
        console.log('Linked Bugs:', totalBugs);

        if (totalBugs === 0) {
            console.log('No linked Bugs found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_linked_bugs', ticketKey };
        }

        // Step 2: Find linked Bugs NOT yet Done via JQL (more reliable than client-side field check)
        const notDoneBugs = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = Bug AND status != "Done"',
            maxResults: 1
        }) || [];

        const notDoneCount = notDoneBugs.length;
        console.log('Linked Bugs not yet Done:', notDoneCount, '/', totalBugs);

        if (notDoneCount > 0) {
            console.log('Not all linked Bugs are Done — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', total: totalBugs, notDone: notDoneCount, ticketKey };
        }

        // All linked Bugs are Done → move TC back to Backlog
        console.log('All', totalBugs, 'linked Bug(s) are Done — moving', ticketKey, 'to Backlog');

        jira_move_to_status({
            key: ticketKey,
            statusName: 'Backlog'
        });

        // Remove test automation label so SM can re-trigger automation
        try {
            jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' });
            console.log('Removed sm_test_automation_triggered — TC will be re-automated next SM cycle');
        } catch (e) {
            console.warn('Failed to remove sm_test_automation_triggered label:', e);
        }

        releaseLock();

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. 🔄 Test Case Ready for Re-automation\n\n' +
                'All *' + totalBugs + '* linked Bug(s) are now in *Done* status.\n\n' +
                'This Test Case has been automatically moved back to *Backlog* to be re-automated against the fixed code.'
        });

        console.log('✅ TC', ticketKey, 'moved to Backlog');
        return { success: true, action: 'moved_to_backlog', totalBugs: totalBugs, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkBugToFixReady:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
