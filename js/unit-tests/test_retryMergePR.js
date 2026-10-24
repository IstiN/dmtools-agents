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
            './common/prLookup.js': loadModule('js/common/prLookup.js', makeRequire({}), {}),
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

// ── gh-1185: characterization tests for getGitHubRepoInfo (the last
// uncovered retryMergePR function) and the token-usage failure catch. ──

suite('retryMergePR: getGitHubRepoInfo (gh-1185 characterization)', function () {
    function loadWithCli(cliBehavior) {
        var calls = [];
        return {
            calls: calls,
            mod: loadModule('js/retryMergePR.js', makeRequire({
                './config.js': configModule,
                './configLoader.js': { loadProjectConfig: function () { return {}; }, resolveInstructions: configLoaderModule.resolveInstructions },
                './common/scm.js': { createScm: function () { return {}; } },
                './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function () { return false; } },
                './common/tokenUsageComment.js': { postTokenUsageComments: function () {}, customParamsOf: function () { return {}; } },
                './common/trackers.js': d4TrackersWith({ jira_remove_label: function () {}, jira_post_comment: function () {}, jira_move_to_status: function () {} }),
                './common/prLookup.js': loadModule('js/common/prLookup.js', makeRequire({}), {})
            }), {
                cli_execute_command: function (opts) {
                    calls.push(opts && opts.command);
                    return cliBehavior();
                }
            })
        };
    }

    test('parses owner/repo from an SSH remote line, stripping the .git suffix', function () {
        var loaded = loadWithCli(function () { return 'origin  git@github.com:IstiN/trackstate.git\n'; });
        assert.deepEqual(loaded.mod.getGitHubRepoInfo(), { owner: 'IstiN', repo: 'trackstate' });
        assert.deepEqual(loaded.calls, ['git config --get remote.origin.url']);
    });

    test('parses owner/repo from an https remote line among noise', function () {
        var loaded = loadWithCli(function () {
            return 'some noise\nhttps://github.com/acme/widgets.git\nmore noise';
        });
        assert.deepEqual(loaded.mod.getGitHubRepoInfo(), { owner: 'acme', repo: 'widgets' });
    });

    test('a remote without a .git suffix is returned as-is', function () {
        var loaded = loadWithCli(function () { return 'https://github.com/acme/widgets\n'; });
        assert.deepEqual(loaded.mod.getGitHubRepoInfo(), { owner: 'acme', repo: 'widgets' });
    });

    test('multi-segment repo paths pin the regex semantics: the first segment after owner wins', function () {
        var loaded = loadWithCli(function () { return 'git@github.com:acme/path/to/repo-name.git'; });
        assert.deepEqual(loaded.mod.getGitHubRepoInfo(), { owner: 'acme', repo: 'path' });
    });

    test('path/query/fragment characters terminate the repo match (regex semantics pinned)', function () {
        var loaded = loadWithCli(function () { return '\thttps://github.com/acme/widgets.git#main  \n'; });
        assert.deepEqual(loaded.mod.getGitHubRepoInfo(), { owner: 'acme', repo: 'widgets' });
    });

    test('no github.com remote line → null', function () {
        var loaded = loadWithCli(function () { return 'git@gitlab.internal:acme/widgets.git\n'; });
        assert.equal(loaded.mod.getGitHubRepoInfo(), null);
    });

    test('empty CLI output → null', function () {
        var loaded = loadWithCli(function () { return ''; });
        assert.equal(loaded.mod.getGitHubRepoInfo(), null);
    });

    test('a failing git CLI → null (never throws)', function () {
        var loaded = loadWithCli(function () { throw new Error('git not found'); });
        assert.equal(loaded.mod.getGitHubRepoInfo(), null);
    });
});

// ── gh-980: characterization tests for every action() branch, pinning the
// behaviour the CRAP refactor must preserve (retry/skip decision branches,
// merge error classification, tracker/SCM call order). ──

suite('retryMergePR: action branch characterization (gh-980)', function() {
    var PR = {
        number: 121,
        title: 'TS-125 fix',
        html_url: 'https://github.com/IstiN/trackstate/pull/121',
        head: { ref: 'ai/TS-125' }
    };

    // opts-key defaulting without per-use ternaries (CRAP: this helper is
    // measured by the quality gate like any other function).
    function def(opts, key, dflt) {
        return opts[key] !== undefined ? opts[key] : dflt;
    }

    function gh980Scm(opts, calls) {
        var scm = {
            getRemoteRepoInfo: function() { return def(opts, 'repoInfo', { owner: 'IstiN', repo: 'trackstate' }); },
            listPrs: function() { return def(opts, 'prs', [PR]); },
            getPr: function() {
                if (opts.getPrError !== undefined) { throw opts.getPrError; }
                return def(opts, 'prDetail', { mergeable: false, mergeable_state: 'dirty' });
            },
            mergePr: function(n, mode) {
                calls.push({ tool: 'scm_mergePr', args: { number: n, mode: mode } });
                if (opts.mergeError !== undefined) { throw opts.mergeError; }
            },
            removeLabel: function(n, label) { calls.push({ tool: 'scm_removeLabel', args: { number: n, label: label } }); },
            updateBranch: function(n, owner, repo) {
                calls.push({ tool: 'scm_updateBranch', args: { number: n, owner: owner, repo: repo } });
            }
        };
        if (opts.hasUpdateBranch === false) { scm.updateBranch = undefined; }
        return scm;
    }

    function load(opts) {
        opts = opts || {};
        var calls = [];
        function rec(name) {
            return function(args) { calls.push({ tool: name, args: args }); };
        }
        var scm = gh980Scm(opts, calls);
        var tokenCalls = [];
        var mod = loadModule(
            'js/retryMergePR.js',
            makeRequire({
                './config.js': configModule,
                './configLoader.js': {
                    loadProjectConfig: function() {
                        return {
                            repository: { owner: 'IstiN', repo: 'trackstate' },
                            jira: { issueTypes: configModule.ISSUE_TYPES, statuses: configModule.STATUSES },
                            jobParamPatches: {
                                retry_merge: {
                                    customParams: {
                                        autoStartRework: true,
                                        autoStartReworkConfigFile: 'agents/pr_rework.json',
                                        removeLabel: 'from_patch'
                                    }
                                }
                            }
                        };
                    },
                    resolveInstructions: configLoaderModule.resolveInstructions
                },
                './common/scm.js': { createScm: function() { return scm; } },
            './common/prLookup.js': loadModule('js/common/prLookup.js', makeRequire({}), {}),
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return true; }
                },
                './common/tokenUsageComment.js': {
                    postTokenUsageComments: function(ticketKey, o) {
                        if (opts.tokenUsageThrows) { throw opts.tokenUsageThrows; }
                        tokenCalls.push({ ticketKey: ticketKey, opts: o });
                    },
                    customParamsOf: function(params) {
                        return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
                    }
                },
                './common/trackers.js': d4TrackersWith(Object.assign({
                    jira_remove_label: rec('jira_remove_label'),
                    jira_post_comment: rec('jira_post_comment'),
                    jira_move_to_status: rec('jira_move_to_status')
                }, opts.mocks || {}))
            }),
            opts.globals || {}
        );
        return { mod: mod, calls: calls, tokenCalls: tokenCalls };
    }

    function runParams(customParams) {
        return {
            ticket: { key: 'TS-125' },
            jobParams: { metadata: { contextId: 'retry_merge' }, customParams: customParams }
        };
    }

    function toolsOf(calls, name) {
        return calls.filter(function(c) { return c.tool === name; });
    }

    test('no ticket key → false, no SCM/tracker interaction at all', function() {
        var loaded = load();
        assert.equal(loaded.mod.action({}), false);
        assert.equal(loaded.mod.action({ ticket: {} }), false);
        assert.deepEqual(loaded.calls, []);
    });

    test('unresolvable owner/repo → false and the SM lock is released', function() {
        var loaded = load({ repoInfo: null });
        var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
        assert.equal(out, false);
        assert.deepEqual(toolsOf(loaded.calls, 'jira_remove_label').map(function(c) { return c.args; }),
            [{ key: 'TS-125', label: 'sm_pr_merge_triggered' }]);
        assert.equal(toolsOf(loaded.calls, 'scm_mergePr').length, 0);
    });

    test('no open PR for the ticket → false and the SM lock is released', function() {
        var loaded = load({ prs: [] });
        var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
        assert.equal(out, false);
        assert.deepEqual(toolsOf(loaded.calls, 'jira_remove_label').map(function(c) { return c.args.label; }),
            ['sm_pr_merge_triggered']);
        assert.equal(toolsOf(loaded.calls, 'scm_mergePr').length, 0);
    });

    test('mergeability probe failure → mergeable stays null → retry next cycle, no merge attempted', function() {
        var loaded = load({ getPrError: new Error('probe down'), prDetail: null });
        var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
        assert.equal(out, false);
        assert.equal(toolsOf(loaded.calls, 'scm_mergePr').length, 0, 'no merge while mergeability is unknown');
        assert.equal(toolsOf(loaded.calls, 'jira_move_to_status').length, 0);
        assert.equal(toolsOf(loaded.calls, 'jira_remove_label').length, 0);
    });

    var RETRY_STATES = ['unknown', 'blocked', 'unstable', 'checking', 'unchecked', 'preparing', 'ci_must_pass', 'ci_still_running'];
    RETRY_STATES.forEach(function(state) {
        test('not-ready mergeable_state "' + state + '" → retry next cycle, no tracker calls, pr_approved kept', function() {
            var loaded = load({ prDetail: { mergeable: true, mergeable_state: state } });
            var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
            assert.equal(out, false);
            assert.equal(toolsOf(loaded.calls, 'scm_mergePr').length, 0);
            assert.equal(toolsOf(loaded.calls, 'jira_move_to_status').length, 0);
            assert.equal(toolsOf(loaded.calls, 'jira_remove_label').length, 0);
        });
    });

    test('mergeable=null (GitHub still computing) → retry next cycle', function() {
        var loaded = load({ prDetail: { mergeable: null, mergeable_state: 'unknown' } });
        assert.equal(loaded.mod.action(runParams({})), false);
        assert.equal(toolsOf(loaded.calls, 'scm_mergePr').length, 0);
    });

    test('behind → branch update requested, merge deferred to the next cycle', function() {
        var loaded = load({ prDetail: { mergeable: true, mergeable_state: 'behind' } });
        var out = loaded.mod.action(runParams({}));
        assert.equal(out, false);
        assert.deepEqual(toolsOf(loaded.calls, 'scm_updateBranch')[0].args,
            { number: 121, owner: 'IstiN', repo: 'trackstate' });
        assert.equal(toolsOf(loaded.calls, 'scm_mergePr').length, 0);
        assert.equal(toolsOf(loaded.calls, 'jira_move_to_status').length, 0);
    });

    test('behind without provider support → warning, merge still deferred', function() {
        var loaded = load({ prDetail: { mergeable: true, mergeable_state: 'behind' }, hasUpdateBranch: false });
        assert.equal(loaded.mod.action(runParams({})), false);
        assert.equal(toolsOf(loaded.calls, 'scm_mergePr').length, 0);
    });

    ['cannot_be_merged', 'conflict'].forEach(function(state) {
        test('mergeable_state "' + state + '" (even mergeable=true) → conflict path: labels stripped, In Rework', function() {
            var loaded = load({ prDetail: { mergeable: true, mergeable_state: state } });
            var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
            assert.equal(out, true);
            assert.contains(toolsOf(loaded.calls, 'jira_post_comment')[0].args.comment, 'MERGE CONFLICT');
            assert.deepEqual(toolsOf(loaded.calls, 'jira_move_to_status')[0].args,
                { key: 'TS-125', statusName: configModule.STATUSES.IN_REWORK });
            assert.deepEqual(toolsOf(loaded.calls, 'jira_remove_label').map(function(c) { return c.args.label; }),
                ['pr_approved', 'sm_pr_merge_triggered']);
        });
    });

    test('clean mergeable PR → squash merge; GitHub label and lock stripped before the Merged move, pr_approved after', function() {
        var loaded = load({ prDetail: { mergeable: true, mergeable_state: 'clean' } });
        var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
        assert.equal(out, true);
        assert.deepEqual(toolsOf(loaded.calls, 'scm_mergePr')[0].args, { number: 121, mode: 'squash' });
        var events = loaded.calls.map(function(c) { return c.tool; });
        function idx(name) { return events.indexOf(name); }
        function lastIdx(name) { return events.lastIndexOf(name); }
        assert.ok(idx('scm_removeLabel') !== -1 && idx('scm_removeLabel') < idx('jira_move_to_status'),
            'the cosmetic GitHub label strip happens BEFORE the tracker status move');
        assert.ok(idx('jira_move_to_status') < lastIdx('jira_remove_label'),
            'the Merged move happens BEFORE pr_approved is stripped from Jira');
        assert.deepEqual(toolsOf(loaded.calls, 'jira_move_to_status')[0].args,
            { key: 'TS-125', statusName: configModule.STATUSES.MERGED });
        assert.deepEqual(toolsOf(loaded.calls, 'jira_remove_label').map(function(c) { return c.args.label; }),
            ['sm_pr_merge_triggered', 'pr_approved']);
    });

    var TEMPORARY_ERRORS = ['blocked by required check', 'HTTP 422: Unprocessable Entity', 'HTTP 405: Method Not Allowed', ''];
    TEMPORARY_ERRORS.forEach(function(msg) {
        test('merge error "' + (msg || '<empty>') + '" → temporary block: retry next cycle, pr_approved kept', function() {
            var loaded = load({ prDetail: { mergeable: true, mergeable_state: 'clean' }, mergeError: msg });
            var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
            assert.equal(out, false);
            assert.equal(toolsOf(loaded.calls, 'jira_move_to_status').length, 0);
            assert.equal(toolsOf(loaded.calls, 'jira_remove_label').length, 0);
            assert.equal(loaded.tokenCalls.length, 0);
        });
    });

    test('merge error mentioning conflict → In Rework with the merge-conflict reason', function() {
        var loaded = load({ prDetail: { mergeable: true, mergeable_state: 'clean' }, mergeError: new Error('Merge conflict detected') });
        var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
        assert.equal(out, true);
        var comment = toolsOf(loaded.calls, 'jira_post_comment')[0].args.comment;
        assert.contains(comment, 'MERGE FAILED');
        assert.contains(comment, 'merge conflict');
        assert.deepEqual(toolsOf(loaded.calls, 'jira_move_to_status')[0].args,
            { key: 'TS-125', statusName: configModule.STATUSES.IN_REWORK });
    });

    test('unclassified merge error → In Rework with the CI-failing reason + token usage summary posted', function() {
        var loaded = load({ prDetail: { mergeable: true, mergeable_state: 'clean' }, mergeError: new Error('validation failed') });
        var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
        assert.equal(out, true);
        var comment = toolsOf(loaded.calls, 'jira_post_comment')[0].args.comment;
        assert.contains(comment, 'MERGE FAILED');
        assert.contains(comment, 'CI checks failing or PR not mergeable');
        assert.deepEqual(toolsOf(loaded.calls, 'jira_move_to_status')[0].args,
            { key: 'TS-125', statusName: configModule.STATUSES.IN_REWORK });
        assert.equal(loaded.tokenCalls.length, 1, 'token usage summary posts once on the failing path');
        assert.equal(loaded.tokenCalls[0].ticketKey, 'TS-125');
    });

    test('a failing token-usage post never fails the action (gh-1185 branch coverage)', function() {
        var loaded = load({
            prDetail: { mergeable: true, mergeable_state: 'clean' },
            mergeError: new Error('validation failed'),
            tokenUsageThrows: new Error('comment API down')
        });
        var out = loaded.mod.action(runParams({ removeLabel: 'sm_pr_merge_triggered' }));
        assert.equal(out, true, 'the escalation result survives the token-usage failure');
        assert.deepEqual(toolsOf(loaded.calls, 'jira_move_to_status')[0].args,
            { key: 'TS-125', statusName: configModule.STATUSES.IN_REWORK });
    });
});

suite('retryMergePR pure helpers (gh-980)', function() {
    test('decideMergeReadiness maps every mergeability signal to its decision', function() {
        var loaded = loadRetryMergePR();
        var decide = loaded.mod.decideMergeReadiness;
        assert.equal(typeof decide, 'function', 'decideMergeReadiness is exported');
        // CI still running / GitHub still computing
        ['unknown', 'blocked', 'unstable', 'checking', 'unchecked', 'preparing', 'ci_must_pass', 'ci_still_running']
            .forEach(function(s) { assert.equal(decide(true, s), 'retry', s); });
        assert.equal(decide(null, 'clean'), 'retry', 'mergeable=null always retries');
        // branch behind base
        assert.equal(decide(true, 'behind'), 'updateBranch');
        // conflicts
        assert.equal(decide(false, 'dirty'), 'conflict');
        assert.equal(decide(true, 'cannot_be_merged'), 'conflict');
        assert.equal(decide(false, 'conflict'), 'conflict');
        // a null mergeable outranks every state — GitHub is still computing
        assert.equal(decide(null, 'conflict'), 'retry');
        assert.equal(decide(null, 'dirty'), 'retry');
        // everything else is mergeable
        assert.equal(decide(true, 'clean'), 'merge');
        assert.equal(decide(false, 'clean'), 'merge', 'mergeable=false without a conflict state still attempts the merge');
    });

    test('classifyMergeError separates conflicts, temporary blocks and hard failures', function() {
        var loaded = loadRetryMergePR();
        var classify = loaded.mod.classifyMergeError;
        assert.equal(typeof classify, 'function', 'classifyMergeError is exported');
        assert.equal(classify(new Error('Merge Conflict detected')), 'conflict');
        assert.equal(classify('blocked by branch protection'), 'temporary');
        assert.equal(classify('HTTP 422'), 'temporary');
        assert.equal(classify('HTTP 405'), 'temporary');
        assert.equal(classify(''), 'temporary');
        assert.equal(classify(null), 'temporary');
        assert.equal(classify(new Error('validation failed')), 'ci-failing');
    });
});
