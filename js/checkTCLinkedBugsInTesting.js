/**
 * Check TC Linked Bugs In Testing — postJSAction for tc_rerun_trigger agent.
 *
 * Runs on every SM cycle for each Test Case in "Failed".
 * - Finds all linked Bugs.
 * - If all linked Bugs are in "In Testing" → moves TC to "Re-run".
 * - Otherwise → removes SM label so the check re-runs next cycle.
 */

const { STATUSES } = require('./config.js');

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        console.log('=== TC linked bugs check for', ticketKey, '===');

        const customParams = params.jobParams && params.jobParams.customParams;
        const removeLabel = customParams && customParams.removeLabel;

        function releaseLock() {
            if (removeLabel) {
                try {
                    jira_remove_label({ key: ticketKey, label: removeLabel });
                    console.log('Released SM label — will re-check next cycle');
                } catch (e) {
                    console.warn('Failed to remove SM label:', e);
                }
            }
        }

        // Find all linked Bugs for this TC
        const linkedBugs = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = Bug',
            fields: ['status', 'summary'],
            maxResults: 50
        }) || [];

        console.log('Linked Bugs:', linkedBugs.length);

        if (linkedBugs.length === 0) {
            console.log('No linked Bugs found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_linked_bugs', ticketKey };
        }

        // Check if all linked Bugs are in "In Testing"
        const notInTesting = linkedBugs.filter(function(bug) {
            return !bug.fields || !bug.fields.status || bug.fields.status.name !== STATUSES.IN_TESTING;
        });

        console.log('Linked Bugs not yet In Testing:', notInTesting.length, '/', linkedBugs.length);

        if (notInTesting.length > 0) {
            console.log('Not all linked Bugs are In Testing — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', total: linkedBugs.length, notInTesting: notInTesting.length, ticketKey };
        }

        // All linked Bugs are In Testing → move TC to Re-run
        console.log('All', linkedBugs.length, 'linked Bug(s) are In Testing — moving', ticketKey, 'to Re-run');

        jira_move_to_status({
            key: ticketKey,
            statusName: 'Re-run'
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. 🔄 Test Case Queued for Re-run\n\n' +
                'All *' + linkedBugs.length + '* linked Bug(s) are now in *In Testing* status.\n\n' +
                'This Test Case has been automatically moved to *Re-run* to verify the fix.'
        });

        console.log('✅ TC', ticketKey, 'moved to Re-run');
        return { success: true, action: 'moved_to_rerun', totalBugs: linkedBugs.length, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkTCLinkedBugsInTesting:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
