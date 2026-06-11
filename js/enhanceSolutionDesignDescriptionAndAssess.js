/**
 * Enhance SD CORE Description and Assess Action
 * Enhances SD CORE ticket descriptions with technical details and updates diagram field 
 * based on AI-generated content from separate files
 */

// Import common helper functions
const { assignForReview, extractTicketKey } = require('./common/jiraHelpers.js');
const { STATUSES, LABELS, DIAGRAM_DEFAULTS, DIAGRAM_FORMAT, JIRA_FIELDS } = require('./config.js');
const outputFiles = require('./common/outputFiles.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

/**
 * Read enhancement data from separate files
 * Reads description from outputs/response.md and diagram from outputs/diagram.md
 *
 * @returns {Object} Parsed enhancement data or null if invalid
 */
function parseSDCoreEnhancementResponse(ticketKey, workingDir) {
    let description = '';
    let diagram = '';

    // Read description from response.md
    try {
        description = outputFiles.readOutputFile('response.md', {
            ticketKey: ticketKey,
            workingDir: workingDir
        });
        if (!description) {
            console.error('Description file not found or empty: outputs/response.md');
            return null;
        }
        description = description.trim();
    } catch (error) {
        console.error('Failed to read description file:', error);
        return null;
    }

    // Read diagram from diagram.md
    try {
        diagram = outputFiles.readOutputFile('diagram.md', {
            ticketKey: ticketKey,
            workingDir: workingDir
        });
        if (!diagram) {
            console.warn('Diagram file not found or empty: outputs/diagram.md, using default');
            diagram = DIAGRAM_DEFAULTS.CORE_GRAPH;
        } else {
            diagram = diagram.trim();
        }
    } catch (error) {
        console.warn('Failed to read diagram file, using default:', error);
        diagram = DIAGRAM_DEFAULTS.CORE_GRAPH;
    }

    // Validate required fields
    if (!description) {
        console.error('Description is empty');
        return null;
    }

    // Basic validation for mermaid diagram
    if (!diagram) {
        console.warn('Empty diagram provided, using default');
        diagram = DIAGRAM_DEFAULTS.CORE_GRAPH;
    }

    return {
        description: description,
        diagram: diagram
    };
}

/**
 * Update SD CORE ticket with enhanced content
 *
 * @param {string} ticketKey - The ticket key to update
 * @param {Object} enhancementData - Parsed enhancement data from AI
 * @returns {Object} Update result
 */
function updateSDCoreTicket(ticketKey, enhancementData) {
    const results = {
        descriptionUpdated: false,
        diagramUpdated: false,
        errors: []
    };

    try {
        // Update ticket description
        jira_update_description({
            key: ticketKey,
            description: enhancementData.description
        });
        results.descriptionUpdated = true;
        console.log('✅ Updated description for ' + ticketKey);
    } catch (error) {
        console.error('Failed to update description for ' + ticketKey + ':', error);
        results.errors.push('Description update failed: ' + error.toString());
    }

    try {
        // Update Diagrams field with mermaid diagram wrapped in code tags for better visualization
        const wrappedDiagram = DIAGRAM_FORMAT.MERMAID_WRAPPER_START + enhancementData.diagram + DIAGRAM_FORMAT.MERMAID_WRAPPER_END;
        jira_update_field({
            key: ticketKey,
            field: JIRA_FIELDS.DIAGRAMS,
            value: wrappedDiagram
        });
        results.diagramUpdated = true;
        console.log('✅ Updated Diagrams field for ' + ticketKey);
    } catch (error) {
        console.error('Failed to update Diagrams field for ' + ticketKey + ':', error);
        results.errors.push('Diagrams field update failed: ' + error.toString());
    }

    return results;
}


function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const initiatorId = params.initiator;
        // Dynamically generate WIP label from contextId
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;

        console.log("Processing SD CORE enhancement for ticket:", ticketKey);

        // Read enhancement data from separate files
        const enhancementData = parseSDCoreEnhancementResponse(ticketKey, null);
        if (!enhancementData) {
            const errorMsg = 'Failed to read enhancement data from output files';
            console.error(errorMsg);

            return {
                success: false,
                error: errorMsg
            };
        }

        // Update SD CORE ticket with enhanced content
        const updateResults = updateSDCoreTicket(ticketKey, enhancementData);

        // Use common assignForReview function for post-processing
        const assignResult = assignForReview(ticketKey, initiatorId, wipLabel, STATUSES.READY_FOR_DEVELOPMENT);

        if (!assignResult.success) {
            return assignResult;
        }

        const successCount = (updateResults.descriptionUpdated ? 1 : 0) +
                           (updateResults.diagramUpdated ? 1 : 0);

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            message: `Ticket ${ticketKey} enhanced, assigned, moved to In Review. Updates: ${successCount}/2 successful`,
            enhancementData: enhancementData,
            updateResults: updateResults
        };

    } catch (error) {
        console.error("❌ Error:", error);

        return {
            success: false,
            error: error.toString()
        };
    }
}
