/**
 * Move To In Testing Action (postJSAction for test_cases_generator)
 * Moves the ticket to "In Testing" status after test cases are generated.
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const trackersModule = require('./common/trackers.js');

function action(params) {
    try {
        const ticketKey = params.ticket ? params.ticket.key : null;
        if (!ticketKey) {
            return { success: false, error: 'No ticket key found in params' };
        }
        const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        const jiraConfig = projectConfig.jira;
        var tracker = trackersModule.createTracker(projectConfig, (params.jobParams && params.jobParams.customParams) || params.customParams || {});

        console.log('Moving ' + ticketKey + ' to ' + jiraConfig.statuses.IN_TESTING);

        tracker.moveToStatus(ticketKey, jiraConfig.statuses.IN_TESTING);

        try {
            tracker.removeLabel(ticketKey, 'sm_test_cases_triggered');
        } catch (e) {
            console.log('Label sm_test_cases_triggered not found or already removed');
        }

        console.log('✅ ' + ticketKey + ' moved to ' + jiraConfig.statuses.IN_TESTING);

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, tracker: tracker });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            message: ticketKey + ' moved to ' + jiraConfig.statuses.IN_TESTING
        };

    } catch (error) {
        console.error('❌ Error in moveToInTesting:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
