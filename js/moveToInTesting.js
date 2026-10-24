/**
 * Move To In Testing Action (postJSAction for test_cases_generator)
 * Moves the ticket to "In Testing" status after test cases are generated.
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const trackersModule = require('./common/trackers.js');

// ── gh-1229: small helpers extracted from action so it stays well under the
//    CRAP gate; behavior is byte-identical to the previous inline flow. ──

/** Ticket key of the triggering params, or null when the action has no ticket. */
function ticketKeyOf(params) {
    return params.ticket ? params.ticket.key : null;
}

/** Custom params: jobParams wins (Teammate path), then top-level, then {}. */
function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/** The SM trigger label is best-effort — absence/already-removed is normal. */
function removeSmTriggerLabelQuietly(tracker, ticketKey) {
    try {
        tracker.removeLabel(ticketKey, 'sm_test_cases_triggered');
    } catch (e) {
        console.log('Label sm_test_cases_triggered not found or already removed');
    }
}

/** Token-usage comments are a nice-to-have — never fail the action on them. */
function postTokenUsageQuietly(tracker, ticketKey, params) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, tracker: tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function action(params) {
    try {
        const ticketKey = ticketKeyOf(params);
        if (!ticketKey) {
            return { success: false, error: 'No ticket key found in params' };
        }
        const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        const jiraConfig = projectConfig.jira;
        var tracker = trackersModule.createTracker(projectConfig, customParamsOf(params));

        console.log('Moving ' + ticketKey + ' to ' + jiraConfig.statuses.IN_TESTING);

        // gh-916: IN_TESTING can be tag-only (restricted ADO workflows) — stage-label fallback in 'label' mode.
        var moveResult = tracker.moveToStatusOrMark(ticketKey, jiraConfig.statuses.IN_TESTING, 'IN_TESTING');

        removeSmTriggerLabelQuietly(tracker, ticketKey);

        if (moveResult.moved || moveResult.marked) {
            console.log('✅ ' + ticketKey + ' moved to ' + jiraConfig.statuses.IN_TESTING);
        }

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        postTokenUsageQuietly(tracker, ticketKey, params);

        return {
            success: true,
            message: ticketKey + ' moved to ' + jiraConfig.statuses.IN_TESTING
        };

    } catch (error) {
        console.error('❌ Error in moveToInTesting:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        ticketKeyOf: ticketKeyOf,
        customParamsOf: customParamsOf
    };
}
