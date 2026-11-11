/**
 * Finish Test Cases Generation (postJSAction for test_cases_generator)
 *
 * After TestCasesGenerator has created the linked Test Case tickets:
 * 1. Make sure the Story is in Ready For Testing so story_test_automation can pick it up.
 * 2. Remove the sm_test_cases_triggered guard label so the next SM cycle can run
 *    story_test_automation.
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;

// ── gh-1229: small helpers extracted from action so it stays well under the
//    CRAP gate; behavior is byte-identical to the previous inline flow. ──

/** Custom params: jobParams wins (Teammate path), then top-level, then {}. */
function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/**
 * Move the Story to Ready For Testing. gh-916: the status can be tag-only
 * (restricted ADO workflows) — moveToStatusOrMark carries the stage_<key>
 * label fallback when stageFallback 'label'; 'none' keeps the exact old
 * move + error flow. Failure is non-fatal for the finishing action.
 */
function moveStoryToReadyForTesting(ticketKey, jiraConfig) {
    try {
        var moved = getTracker().moveToStatusOrMark(ticketKey, jiraConfig.statuses.READY_FOR_TESTING, 'READY_FOR_TESTING');
        if (moved.moved || moved.marked) {
            console.log('✅ Moved', ticketKey, 'to', jiraConfig.statuses.READY_FOR_TESTING);
        }
    } catch (e) {
        console.warn('Could not move Story to Ready For Testing:', e);
    }
}

/** The generator guard label is best-effort — a tracker hiccup only warns. */
function removeGeneratorTriggerLabelQuietly(ticketKey) {
    try {
        getTracker().removeLabel(ticketKey, 'sm_test_cases_triggered');
        console.log('Removed sm_test_cases_triggered — story_test_automation can run next cycle');
    } catch (e) {
        console.warn('Could not remove sm_test_cases_triggered label:', e);
    }
}

/** Token-usage comments are a nice-to-have — never fail the action on them. */
function postTokenUsageQuietly(ticketKey, params) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        return { success: false, error: 'No ticket key found in params' };
    }
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const jiraConfig = projectConfig.jira;
    initTracker(projectConfig, customParamsOf(params));

    console.log('=== Finishing test case generation for', ticketKey, '===');

    moveStoryToReadyForTesting(ticketKey, jiraConfig);

    removeGeneratorTriggerLabelQuietly(ticketKey);

    postTokenUsageQuietly(ticketKey, params);

    return { success: true, ticketKey: ticketKey };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        customParamsOf: customParamsOf
    };
}
