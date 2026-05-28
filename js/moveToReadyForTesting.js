/**
 * Move To Ready For Testing Action (postJSAction for test_cases_generator)
 * Moves the ticket to "Ready For Testing" status after test cases are generated.
 */

const { STATUSES } = require('./config.js');

function action(params) {
    try {
        const ticketKey = params.ticket ? params.ticket.key : null;
        if (!ticketKey) {
            return { success: false, error: 'No ticket key found in params' };
        }

        console.log('Moving ' + ticketKey + ' to ' + STATUSES.READY_FOR_TESTING);

        jira_move_to_status({
            key: ticketKey,
            statusName: STATUSES.READY_FOR_TESTING
        });

        console.log('✅ ' + ticketKey + ' moved to ' + STATUSES.READY_FOR_TESTING);

        return {
            success: true,
            message: ticketKey + ' moved to ' + STATUSES.READY_FOR_TESTING
        };

    } catch (error) {
        console.error('❌ Error in moveToReadyForTesting:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
