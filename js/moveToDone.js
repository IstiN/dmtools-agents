/**
 * Move To Done Action (postJSAction for bug_test_cases_generator)
 * After test cases are generated for a bug, move the bug directly to Done.
 * If tests fail later, AI creates a new bug instead of re-opening this one.
 */

const tokenUsageComment = require('./common/tokenUsageComment.js');
var actionTicketContext = require('./common/actionTicketContext.js');

function action(params) {
    try {
        var ctx = actionTicketContext.resolveTicketContext(params, { statusKey: 'DONE', logNote: ' (bug with test cases generated)' });
        if (!ctx.ok) {
            return ctx.failure;
        }
        const ticketKey = ctx.ticketKey;
        const jiraConfig = ctx.jiraConfig;
        var tracker = ctx.tracker;

        tracker.moveToStatus(ticketKey, jiraConfig.statuses.DONE);

        try {
            tracker.removeLabel(ticketKey, 'sm_bug_test_cases_triggered');
        } catch (e) {
            console.log('Label sm_bug_test_cases_triggered not found or already removed');
        }

        tracker.postComment(ticketKey, 'Test cases generated. Bug marked as Done. If regression is detected, a new bug will be created automatically.');

        console.log('✅ ' + ticketKey + ' moved to ' + jiraConfig.statuses.DONE);

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, tracker: tracker });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            message: ticketKey + ' moved to ' + jiraConfig.statuses.DONE
        };

    } catch (error) {
        console.error('❌ Error in moveToDone:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
