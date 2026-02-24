/**
 * Assign For Solution Architecture Post-Action
 * Assigns ticket to initiator and moves to "Solution Architecture" status.
 * Used after Acceptance Criteria are written.
 */

const { extractTicketKey } = require('./common/jiraHelpers.js');
const { LABELS, STATUSES } = require('./config.js');

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var initiatorId = params.initiator;
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;

        // Assign to initiator
        jira_assign_ticket_to({
            key: ticketKey,
            accountId: initiatorId
        });

        // Move to Solution Architecture
        jira_move_to_status({
            key: ticketKey,
            statusName: STATUSES.SOLUTION_ARCHITECTURE
        });
        console.log('Moved ' + ticketKey + ' to Solution Architecture');

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
                console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
            } catch (e) {
                console.warn('Failed to remove WIP label:', e);
            }
        }

        return {
            success: true,
            message: ticketKey + ' assigned and moved to Solution Architecture'
        };

    } catch (error) {
        console.error('Error in assignForSolutionArchitecture:', error);
        return {
            success: false,
            error: error.toString()
        };
    }
}
