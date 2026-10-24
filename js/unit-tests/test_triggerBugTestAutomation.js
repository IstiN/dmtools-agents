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

    test('triggers bug_test_automation and keeps generator label to prevent re-run loop', function() {
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
        // Implementation deliberately keeps the generator SM label to avoid a re-run loop.
        assert.deepEqual(removedLabels, []);
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

    // ── gh-1229 characterization: seams pinned before helper extraction ──

    test('partial autoStart config (flag without config file) also falls back to SM', function() {
        var workflowOpts = [];
        var smTriggered = false;

        var module = loadTriggerBugTestAutomation({
            triggerConfiguredWorkflowForTicket: function(opts) { workflowOpts.push(opts); return true; },
            triggerSmIfIdle: function() { smTriggered = true; return { success: true }; }
        });

        var result = module.action({
            ticket: { key: 'TP-202' },
            jobParams: { customParams: { autoStartBugTestAutomation: true } }
        });

        assert.equal(result.triggered, false);
        assert.deepEqual(workflowOpts, []);
        assert.equal(smTriggered, true);
    });

    test('a failing token-usage post only warns and the action still succeeds', function() {
        var module = loadTriggerBugTestAutomation({
            postTokenUsageComments: function() { throw new Error('usage api down'); }
        });

        var result = module.action({ ticket: { key: 'TP-203' }, initiator: 'sm' });

        assert.equal(result.success, true);
        assert.equal(result.bugKey, 'TP-203');
    });

    test('action-level failure returns the structured error contract', function() {
        var module = loadTriggerBugTestAutomation({
            triggerSmIfIdle: function() { throw new Error('sm exploded'); }
        });

        var result = module.action({ ticket: { key: 'TP-204' }, jobParams: { customParams: {} } });

        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('sm exploded') !== -1);
    });

    test('customParamsOf keeps the jobParams-then-top-level precedence', function() {
        var m = loadTriggerBugTestAutomation({});
        assert.deepEqual(m.customParamsOf({ jobParams: { customParams: { a: 1 } } }), { a: 1 });
        assert.deepEqual(m.customParamsOf({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(m.customParamsOf({}), {});
        assert.deepEqual(m.configOf({ jobParams: { config: { c: 3 } } }), { c: 3 });
        assert.deepEqual(m.configOf({ config: { d: 4 } }), { d: 4 });
        assert.deepEqual(m.configOf({}), {});
    });

});
