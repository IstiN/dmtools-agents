/**
 * Move To Ready For Testing Action (postJSAction for test_cases_generator)
 * Moves the ticket to "Ready For Testing" status after test cases are generated.
 */

const configLoader = require('./configLoader.js');

function action(params) {
    try {
        const ticketKey = params.ticket ? params.ticket.key : null;
        if (!ticketKey) {
            return { success: false, error: 'No ticket key found in params' };
        }
        const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        const jiraConfig = projectConfig.jira;

        console.log('Moving ' + ticketKey + ' to ' + jiraConfig.statuses.READY_FOR_TESTING);

        jira_move_to_status({
            key: ticketKey,
            statusName: jiraConfig.statuses.READY_FOR_TESTING
        });

        console.log('✅ ' + ticketKey + ' moved to ' + jiraConfig.statuses.READY_FOR_TESTING);

        return {
            success: true,
            message: ticketKey + ' moved to ' + jiraConfig.statuses.READY_FOR_TESTING
        };

    } catch (error) {
        console.error('❌ Error in moveToReadyForTesting:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
