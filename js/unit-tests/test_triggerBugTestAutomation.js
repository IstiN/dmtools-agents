/**
 * Unit tests for js/triggerBugTestAutomation.js and the shared
 * js/common/autoStartTrigger.js helper it delegates to (gh-1250).
 */

function loadAutoStartTrigger(mocks) {
    var autoStartMock = {
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
    };
    return loadModule(
        'js/common/autoStartTrigger.js',
        makeRequire({
            './autoStart.js': autoStartMock,
            './tokenUsageComment.js': makeTokenUsageMock(mocks)
        }),
        {}
    );
}

function makeTokenUsageMock(mocks) {
    var tokenUsageMock = {
        postTokenUsageComments: function(key, opts) {
            if (mocks && mocks.postTokenUsageComments) mocks.postTokenUsageComments(key, opts);
        },
        customParamsOf: function(params) {
            return (params && params.jobParams && params.jobParams.customParams) ||
                (params && params.customParams) || {};
        }
    };
    tokenUsageMock.postTokenUsageCommentsSafely = function(key, opts) {
        try {
            tokenUsageMock.postTokenUsageComments(key, opts);
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }
    };
    return tokenUsageMock;
}

function loadTriggerBugTestAutomation(mocks) {
    var defaults = {
        jira_remove_label: function() {},
        jira_post_comment: function() {}
    };

    return loadModule(
        'js/triggerBugTestAutomation.js',
        makeRequire({
            './common/autoStartTrigger.js': loadAutoStartTrigger(mocks),
            './common/tokenUsageComment.js': makeTokenUsageMock(mocks)
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

// ── gh-1250: direct coverage of the shared autoStartTrigger branches ──

suite('autoStartTrigger (shared, via bug test suite)', function() {

    function baseOpts(customParams) {
        return {
            ticketKey: 'TP-300',
            config: { c: 1 },
            customParams: customParams,
            label: 'bug_test_automation'
        };
    }

    test('flag set and workflow triggered: fires autoStart and skips SM', function() {
        var smCalled = false;
        var module = loadAutoStartTrigger({
            triggerConfiguredWorkflowForTicket: function(opts) {
                assert.equal(opts.ticketKey, 'TP-300');
                assert.equal(opts.configFile, 'agents/bug_test_automation.json');
                assert.equal(opts.label, 'bug_test_automation');
                assert.deepEqual(opts.stripKeys, ['removeLabel', 'autoStartBugTestAutomation', 'autoStartBugTestAutomationConfigFile']);
                return true;
            },
            triggerSmIfIdle: function() { smCalled = true; }
        });

        var triggered = module.triggerWorkflowOrAskSm(baseOpts({
            autoStartBugTestAutomation: true,
            autoStartBugTestAutomationConfigFile: 'agents/bug_test_automation.json'
        }));

        assert.equal(triggered, true);
        assert.equal(smCalled, false);
    });

    test('flag set but workflow not triggered: asks SM to re-evaluate', function() {
        var smCalled = false;
        var module = loadAutoStartTrigger({
            triggerConfiguredWorkflowForTicket: function() { return false; },
            triggerSmIfIdle: function(opts) {
                smCalled = true;
                assert.deepEqual(opts.config, { c: 1 });
            }
        });

        var triggered = module.triggerWorkflowOrAskSm(baseOpts({
            autoStartBugTestAutomation: true,
            autoStartBugTestAutomationConfigFile: 'agents/bug_test_automation.json'
        }));

        assert.equal(triggered, false);
        assert.equal(smCalled, true);
    });

    test('flag missing: never calls autoStart and asks SM to re-evaluate', function() {
        var workflowCalled = false;
        var smCalled = false;
        var module = loadAutoStartTrigger({
            triggerConfiguredWorkflowForTicket: function() { workflowCalled = true; return true; },
            triggerSmIfIdle: function() { smCalled = true; }
        });

        var triggered = module.triggerWorkflowOrAskSm(baseOpts({}));

        assert.equal(triggered, false);
        assert.equal(workflowCalled, false);
        assert.equal(smCalled, true);
    });

    test('runTriggerAction: posts token usage via postTokenUsageCommentsSafely and reports the keyed result', function() {
        var usageCalls = [];
        var module = loadAutoStartTrigger({
            triggerConfiguredWorkflowForTicket: function() { return true; },
            postTokenUsageComments: function(key, opts) { usageCalls.push({ key: key, opts: opts }); }
        });

        var result = module.runTriggerAction({
            params: {
                ticket: { key: 'TP-301' },
                initiator: 'sm',
                jobParams: { customParams: { autoStartBugTestAutomation: true, autoStartBugTestAutomationConfigFile: 'agents/bug_test_automation.json' } }
            },
            label: 'bug_test_automation',
            keyName: 'bugKey',
            errorPrefix: 'err:',
            logHeader: function() {},
            afterTrigger: function() {},
            tokenUsageOptions: function(params) {
                return { initiator: params.initiator, customParams: module.customParamsOf(params) };
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.triggered, true);
        assert.equal(result.bugKey, 'TP-301');
        assert.equal(usageCalls.length, 1);
        assert.equal(usageCalls[0].key, 'TP-301');
        assert.deepEqual(usageCalls[0].opts.customParams, { autoStartBugTestAutomation: true, autoStartBugTestAutomationConfigFile: 'agents/bug_test_automation.json' });
    });

    test('runTriggerAction: a throwing token-usage post is swallowed and the action still succeeds', function() {
        var module = loadAutoStartTrigger({
            triggerSmIfIdle: function() {},
            postTokenUsageComments: function() { throw new Error('usage api down'); }
        });

        var result = module.runTriggerAction({
            params: { ticket: { key: 'TP-302' }, initiator: 'sm' },
            label: 'bug_test_automation',
            keyName: 'bugKey',
            errorPrefix: 'err:',
            logHeader: function() {},
            afterTrigger: function() {},
            tokenUsageOptions: function() { return {}; }
        });

        assert.equal(result.success, true);
        assert.equal(result.triggered, false);
        assert.equal(result.bugKey, 'TP-302');
    });

    test('runTriggerAction: action-level failure returns the structured error contract', function() {
        var module = loadAutoStartTrigger({
            triggerSmIfIdle: function() { throw new Error('sm exploded'); }
        });

        var result = module.runTriggerAction({
            params: { ticket: { key: 'TP-303' }, jobParams: { customParams: {} } },
            label: 'bug_test_automation',
            keyName: 'bugKey',
            errorPrefix: 'err:',
            logHeader: function() {},
            afterTrigger: function() {},
            tokenUsageOptions: function() { return {}; }
        });

        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('sm exploded') !== -1);
    });

});
