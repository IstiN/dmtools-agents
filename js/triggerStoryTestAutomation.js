/**
 * Trigger Story Test Automation
 * Post-action for test_cases_generator.
 * Keeps the Story in Ready For Testing and immediately triggers story_test_automation.
 */

var autoStart = require('./common/autoStart.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

function action(params) {
    try {
        const storyKey = params.ticket.key;
        const config = params.jobParams && params.jobParams.config
            ? params.jobParams.config
            : (params.config || {});
        const customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};

        console.log('=== Triggering story test automation for', storyKey, '===');

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

        // Remove the SM trigger label so test_cases_generator does not keep re-running
        const smTriggerLabel = customParams.removeLabel || 'sm_test_cases_triggered';
        try {
            jira_remove_label({ key: storyKey, label: smTriggerLabel });
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        } catch (e) {
            console.warn('Failed to remove SM trigger label:', e);
        }

        // Post token usage summary comments from the test-case generation run
        try {
            tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return { success: true, triggered: triggered, storyKey: storyKey };

    } catch (error) {
        console.error('❌ Error in triggerStoryTestAutomation:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
