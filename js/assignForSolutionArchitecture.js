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
const tokenUsageComment = require('./common/tokenUsageComment.js');
var trackerHelper = require('./common/tracker.js');

const ACCEPTANCE_CRITERIA_TRIGGER_LABELS = [
    'sm_story_acceptance_criteria_triggered',
    'sm_story_acceptance_criterias_triggered'
];

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var initiatorId = params.initiator;
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var trackerConfig = projectConfig.tracker;
        var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};

        // Assign to initiator (skip if accountId is not available)
        if (initiatorId) {
            try {
                tracker_assign_ticket({
                    key: ticketKey,
                    accountId: initiatorId
                });
            } catch (e) {
                console.warn('Failed to assign ticket, continuing:', e);
            }
        }

        // Move to Solution Architecture — trigger labels are only removed on success
        try {
            tracker_move_to_status({
                key: ticketKey,
                statusName: trackerConfig.statuses.SOLUTION_ARCHITECTURE
            });
        } catch (statusError) {
            console.error('Failed to move ' + ticketKey + ' to Solution Architecture — trigger labels NOT removed:', statusError);
            throw statusError;
        }
        console.log('Moved ' + ticketKey + ' to Solution Architecture');

        // Add ai_generated label
        try {
            trackerHelper.addLabel(ticketKey, LABELS.AI_GENERATED);
        } catch (e) {
            console.warn('Failed to add ai_generated label:', e);
        }

        // Remove WIP label if present
        if (wipLabel) {
            try {
                trackerHelper.removeLabel(ticketKey, wipLabel);
                console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
            } catch (e) {
                console.warn('Failed to remove WIP label:', e);
            }
        }

        ACCEPTANCE_CRITERIA_TRIGGER_LABELS.forEach(function(label) {
            try {
                trackerHelper.removeLabel(ticketKey, label);
                console.log('Removed trigger label "' + label + '" from ' + ticketKey);
            } catch (e) {
                console.warn('Failed to remove trigger label "' + label + '":', e);
            }
        });

        // Post token usage summary comments (e.g. [kimi_usage]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        var autoStartSolution = customParams.autoStartSolution === true ||
            customParams.autoStartSolution === 'true';
        var solutionConfigFile = customParams.autoStartSolutionConfigFile;
        if (autoStartSolution && solutionConfigFile) {
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
