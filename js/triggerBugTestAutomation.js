/**
 * Trigger Bug Test Automation
 * Post-action for bug_test_cases_generator.
 * Keeps the Bug in Ready For Testing and immediately triggers bug_test_automation.
 */

var autoStart = require('./common/autoStart.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

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
 * Trigger bug_test_automation via autoStart when fully configured;
 * otherwise ask the SM to re-evaluate. Returns whether the workflow fired.
 */
function triggerWorkflowOrAskSm(bugKey, config, customParams) {
    var triggered = false;
    if (customParams.autoStartBugTestAutomation && customParams.autoStartBugTestAutomationConfigFile) {
        triggered = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: bugKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartBugTestAutomationConfigFile,
            label: 'bug_test_automation',
            stripKeys: [
                'removeLabel',
                'autoStartBugTestAutomation',
                'autoStartBugTestAutomationConfigFile'
            ]
        });
    }

    if (!triggered) {
        console.log('Bug test automation not triggered via autoStart; asking SM to re-evaluate.');
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
    } else {
        console.log('✅ Triggered bug_test_automation for', bugKey);
    }
    return triggered;
}

/** Token-usage comments are a nice-to-have — never fail the action on them. */
function postTokenUsageQuietly(bugKey, params) {
    try {
        tokenUsageComment.postTokenUsageComments(bugKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
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

        // Post token usage summary comments from the test-case generation run
        postTokenUsageQuietly(bugKey, params);

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
