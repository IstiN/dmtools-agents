/**
 * Trigger Story Test Automation
 * Post-action for test_cases_generator.
 * Keeps the Story in Ready For Testing and immediately triggers story_test_automation.
 */

var autoStart = require('./common/autoStart.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackersModule = require('./common/trackers.js');

// ── gh-1229: small helpers extracted from action so it stays well under the
//    CRAP gate; behavior is byte-identical to the previous inline flow. ──

/** Config: jobParams wins (Teammate path), then top-level, then {}. */
function configOf(params) {
    return params.jobParams && params.jobParams.config
        ? params.jobParams.config
        : (params.config || {});
}

/** Custom params: jobParams wins (Teammate path), then top-level, then {}. */
function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/**
 * Trigger story_test_automation via autoStart when fully configured;
 * otherwise ask the SM to re-evaluate. Returns whether the workflow fired.
 */
function triggerWorkflowOrAskSm(storyKey, config, customParams) {
    var triggered = false;
    if (customParams.autoStartStoryTestAutomation && customParams.autoStartStoryTestAutomationConfigFile) {
        triggered = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: storyKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartStoryTestAutomationConfigFile,
            label: 'story_test_automation',
            stripKeys: [
                'removeLabel',
                'autoStartStoryTestAutomation',
                'autoStartStoryTestAutomationConfigFile'
            ]
        });
    }

    if (!triggered) {
        console.log('Story test automation not triggered via autoStart; asking SM to re-evaluate.');
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
    } else {
        console.log('✅ Triggered story_test_automation for', storyKey);
    }
    return triggered;
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

/** Token-usage comments are a nice-to-have — never fail the action on them. */
function postTokenUsageQuietly(storyKey, params, tracker) {
    try {
        tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator, tracker: tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
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

        // Post token usage summary comments from the test-case generation run
        postTokenUsageQuietly(storyKey, params, tracker);

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
