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

function action(params) {
    return autoStartTrigger.runTriggerAction({
        params: params,
        label: 'bug_test_automation',
        keyName: 'bugKey',
        errorPrefix: '❌ Error in triggerBugTestAutomation:',
        logHeader: function(bugKey) {
            console.log('=== Triggering bug test automation for', bugKey, '===');
        },
        afterTrigger: function(bugKey, config, customParams) {
            // Keep the generator SM trigger label on the bug. The SM rule for
            // bug_test_cases_generator uses it as a skip label, so removing it here
            // caused the generator to re-run while bug_test_automation was still
            // waiting for a workflow slot. Leaving the label prevents that loop;
            // bug_test_automation will move the bug out of Ready For Testing when it
            // completes, which stops the generator rule from matching.
            console.log('Keeping generator SM label sm_bug_test_cases_triggered to prevent re-run loop.');
        },
        tokenUsageOptions: function(params) {
            // Token-usage comments are a nice-to-have — never fail the action on them.
            return { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) };
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
