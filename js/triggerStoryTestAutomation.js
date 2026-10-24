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
    return autoStartTrigger.runTriggerAction({
        params: params,
        label: 'story_test_automation',
        keyName: 'storyKey',
        errorPrefix: '❌ Error in triggerStoryTestAutomation:',
        logHeader: function(storyKey) {
            console.log('=== Triggering story test automation for', storyKey, '===');
        },
        beforeHeader: function(config, customParams) {
            return trackersModule.createTracker(config, customParams);
        },
        afterTrigger: function(storyKey, config, customParams, tracker) {
            // Remove the SM trigger label so test_cases_generator does not keep re-running
            removeSmTriggerLabelQuietly(tracker, storyKey, customParams);
        },
        tokenUsageOptions: function(params, tracker) {
            // Token-usage comments are a nice-to-have — never fail the action on them.
            return { initiator: params.initiator, tracker: tracker };
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        configOf: configOf,
        customParamsOf: customParamsOf
    };
}
