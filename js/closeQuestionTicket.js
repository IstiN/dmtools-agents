/**
 * Close Question Ticket Post-Action
 * Adds ai_generated label and moves the question subtask to Done
 * after the Answer field has been written by the outputType:field handler.
 */

const { LABELS, STATUSES } = require('./config.js');

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;

        // Add ai_generated label
        try {
            jira_add_label({ key: ticketKey, label: LABELS.AI_GENERATED });
        } catch (e) {
            console.warn('Failed to add ai_generated label:', e);
        }

        // Remove WIP label if present
        if (wipLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: wipLabel });
            } catch (e) {
                console.warn('Failed to remove WIP label:', e);
            }
        }

        // Move to Done
        jira_move_to_status({ key: ticketKey, statusName: STATUSES.DONE });
        console.log('Moved ' + ticketKey + ' to Done');

        return { success: true, message: ticketKey + ' answered and closed' };

    } catch (error) {
        console.error('Error in closeQuestionTicket:', error);
        return { success: false, error: error.toString() };
    }
}
