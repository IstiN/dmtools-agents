/**
 * Finish Test Cases Generation (postJSAction for test_cases_generator)
 *
 * After TestCasesGenerator has created the linked Test Case tickets:
 * 1. Make sure the Story is in Ready For Testing so story_test_automation can pick it up.
 * 2. Remove the sm_test_cases_triggered guard label so the next SM cycle can run
 *    story_test_automation.
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        return { success: false, error: 'No ticket key found in params' };
    }
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const jiraConfig = projectConfig.jira;

    console.log('=== Finishing test case generation for', ticketKey, '===');

    try {
        jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.READY_FOR_TESTING });
        console.log('✅ Moved', ticketKey, 'to', jiraConfig.statuses.READY_FOR_TESTING);
    } catch (e) {
        console.warn('Could not move Story to Ready For Testing:', e);
    }

    try {
        jira_remove_label({ key: ticketKey, label: 'sm_test_cases_triggered' });
        console.log('Removed sm_test_cases_triggered — story_test_automation can run next cycle');
    } catch (e) {
        console.warn('Could not remove sm_test_cases_triggered label:', e);
    }

    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }

    return { success: true, ticketKey: ticketKey };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
