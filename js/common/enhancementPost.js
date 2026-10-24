/**
 * Shared post-enhancement steps for the enhance*DescriptionAndAssess actions
 * (gh-1250).
 *
 * The SD API and SD CORE enhancement actions used to carry identical copies
 * of two blocks: the action() preamble that resolves the project config and
 * (re)initializes the lazy tracker slot, and the ticket-update pair that
 * pushes the enhanced description plus the mermaid-wrapped Diagrams field
 * while collecting per-step, non-fatal errors.
 *
 * IMPORTANT: this module runs inside the DMTools GraalJS bridge — keep
 * requires load-time (gh-823) and data structures JSON-safe.
 */

// gh-823: load-time require — hoisted requires resolve file-relative and
// dmtools compile discovers them for the pack closure.
var trackerSlot = require('./trackerSlot.js');
var actionConfig = require('../config.js');
var configLoader = null;
try { configLoader = require('../configLoader.js'); } catch (e) { /* unit tests inject their own */ }

/**
 * The project config for the tracker provider, or null when no
 * configLoader is available.
 */
function resolveProjectConfig(params) {
    return configLoader ? configLoader.loadProjectConfig(params) : null;
}

/**
 * The action's customParams: jobParams.customParams wins, then
 * params.customParams, then {}.
 */
function actionCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/**
 * action() preamble shared by the enhancement actions: (re)initialize the
 * shared lazy tracker slot from the job's project config and customParams.
 */
function initEnhancementTracker(params) {
    trackerSlot.initTracker(resolveProjectConfig(params), actionCustomParams(params));
}

/**
 * The description + Diagrams ticket-update pair shared by both enhancement
 * actions. Each step is isolated: a failure is logged, recorded in
 * results.errors, and never blocks the other step.
 *
 * @param {Function} getTracker - Lazy tracker accessor (trackerSlot slot).
 * @param {string} ticketKey - The ticket key to update.
 * @param {Object} enhancementData - Parsed enhancement data (description, diagram).
 * @returns {Object} { descriptionUpdated, diagramUpdated, errors[] }.
 */
function updateDescriptionAndDiagram(getTracker, ticketKey, enhancementData) {
    var results = {
        descriptionUpdated: false,
        diagramUpdated: false,
        errors: []
    };

    try {
        getTracker().updateDescription(ticketKey, enhancementData.description);
        results.descriptionUpdated = true;
        console.log('✅ Updated description for ' + ticketKey);
    } catch (error) {
        console.error('Failed to update description for ' + ticketKey + ':', error);
        results.errors.push('Description update failed: ' + error.toString());
    }

    try {
        // Wrap the mermaid diagram in code tags for better visualization.
        var wrappedDiagram = actionConfig.DIAGRAM_FORMAT.MERMAID_WRAPPER_START +
            enhancementData.diagram + actionConfig.DIAGRAM_FORMAT.MERMAID_WRAPPER_END;
        getTracker().updateField(ticketKey, actionConfig.JIRA_FIELDS.DIAGRAMS, wrappedDiagram);
        results.diagramUpdated = true;
        console.log('✅ Updated Diagrams field for ' + ticketKey);
    } catch (error) {
        console.error('Failed to update Diagrams field for ' + ticketKey + ':', error);
        results.errors.push('Diagrams field update failed: ' + error.toString());
    }

    return results;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initEnhancementTracker: initEnhancementTracker,
        updateDescriptionAndDiagram: updateDescriptionAndDiagram,
        resolveProjectConfig: resolveProjectConfig,
        actionCustomParams: actionCustomParams
    };
}
