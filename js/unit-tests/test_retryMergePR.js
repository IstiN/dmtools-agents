/**
 * Unit tests for retryMergePR.js.
 */

function loadRetryMergePR(options) {
    options = options || {};
    var autoStartCalls = [];
    var config = options.config || {
        repository: { owner: 'IstiN', repo: 'trackstate' },
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
            }
        }),
        {
            jira_remove_label: function() {},
            jira_post_comment: function() {},
            jira_move_to_status: function() {}
        }
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
});
