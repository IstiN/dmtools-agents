/**
 * Write Solution and Diagrams Post-Action
 * Reads AI-generated outputs/response.md and outputs/diagram.md,
 * writes them to the Solution and Diagrams fields of the story ticket,
 * then assigns for review.
 */

const { LABELS, DIAGRAM_FORMAT, JIRA_FIELDS, STATUSES } = require('./config.js');

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var initiatorId = params.initiator;
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;

        console.log('Processing solution and diagrams for:', ticketKey);

        // 1. Read solution from outputs/response.md
        var solution = '';
        try {
            solution = file_read('outputs/response.md');
            if (solution) solution = solution.trim();
        } catch (e) {
            console.error('Failed to read outputs/response.md:', e);
            return { success: false, error: 'Could not read outputs/response.md' };
        }
        if (!solution) {
            return { success: false, error: 'outputs/response.md is empty' };
        }

        // 2. Read diagram from outputs/diagram.md
        var diagram = '';
        try {
            diagram = file_read('outputs/diagram.md');
            if (diagram) diagram = diagram.trim();
        } catch (e) {
            console.warn('Failed to read outputs/diagram.md, skipping diagram update:', e);
        }

        // 3. Write to Solution field
        try {
            jira_update_field({ key: ticketKey, field: JIRA_FIELDS.SOLUTION, value: solution });
            console.log('Updated Solution field for ' + ticketKey);
        } catch (e) {
            console.error('Failed to update Solution field:', e);
            return { success: false, error: 'Solution field update failed: ' + e.toString() };
        }

        // 4. Write to Diagrams field (wrapped in mermaid code block)
        if (diagram) {
            try {
                // Pass raw mermaid without {code:mermaid} wrapper — DMTools mis-parses wiki macros
                jira_update_field({ key: ticketKey, field: JIRA_FIELDS.DIAGRAMS, value: diagram });
                console.log('Updated Diagrams field for ' + ticketKey);
            } catch (e) {
                console.warn('Failed to update Diagrams field:', e);
            }
        }

        // 5. Assign to initiator
        try {
            jira_assign_ticket_to({ key: ticketKey, accountId: initiatorId });
            console.log('Assigned ' + ticketKey + ' to initiator');
        } catch (e) {
            console.warn('Failed to assign ticket:', e);
        }

        // 6. Move to Ready For Development
        try {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.READY_FOR_DEVELOPMENT });
            console.log('Moved ' + ticketKey + ' to Ready For Development');
        } catch (e) {
            console.warn('Failed to move to Ready For Development:', e);
        }

        // 7. Add ai_generated label
        try {
            jira_add_label({ key: ticketKey, label: LABELS.AI_GENERATED });
        } catch (e) {
            console.warn('Failed to add ai_generated label:', e);
        }

        // 8. Remove WIP label if present
        if (wipLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: wipLabel });
                console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
            } catch (e) {
                console.warn('Failed to remove WIP label:', e);
            }
        }

        return { success: true, message: ticketKey + ' solution written, moved to Ready For Development' };

    } catch (error) {
        console.error('Error in writeSolutionAndDiagrams:', error);
        return { success: false, error: error.toString() };
    }
}
