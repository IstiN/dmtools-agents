/**
 * Unit tests for js/triggerBugTestAutomation.js
 */

function loadTriggerBugTestAutomation(mocks) {
    var defaults = {
        jira_remove_label: function() {},
        jira_post_comment: function() {}
    };

    return loadModule(
        'js/triggerBugTestAutomation.js',
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

suite('triggerBugTestAutomation', function() {

    test('triggers bug_test_automation and removes generator label', function() {
        var triggered = false;
        var removedLabels = [];

        var module = loadTriggerBugTestAutomation({
            triggerConfiguredWorkflowForTicket: function(opts) {
                triggered = true;
                assert.equal(opts.ticketKey, 'TP-200');
                assert.equal(opts.configFile, 'agents/bug_test_automation.json');
                assert.equal(opts.label, 'bug_test_automation');
                return true;
            },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TP-200' },
            jobParams: {
                customParams: {
                    autoStartBugTestAutomation: true,
                    autoStartBugTestAutomationConfigFile: 'agents/bug_test_automation.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.triggered, true);
        assert.equal(triggered, true);
        assert.deepEqual(removedLabels, [{ key: 'TP-200', label: 'sm_bug_test_cases_triggered' }]);
    });

    test('falls back to SM when autoStart config is missing', function() {
        var smTriggered = false;

        var module = loadTriggerBugTestAutomation({
            triggerSmIfIdle: function() { smTriggered = true; return { success: true }; }
        });

        var result = module.action({
            ticket: { key: 'TP-201' },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(result.triggered, false);
        assert.equal(smTriggered, true);
    });

});
