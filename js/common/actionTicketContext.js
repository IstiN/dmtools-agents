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

/**
 * Print the shared "Moving <key> to <status>" opener; a no-op unless the
 * caller asked for it via options.statusKey. options.logNote is appended
 * verbatim (moveToDone uses it for its "(bug with test cases generated)"
 * suffix).
 */
function announceMove(ticketKey, jiraConfig, options) {
    if (!options || !options.statusKey) {
        return;
    }
    console.log('Moving ' + ticketKey + ' to ' + jiraConfig.statuses[options.statusKey] + (options.logNote || ''));
}

/**
 * Resolve the shared context a moveTo* action works against.
 *
 * The ticket key comes from params.ticket.key; the custom params prefer
 * params.jobParams.customParams (Teammate path), then top-level
 * params.customParams, then {}. options.statusKey additionally prints the
 * shared opener right after tracker creation.
 *
 * Returns { ok: true, ticketKey, projectConfig, jiraConfig, tracker } on
 * success, or { ok: false, failure: { success: false, error } } when the
 * triggering params carry no ticket key. Config-load and tracker-creation
 * errors are NOT swallowed — they propagate so the caller's action-level
 * try/catch keeps its exact old behavior.
 */
function resolveTicketContext(params, options) {
    var ticketKey = params.ticket ? params.ticket.key : null;
    if (!ticketKey) {
        return { ok: false, failure: { success: false, error: 'No ticket key found in params' } };
    }
    var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = projectConfig.jira;
    var tracker = trackersModule.createTracker(projectConfig, customParams);
    announceMove(ticketKey, jiraConfig, options);
    return {
        ok: true,
        ticketKey: ticketKey,
        projectConfig: projectConfig,
        jiraConfig: jiraConfig,
        tracker: tracker
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        resolveTicketContext: resolveTicketContext,
        announceMove: announceMove
    };
}
