/**
 * Simple Assign For Review Action
 * Assigns ticket to initiator and moves to "In Review" status
 */

// Import common Jira helper functions
var jiraHelpers = require('./common/jiraHelpers.js');
var tokenUsageComment = require('./js/common/tokenUsageComment.js');
var trackersModule = require('./js/common/trackers.js');
var configLoader = null;
try { configLoader = require('./js/configLoader.js'); } catch (e) { /* unit tests may omit configLoader */ }

function resolveCustomParams(params) {
    return (params && params.jobParams && params.jobParams.customParams) ||
        (params && params.customParams) || {};
}

function resolveProjectConfig(params) {
    if (!configLoader || typeof configLoader.loadProjectConfig !== 'function') {
        return null;
    }
    return configLoader.loadProjectConfig((params && params.jobParams) || params);
}

function resolveWipLabel(params) {
    return params && params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : null;
}

function postUsageSafely(ticketKey, initiator, tracker, projectConfig, customParams) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, {
            initiator: initiator,
            tracker: tracker,
            config: projectConfig,
            customParams: customParams
        });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var initiatorId = params.initiator;
        var customParams = resolveCustomParams(params);
        var projectConfig = resolveProjectConfig(params);
        var tracker = trackersModule.createTracker(projectConfig, customParams);
        var wipLabel = resolveWipLabel(params);
        var targetStatus = (params && params.targetStatus) || null;

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        postUsageSafely(ticketKey, initiatorId, tracker, projectConfig, customParams);

        // Use common assignForReview function
        return jiraHelpers.assignForReview(ticketKey, initiatorId, wipLabel, targetStatus, tracker);
    } catch (error) {
        console.error('❌ Error:', error);
        return {
            success: false,
            error: error.toString()
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveCustomParams: resolveCustomParams,
        resolveProjectConfig: resolveProjectConfig,
        resolveWipLabel: resolveWipLabel
    };
}
