/**
 * Trigger Story Test Automation
 * Post-action for test_cases_generator.
 * Keeps the Story in Ready For Testing and immediately triggers story_test_automation.
 */

var autoStartTrigger = require('./common/autoStartTrigger.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackersModule = require('./common/trackers.js');

// ── gh-1229/gh-1250: helpers delegate to the shared autoStartTrigger module
//    (single parameterized copy of the former inline flow). ──

/** Config: jobParams wins (Teammate path), then top-level, then {}. */
function configOf(params) {
    return autoStartTrigger.configOf(params);
}

/** Custom params: jobParams wins (Teammate path), then top-level, then {}. */
function customParamsOf(params) {
    return autoStartTrigger.customParamsOf(params);
}

/**
 * Trigger story_test_automation via autoStart when fully configured;
 * otherwise ask the SM to re-evaluate. Returns whether the workflow fired.
 */
function triggerWorkflowOrAskSm(storyKey, config, customParams) {
    return autoStartTrigger.triggerWorkflowOrAskSm({
        ticketKey: storyKey,
        config: config,
        customParams: customParams,
        label: 'story_test_automation'
    });
}

/** The SM trigger label must go so test_cases_generator does not re-run. */
function removeSmTriggerLabelQuietly(tracker, storyKey, customParams) {
    const smTriggerLabel = customParams.removeLabel || 'sm_test_cases_triggered';
    try {
        tracker.removeLabel(storyKey, smTriggerLabel);
        console.log('✅ Removed SM trigger label:', smTriggerLabel);
    } catch (e) {
        console.warn('Failed to remove SM trigger label:', e);
    }
}

function action(params) {
    try {
        const storyKey = params.ticket.key;
        const config = configOf(params);
        const customParams = customParamsOf(params);

        var tracker = trackersModule.createTracker(config, customParams);

        console.log('=== Triggering story test automation for', storyKey, '===');

        var triggered = triggerWorkflowOrAskSm(storyKey, config, customParams);

        // Remove the SM trigger label so test_cases_generator does not keep re-running
        removeSmTriggerLabelQuietly(tracker, storyKey, customParams);

        // Post token usage summary comments from the test-case generation run.
        // Token-usage comments are a nice-to-have — never fail the action on them.
        tokenUsageComment.postTokenUsageCommentsSafely(storyKey, { initiator: params.initiator, tracker: tracker });

        return { success: true, triggered: triggered, storyKey: storyKey };

    } catch (error) {
        console.error('❌ Error in triggerStoryTestAutomation:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        configOf: configOf,
        customParamsOf: customParamsOf
    };
}
