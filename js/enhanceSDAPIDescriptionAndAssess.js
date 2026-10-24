/**
 * Enhance SD API Description and Assess Action
 * Enhances SD API ticket descriptions with technical details, assesses implementation needs, 
 * and updates diagram field based on AI-generated content
 */

// Import common helper functions
const { extractTicketKey } = require('./common/jiraHelpers.js');
const { LABELS, DIAGRAM_DEFAULTS, DIAGRAM_FORMAT, JIRA_FIELDS } = require('./config.js');
// Load-time require (gh-823): hoisted to the top — JSON parsing helper shared
// with the questions post-action (same 'Invalid JSON from AI:' contract).
const aiResponseParser = require('./common/aiResponseParser.js');
var configLoader = null;
try { configLoader = require('./configLoader.js'); } catch (e) {}

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}
function resolveProjectConfig(params) {
    return configLoader ? configLoader.loadProjectConfig(params) : null;
}

/**
 * Parse AI response for SD API enhancement
 * Expects JSON object with description, apiSubtaskCreation boolean, and diagram string
 *
 * @param {Object|string} response - AI response (should be JSON object)
 * @returns {Object} Parsed enhancement data or null if invalid
 */
function parseSDAPIEnhancementResponse(response) {
    // Handle string responses (parse JSON)
    if (typeof response === 'string') {
        var parsed = aiResponseParser.tryParseJson(response);
        if (!parsed.ok) {
            return null;
        }
        response = parsed.value;
    }

    // Validate expected structure
    if (!isResponseObject(response)) {
        console.warn('AI response is not an object, got:', typeof response);
        return null;
    }

    // Validate required fields
    if (!hasRequiredEnhancementFields(response)) {
        console.error('AI response missing required fields or wrong types:', response);
        return null;
    }

    // Basic validation for mermaid sequence diagram
    if (!response.diagram.trim()) {
        console.warn('Empty diagram provided');
        response.diagram = DIAGRAM_DEFAULTS.API_SEQUENCE;
    }

    return response;
}

/**
 * An enhancement response must be a non-null object.
 */
function isResponseObject(response) {
    return Boolean(response) && typeof response === 'object';
}

/**
 * The three required members with their exact types.
 */
function hasRequiredEnhancementFields(response) {
    return typeof response.description === 'string' &&
        typeof response.apiSubtaskCreation === 'boolean' &&
        typeof response.diagram === 'string';
}

/**
 * Update SD API ticket with enhanced content
 * 
 * @param {string} ticketKey - The ticket key to update
 * @param {Object} enhancementData - Parsed enhancement data from AI
 * @returns {Object} Update result
 */
function updateSDAPITicket(ticketKey, enhancementData) {
    const results = {
        descriptionUpdated: false,
        diagramUpdated: false,
        labelAdded: false,
        errors: []
    };
    
    try {
        // Update ticket description
        getTracker().updateDescription(ticketKey, enhancementData.description);
        results.descriptionUpdated = true;
        console.log('✅ Updated description for ' + ticketKey);
    } catch (error) {
        console.error('Failed to update description for ' + ticketKey + ':', error);
        results.errors.push('Description update failed: ' + error.toString());
    }
    
    try {
        // Update Diagrams field with mermaid sequence diagram wrapped in code tags for better visualization
        const wrappedDiagram = DIAGRAM_FORMAT.MERMAID_WRAPPER_START + enhancementData.diagram + DIAGRAM_FORMAT.MERMAID_WRAPPER_END;
        getTracker().updateField(ticketKey, JIRA_FIELDS.DIAGRAMS, wrappedDiagram);
        results.diagramUpdated = true;
        console.log('✅ Updated Diagrams field for ' + ticketKey);
    } catch (error) {
        console.error('Failed to update Diagrams field for ' + ticketKey + ':', error);
        results.errors.push('Diagrams field update failed: ' + error.toString());
    }
    
    try {
        // Add implementation assessment label if needed
        if (enhancementData.apiSubtaskCreation) {
            getTracker().addLabel(ticketKey, LABELS.NEEDS_API_IMPLEMENTATION);
            results.labelAdded = true;
            console.log('✅ Added needs_api_implementation label to ' + ticketKey);
        } else {
            console.log('ℹ️ No additional API implementation needed for ' + ticketKey);
        }
    } catch (error) {
        console.error('Failed to add implementation label to ' + ticketKey + ':', error);
        results.errors.push('Label addition failed: ' + error.toString());
    }
    
    return results;
}

/**
 * WIP label from the job metadata's contextId, or null without one.
 */
function resolveWipLabel(metadata) {
    return metadata && metadata.contextId
        ? metadata.contextId + '_wip'
        : null;
}

/**
 * How many of the three ticket updates landed (description, diagram, label).
 */
function countSuccessfulUpdates(updateResults) {
    return (updateResults.descriptionUpdated ? 1 : 0) +
        (updateResults.diagramUpdated ? 1 : 0) +
        (updateResults.labelAdded ? 1 : 0);
}

/**
 * The success-path result message with the honest update count.
 */
function buildEnhancementSuccessMessage(ticketKey, successCount) {
    return 'Ticket ' + ticketKey + ' enhanced, assigned, moved to In Review. Updates: ' + successCount + '/3 successful';
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const initiatorId = params.initiator;
        initTracker(resolveProjectConfig(params), (params.jobParams && params.jobParams.customParams) || params.customParams || {});
        // Dynamically generate WIP label from contextId
        const wipLabel = resolveWipLabel(params.metadata);

        console.log("Processing SD API enhancement for ticket:", ticketKey);

        // Parse AI enhancement response
        const enhancementData = parseSDAPIEnhancementResponse(params.response);
        if (!enhancementData) {
            const errorMsg = 'Invalid AI response format for SD API enhancement';
            console.error(errorMsg);

            return {
                success: false,
                error: errorMsg
            };
        }

        // Update SD API ticket with enhanced content
        const updateResults = updateSDAPITicket(ticketKey, enhancementData);

        // Use common assignForReview function for post-processing
        const assignResult = getTracker().assignForReview(ticketKey, initiatorId, wipLabel);

        if (!assignResult.success) {
            return assignResult;
        }

        return {
            success: true,
            message: buildEnhancementSuccessMessage(ticketKey, countSuccessfulUpdates(updateResults)),
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


if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        action: action,
        parseSDAPIEnhancementResponse: parseSDAPIEnhancementResponse,
        updateSDAPITicket: updateSDAPITicket,
        isResponseObject: isResponseObject,
        hasRequiredEnhancementFields: hasRequiredEnhancementFields,
        resolveWipLabel: resolveWipLabel,
        countSuccessfulUpdates: countSuccessfulUpdates,
        buildEnhancementSuccessMessage: buildEnhancementSuccessMessage
    };
}
