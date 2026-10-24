/**
 * Move To Ready For Testing Action (postJSAction for test_cases_generator)
 * Moves the ticket to "Ready For Testing" status after test cases are generated.
 */

var actionTicketContext = require('./common/actionTicketContext.js');

function action(params) {
    try {
        var ctx = actionTicketContext.resolveTicketContext(params, { statusKey: 'READY_FOR_TESTING' });
        if (!ctx.ok) {
            return ctx.failure;
        }
        const ticketKey = ctx.ticketKey;
        const jiraConfig = ctx.jiraConfig;
        var tracker = ctx.tracker;

        // gh-916: READY_FOR_TESTING can be tag-only (restricted ADO workflows) — stage-label fallback in 'label' mode.
        var moveResult = tracker.moveToStatusOrMark(ticketKey, jiraConfig.statuses.READY_FOR_TESTING, 'READY_FOR_TESTING');

        if (moveResult.moved || moveResult.marked) {
            console.log('✅ ' + ticketKey + ' moved to ' + jiraConfig.statuses.READY_FOR_TESTING);
        }

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
