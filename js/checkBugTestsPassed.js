/**
 * Check Bug Tests Passed — postJSAction for bug_done_check agent.
 *
 * Runs on every SM cycle for each Bug in "In Testing".
 * - If all linked Test Cases are in "Passed" status → moves the Bug to Done.
 * - Otherwise → removes the SM idempotency label so the SM re-triggers
 *   this check on the next cycle.
 */

const { STATUSES } = require('./config.js');
const configLoader = require('./configLoader.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;

    // Load project config to get testCaseIssueType (default: "Test Case")
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const testCaseType = projectConfig.jira.issueTypes.TEST_CASE || 'Test Case';

    // Helper: remove SM label so the check re-runs on the next SM cycle
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
        console.log('=== Bug done check for', ticketKey, '===');

        // Step 1: Find all linked Test Cases for this bug
        // jira_search_by_jql returns a plain array
        const allTCs = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "' + testCaseType + '"',
            maxResults: 100
        }) || [];

        const totalTCs = allTCs.length;
        console.log('Linked Test Cases:', totalTCs);

        if (totalTCs === 0) {
            console.log('No linked Test Cases found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_test_cases', ticketKey };
        }

        // Step 2: Find linked Test Cases that are NOT yet Passed
        const notPassedTCs = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "' + testCaseType + '" AND status not in ("Passed")',
            maxResults: 1
        }) || [];

        const notPassedCount = notPassedTCs.length;

        console.log('Test Cases not yet Passed:', notPassedCount, '/', totalTCs);

        if (notPassedCount > 0) {
            console.log('Not all Test Cases passed — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', totalTCs, notPassedCount, ticketKey };
        }

        // Step 3: All Test Cases are Passed — move Bug to Done
        console.log('All', totalTCs, 'Test Case(s) passed — moving', ticketKey, 'to Done');

        jira_move_to_status({
            key: ticketKey,
            statusName: STATUSES.DONE
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Bug Complete — All Test Cases Passed\n\n' +
                'All *' + totalTCs + '* linked Test Case(s) are in *Passed* status.\n\n' +
                'The bug has been automatically moved to *Done*.'
        });

        console.log('✅ Bug', ticketKey, 'moved to Done');
        return { success: true, action: 'moved_to_done', totalTCs, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkBugTestsPassed:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
