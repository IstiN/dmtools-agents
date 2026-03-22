/**
 * Write Solution and Diagrams Post-Action
 * Reads AI-generated outputs/response.md and outputs/diagram.md,
 * writes them to the Solution and Diagrams fields of the story ticket,
 * then assigns for review.
 *
 * Supports customParams overrides (via agent JSON customParams):
 *   solutionField — Jira field name for solution content (default: JIRA_FIELDS.SOLUTION)
 *   diagramField  — Jira field name for diagram (default: JIRA_FIELDS.DIAGRAMS).
 *                   If empty string or not set, diagram is prepended to solution as {code:mermaid}.
 */

const { LABELS, DIAGRAM_FORMAT, JIRA_FIELDS, STATUSES } = require('./config.js');

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var initiatorId = params.initiator;
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;

        // Resolve field names from customParams if provided
        var customParams = (params.customParams) || (params.jobParams && params.jobParams.customParams) || {};
        var solutionField = customParams.solutionField || JIRA_FIELDS.SOLUTION;
        var diagramField  = (customParams.diagramField !== undefined) ? customParams.diagramField : JIRA_FIELDS.DIAGRAMS;

        console.log('Processing solution and diagrams for:', ticketKey);
        console.log('Solution field: ' + solutionField + ', Diagram field: ' + (diagramField || '(none — will prepend to solution)'));

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

        // 3. If no dedicated diagram field — prepend diagram as Jira code block to solution
        if (diagram && !diagramField) {
            solution = '{code:mermaid}\n' + diagram + '\n{code}\n\n' + solution;
            console.log('No diagram field configured — diagram prepended to solution as {code:mermaid} block');
            diagram = ''; // mark as handled
        }

        // 4. Write to solution field
        try {
            jira_update_field({ key: ticketKey, field: solutionField, value: solution });
            console.log('Updated "' + solutionField + '" field for ' + ticketKey);
        } catch (e) {
            console.error('Failed to update solution field "' + solutionField + '":', e);
            return { success: false, error: 'Solution field update failed: ' + e.toString() };
        }

        // 5. Write to diagram field if configured and diagram exists
        if (diagram && diagramField) {
            try {
                jira_update_field({ key: ticketKey, field: diagramField, value: diagram });
                console.log('Updated "' + diagramField + '" field for ' + ticketKey);
            } catch (e) {
                console.warn('Failed to update diagram field "' + diagramField + '":', e);
            }
        }

        // 6. Assign to initiator
        try {
            jira_assign_ticket_to({ key: ticketKey, accountId: initiatorId });
            console.log('Assigned ' + ticketKey + ' to initiator');
        } catch (e) {
            console.warn('Failed to assign ticket:', e);
        }

        // 7. Move to Ready For Development
        try {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.READY_FOR_DEVELOPMENT });
            console.log('Moved ' + ticketKey + ' to Ready For Development');
        } catch (e) {
            console.warn('Failed to move to Ready For Development:', e);
        }

        // 8. Add ai_generated label
        try {
            jira_add_label({ key: ticketKey, label: LABELS.AI_GENERATED });
        } catch (e) {
            console.warn('Failed to add ai_generated label:', e);
        }

        // 9. Remove WIP label if present
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
