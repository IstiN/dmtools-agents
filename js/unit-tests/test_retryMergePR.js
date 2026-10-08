function d4TrackersWith(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

/**
 * Unit tests for retryMergePR.js.
 */

function loadRetryMergePR(options) {
    options = options || {};
    var autoStartCalls = [];
    var config = options.config || {
        repository: { owner: 'IstiN', repo: 'trackstate' },
        jira: {
            issueTypes: configModule.ISSUE_TYPES,
            statuses: configModule.STATUSES
        },
        jobParamPatches: {
            retry_merge: {
                customParams: {
                    autoStartRework: true,
                    autoStartReworkConfigFile: 'agents/pr_rework.json',
                    removeLabel: 'from_patch'
                }
            },
            retry_merge_test: {
                customParams: {
                    autoStartRework: true,
                    autoStartReworkConfigFile: 'agents/pr_test_automation_rework.json'
                }
            }
        }
    };
    var scm = options.scm || {
        getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; },
        listPrs: function() {
            return [{
                number: 121,
                title: 'TS-125 fix',
                html_url: 'https://github.com/IstiN/trackstate/pull/121',
                head: { ref: 'ai/TS-125' }
            }];
        },
        getPr: function() { return { mergeable: false, mergeable_state: 'dirty' }; },
        removeLabel: function() {}
    };

    var retryMocks = Object.assign({
        jira_remove_label: function() {},
        jira_post_comment: function() {},
        jira_move_to_status: function() {}
    }, options.mocks || {});
    var mod = loadModule(
        'js/retryMergePR.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': {
                loadProjectConfig: function() { return config; },
                resolveInstructions: configLoaderModule.resolveInstructions
            },
            './common/scm.js': { createScm: function() { return scm; } },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function(opts) {
                    autoStartCalls.push(opts);
                    return true;
                }
            },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': d4TrackersWith(retryMocks)
        }),
        retryMocks
    );

    return { mod: mod, autoStartCalls: autoStartCalls };
}

suite('retryMergePR', function() {
    test('merges retry_merge jobParamPatches into runtime customParams', function() {
        var loaded = loadRetryMergePR();

        var customParams = loaded.mod.resolveCustomParams(
            {
                jobParams: {
                    metadata: { contextId: 'retry_merge' },
                    customParams: { removeLabel: 'sm_pr_merge_triggered' }
                }
            },
            {
                jobParamPatches: {
                    retry_merge: {
                        customParams: {
                            autoStartRework: true,
                            autoStartReworkConfigFile: 'agents/pr_rework.json',
                            removeLabel: 'from_patch'
                        }
                    }
                }
            }
        );

        assert.equal(customParams.autoStartRework, true);
        assert.equal(customParams.autoStartReworkConfigFile, 'agents/pr_rework.json');
        assert.equal(customParams.removeLabel, 'sm_pr_merge_triggered');
    });

    test('auto-starts rework when an approved PR has merge conflicts', function() {
        var loaded = loadRetryMergePR();

        var result = loaded.mod.action({
            ticket: { key: 'TS-125' },
            jobParams: {
                metadata: { contextId: 'retry_merge' },
                customParams: { removeLabel: 'sm_pr_merge_triggered' }
            }
        });

        assert.equal(result, true);
        assert.equal(loaded.autoStartCalls.length, 1);
        assert.equal(loaded.autoStartCalls[0].ticketKey, 'TS-125');
        assert.equal(loaded.autoStartCalls[0].configFile, 'agents/pr_rework.json');
        assert.deepEqual(loaded.autoStartCalls[0].stripKeys, [
            'removeLabel',
            'autoStartRework',
            'autoStartReworkConfigFile'
        ]);
    });
    test('ado: merge conflict -> ado_add_work_item_comment / ado_move_to_state / label removal, no jira_*', function() {
        var calls = [];
        function rec(n) { return function(a) { calls.push({ tool: n, args: a }); }; }
        function forbid(n) { return function() { throw new Error(n + ' must not be called on ado'); }; }
        var loaded = loadRetryMergePR({ mocks: {
            ado_add_work_item_comment: rec('ado_add_work_item_comment'),
            ado_move_to_state: rec('ado_move_to_state'),
            ado_remove_work_item_label: rec('ado_remove_work_item_label'),
            jira_remove_label: forbid('jira_remove_label'),
            jira_post_comment: forbid('jira_post_comment'),
            jira_move_to_status: forbid('jira_move_to_status')
        } });
        var result = loaded.mod.action({
            ticket: { key: '125' },
            jobParams: {
                metadata: { contextId: 'retry_merge' },
                customParams: { trackerProvider: 'ado', removeLabel: 'sm_pr_merge_triggered' }
            }
        });
        assert.equal(result, true);
        var moves = calls.filter(function(c) { return c.tool === 'ado_move_to_state'; });
        assert.deepEqual(moves[0].args, { id: '125', state: configModule.STATUSES.IN_REWORK });
        var comments = calls.filter(function(c) { return c.tool === 'ado_add_work_item_comment'; });
        assert.equal(comments[0].args.id, '125');
        assert.contains(comments[0].args.comment, 'MERGE CONFLICT');
        var labels = calls.filter(function(c) { return c.tool === 'ado_remove_work_item_label'; }).map(function(c) { return c.args.label; });
        assert.ok(labels.indexOf('sm_pr_merge_triggered') !== -1);
    });
});
