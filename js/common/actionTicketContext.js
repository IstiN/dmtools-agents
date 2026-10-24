/**
 * Shared per-ticket action context for the moveTo* postJSActions (gh-1250).
 *
 * Every moveTo* action used to open with the same block: resolve the ticket
 * key (fail structured when absent), load the project config, then create the
 * tracker from the config + custom params. This module is that block,
 * extracted once so the action files stay free of cross-file clones.
 *
 * IMPORTANT: this module runs inside the DMTools GraalJS bridge — keep
 * requires load-time (gh-823) and data structures JSON-safe.
 */

// gh-823: load-time requires — hoisted requires resolve file-relative and
// dmtools compile discovers them for the pack closure.
var configLoader = require('../configLoader.js');
var trackersModule = require('./trackers.js');

/** Ticket key of the triggering params, or null when the action has no ticket. */
function ticketKeyOf(params) {
    return params.ticket ? params.ticket.key : null;
}

/** Custom params: jobParams wins (Teammate path), then top-level, then {}. */
function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/**
 * Resolve the shared context a moveTo* action works against.
 *
 * Returns { ok: true, ticketKey, projectConfig, jiraConfig, tracker } on
 * success, or { ok: false, failure: { success: false, error } } when the
 * triggering params carry no ticket key. Config-load and tracker-creation
 * errors are NOT swallowed — they propagate so the caller's action-level
 * try/catch keeps its exact old behavior.
 */
function resolveTicketContext(params) {
    var ticketKey = ticketKeyOf(params);
    if (!ticketKey) {
        return { ok: false, failure: { success: false, error: 'No ticket key found in params' } };
    }
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    return {
        ok: true,
        ticketKey: ticketKey,
        projectConfig: projectConfig,
        jiraConfig: projectConfig.jira,
        tracker: trackersModule.createTracker(projectConfig, customParamsOf(params))
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ticketKeyOf: ticketKeyOf,
        customParamsOf: customParamsOf,
        resolveTicketContext: resolveTicketContext
    };
}
