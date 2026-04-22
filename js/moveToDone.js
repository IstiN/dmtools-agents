/**
 * Move To Done Action (postJSAction for bug_test_cases_generator)
 * After test cases are generated for a bug, move the bug directly to Done.
 * If tests fail later, AI creates a new bug instead of re-opening this one.
 */

const { STATUSES } = require('./config.js');

function action(params) {
    try {
        const ticketKey = params.ticket ? params.ticket.key : null;
        if (!ticketKey) {
            return { success: false, error: 'No ticket key found in params' };
        }

        console.log('Moving ' + ticketKey + ' to ' + STATUSES.DONE + ' (bug with test cases generated)');

        jira_move_to_status({
            key: ticketKey,
            statusName: STATUSES.DONE
        });

        try {
            jira_remove_label({ key: ticketKey, label: 'sm_bug_test_cases_triggered' });
        } catch (e) {
            console.log('Label sm_bug_test_cases_triggered not found or already removed');
        }

        jira_post_comment({
            key: ticketKey,
            comment: 'Test cases generated. Bug marked as Done. If regression is detected, a new bug will be created automatically.'
        });

        console.log('✅ ' + ticketKey + ' moved to ' + STATUSES.DONE);

        return {
            success: true,
            message: ticketKey + ' moved to ' + STATUSES.DONE
        };

    } catch (error) {
        console.error('❌ Error in moveToDone:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
