/**
 * Unit tests for js/triggerStoryTestAutomation.js
 */

function loadTriggerStoryTestAutomation(mocks) {
    var defaults = {
        jira_remove_label: function() {},
        jira_post_comment: function() {}
    };

    var allMocks = Object.assign({}, defaults, mocks);
    var trackersMod = loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), allMocks);

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
    var autoStartTriggerMod = loadModule(
        'js/common/autoStartTrigger.js',
        makeRequire({
            './autoStart.js': autoStartMock,
            './tokenUsageComment.js': tokenUsageMock
        }),
        {}
    );

    return loadModule(
        'js/triggerStoryTestAutomation.js',
        makeRequire({
            './common/trackers.js': trackersMod,
            './common/autoStartTrigger.js': autoStartTriggerMod,
            './common/tokenUsageComment.js': tokenUsageMock
        }),
        allMocks
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

    // ── gh-1229 characterization: seams pinned before helper extraction ──

    test('partial autoStart config (flag without config file) also falls back to SM', function() {
        var workflowOpts = [];
        var smTriggered = false;

        var module = loadTriggerStoryTestAutomation({
            triggerConfiguredWorkflowForTicket: function(opts) { workflowOpts.push(opts); return true; },
            triggerSmIfIdle: function() { smTriggered = true; return { success: true }; }
        });

        var result = module.action({
            ticket: { key: 'TS-102' },
            jobParams: { customParams: { autoStartStoryTestAutomation: true } }
        });

        assert.equal(result.triggered, false);
        assert.deepEqual(workflowOpts, []);
        assert.equal(smTriggered, true);
    });

    test('a failing label removal or token-usage post only warns and the action still succeeds', function() {
        var module = loadTriggerStoryTestAutomation({
            jira_remove_label: function() { throw new Error('label api down'); },
            postTokenUsageComments: function() { throw new Error('usage api down'); }
        });

        var result = module.action({ ticket: { key: 'TS-103' }, initiator: 'sm' });

        assert.equal(result.success, true);
        assert.equal(result.storyKey, 'TS-103');
    });

    test('action-level failure returns the structured error contract', function() {
        var module = loadTriggerStoryTestAutomation({
            triggerSmIfIdle: function() { throw new Error('sm exploded'); }
        });

        var result = module.action({
            ticket: { key: 'TS-104' },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('sm exploded') !== -1);
    });

    test('configOf/customParamsOf keep the jobParams-then-top-level precedence', function() {
        var m = loadTriggerStoryTestAutomation({});
        assert.deepEqual(m.customParamsOf({ jobParams: { customParams: { a: 1 } } }), { a: 1 });
        assert.deepEqual(m.customParamsOf({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(m.customParamsOf({}), {});
        assert.deepEqual(m.configOf({ jobParams: { config: { c: 3 } } }), { c: 3 });
        assert.deepEqual(m.configOf({ config: { d: 4 } }), { d: 4 });
        assert.deepEqual(m.configOf({}), {});
    });

});
