/**
 * Check Story Tests Passed — postJSAction for story_done_check agent.
 *
 * Runs on every SM cycle for each Story in "In Testing".
 * - If all linked Test Cases are in "Passed" status → moves the Story to Done.
 * - Otherwise → removes the SM idempotency label so the SM re-triggers
 *   this check on the next cycle.
 */

const { STATUSES } = require('./config.js');

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        console.log('=== Story done check for', ticketKey, '===');

        const customParams = params.jobParams && params.jobParams.customParams;
        const removeLabel = customParams && customParams.removeLabel;

        // Helper: remove SM label so the check re-runs on the next SM cycle
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

        // Step 1: Find all linked Test Cases for this story
        const allTCsResult = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "Test Case"',
            maxResults: 100
        });

        const totalTCs = allTCsResult ? (allTCsResult.total || (allTCsResult.issues && allTCsResult.issues.length) || 0) : 0;
        console.log('Linked Test Cases:', totalTCs);

        if (totalTCs === 0) {
            console.log('No linked Test Cases found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_test_cases', ticketKey };
        }

        // Step 2: Find linked Test Cases that are NOT yet Passed
        const notPassedResult = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "Test Case" AND status != "Passed"',
            maxResults: 1
        });

        const notPassedCount = notPassedResult
            ? (notPassedResult.total || (notPassedResult.issues && notPassedResult.issues.length) || 0)
            : 0;

        console.log('Test Cases not yet Passed:', notPassedCount, '/', totalTCs);

        if (notPassedCount > 0) {
            console.log('Not all Test Cases passed — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', totalTCs, notPassedCount, ticketKey };
        }

        // Step 3: All Test Cases are Passed — move Story to Done
        console.log('All', totalTCs, 'Test Case(s) passed — moving', ticketKey, 'to Done');

        jira_move_to_status({
            key: ticketKey,
            statusName: STATUSES.DONE
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Story Complete — All Test Cases Passed\n\n' +
                'All *' + totalTCs + '* linked Test Case(s) are in *Passed* status.\n\n' +
                'The story has been automatically moved to *Done*.'
        });

        console.log('✅ Story', ticketKey, 'moved to Done');
        return { success: true, action: 'moved_to_done', totalTCs, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkStoryTestsPassed:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
