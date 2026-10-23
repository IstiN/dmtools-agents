/**
 * Assign For Solution Architecture Post-Action
 * Assigns ticket to initiator and moves to "Solution Architecture" status.
 * Used after Acceptance Criteria are written.
 */

const { extractTicketKey } = require('./common/jiraHelpers.js');
const { LABELS } = require('./config.js');
const configLoader = require('./configLoader.js');
const scmModule = require('./common/scm.js');
const autoStart = require('./common/autoStart.js');
var trackersModule = require('./common/trackers.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

const ACCEPTANCE_CRITERIA_TRIGGER_LABELS = [
    'sm_story_acceptance_criteria_triggered',
    'sm_story_acceptance_criterias_triggered'
];

// ── Extracted step helpers (gh-1187 CRAP split): same tracker calls, same
// order, same log lines. Quiet steps warn and continue; only the status move
// is fatal (trigger labels must not be removed on a failed move).

function resolveWipLabel(params) {
    return params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : null;
}

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

function assignToInitiatorQuietly(tracker, ticketKey, initiatorId) {
    if (!initiatorId) {
        return;
    }
    try {
        tracker.assignTo(ticketKey, initiatorId);
    } catch (e) {
        console.warn('Failed to assign ticket, continuing:', e);
    }
}

// Fatal on failure (rethrows): the trigger labels are only removed on success.
function moveToSolutionArchitecture(tracker, ticketKey, statusName) {
    try {
        tracker.moveToStatus(ticketKey, statusName);
    } catch (statusError) {
        console.error('Failed to move ' + ticketKey + ' to Solution Architecture — trigger labels NOT removed:', statusError);
        throw statusError;
    }
    console.log('Moved ' + ticketKey + ' to Solution Architecture');
}

function addAiGeneratedLabelQuietly(tracker, ticketKey) {
    try {
        tracker.addLabel(ticketKey, LABELS.AI_GENERATED);
    } catch (e) {
        console.warn('Failed to add ai_generated label:', e);
    }
}

function removeWipLabelQuietly(tracker, ticketKey, wipLabel) {
    if (!wipLabel) {
        return;
    }
    try {
        tracker.removeLabel(ticketKey, wipLabel);
        console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
    } catch (e) {
        console.warn('Failed to remove WIP label:', e);
    }
}

function removeTriggerLabelsQuietly(tracker, ticketKey) {
    ACCEPTANCE_CRITERIA_TRIGGER_LABELS.forEach(function(label) {
        try {
            tracker.removeLabel(ticketKey, label);
            console.log('Removed trigger label "' + label + '" from ' + ticketKey);
        } catch (e) {
            console.warn('Failed to remove trigger label "' + label + '":', e);
        }
    });
}

function postTokenUsageQuietly(tracker, ticketKey, params) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function triggerSolutionAutoStartQuietly(customParams, projectConfig, ticketKey) {
    var autoStartSolution = customParams.autoStartSolution === true ||
        customParams.autoStartSolution === 'true';
    var solutionConfigFile = customParams.autoStartSolutionConfigFile;
    if (!autoStartSolution || !solutionConfigFile) {
        return;
    }
    try {
        autoStart.triggerConfiguredWorkflowForTicket({
            scm: scmModule.createScm(projectConfig),
            config: projectConfig,
            ticketKey: ticketKey,
            customParams: customParams,
            configFile: solutionConfigFile,
            label: 'solution',
            stripKeys: ['autoStartSolution', 'autoStartSolutionConfigFile']
        });
    } catch (e) {
        console.warn('⚠️ autoStartSolution trigger failed:', e.message || e);
    }
}

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var initiatorId = params.initiator;
        var wipLabel = resolveWipLabel(params);
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var jiraConfig = projectConfig.jira;
        var customParams = resolveCustomParams(params);

        var tracker = trackersModule.createTracker(projectConfig, customParams);

        // Assign to initiator (skip if accountId is not available)
        assignToInitiatorQuietly(tracker, ticketKey, initiatorId);

        // Move to Solution Architecture — trigger labels are only removed on success
        moveToSolutionArchitecture(tracker, ticketKey, jiraConfig.statuses.SOLUTION_ARCHITECTURE);

        // Add ai_generated label
        addAiGeneratedLabelQuietly(tracker, ticketKey);

        // Remove WIP label if present
        removeWipLabelQuietly(tracker, ticketKey, wipLabel);

        removeTriggerLabelsQuietly(tracker, ticketKey);

        // Post token usage summary comments (e.g. [kimi_usage]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        postTokenUsageQuietly(tracker, ticketKey, params);

        triggerSolutionAutoStartQuietly(customParams, projectConfig, ticketKey);

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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, resolveWipLabel, resolveCustomParams };
}
