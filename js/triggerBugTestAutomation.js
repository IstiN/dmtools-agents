/**
 * Trigger Bug Test Automation
 * Post-action for bug_test_cases_generator.
 * Keeps the Bug in Ready For Testing and immediately triggers bug_test_automation.
 */

var autoStart = require('./common/autoStart.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

function action(params) {
    try {
        const bugKey = params.ticket.key;
        const config = params.jobParams && params.jobParams.config
            ? params.jobParams.config
            : (params.config || {});
        const customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};

        console.log('=== Triggering bug test automation for', bugKey, '===');

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

        // Keep the generator SM trigger label on the bug. The SM rule for
        // bug_test_cases_generator uses it as a skip label, so removing it here
        // caused the generator to re-run while bug_test_automation was still
        // waiting for a workflow slot. Leaving the label prevents that loop;
        // bug_test_automation will move the bug out of Ready For Testing when it
        // completes, which stops the generator rule from matching.
        console.log('Keeping generator SM label sm_bug_test_cases_triggered to prevent re-run loop.');

        // Post token usage summary comments from the test-case generation run
        try {
            tokenUsageComment.postTokenUsageComments(bugKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return { success: true, triggered: triggered, bugKey: bugKey };

    } catch (error) {
        console.error('❌ Error in triggerBugTestAutomation:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
