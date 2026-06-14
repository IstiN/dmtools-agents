/**
 * Unit tests for js/triggerStoryTestAutomation.js
 */

function loadTriggerStoryTestAutomation(mocks) {
    var defaults = {
        jira_remove_label: function() {},
        jira_post_comment: function() {}
    };

    return loadModule(
        'js/triggerStoryTestAutomation.js',
        makeRequire({
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function(opts) {
                    return (mocks && mocks.triggerConfiguredWorkflowForTicket)
                        ? mocks.triggerConfiguredWorkflowForTicket(opts)
                        : false;
                },
                triggerSmIfIdle: function(opts) {
                    return (mocks && mocks.triggerSmIfIdle)
                        ? mocks.triggerSmIfIdle(opts)
                        : { success: true };
                }
            },
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function(key, opts) {
                    if (mocks && mocks.postTokenUsageComments) mocks.postTokenUsageComments(key, opts);
                }
            }
        }),
        Object.assign({}, defaults, mocks)
    );
}

suite('triggerStoryTestAutomation', function() {

    test('triggers story_test_automation and removes SM label', function() {
        var triggered = false;
        var removedLabels = [];
        var tokenKeys = [];

        var module = loadTriggerStoryTestAutomation({
            triggerConfiguredWorkflowForTicket: function(opts) {
                triggered = true;
                assert.equal(opts.ticketKey, 'TS-100');
                assert.equal(opts.configFile, 'agents/story_test_automation.json');
                assert.equal(opts.label, 'story_test_automation');
                return true;
            },
            jira_remove_label: function(args) { removedLabels.push(args); },
            postTokenUsageComments: function(key) { tokenKeys.push(key); }
        });

        var result = module.action({
            ticket: { key: 'TS-100' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_test_cases_triggered',
                    autoStartStoryTestAutomation: true,
                    autoStartStoryTestAutomationConfigFile: 'agents/story_test_automation.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.triggered, true);
        assert.equal(triggered, true);
        assert.deepEqual(removedLabels, [{ key: 'TS-100', label: 'sm_test_cases_triggered' }]);
        assert.deepEqual(tokenKeys, ['TS-100']);
    });

    test('falls back to SM trigger when autoStart is disabled', function() {
        var smTriggered = false;
        var removedLabels = [];

        var module = loadTriggerStoryTestAutomation({
            triggerSmIfIdle: function() { smTriggered = true; return { success: true }; },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-101' },
            jobParams: {
                customParams: { removeLabel: 'sm_test_cases_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.triggered, false);
        assert.equal(smTriggered, true);
        assert.deepEqual(removedLabels, [{ key: 'TS-101', label: 'sm_test_cases_triggered' }]);
    });

});
