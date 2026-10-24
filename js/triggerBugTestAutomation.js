/**
 * Trigger Bug Test Automation
 * Post-action for bug_test_cases_generator.
 * Keeps the Bug in Ready For Testing and immediately triggers bug_test_automation.
 */

var autoStartTrigger = require('./common/autoStartTrigger.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

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
 * Trigger bug_test_automation via autoStart when fully configured;
 * otherwise ask the SM to re-evaluate. Returns whether the workflow fired.
 */
function triggerWorkflowOrAskSm(bugKey, config, customParams) {
    return autoStartTrigger.triggerWorkflowOrAskSm({
        ticketKey: bugKey,
        config: config,
        customParams: customParams,
        label: 'bug_test_automation'
    });
}

function action(params) {
    try {
        const bugKey = params.ticket.key;
        const config = configOf(params);
        const customParams = customParamsOf(params);

        console.log('=== Triggering bug test automation for', bugKey, '===');

        var triggered = triggerWorkflowOrAskSm(bugKey, config, customParams);

        // Keep the generator SM trigger label on the bug. The SM rule for
        // bug_test_cases_generator uses it as a skip label, so removing it here
        // caused the generator to re-run while bug_test_automation was still
        // waiting for a workflow slot. Leaving the label prevents that loop;
        // bug_test_automation will move the bug out of Ready For Testing when it
        // completes, which stops the generator rule from matching.
        console.log('Keeping generator SM label sm_bug_test_cases_triggered to prevent re-run loop.');

        // Post token usage summary comments from the test-case generation run.
        // Token-usage comments are a nice-to-have — never fail the action on them.
        tokenUsageComment.postTokenUsageCommentsSafely(bugKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });

        return { success: true, triggered: triggered, bugKey: bugKey };

    } catch (error) {
        console.error('❌ Error in triggerBugTestAutomation:', error);
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
