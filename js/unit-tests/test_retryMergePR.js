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

// ── gh-916: stage-label fallback for the In Review - Passed gate and the final moves ──

suite('retryMergePR: stage-label fallback (gh-916)', function() {
    function gh916RetryScm() {
        return {
            getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; },
            listPrs: function() {
                return [{ number: 130, title: 'TS-130 fix', html_url: 'https://github.com/IstiN/trackstate/pull/130', head: { ref: 'ai/TS-130' } }];
            },
            getPr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            mergePr: function() {},
            removeLabel: function() {},
            updateBranch: function() {}
        };
    }

    test("'label' mode: test-case merge with a stage_in_review_passed marker resolves to Passed and marks stage_passed when rejected", function() {
        var added = [];
        var moves = [];
        var loaded = loadRetryMergePR({
            scm: gh916RetryScm(),
            mocks: {
                jira_get_ticket: function() { return { fields: { status: { name: 'New' }, labels: ['stage_in_review_passed'] } }; },
                jira_move_to_status: function(args) {
                    moves.push(args);
                    throw new Error("The field 'State' contains the value 'Passed' that is not in the list of supported values");
                },
                jira_add_label: function(args) { added.push(args); },
                jira_remove_label: function() {},
                jira_post_comment: function() {}
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-130' },
            jobParams: {
                metadata: { contextId: 'retry_merge_test' },
                customParams: { testCaseMerge: true, stageFallback: 'label', removeLabel: 'sm_pr_merge_test_triggered' }
            }
        });

        assert.equal(result, true);
        assert.deepEqual(moves, [{ key: 'TS-130', statusName: 'Passed' }]);
        assert.deepEqual(added, [{ key: 'TS-130', label: 'stage_passed' }]);
    });

    test("'label' mode: a rejected Merged move marks stage_merged — no throw", function() {
        var added = [];
        var loaded = loadRetryMergePR({
            scm: gh916RetryScm(),
            mocks: {
                jira_move_to_status: function() { throw new Error('state rejected'); },
                jira_add_label: function(args) { added.push(args); },
                jira_remove_label: function() {},
                jira_post_comment: function() {}
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-130' },
            jobParams: {
                metadata: { contextId: 'retry_merge' },
                customParams: { stageFallback: 'label', removeLabel: 'sm_pr_merge_triggered' }
            }
        });

        assert.equal(result, true);
        assert.deepEqual(added, [{ key: 'TS-130', label: 'stage_merged' }]);
    });
});
