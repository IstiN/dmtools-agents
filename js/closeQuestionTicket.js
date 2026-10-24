/**
 * Close Question Ticket Post-Action
 * Adds ai_generated label and moves the question subtask to Done
 * after the Answer field has been written by the outputType:field handler.
 */

const { LABELS } = require('./config.js');
const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const trackersModule = require('./common/trackers.js');

// ── Extracted step helpers (gh-1228 CRAP split): each step is independently
// guarded — a single failing tracker/usage call must not abort the close flow.

/** Add the ai_generated label; a failure is logged and skipped. */
function addAiGeneratedLabelSafely(tracker, ticketKey) {
    try {
        tracker.addLabel(ticketKey, LABELS.AI_GENERATED);
    } catch (e) {
        console.warn('Failed to add ai_generated label:', e);
    }
}

/** Remove the context WIP label when there is one; a failure is logged and skipped. */
function removeWipLabelSafely(tracker, ticketKey, wipLabel) {
    if (!wipLabel) return;
    try {
        tracker.removeLabel(ticketKey, wipLabel);
    } catch (e) {
        console.warn('Failed to remove WIP label:', e);
    }
}

/** Post token usage summary comments; a failure is logged and skipped. */
function postTokenUsageCommentsSafely(ticketKey, params, tracker) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, tracker: tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var jiraConfig = projectConfig.jira;
        var tracker = trackersModule.createTracker(projectConfig, (params.jobParams && params.jobParams.customParams) || params.customParams || {});
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;

        addAiGeneratedLabelSafely(tracker, ticketKey);
        removeWipLabelSafely(tracker, ticketKey, wipLabel);

        // Move to Done
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.DONE);
        console.log('Moved ' + ticketKey + ' to Done');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        postTokenUsageCommentsSafely(ticketKey, params, tracker);

        return { success: true, message: ticketKey + ' answered and closed' };

    } catch (error) {
        console.error('Error in closeQuestionTicket:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
