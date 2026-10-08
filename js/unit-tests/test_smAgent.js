/**
 * Unit tests for js/smAgent.js
 *
 * Tests JQL interpolation, config loading, rule dispatch, and label skipping.
 *
 * Uses: configModule, configLoaderModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a smAgent instance with full mock injection.
 *
 * The key design: a fresh configLoader is created per test using the SAME
 * file_read mock, so config discovery paths are fully controlled by fileMap.
 *
 * file_read mock strategy:
 *   - Paths containing ".dmtools/config" → only accessible if listed in fileMap
 *     (ensures "no config" tests don't accidentally load the real project config)
 *   - All other paths → forwarded to the real file_read (for agent JSON configs etc.)
 *
 * @param {Object} opts
 *   fileMap        - { path: content } for config file discovery (config paths only)
 *   tickets        - tickets returned by jira_search_by_jql (default: [])
 *   fullTicket     - ticket returned by jira_get_ticket
 *   onTrigger      - fn(owner, repo, workflow, inputs, ref) called on triggerWorkflow
 *   onAddLabel     - fn(opts) called on jira_add_label
 *   onMoveStatus   - fn(opts) called on jira_move_to_status
 *   workflowRuns   - { queued: [], in_progress: [] } active workflow runs by status
 */
function makeSmAgent(opts) {
    opts = opts || {};

    var capturedTriggers = [];
    var capturedLabels = [];
    var capturedStatusMoves = [];
    var capturedJqls = [];
    var capturedCliCommands = [];
    var capturedCloses = [];
    var capturedPrMerges = [];
    var capturedPrLabelAdds = [];
    var capturedPrLabelRemoves = [];
    var capturedPrComments = [];
    var capturedEnvSets = [];
    var capturedScmConfigs = [];
    var capturedIoCacheDrops = [];
    var capturedLogs = [];

    // Controlled file_read: config discovery paths from fileMap only; other paths from disk.
    var fileReadMock = function(readOpts) {
        var p = readOpts.path;
        var isConfigDiscovery = p.indexOf('.dmtools/config') !== -1;

        if (opts.fileMap && opts.fileMap.hasOwnProperty(p)) {
            return opts.fileMap[p];
        }
        // Block config discovery for paths not in fileMap (so tests control exactly which config loads)
        if (isConfigDiscovery) return null;

        // Forward agent JSON / JS reads to disk
        // Try with agents/ prefix first (submodule layout), then without (standalone)
        try {
            var result = file_read(readOpts);
            if (result) return result;
        } catch (e) {}
        if (p.indexOf('agents/') === 0) {
            try { return file_read({ path: p.substring('agents/'.length) }); } catch (e) {}
        }
        return null;
    };

    var jiraSearchMock = function(searchOpts) {
        capturedJqls.push(searchOpts.jql);
        return opts.tickets || [];
    };

    var smMocks = {
        file_read: fileReadMock,
        jira_search_by_jql: jiraSearchMock,
        jira_get_ticket: function(key) {
            return opts.fullTicket || { key: key, fields: { labels: [], summary: 'Test ticket' } };
        },
        jira_add_label: function(labelOpts) {
            capturedLabels.push(labelOpts);
            if (opts.onAddLabel) opts.onAddLabel(labelOpts);
        },
        jira_remove_label: function() {},
        jira_move_to_status: function(moveOpts) {
            capturedStatusMoves.push(moveOpts);
            if (opts.onMoveStatus) opts.onMoveStatus(moveOpts);
        },
        cli_execute_command: function(cmdOpts) {
            capturedCliCommands.push(cmdOpts);
            if (opts.onCliExecute) return opts.onCliExecute(cmdOpts);
            return '';
        },
        // Bridge tools used by syncValidationChecks (stamp echo of the
        // dispatched run). Default: delegate to the host bridge when
        // present (preserves prior behavior); tests override via
        // opts.github.prList / opts.github.workflowApiRuns.
        github_list_prs: function(args) {
            if (opts.github && opts.github.prList) return opts.github.prList;
            return (typeof github_list_prs !== 'undefined') ? github_list_prs(args) : '[]';
        },
        github_list_workflow_runs: function(args) {
            if (opts.github && opts.github.workflowApiRuns) {
                return JSON.stringify({ workflow_runs: opts.github.workflowApiRuns });
            }
            return (typeof github_list_workflow_runs !== 'undefined')
                ? github_list_workflow_runs(args)
                : '{"workflow_runs":[]}';
        },
        // Backlog source for the statePublish block (gh-769): safe default —
        // without it the block hits the real bridge (dmtools runtime) or a
        // ReferenceError (node harness) on every publish tick.
        github_search_issues: function(args) {
            if (opts.github && opts.github.issueSearch) {
                return JSON.stringify(opts.github.issueSearch);
            }
            return '{"items":[]}';
        },
        file_write: function(writeOpts) {
            if (opts.onFileWrite) opts.onFileWrite(writeOpts);
            return true;
        },
        encodeURIComponent: encodeURIComponent,
        JSON: JSON,
        eval: eval
    };
    // runAsync fake injection (spec: probeDispatchedState delegation pin) —
    // shadows the (absent) global inside the smAgent module scope.
    if (opts.runAsync) smMocks.runAsync = opts.runAsync;

    // Console capture (owner directive 2026-10-08 priority-tier tests): the
    // 🥇 preemption line prints from inside the source query (githubSource),
    // so the mock shadows the module-scope console for every loadModule'd
    // module that receives smMocks (smAgent, githubSource, smAsync).
    if (opts.captureConsole) {
        var captureInto = function () {
            capturedLogs.push(Array.prototype.map.call(arguments, String).join(' '));
        };
        smMocks.console = { log: captureInto, warn: captureInto, error: captureInto };
    }

    // SCM mock: intercepts triggerWorkflow so capturedTriggers is populated
    var mockScmProvider = {
        triggerWorkflow: function(owner, repo, workflow, inputs, ref) {
            capturedTriggers.push({ owner: owner, repo: repo, workflow: workflow, inputs: inputs, ref: ref });
            if (opts.onTrigger) opts.onTrigger(owner, repo, workflow, inputs, ref);
        },
        listPrs: function() { return '[]'; },
        getPr: function() { return '{}'; },
        getPrComments: function() { return '[]'; },
        addComment: function() {},
        replyToThread: function() {},
        resolveThread: function() {},
        mergePr: function() {},
        addLabel: function() {},
        removeLabel: function() {},
        fetchDiscussions: function() { return { markdown: '', rawThreads: [] }; },
        listWorkflowRuns: function(status) {
            var byStatus = opts.workflowRuns || {};
            return JSON.stringify({ workflow_runs: byStatus[status] || [] });
        },
        getRemoteRepoInfo: function() { return null; }
    };
    var mockScmModule = {
        createScm: function(config) { capturedScmConfigs.push(config); return mockScmProvider; }
    };

    // CRITICAL: create a fresh configLoader using the SAME file_read mock.
    // If we reuse the global configLoaderModule, it calls the real file_read and
    // would load the actual .dmtools/config.js regardless of what fileMap says.
    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({ './config.js': configModule, './common/scm.js': mockScmModule }),
        { file_read: fileReadMock }
    );

    var buildEncodedConfigModule = loadModule(
        'js/common/buildEncodedConfig.js',
        makeRequire({ '../configLoader.js': freshConfigLoader }),
        { file_read: fileReadMock, encodeURIComponent: encodeURIComponent, JSON: JSON }
    );

    // The jira state source, stubbed to the mocked jira_search_by_jql
    // (mirrors js/sm/sources/jiraSource.js against the same global mock).
    // NOTE: the stub closes over jiraSearchMock (makeSmAgent's scope) —
    // the test file's own jira_search_by_jql global is the REAL bridge tool
    // (mocks only shadow globals inside loadModule'd modules).
    var jiraSourceStub = {
        query: function (rule, ctx) {
            var tickets = jiraSearchMock({ jql: (ctx && ctx.jql) || rule.jql, fields: ['key', 'labels'] }) || [];
            return (Array.isArray(tickets) ? tickets : []).map(function (t) {
                return { key: t.key,
                         labels: (t.fields && t.fields.labels) || t.labels || [],
                         pr: null, issueNumber: null, prNumber: null };
            });
        }
    };
    // Optional github source stub: opts.github = { items: [...], pr: {...} } —
    // for close-on-merge (localAction) and PR-lifecycle (#687) rule tests.
    if (opts.github) {
        jiraSourceStub = {
            // items may be a FUNCTION (owner directive 2026-10-04 same-tick
            // tests): called per rule query, returning that rule's live
            // candidate list — models the engine's re-query after a
            // mid-tick label mutation (ioCache drop).
            query: function (rule, ctx) {
                return typeof opts.github.items === 'function'
                    ? opts.github.items(rule, ctx)
                    : opts.github.items;
            }
        };
        smMocks.github_close_issue = function (closeOpts) {
            capturedCloses.push(closeOpts);
        };
        // #687 PR-lifecycle localActions: capture every GitHub mutation.
        smMocks.github_merge_pr = function (mergeOpts) {
            capturedPrMerges.push(mergeOpts);
            return opts.github.mergeResult !== undefined
                ? opts.github.mergeResult
                : JSON.stringify({ merged: true, sha: 'deadbeef', message: 'Pull Request successfully merged' });
        };
        smMocks.github_add_labels = function (labelOpts) { capturedPrLabelAdds.push(labelOpts); };
        smMocks.github_remove_label = function (remOpts) { capturedPrLabelRemoves.push(remOpts); };
        smMocks.github_create_comment = function (cOpts) { capturedPrComments.push(cOpts); };
        smMocks.github_get_pr = function () {
            return JSON.stringify(opts.github.pr || { number: 1, body: opts.github.prBody || '' });
        };
        // #544: linked-issue existence probe — a scraped #N that 404s
        // (cross-repo/dangling) must degrade to a PR-anchored dispatch.
        // Live-bridge shape: the sync tool does NOT throw on 404 — it
        // returns the REST error BODY; issueLookupBody simulates that.
        // issues (owner directive 2026-10-08): map issueNumber → issue
        // payload — the priority-tier resolution reads linked-issue
        // LABELS through this tool (githubSource cachedIssueLabels).
        smMocks.github_get_issue = function (issueOpts) {
            if (opts.github.issueLookupError) throw new Error(opts.github.issueLookupError);
            if (opts.github.onIssueLookup) opts.github.onIssueLookup(issueOpts && issueOpts.issueNumber);
            if (opts.github.issueLookupBody) return opts.github.issueLookupBody;
            var n = issueOpts && issueOpts.issueNumber;
            if (opts.github.issues && opts.github.issues[n] !== undefined) {
                return opts.github.issues[n];
            }
            return opts.github.issue || { number: n };
        };
        smMocks.github_get_pr_comments = function () {
            return JSON.stringify(opts.github.prComments || []);
        };
        // dmtools-agents#682 (rerun_cancelled_checks): the head's check-run
        // rollup — conclusions exactly as the REST commit check-runs tool
        // returns them (lowercase).
        smMocks.github_get_commit_check_runs = function () {
            if (opts.github.commitCheckRunsError) throw new Error(opts.github.commitCheckRunsError);
            return JSON.stringify(opts.github.commitCheckRuns || { check_runs: [] });
        };
        smMocks.set_env_variable = function (name, value) {
            capturedEnvSets.push({ name: name, value: value });
        };
    }
    var machineAuthorModule = loadModule(
        'js/common/machineAuthor.js', makeRequire({}), {}
    );
    // Real github source (owner directive 2026-10-08 priority tiers): the
    // items-stub above replaces the whole source query, which would bypass
    // queryPrs' tier-aware FIFO sort and the linked-issue label carrier.
    // opts.github.realSource routes github rules through the REAL
    // js/sm/sources/githubSource.js — opts.github.prList is the raw REST
    // /pulls payload (served by smMocks.github_list_prs), prStatus comes
    // from the provider stub (shared object, or prStatusByPr keyed by PR
    // number), and github_get_issue serves opts.github.issues.
    if (opts.github && opts.github.realSource) {
        var realProvider = {
            prStatus: function (n) {
                if (opts.github.prStatusByPr) return opts.github.prStatusByPr[n] || null;
                return opts.github.prStatus || null;
            }
        };
        var smProviderStub = { createSmProvider: function () { return realProvider; } };
        var smAsyncForSource = loadModule(
            'js/common/smAsync.js',
            makeRequire({ './common/smProvider.js': smProviderStub }),
            smMocks
        );
        jiraSourceStub = loadModule(
            'js/sm/sources/githubSource.js',
            makeRequire({
                '../../common/machineAuthor.js': machineAuthorModule,
                '../../common/smProvider.js': smProviderStub,
                '../../common/smAsync.js': smAsyncForSource
            }),
            smMocks
        );
    }
    var sm = loadModule(
        'js/smAgent.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './sm/sourceResolver.js': { resolve: function () { return jiraSourceStub; } },
            './common/scm.js': mockScmModule,
            './common/buildEncodedConfig.js': buildEncodedConfigModule,
            './common/machineAuthor.js': machineAuthorModule,
            './common/smProvider.js': {
                createSmProvider: function () {
                    return {
                        prStatus: function () {
                            return (opts.github && opts.github.prStatus) || null;
                        }
                    };
                },
                // ioCacheDrop spy (owner directive 2026-10-04): the same-tick
                // slot-yield tests assert fail_validation/unarm drop the
                // cached open-PR list after mutating labels.
                ioCacheDrop: function (o, r, kind, id) {
                    capturedIoCacheDrops.push({ owner: o, repo: r, kind: kind, id: id });
                }
            },
            './factoryState.js': loadModule('js/factoryState.js',
                makeRequire({ './common/machineAuthor.js': machineAuthorModule }), {}),
        }),
        smMocks
    );

    return {
        action: sm.action,
        applyRuleOverridesForTest: sm.applyRuleOverridesForTest,
        probeDispatchedState: sm.probeDispatchedState,
        hasRecentHeadRun: sm.hasRecentHeadRun,
        dispatchRaceGraceMs: sm.dispatchRaceGraceMs,
        capturedTriggers: capturedTriggers,
        capturedLabels: capturedLabels,
        capturedStatusMoves: capturedStatusMoves,
        capturedJqls: capturedJqls,
        capturedCliCommands: capturedCliCommands,
        capturedCloses: capturedCloses,
        capturedPrMerges: capturedPrMerges,
        capturedPrLabelAdds: capturedPrLabelAdds,
        capturedPrLabelRemoves: capturedPrLabelRemoves,
        capturedPrComments: capturedPrComments,
        capturedEnvSets: capturedEnvSets,
        capturedScmConfigs: capturedScmConfigs,
        capturedIoCacheDrops: capturedIoCacheDrops,
        capturedLogs: capturedLogs
    };
}

/** Minimal sm.json-style rule */
function makeRule(jql, overrides) {
    var base = {
        description: 'test rule',
        jql: jql,
        configFile: 'agents/test.json'
    };
    if (overrides) {
        for (var k in overrides) {
            if (overrides.hasOwnProperty(k)) base[k] = overrides[k];
        }
    }
    return base;
}

/** Base jobParams with owner/repo */
function baseParams(owner, repo, rules) {
    return {
        jobParams: {
            owner: owner || 'test-org',
            repo: repo || 'test-repo',
            rules: rules || []
        }
    };
}

/** JSON string for a minimal agent config with postJSAction */
var MINIMAL_AGENT_CONFIG = JSON.stringify({
    name: 'JSRunner',
    params: {
        postJSAction: 'js/unit-tests/_fixtures/noop.js',
        customParams: {}
    }
});

suite('sm.json rule ordering', function() {
    test('failed test case bug creation runs before bug development consumes workflow cap', function() {
        var config = JSON.parse(file_read({ path: 'sm.json' }));
        var rules = config.params.jobParams.rules;
        var indexByDescription = {};

        rules.forEach(function(rule, index) {
            indexByDescription[rule.description] = index;
        });

        var failedTcBulk = indexByDescription['Failed Test Cases → create or link bugs in batch'];
        var bugDevelopment = indexByDescription['Backlog / To Do / Ready For Development / In Development / In Rework Bugs → trigger bug_development'];

        assert.ok(failedTcBulk >= 0, 'failed TC bulk creation rule exists');
        assert.ok(bugDevelopment >= 0, 'bug development rule exists');
        assert.ok(
            failedTcBulk < bugDevelopment,
            'failed TC bug creation must be prioritized before bug development uses maxTriggeredWorkflows'
        );
    });

    test('bug development has a cooldown to avoid Copilot rate-limit retry storms', function() {
        var config = JSON.parse(file_read({ path: 'sm.json' }));
        var rules = config.params.jobParams.rules;
        var bugDevelopment = null;

        rules.forEach(function(rule) {
            if (rule.description === 'Backlog / To Do / Ready For Development / In Development / In Rework Bugs → trigger bug_development') {
                bugDevelopment = rule;
            }
        });

        assert.ok(bugDevelopment, 'bug development rule exists');
        assert.contains(bugDevelopment.jql, 'updated <= -15m');
        assert.equal(bugDevelopment.limit, 1, 'bug development should retry one ticket per SM cycle to avoid Copilot rate-limit bursts');
        assert.equal(bugDevelopment.concurrencyKey, 'bug_development', 'bug development should use shared active-run detection across SM cycles');
    });

    test('recover merged PR runs before pr_rework so In Rework tickets with merged PR are recovered first', function() {
        var config = JSON.parse(file_read({ path: 'sm.json' }));
        var rules = config.params.jobParams.rules;
        var indexByDescription = {};

        rules.forEach(function(rule, index) {
            indexByDescription[rule.description] = index;
        });

        var recoverMerged = indexByDescription['Review/Rework/Blocked Stories & Bugs with already merged PR → recover Merged status'];
        var prRework = indexByDescription['In Rework Stories & Bugs → trigger pr_rework'];

        assert.ok(recoverMerged >= 0, 'recover merged PR rule exists');
        assert.ok(prRework >= 0, 'pr_rework rule exists');
        assert.ok(
            recoverMerged < prRework,
            'recover_merged_pr must run before pr_rework to avoid starting rework on tickets whose PR is already merged'
        );
    });

    test('stuck test case recovery has a cooldown to avoid racing active automation', function() {
        var config = JSON.parse(file_read({ path: 'sm.json' }));
        var rules = config.params.jobParams.rules;
        var stuckRecovery = null;

        rules.forEach(function(rule) {
            if (rule.description === 'Stuck In Development Test Cases → recover (check PR, route to Rework/Review/Backlog)') {
                stuckRecovery = rule;
            }
        });

        assert.ok(stuckRecovery, 'stuck test case recovery rule exists');
        assert.contains(stuckRecovery.jql, 'updated <= -15m');
        assert.equal(stuckRecovery.localExecution, true, 'recovery should stay local execution');
    });
});

// ── JQL interpolation ─────────────────────────────────────────────────────────

suite('smAgent: JQL interpolation', function() {

    test('replaces {jiraProject} with project from config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "MYPROJ", parentTicket: "MYPROJ-1" }, repository: { owner: "test-org", repo: "test-repo" } };'
            }
        });

        sm.action(baseParams('test-org', 'test-repo', [
            makeRule("project = {jiraProject} AND issuetype = 'Story'")
        ]));

        assert.equal(sm.capturedJqls.length, 1, 'one JQL was executed');
        assert.contains(sm.capturedJqls[0], 'project = MYPROJ', 'project placeholder replaced');
        assert.notContains(sm.capturedJqls[0], '{jiraProject}', 'placeholder removed');
    });

    test('replaces {parentTicket} with parentTicket from config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "PROJ", parentTicket: "PROJ-99" }, repository: { owner: "o", repo: "r" } };'
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND parent = {parentTicket}")
        ]));

        assert.contains(sm.capturedJqls[0], 'parent = PROJ-99', 'parentTicket placeholder replaced');
    });

    test('leaves JQL unchanged when no config file found', function() {
        var sm = makeSmAgent({ fileMap: {} }); // no config file

        sm.action(baseParams('test-org', 'test-repo', [
            makeRule("project = HARDCODED AND issuetype = 'Bug'")
        ]));

        assert.equal(sm.capturedJqls.length, 1);
        assert.contains(sm.capturedJqls[0], 'project = HARDCODED', 'hardcoded JQL preserved');
    });

    test('multiple rules each get JQL interpolated', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "MULTI", parentTicket: "MULTI-1" }, repository: { owner: "o", repo: "r" } };'
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Backlog'"),
            makeRule("project = {jiraProject} AND status = 'In Review'"),
            makeRule("project = {jiraProject} AND parent = {parentTicket}")
        ]));

        assert.equal(sm.capturedJqls.length, 3);
        assert.contains(sm.capturedJqls[0], 'project = MULTI');
        assert.contains(sm.capturedJqls[1], 'project = MULTI');
        assert.contains(sm.capturedJqls[2], 'parent = MULTI-1');
    });

});

// ── Config overrides ──────────────────────────────────────────────────────────

suite('smAgent: config repository override', function() {

    test('uses repository from config when provided', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { repository: { owner: "config-org", repo: "config-repo" }, jira: { project: "P" } };'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action({
            jobParams: {
                owner: 'params-org',   // should be overridden
                repo: 'params-repo',   // should be overridden
                rules: [makeRule("project = {jiraProject} AND status = 'Backlog'")]
            }
        });

        assert.equal(sm.capturedTriggers.length, 1);
        assert.equal(sm.capturedTriggers[0].owner, 'config-org', 'config owner used');
        assert.equal(sm.capturedTriggers[0].repo, 'config-repo', 'config repo used');
    });

    test('uses params owner/repo when no config file', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('param-owner', 'param-repo', [
            makeRule("project = FIXED AND status = 'Ready'")
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        assert.equal(sm.capturedTriggers[0].owner, 'param-owner');
        assert.equal(sm.capturedTriggers[0].repo, 'param-repo');
    });

});

// ── smRules override ──────────────────────────────────────────────────────────

suite('smAgent: smRules override from config', function() {

    test('uses smRules from config when provided — ignores params.rules', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  jira: { project: "PROJ" },' +
                    '  smRules: [{' +
                    '    jql: "project = {jiraProject} AND status = \'Custom\'",' +
                    '    configFile: "agents/custom.json",' +
                    '    description: "custom rule from config"' +
                    '  }]' +
                    '};'
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = SHOULD_NOT_RUN AND status = 'Backlog'") // should be ignored
        ]));

        assert.equal(sm.capturedJqls.length, 1, 'only config rules ran');
        assert.contains(sm.capturedJqls[0], "status = 'Custom'", 'config rule JQL used');
        assert.notContains(sm.capturedJqls[0], 'SHOULD_NOT_RUN', 'params rule ignored');
    });

    test('uses params.rules when config smRules is null', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" }, smRules: null };'
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Params Rule'")
        ]));

        assert.equal(sm.capturedJqls.length, 1);
        assert.contains(sm.capturedJqls[0], "status = 'Params Rule'", 'params rule used');
    });

});

// ── Ticket dispatch ───────────────────────────────────────────────────────────


suite('smRuleOverrides: id-based patching (github rules)', function() {
  test('patches a github rule by its stable id', function() {
    var patched = makeSmAgent({}).applyRuleOverridesForTest(
      [{ id: 'rework-on-red-ci', limit: 1, description: 'x' }],
      { 'rework-on-red-ci': { limit: 5, enabled: false } });
    assert.equal(patched[0].limit, 5, 'limit patched');
    assert.equal(patched[0].enabled, false, 'enabled patched');
    assert.equal(patched[0].description, 'x', 'untouched keys preserved');
  });
  test('configFile keys still work (jira rules)', function() {
    var patched = makeSmAgent({}).applyRuleOverridesForTest(
      [{ configFile: 'agents/sm.json' }], { 'agents/sm.json': { enabled: false } });
    assert.equal(patched[0].enabled, false, 'configFile match');
  });
  test('unmatched rules pass through untouched', function() {
    var patched = makeSmAgent({}).applyRuleOverridesForTest(
      [{ id: 'other' }], { 'rework-on-red-ci': { limit: 5 } });
    assert.equal(patched[0].limit, undefined, 'no patch applied');
  });
});

suite('smAgent: localAction close_issue (github close-on-merge)', function () {

    test('closes the issue when the linked PR is MERGED; no workflow dispatch', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [
                    { key: 'gh-155', labels: ['ai_developed', 'pr_approved'], issueNumber: 155, prNumber: 157,
                      pr: { number: 157, state: 'MERGED', checks: 'none', mergeState: 'UNKNOWN', mergeable: null } }
                ]
            }
        });

        sm.action(baseParams('epam', 'dmtools-dart', [{
            description: 'GitHub: linked PR merged → close the issue',
            source: 'github',
            query: { type: 'issue', labels: ['ai_developed'], prState: 'MERGED' },
            localAction: 'close_issue',
            limit: 5,
            id: 'close-on-merge'
        }]));

        assert.equal(sm.capturedCloses.length, 1, 'issue closed exactly once');
        assert.equal(sm.capturedCloses[0].number, 155, 'closes the matching issue');
        assert.equal(sm.capturedCloses[0].workspace, 'epam', 'owner from rule context');
        assert.equal(sm.capturedCloses[0].repository, 'dmtools-dart', 'repo from rule context');
        assert.equal(sm.capturedTriggers.length, 0, 'no workflow dispatched for a localAction rule');
        assert.equal(sm.capturedLabels.length, 0, 'no label churn');
    });

    test('localAction rule is valid without configFile or inputs', function () {
        // Smoke: the validation branch must not skip such rules (no crash, no dispatch).
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "a", repo: "b" } };' },
            github: { items: [] }
        });

        sm.action(baseParams('a', 'b', [{
            source: 'github',
            query: { type: 'issue', labels: ['ai_developed'], prState: 'MERGED' },
            localAction: 'close_issue',
            id: 'close-on-merge'
        }]));

        assert.equal(sm.capturedCloses.length, 0, 'nothing to close');
        assert.equal(sm.capturedTriggers.length, 0, 'no dispatch');
    });
});

suite('smAgent: localAction arm_rework (gh-683 unresolved review threads)', function () {

    test('labels the PR agent:rework + explains in a comment; no workflow dispatched', function () {
        // Live fa #1194/#1211/#1212 + dart #340 (2026-10-04): green +
        // reviewed + validated machine PRs with OPEN review threads matched
        // no rule (every re-review armer requires threadsResolved:true).
        // arm_rework arms the PR label; rework-on-label (an existing rule)
        // dispatches the leg and consumes the label — so this action must
        // NOT dispatch anything itself.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [
                    { key: 'pr-1211', labels: ['ai_pr_reviewed'], issueNumber: null, prNumber: 1211,
                      pr: { number: 1211, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true } }
                ]
            }
        });

        sm.action(baseParams('epam', 'dmtools-dart', [{
            description: 'unresolved review threads on a machine-authored reviewed PR -> arm agent:rework',
            source: 'github',
            query: {
                type: 'pr',
                labels: ['ai_pr_reviewed'],
                notLabels: ['agent:rework', 'agent:review', 'ai_validating', 'pr_approved', 'validation_failed'],
                prMachineAuthor: true,
                threadsResolved: false,
                draft: false
            },
            localAction: 'arm_rework',
            limit: 5,
            id: 'rework-unresolved-threads'
        }]));

        assert.equal(sm.capturedPrLabelAdds.length, 1, 'exactly one label write');
        assert.equal(sm.capturedPrLabelAdds[0].number, 1211, 'the label lands on the PR');
        assert.equal(sm.capturedPrLabelAdds[0].labels.join(','), 'agent:rework');
        assert.equal(sm.capturedPrLabelAdds[0].workspace, 'epam', 'owner from rule context');
        assert.equal(sm.capturedPrLabelAdds[0].repository, 'dmtools-dart', 'repo from rule context');
        assert.equal(sm.capturedPrComments.length, 1, 'exactly one explanatory comment');
        assert.contains(sm.capturedPrComments[0].body, 'Unresolved review threads',
            'the comment states the reason (matches conflict_rework report style)');
        assert.contains(sm.capturedPrComments[0].body, 'rework leg owns open threads',
            'the comment states the owner-design mechanism');
        assert.equal(sm.capturedTriggers.length, 0,
            'no workflow dispatched — rework-on-label owns the dispatch (issue-anchored, PR-anchored fallback #544)');
        assert.equal(sm.capturedCloses.length, 0, 'no issue churn');
    });
});

suite('smAgent: sm_github.json rule hygiene', function () {

    test('every deployed github rule passes the validator (source + query + dispatch shape)', function () {
        // Live regression (#458 follow-up): the develop-done rule shipped
        // without `source: github` and the validator silently skipped it
        // ("jql and configFile are required" — classic-rule branch). Pin
        // the hygiene of every rule in the deployed config.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        assert.ok(rules.length >= 10, 'expected the full rule set, got ' + rules.length);
        rules.forEach(function (r) {
            assert.equal(r.source, 'github', r.id + ' must declare source: github');
            assert.ok(r.query, r.id + ' needs a query object');
            assert.ok(r.configFile || r.inputs || r.localAction,
                r.id + ' needs configFile, inputs, or localAction');
        });
    });

    test('rework policy: auto gated on machine author, manual via PR label (any author), review ungated', function () {
        // Owner rule (fa run 35520284127 — auto rework fired on a
        // foreign-authored PR and was cancelled): AUTO rework only on
        // machine-authored PRs; MANUAL rework via the agent:rework PR label
        // on any author; REVIEW stays for all PRs.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });

        var auto = byId['rework-on-red-ci'];
        assert.ok(auto, 'rework-on-red-ci exists');
        assert.equal(auto.query.prMachineAuthor, true,
            'auto rework is machine-author-gated (fail-closed when unconfigured)');

        var manual = byId['rework-on-label'];
        assert.ok(manual, 'rework-on-label exists (manual PR-label request)');
        assert.equal(manual.query.type, 'pr', 'manual request lives on the PR');
        assert.ok((manual.query.labels || []).indexOf('agent:rework') !== -1);
        assert.ok(!manual.query.prMachineAuthor, 'manual rework is NOT author-gated');
        assert.ok((manual.consumeLabels || []).indexOf('agent:rework') !== -1,
            'the PR request label is consumed on dispatch (no re-fire)');

        ['review-after-dev', 'review-external-once', 'review-on-label'].forEach(function (id) {
            assert.ok(byId[id], id + ' exists');
            assert.ok(!byId[id].query.prMachineAuthor, id + ': review stays open to all authors');
        });
    });

    test('review-machine-unlinked: issue-less machine PRs get their one review (fa #1068 starvation)', function () {
        // Owner order (fa 2026-09-30): #1068 sat ai_validated 19h with ZERO
        // review legs. The three review entries all miss it: develop-done
        // backfills OPEN linked issues only, review-after-dev rides the
        // issue carrier, review-external-once excludes machine authors.
        // This rule is the machine-author twin of review-external-once —
        // author-gated (prMachineAuthor fails closed) and green-independent
        // (silent-updated heads read checks 'none'; review-after-dev's
        // economy: the ai_validated latch alone qualifies). Dedup is
        // structural: workflowRef={branch} puts the leg's check run on the
        // head, and the 'pending' rollup is excluded from the query.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });
        var rule = byId['review-machine-unlinked'];
        assert.ok(rule, 'review-machine-unlinked exists');
        assert.equal(rule.query.type, 'pr', 'PR-anchored (no issue carrier)');
        assert.equal(rule.query.prMachineAuthor, true, 'machine-author-gated (fail-closed)');
        assert.deepEqual(rule.query.labels, ['ai_validated'], 'targets the validated latch');
        ['ai_pr_reviewed', 'pr_approved', 'agent:review', 'ai_validating'].forEach(function (l) {
            assert.ok((rule.query.notLabels || []).indexOf(l) !== -1, 'excludes ' + l);
        });
        assert.deepEqual(rule.query.checks, ['green', 'none'],
            'green-independent but never pending — the running leg is its own dedup');
        assert.equal(rule.inputs.leg, 'review', 'dispatches the review leg');
        assert.equal(rule.inputs.pr, '{prNumber}', 'PR-anchored dispatch input');
        assert.equal(rule.workflowRef, '{branch}', 'leg runs on the PR head (check-run dedup)');
        assert.equal(rule.limit, 1, 'one per tick — review-external-once pacing');
        assert.equal(rules.indexOf(rule), rules.indexOf(byId['review-external-once']) + 1,
            'sits right after review-external-once');
    });

    test('rework-unresolved-threads: gh-683 — unresolved threads arm agent:rework, disjoint from the re-review armers', function () {
        // Live fa #1194/#1211/#1212 + dart #340 (2026-10-04): green +
        // reviewed + validated machine PRs with OPEN threads, heads
        // silently refreshed — the 04:30 fa tick processed 0 (every
        // re-review armer requires threadsResolved:true; the complement
        // matched nothing). This rule owns the complement.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });

        var rule = byId['rework-unresolved-threads'];
        assert.ok(rule, 'rework-unresolved-threads exists');
        assert.equal(rule.localAction, 'arm_rework', 'a localAction — no direct dispatch');
        assert.equal(rule.query.type, 'pr', 'PR carrier');
        assert.equal(rule.query.prMachineAuthor, true,
            'machine-author-gated (owner rule: auto-rework is machine-only, fail-closed)');
        assert.equal(rule.query.threadsResolved, false,
            'the complement of review-threads-resolved — regardless of verdict staleness');
        assert.deepEqual(rule.query.labels, ['ai_pr_reviewed'], 'only reviewed PRs');
        // gh-710: pr_approved is deliberately NOT excluded — an APPROVE
        // verdict with unresolved threads deadlocks merge (BLOCKED
        // conversation gate) without the rework arm. Pinned by the
        // gh-710 test below; here only the remaining in-flight guards.
        ['agent:rework', 'agent:review', 'ai_validating', 'validation_failed'].forEach(function (l) {
            assert.ok((rule.query.notLabels || []).indexOf(l) !== -1, 'excludes ' + l);
        });

        // Disjointness from the re-review armers: they require
        // threadsResolved:true, this rule false — one PR can never arm
        // both. review-stale-verdict (the only armer without a threads
        // guard) must exclude agent:rework so a reworked PR never stacks
        // a re-review on top (same tick or the next).
        var rsv = byId['review-stale-verdict'];
        assert.ok(rsv, 'review-stale-verdict exists');
        assert.ok((rsv.query.notLabels || []).indexOf('agent:rework') !== -1,
            'review-stale-verdict defers while rework is armed (#683)');
        var rtr = byId['review-threads-resolved'];
        assert.equal(rtr.query.threadsResolved, true, 'the re-review armer stays on the true side');

        // ORDER: after every re-review armer (a re-review, once armed via
        // agent:review, defers this rule), before close-on-merge.
        var lastArmer = Math.max.apply(null,
            ['review-stale-verdict', 'review-threads-resolved', 'review-stale-verdict-unchecked']
                .map(function (id) { return rules.indexOf(byId[id]); }));
        var mine = rules.indexOf(rule);
        assert.ok(mine > lastArmer, 'runs after the re-review armers');
        assert.ok(mine < rules.indexOf(byId['close-on-merge']), 'before close-on-merge (end of file)');
    });

    test('rework-unresolved-threads: gh-710 — APPROVE-with-unresolved-threads (pr_approved) must arm rework, not deadlock', function () {
        // Live fa #1211 (2026-10-04): the 14:13 re-review verdict was
        // APPROVE but posted 5 new threads. Result: pr_approved +
        // ai_validated + unresolved threads = mergeStateStatus BLOCKED
        // (conversation gate), while every rework armer missed — the
        // rework-unresolved-threads rule excluded pr_approved, red-CI
        // rework needs red checks (green), the review-verdict arm fires
        // only on CHANGES_REQUESTED. Merge blocked + no armed leg = the
        // PR deadlocked ~1h until a manual rework dispatch. The rule must
        // gate on unresolved threads > 0 AND no active rework/review/
        // validation in flight — the verdict being APPROVE is irrelevant.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });

        var rule = byId['rework-unresolved-threads'];
        assert.ok(rule, 'rework-unresolved-threads exists');
        assert.equal(rule.query.threadsResolved, false, 'still the unresolved-threads complement');
        assert.equal((rule.query.notLabels || []).indexOf('pr_approved'), -1,
            'pr_approved must NOT exclude the rework arm (gh-710 deadlock)');
        // The in-flight guards stay — the ticket-suggested gate:
        ['agent:rework', 'agent:review', 'ai_validating', 'validation_failed'].forEach(function (l) {
            assert.ok((rule.query.notLabels || []).indexOf(l) !== -1, 'still excludes ' + l);
        });

        // Sticky approval is why REWORK is the right leg (not re-review):
        // after the rework push, validate-armed re-validates the new head
        // and merge proceeds without a re-review. The re-review armers
        // must keep excluding pr_approved so no review stacks on top.
        var rtr = byId['review-threads-resolved'];
        assert.ok((rtr.query.notLabels || []).indexOf('pr_approved') !== -1,
            'review-threads-resolved keeps excluding pr_approved (sticky approval)');
    });
});

suite('smAgent: localAction mark_developed (github machine-loop backfill)', function () {

    test('labels the issue ai_developed when its green PR is open; no dispatch', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [
                    { key: 'gh-701', labels: ['in progress'], issueNumber: 701, prNumber: 724,
                      pr: { number: 724, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, labels: [] } }
                ]
            }
        });

        sm.action(baseParams('epam', 'dmtools-dart', [{
            description: 'dev done backfill',
            source: 'github',
            // Mirrors the live rule: NO `in progress` requirement (issues
            // whose dev leg predates the status-label convention — live:
            // fa #503 / PR #676 — must still backfill) + prMachineAuthor so
            // external PRs never enter the review loop through here.
            query: { type: 'issue', notLabels: ['ai_developed', 'agent:rework'],
                     prState: 'OPEN', prChecks: 'green', prMachineAuthor: true },
            localAction: 'mark_developed',
            limit: 5,
            id: 'develop-done'
        }]));

        assert.equal(sm.capturedPrLabelAdds.length, 1, 'exactly one label add');
        assert.equal(sm.capturedPrLabelAdds[0].number, 701, 'labels the ISSUE number');
        assert.deepEqual(sm.capturedPrLabelAdds[0].labels, ['ai_developed']);
        assert.equal(sm.capturedTriggers.length, 0, 'localAction never dispatches workflows');
    });

    test('nothing to backfill — no label churn, no dispatch', function () {
        // The source-level notLabels guard is covered by test_smGithubSource;
        // here the stub returns items verbatim, so an empty feed is the
        // convention for guard-side cases (see the close_issue suite).
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "a", repo: "b" } };' },
            github: { items: [] }
        });

        sm.action(baseParams('a', 'b', [{
            source: 'github',
            query: { type: 'issue', labels: ['in progress'], notLabels: ['ai_developed'], prState: 'OPEN' },
            localAction: 'mark_developed',
            id: 'develop-done'
        }]));

        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no label churn');
        assert.equal(sm.capturedTriggers.length, 0, 'no dispatch');
    });
});

suite('smAgent: PR lifecycle localActions (#687)', function () {

    var RULES = {
        update: { source: 'github', query: { type: 'pr', labels: ['pr_approved'], mergeState: 'BEHIND' },
                  localAction: 'update_branch', limit: 5, id: 'silent-update-behind' },
        validate: { source: 'github', query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'], notMergeState: 'BEHIND', draft: false },
                    localAction: 'validate_pr', limit: 1, id: 'validate-armed' },
        merge: { source: 'github', query: { type: 'pr', labels: ['pr_approved', 'ai_validating'], checks: 'green', mergeState: 'CLEAN' },
                 localAction: 'merge_pr', limit: 1, id: 'merge-validated' },
        fail: { source: 'github', query: { type: 'pr', labels: ['pr_approved', 'ai_validating'], checks: 'red' },
                localAction: 'fail_validation', limit: 1, id: 'fail-validation' },
        unarm: { source: 'github', query: { type: 'pr', labels: ['ai_validating'], mergeState: ['BEHIND', 'BLOCKED'], draft: false },
                 localAction: 'unarm_validation', limit: 1, id: 'unarm-stale-validation' }
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['pr_approved'], issueNumber: null, prNumber: n, draft: false };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    test('update_branch: git merge push (workflow token — no CI, no bot-blocked APIs)', function () {
        var sm = makeSmAgent(Object.assign(config('epam', 'dmtools-dart'), {
            github: { items: [prItem(681, { branch: 'feat/x' })] }
        }));
        var params = { jobParams: { owner: 'epam', repo: 'dmtools-dart',
            silentToken: 'SILENT-TOKEN', sourceToken: 'PAT-TOKEN', rules: [RULES.update] } };

        sm.action(params);

        assert.equal(sm.capturedCliCommands.length, 1, 'one update command');
        // A git merge push, not the GitHub update-branch APIs: GraphQL
        // updatePullRequestBranch and the PUT REST endpoint both block
        // github-actions[bot] (live-verified); a plain push on the runner
        // checkout is allowed and triggers no workflows.
        var cmd = sm.capturedCliCommands[0].command;
        assert.ok(cmd.indexOf('gh repo clone ') === 0, 'clones via gh (whitelisted, GH_TOKEN)');
        assert.ok(cmd.indexOf('epam/dmtools-dart') !== -1, 'clones the TARGET repo');
        assert.ok(cmd.indexOf('--branch feat/x') !== -1, 'single-branch clone of the head ref');
        assert.ok(cmd.indexOf('merge --no-edit FETCH_HEAD') !== -1, 'merges fetched main');
        assert.equal(cmd.slice(-'git push https://x-access-token:${GH_TOKEN}@github.com/epam/dmtools-dart.git feat/x'.length),
            'git push https://x-access-token:${GH_TOKEN}@github.com/epam/dmtools-dart.git feat/x');
        // No env swap: the push rides the checkout's stored credentials.
        assert.equal(sm.capturedEnvSets.length, 0, 'no token swap');
    });

    test('update_branch: branch-less ticket is skipped loudly', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), { github: { items: [prItem(9)] } }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.update] } });
        assert.equal(sm.capturedCliCommands.length, 0, 'no command without a branch name');
    });

    test('validate_pr: dispatches the CI workflow on the head + ai_validating label on the PR', function () {
        // Dispatch-only CI: no push ever fires CI — the SM is the only
        // trigger. The PAT update-branch dance is retired.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(70, { branch: 'ai/gh-50' })] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
            silentToken: 'SILENT', sourceToken: 'PAT', rules: [RULES.validate] } });

        assert.equal(sm.capturedCliCommands.length, 1, 'one dispatch command');
        assert.equal(sm.capturedCliCommands[0].command,
            'gh workflow run quality.yml --repo a/b --ref ai/gh-50');
        assert.equal(sm.capturedEnvSets.length, 0, 'no PAT swap — dispatch rides the ambient token');
        assert.equal(sm.capturedPrLabelAdds.length, 1);
        assert.equal(sm.capturedPrLabelAdds[0].number, 70);
        assert.deepEqual(sm.capturedPrLabelAdds[0].labels, ['ai_validating']);
    });

    test('validate_pr: jobParams.ciWorkflow overrides the default (per-repo CI file)', function () {
        var sm = makeSmAgent(Object.assign(config('IstiN', 'flutter_agent_harness'), {
            github: { items: [prItem(76, { branch: 'ai/gh-9' })] }
        }));
        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            ciWorkflow: 'ci.yml', rules: [RULES.validate] } });

        assert.equal(sm.capturedCliCommands[0].command,
            'gh workflow run ci.yml --repo IstiN/flutter_agent_harness --ref ai/gh-9');
    });

    test('validate_pr: cancels in-flight validations on superseded heads before arming', function () {
        // Owner 2026-09-23: a branch that moves after dispatch makes the
        // old runs useless — cancel them, scoped to THIS branch only (a
        // run on the current head or on another branch is untouchable).
        var CUR = 'cccc1111cccc1111cccc1111cccc1111cccc1111';
        var sm = makeSmAgent(Object.assign(config('IstiN', 'flutter_agent_harness'), {
            github: { items: [prItem(82, { branch: 'ai/gh-77', headSha: CUR })] },
            onCliExecute: function (cmdOpts) {
                var c = cmdOpts.command;
                if (c.indexOf('runs?head_sha=') !== -1) return { workflow_runs: [] };
                if (c.indexOf('runs?event=workflow_dispatch') !== -1) {
                    return { workflow_runs: [
                        { id: 111, event: 'workflow_dispatch', head_branch: 'ai/gh-77',
                          head_sha: 'aaaa0000aaaa', status: 'in_progress' },
                        { id: 222, event: 'workflow_dispatch', head_branch: 'ai/gh-77',
                          head_sha: CUR, status: 'queued' },
                        { id: 333, event: 'workflow_dispatch', head_branch: 'other/branch',
                          head_sha: 'bbbb0000bbbb', status: 'in_progress' },
                        { id: 444, event: 'workflow_dispatch', head_branch: 'ai/gh-77',
                          head_sha: 'dddd0000dddd', status: 'completed' }
                    ] };
                }
                return undefined;
            }
        }));
        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            ciWorkflow: 'ci.yml', rules: [RULES.validate] } });

        var cancels = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('/cancel') !== -1; }).map(function (c) {
            return c.command; });
        assert.equal(cancels.length, 1, 'exactly the superseded-head run is cancelled');
        assert.ok(cancels[0].indexOf('/actions/runs/111/cancel') !== -1, 'run 111 (old head, this branch)');
        var dispatch = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('workflow run ci.yml') !== -1; });
        assert.equal(dispatch.length, 1, 'arm still proceeds after the cleanup');
        assert.equal(sm.capturedPrLabelAdds.length, 1, 'ai_validating armed');
    });

    test('validate_pr: skipIfGreenCi — a completed green CI run on the head stops the re-dispatch loop', function () {
        // Dead-zone guard (fa pr-922, 2026-09-26): revalidate-armed-green
        // re-dispatches CI when the rollup is green but the CI verdict is
        // missing. If the head ALREADY carries a completed green dispatched
        // run and mergeState is still BLOCKED, the unmet required check
        // belongs to another workflow — re-running this CI every tick would
        // loop forever. The rule's skipIfGreenCi flag makes validate_pr skip.
        var CUR = 'eeee2222eeee2222eeee2222eeee2222eeee2222';
        var greenRule = { source: 'github',
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'],
                     notMergeState: ['BEHIND', 'DIRTY', 'CLEAN'], checks: ['green'], draft: false },
            localAction: 'validate_pr', limit: 1, id: 'revalidate-armed-green',
            skipIfGreenCi: true };
        var sm = makeSmAgent(Object.assign(config('IstiN', 'flutter_agent_harness'), {
            github: { items: [prItem(922, { branch: 'fix/921', headSha: CUR,
                                            labels: ['pr_approved', 'ai_validating'] })] },
            onCliExecute: function (cmdOpts) {
                var c = cmdOpts.command;
                if (c.indexOf('runs?head_sha=') !== -1) {
                    // Old completed green run: outside the 15-min active
                    // window (the active guard passes) but a green cover.
                    return { workflow_runs: [
                        { id: 555, event: 'workflow_dispatch', head_branch: 'fix/921',
                          head_sha: CUR, status: 'completed', conclusion: 'success',
                          created_at: '2026-09-20T00:00:00Z' }
                    ] };
                }
                if (c.indexOf('runs?event=workflow_dispatch') !== -1) {
                    return { workflow_runs: [] };
                }
                return undefined;
            }
        }));
        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            ciWorkflow: 'ci.yml', rules: [greenRule] } });

        var dispatch = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('workflow run ci.yml') !== -1; });
        assert.equal(dispatch.length, 0, 'no re-dispatch — green cover already on the head');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no arm churn');
    });

    test('validate_pr: skipIfGreenCi — a CANCELLED run is not a green cover (re-dispatch proceeds)', function () {
        // The exact fa pr-922 shape: the dispatched run was concurrency-cancelled
        // — no verdict, no green cover. The rule MUST re-dispatch.
        var CUR = 'ffff3333ffff3333ffff3333ffff3333ffff3333';
        var greenRule = { source: 'github',
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'],
                     notMergeState: ['BEHIND', 'DIRTY', 'CLEAN'], checks: ['green'], draft: false },
            localAction: 'validate_pr', limit: 1, id: 'revalidate-armed-green',
            skipIfGreenCi: true };
        var sm = makeSmAgent(Object.assign(config('IstiN', 'flutter_agent_harness'), {
            github: { items: [prItem(922, { branch: 'fix/921', headSha: CUR,
                                            labels: ['pr_approved', 'ai_validating'] })] },
            onCliExecute: function (cmdOpts) {
                var c = cmdOpts.command;
                if (c.indexOf('runs?head_sha=') !== -1) {
                    return { workflow_runs: [
                        { id: 556, event: 'workflow_dispatch', head_branch: 'fix/921',
                          head_sha: CUR, status: 'completed', conclusion: 'cancelled',
                          created_at: '2026-09-20T00:00:00Z' }
                    ] };
                }
                if (c.indexOf('runs?event=workflow_dispatch') !== -1) {
                    return { workflow_runs: [] };
                }
                return undefined;
            }
        }));
        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            ciWorkflow: 'ci.yml', rules: [greenRule] } });

        var dispatch = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('workflow run ci.yml') !== -1; });
        assert.equal(dispatch.length, 1, 'cancelled is not a cover — CI re-dispatched');
        assert.equal(sm.capturedPrLabelAdds.length, 1, 'arm re-applied (idempotent)');
    });

    test('config order: unarm precedes silent-update (same-tick actualization)', function () {
        // Owner 2026-09-23: a BEHIND queue head with ai_validating armed
        // took 3 ticks to refresh (rule 0 skipped the armed PR, the unarm
        // rule ran last, update+re-arm followed next ticks). unarm MUST
        // run before the update rule so BEHIND+armed is resolved in one
        // tick; stale runs are cancelled by validate_pr (agents#519).
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (function dig(o) {
            if (o && typeof o === 'object') {
                if (Array.isArray(o.rules)) return o.rules;
                for (var k in o) { var r = dig(o[k]); if (r) return r; }
            }
            return null;
        })(cfg);
        var gh = rules.filter(function (r) { return r.source === 'github'; });
        var idx = function (id) {
            return gh.map(function (r) { return r.id; }).indexOf(id);
        };
        assert.ok(idx('unarm-stale-validation') < idx('silent-update-behind'),
                  'unarm-stale-validation must precede silent-update-behind');
    });

    test('validate_pr: dispatch failure leaves the marker un-armed (next tick retries)', function () {
        // Self-healing: a failed dispatch (bad workflow name, transient
        // API error) must not arm ai_validating — the rule re-matches on
        // the next tick and retries.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(72, { branch: 'feat/x' })] },
            onCliExecute: function () {
                throw new Error('Command execution failed (exit code 1): workflow not found');
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.validate] } });

        assert.equal(sm.capturedCliCommands.length, 1, 'dispatch attempted');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no marker without a dispatched run');
    });

    test('validate_pr: branch-less ticket is skipped loudly', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), { github: { items: [prItem(78)] } }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.validate] } });
        assert.equal(sm.capturedCliCommands.length, 0, 'no branch — no dispatch target');
        assert.equal(sm.capturedPrLabelAdds.length, 0);
    });

    test('rework-on-label: manual PR rework — any author, consumes the PR label on dispatch', function () {
        // Owner rule: rework fires on ANY PR when a human labels the PR
        // agent:rework; only the AUTO path (agent:rework armed on the issue
        // by verdict/CI) is machine-author-gated. The PR label is consumed
        // at dispatch — the issue-anchored rework runner's removeLabels
        // never reaches PR labels, so without consumption every later tick
        // re-fires.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(90, { labels: ['agent:rework'], issueNumber: 732, author: 'some-human' })] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['agent:rework'] },
              workflowFile: 'ai-teammate.yml',
              inputs: { issue: '{issueNumber}', leg: 'rework',
                        reason: 'sm: agent:rework label on the PR (manual rework request)' },
              consumeLabels: ['agent:rework'], limit: 1, id: 'rework-on-label' }
        ] } });

        assert.equal(sm.capturedTriggers.length, 1, 'manual rework dispatches for any author');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.issue, '732', 'issue-anchored dispatch on the linked issue');
        assert.equal(inputs.leg, 'rework');
        assert.equal(sm.capturedPrLabelRemoves.length, 1, 'the request label is consumed');
        assert.equal(sm.capturedPrLabelRemoves[0].number, 90);
        assert.equal(sm.capturedPrLabelRemoves[0].label, 'agent:rework'); // gh-683 bug D: singular param + owner/repo (asserted below)
    });

    test('rework-on-label: PR with a linked issue dispatches issue-anchored after the local-existence check (#544)', function () {
        // The body scrape (githubSource.linkedIssueNumber) returns a number;
        // before anchoring the dispatch smAgent verifies via github_get_issue
        // that it is an EXISTING LOCAL issue. A resolvable one keeps the
        // legacy issue-anchored shape byte-identical.
        var lookedUp = [];
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(89, { labels: ['agent:rework'], issueNumber: 555, author: 'some-human' })],
                onIssueLookup: function (n) { lookedUp.push(n); }
            }
        }));
        // Wire the probe through the capture (the mock default returns success).
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['agent:rework'] },
              workflowFile: 'ai-teammate.yml',
              inputs: { issue: '{issueNumber}', leg: 'rework',
                        reason: 'sm: agent:rework label on the PR (manual rework request)' },
              consumeLabels: ['agent:rework'], limit: 1, id: 'rework-on-label' }
        ] } });

        assert.deepEqual(lookedUp, [555], 'local existence verified via github_get_issue before anchoring');
        assert.equal(sm.capturedTriggers.length, 1, 'existing local issue → issue-anchored dispatch');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.issue, '555');
        assert.equal(inputs.leg, 'rework');
        assert.equal(inputs.pr || '', '', 'issue-anchored dispatch carries no pr input');
    });

    test('rework-on-label: PR without a linked issue dispatches PR-anchored (#544 owner rule 3)', function () {
        // Guest/issue-less PR the owner labeled agent:rework — the anchor is
        // the PR itself (inputs.pr), the factory guard runs the rework leg
        // on pr-<N>. The request label is still consumed on dispatch.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(91, { labels: ['agent:rework'], issueNumber: null })] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['agent:rework'] },
              workflowFile: 'ai-teammate.yml',
              inputs: { issue: '{issueNumber}', leg: 'rework' },
              consumeLabels: ['agent:rework'], limit: 1, id: 'rework-on-label' }
        ] } });

        assert.equal(sm.capturedTriggers.length, 1, 'PR-anchored rework dispatches for an issue-less PR');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.issue, '', 'no issue anchor — empty, never a pr-N pseudo-anchor');
        assert.equal(inputs.pr, '91', 'the PR is the anchor');
        assert.equal(inputs.leg, 'rework');
        assert.equal(sm.capturedPrLabelRemoves.length, 1, 'the request label is consumed');
        assert.equal(sm.capturedPrLabelRemoves[0].number, 91);
        // gh-683 bug D: the consume call carries owner/repo + the singular
        // `label` param the bridge reads (the plural `labels` shape starved
        // the consume on live fa #1194 — every tick re-dispatched).
        assert.equal(sm.capturedPrLabelRemoves[0].label, 'agent:rework');
        assert.equal(sm.capturedPrLabelRemoves[0].workspace, 'a');
        assert.equal(sm.capturedPrLabelRemoves[0].repository, 'b');
    });

    test('rework-on-label: dangling scraped #N (not a local issue) degrades to PR-anchored (#544)', function () {
        // The bare-#N scrape survived the cross-repo filter but the number
        // does not exist locally (deleted issue / ref to another repo the
        // qualifier missed). github_get_issue 404 → PR-anchored fallback —
        // the guard never sees a bogus issue number.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(92, { labels: ['agent:rework'], issueNumber: 601 })],
                issueLookupError: 'GraphQL: Could not resolve to an issue or pull request with the number of 601'
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['agent:rework'] },
              workflowFile: 'ai-teammate.yml',
              inputs: { issue: '{issueNumber}', leg: 'rework' },
              consumeLabels: ['agent:rework'], limit: 1, id: 'rework-on-label' }
        ] } });

        assert.equal(sm.capturedTriggers.length, 1, 'fallback dispatches instead of crashing the cycle');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.issue, '', 'bogus #601 anchor dropped');
        assert.equal(inputs.pr, '92');
        assert.equal(inputs.leg, 'rework');
    });

    test('auto rework: dangling scraped #N with a bridge 404 BODY (no throw) degrades to PR-anchored', function () {
        // Live (dmd #266): the sync github_get_issue does NOT throw on 404 —
        // it returns the REST error body. The existence probe must inspect
        // the BODY, else the dangling scrape anchors gh-601 and the rework
        // never touches the PR. AUTO path shape: machine-author gated, no
        // consumeLabels (the rework leg clears the label on push).
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(93, { labels: ['agent:rework'], issueNumber: 601,
                                     branch: 'ai/gh-266', author: 'ai-teammate' })],
                issueLookupBody: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}'
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [
            { source: 'github', query: { type: 'pr', labels: ['agent:rework'], prMachineAuthor: true },
              workflowFile: 'ai-teammate.yml',
              inputs: { issue: '{issueNumber}', leg: 'rework',
                        reason: 'sm: agent:rework (red CI or review CHANGES)' },
              workflowRef: '{branch}', limit: 1, id: 'rework-on-red-ci' }
        ] } });

        assert.equal(sm.capturedTriggers.length, 1, 'auto rework dispatches PR-anchored instead of gh-601');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.issue, '', 'bogus #601 anchor dropped — the PR under rework is the only sane anchor');
        assert.equal(inputs.pr, '93');
        assert.equal(inputs.leg, 'rework');
        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'auto path does not consume the arm — the rework leg clears it on push');
        assert.equal(sm.capturedTriggers[0].ref, 'ai/gh-266', 'leg still dispatches on the PR head');
    });

    test('auto review: dangling scraped #N with a bridge 404 BODY degrades to PR-anchored review', function () {
        // Same root cause on the AUTO REVIEW leg (live: dmd #266, run
        // 36332635090 — auto review dispatch anchored gh-601, scraped from
        // the PR body referencing 'dm.ai #601', local issue missing). The
        // fallback is engine-level: any issue-anchored leg on a PR-carrier
        // item degrades to inputs.pr, and the factory guard's PR-anchored
        // branch runs the review leg on pr-<N>.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(94, { labels: ['ai_developed'], issueNumber: 601,
                                     branch: 'ai/gh-266' })],
                issueLookupBody: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}'
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['ai_developed'] },
              workflowFile: 'ai-teammate.yml',
              inputs: { issue: '{issueNumber}', leg: 'review',
                        reason: 'sm: green PR awaits review' },
              workflowRef: '{branch}', limit: 1, id: 'review-after-dev' }
        ] } });

        assert.equal(sm.capturedTriggers.length, 1, 'auto review dispatches PR-anchored instead of gh-601');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.issue, '');
        assert.equal(inputs.pr, '94', 'the PR under review is the anchor');
        assert.equal(inputs.leg, 'review', 'the guard PR-anchored branch runs the REVIEW leg by default');
    });

    test('auto review: scraped #N resolving to a REAL local issue keeps the issue anchor', function () {
        // No regression for the healthy path: the bridge returns the issue
        // JSON body (number present) → issue-anchored review dispatch.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(95, { labels: ['ai_developed'], issueNumber: 266,
                                     branch: 'ai/gh-266' })],
                issue: { number: 266, state: 'open' }
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['ai_developed'] },
              workflowFile: 'ai-teammate.yml',
              inputs: { issue: '{issueNumber}', leg: 'review',
                        reason: 'sm: green PR awaits review' },
              workflowRef: '{branch}', limit: 1, id: 'review-after-dev' }
        ] } });

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.issue, '266', 'resolvable scrape keeps the legacy issue-anchored shape');
        assert.equal(inputs.leg, 'review');
    });

    function issueItem(n, extra) {
        var it = { key: 'gh-' + n, labels: ['ai_developed'], issueNumber: n,
                   prNumber: null, branch: 'ai/gh-' + n, draft: false };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    var REVIEW_AFTER_DEV_RULE = { source: 'github',
        query: { type: 'issue', labels: ['ai_developed'], notLabels: ['agent:rework'],
                 notPrLabels: ['ai_pr_reviewed', 'pr_approved'], prLabels: ['ai_validated'] },
        workflowFile: 'ai-teammate.yml',
        inputs: { issue: '{issueNumber}', leg: 'review',
                  reason: 'sm: green PR awaits review' },
        workflowRef: '{branch}', limit: 10, id: 'review-after-dev' };

    test('review-after-dev (gh-744): neighbor-key legs in flight must not suppress the post-rework review dispatch', function () {
        // Live fa gh-1274: dev leg → rework leg (success 11:07) → issue
        // ai_developed + green PR — and NO review leg for 3+ h (a manual
        // 'leg=review' dispatch unblocked it instantly). Trace: the
        // in-flight guard's stub-title match was a PLAIN SUBSTRING — the
        // guard for 'gh-1274' also matched '▶ rework (SM) · gh-12749'
        // (a DIFFERENT issue's leg; gh-1274 is a key PREFIX of gh-12749),
        // and the gh-715 cross-anchor pass matched '· pr-1279' inside
        // '▶ dev (SM) · pr-12790'. While any neighbor leg cycled, every
        // review-after-dev dispatch was suppressed. The anchor is a whole
        // token: a key-extending character after it must not match.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [issueItem(1274, { prNumber: 1279 })],
                issue: { number: 1274, state: 'open' }
            },
            workflowRuns: { in_progress: [
                // a NEIGHBOR issue's leg — 'gh-1274' is a prefix of its key:
                { name: '\u25b6 rework (SM) \u00b7 gh-12749', id: 11,
                  updated_at: new Date().toISOString() },
                // a NEIGHBOR PR's leg — 'pr-1279' is a prefix of its key
                // (hits the gh-715 cross-anchor pass for issue gh-1274):
                { name: '\u25b6 dev (SM) \u00b7 pr-12790', id: 12,
                  updated_at: new Date().toISOString() }
            ] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [REVIEW_AFTER_DEV_RULE] } });

        assert.equal(sm.capturedTriggers.length, 1,
            'review leg dispatches on the first tick after rework success');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.leg, 'review');
        assert.equal(inputs.issue, '1274', 'the post-rework review stays issue-anchored');
    });

    test('review-after-dev (gh-744): the issue\'s OWN in-flight leg still suppresses the dispatch', function () {
        // Guard hardening must not weaken the dedup the stub title exists
        // for: gh-1274's own running leg blocks the re-dispatch regardless
        // of the stub's trailing lines (second anchor line, ': title').
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [issueItem(1274, { prNumber: 1279 })],
                issue: { number: 1274, state: 'open' }
            },
            workflowRuns: { in_progress: [
                // full stub shape: anchor + second anchor line + issue title:
                { name: '\u25b6 rework (SM) \u00b7 gh-1274\n\u00b7 gh-1274: some title', id: 21,
                  updated_at: new Date().toISOString() },
                // cross-anchor: a PR-anchored leg for the SAME PR (#544 shape):
                { name: '\u25b6 rework (SM) \u00b7 pr-1279', id: 22,
                  updated_at: new Date().toISOString() }
            ] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [REVIEW_AFTER_DEV_RULE] } });

        assert.equal(sm.capturedTriggers.length, 0,
            'own in-flight leg still blocks the dispatch (no duplicate leg)');
    });

    test('unarm_validation: stale validated PR drops ai_validating (refresh + re-validate follows)', function () {
        // Live deadlock (fa pr-744): armed + validated green, then base
        // moved → BEHIND. silent-update-behind excludes ai_validating,
        // merge-validated needs CLEAN — nothing ever touched the PR again.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(74, { labels: ['pr_approved', 'ai_validating'] })] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.unarm] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }), ['ai_validating']);
        assert.equal(sm.capturedPrMerges.length, 0, 'no merge on a stale head');
        assert.equal(sm.capturedTriggers.length, 0, 'localAction never dispatches');
    });

    test('merge_pr: squash-merge + clears ai_validating, pr_approved and ai_validated', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(71, { labels: ['pr_approved', 'ai_validating'] })],
                pr: { number: 71, labels: ['pr_approved', 'ai_validating'] }
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.merge] } });

        assert.equal(sm.capturedPrMerges.length, 1);
        assert.equal(sm.capturedPrMerges[0].pullRequestId, 71);
        assert.equal(sm.capturedPrMerges[0].mergeMethod, 'squash');
        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['ai_validating', 'pr_approved', 'ai_validated']);
    });

    test('merge_pr: un-approved green head latches ai_validated instead of merging', function () {
        // Dispatch-only CI armed the validation PRE-review (validate-fresh):
        // green + CLEAN but no sticky pr_approved yet — merge is refused,
        // the latch flips, review-after-dev picks the head up.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(77, { labels: ['ai_validating'] })],
                pr: { number: 77, labels: ['ai_validating'] }
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.merge] } });

        assert.equal(sm.capturedPrMerges.length, 0, 'never merges without pr_approved');
        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }), ['ai_validating']);
        assert.equal(sm.capturedPrLabelAdds.length, 1);
        assert.deepEqual(sm.capturedPrLabelAdds[0].labels, ['ai_validated']);
    });

    test('merge_pr: refused merge (405 body, no thrown error) keeps the armed markers (fa pr-753)', function () {
        // The HTTP layer returns the raw body for error statuses (Java
        // parity) — github_merge_pr does NOT throw on a 405. Clearing the
        // markers on a refused merge orphaned fa pr-753 (logged
        // "squash-merged", PR stayed open and unarmed).
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(753, { labels: ['pr_approved', 'ai_validating'] })],
                pr: { number: 753, labels: ['pr_approved', 'ai_validating'] },
                mergeResult: JSON.stringify({ message: 'Pull Request is not mergeable', merged: false })
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.merge] } });

        assert.equal(sm.capturedPrMerges.length, 1, 'merge attempted');
        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'markers must survive a refused merge — unarm-stale/refresh/re-validate self-heals');
    });

    test('merge_pr: non-JSON body also counts as refusal', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(754, { labels: ['pr_approved', 'ai_validating'] })],
                pr: { number: 754, labels: ['pr_approved', 'ai_validating'] },
                mergeResult: 'Bad Gateway'
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.merge] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0);
    });

    test('complete_validation: green pre-review head latches ai_validated', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(79, { labels: ['ai_validating'] })] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [{
            source: 'github',
            query: { type: 'pr', labels: ['ai_validating'], notLabels: ['pr_approved'], checks: 'green' },
            localAction: 'complete_validation', limit: 1, id: 'validated-green'
        }] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }), ['ai_validating']);
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (r) { return r.labels; }), [['ai_validated']]);
        assert.equal(sm.capturedPrMerges.length, 0);
    });

    test('conflict_rework: machine DIRTY PR — comments with head sha, re-arms agent:rework, pr_approved STICKY', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(95, { labels: ['pr_approved', 'ai_validating'], branch: 'ai/gh-91', author: 'ai-teammate',
                                      pr: { headSha: 'deadbee' } })],
                pr: { number: 95, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #91 — thing' },
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [{
            source: 'github', query: { type: 'pr', mergeState: ['DIRTY'], draft: false },
            localAction: 'conflict_rework', limit: 1, id: 'conflict-rework' }] } });

        assert.equal(sm.capturedPrComments.length, 1, 'conflict report comment');
        assert.ok(sm.capturedPrComments[0].body.indexOf('Merge conflict with main') !== -1);
        assert.ok(sm.capturedPrComments[0].body.indexOf('deadbee') !== -1, 'comment carries the head sha (per-head dedup key)');
        assert.equal(sm.capturedPrLabelAdds.length, 1);
        assert.equal(sm.capturedPrLabelAdds[0].number, 91, 're-arm lands on the linked issue');
        assert.deepEqual(sm.capturedPrLabelAdds[0].labels, ['agent:rework']);
        assert.ok(sm.capturedPrLabelRemoves.some(function (r) { return r.label === 'ai_validating'; }),
            'ai_validating disarmed');
        assert.ok(!sm.capturedPrLabelRemoves.some(function (r) { return r.label === 'pr_approved'; }),
            'pr_approved is STICKY — the conflicted fix re-validates, never re-reviews');
    });

    test('conflict_rework: already reported for THIS head — silent skip (once per head)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(95, { labels: [], branch: 'ai/gh-91', author: 'ai-teammate',
                                      pr: { headSha: 'deadbee' } })],
                pr: { number: 95, labels: [], body: 'Fixes #91 — thing' },
                // gh-683 bug C: the linked issue carries agent:rework — the
                // re-arm LANDED. (Marker present + label absent now re-arms:
                // see the conflict_rework re-arm reliability suite.)
                issue: { number: 91, state: 'open', labels: [{ name: 'agent:rework' }] },
                prComments: [
                    { body: '⚠️ Merge conflict with main — the silent branch update could not merge main (conflict). (head `deadbee`)' }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [{
            source: 'github', query: { type: 'pr', mergeState: ['DIRTY'], draft: false },
            localAction: 'conflict_rework', limit: 1, id: 'conflict-rework' }] } });

        assert.equal(sm.capturedPrComments.length, 0, 'no duplicate comment for the same head');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no duplicate rework arm for the same head');
        // A comment for a DIFFERENT head must NOT suppress: new head = new report.
        var sm2 = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(95, { labels: [], branch: 'ai/gh-91', author: 'ai-teammate',
                                      pr: { headSha: 'cafe123' } })],
                pr: { number: 95, labels: [], body: 'Fixes #91 — thing' },
                prComments: [
                    { body: '⚠️ Merge conflict with main — ... (head `deadbee`)' }
                ]
            }
        }));
        sm2.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [{
            source: 'github', query: { type: 'pr', mergeState: ['DIRTY'], draft: false },
            localAction: 'conflict_rework', limit: 1, id: 'conflict-rework' }] } });
        assert.equal(sm2.capturedPrComments.length, 1, 'moved head re-reports');
        assert.equal(sm2.capturedPrLabelAdds.length, 1, 'moved head re-arms rework');
    });

    test('conflict_rework: GUEST DIRTY PR — report only, never a rework arm', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(96, { labels: [], branch: 'fix/773-thing', author: 'someguest',
                                      pr: { headSha: 'ab12cd' } })],
                pr: { number: 96, labels: [], body: 'Fixes #773 — guest' },
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [{
            source: 'github', query: { type: 'pr', mergeState: ['DIRTY'], draft: false },
            localAction: 'conflict_rework', limit: 1, id: 'conflict-rework' }] } });

        assert.equal(sm.capturedPrComments.length, 1);
        assert.ok(sm.capturedPrComments[0].body.indexOf('Guest PR') !== -1);
        assert.ok(sm.capturedPrComments[0].body.indexOf('rebase onto main') !== -1);
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no rework arm for guests');
    });

    test('conflict_rework: linked issue CLOSED — PR-anchored rework dispatch, no dead-letter label (#579)', function () {
        // Live fa #1075 (2026-09-30): DIRTY, linked #1074 CLOSED (fixed via
        // #1081) — the old path labelled the closed issue and the PR waited
        // on rework forever (the issue-rework rule matches OPEN issues
        // only). The re-arm must anchor on the PR instead.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(95, { labels: [], branch: 'fix/1074-web-shift-safety', author: 'ai-teammate',
                                      pr: { headSha: 'deadbee' } })],
                pr: { number: 95, labels: [], body: 'Fixes #1074 — superseded fix' },
                issue: { number: 1074, state: 'closed' },
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [{
            source: 'github', query: { type: 'pr', mergeState: ['DIRTY'], draft: false },
            localAction: 'conflict_rework', limit: 1, id: 'conflict-rework' }] } });

        assert.equal(sm.capturedPrLabelAdds.length, 0,
            'no agent:rework on a CLOSED issue — dead letter');
        assert.equal(sm.capturedTriggers.length, 1, 'PR-anchored rework dispatched');
        assert.equal(sm.capturedTriggers[0].workflow, 'ai-teammate.yml');
        assert.equal(sm.capturedTriggers[0].ref, 'fix/1074-web-shift-safety', 'leg runs on the PR head');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.leg, 'rework');
        assert.equal(inputs.pr, '95', 'PR anchor');
        assert.equal(inputs.issue || '', '', 'no issue anchor');
        assert.ok(sm.capturedPrComments[0].body.indexOf('PR-anchored conflict rework') !== -1,
            'report names the PR-anchored path');
    });

    test('conflict_rework: <n>-slug branch resolves the linked issue — OPEN issue keeps the label path (#579 grammar)', function () {
        // The merge-trigger linkage grammar also accepts '<n>-slug'
        // branches; 'fix/1074-web-shift-safety' resolved to nothing under
        // the gh-<n>-only scan. An OPEN linked issue keeps the legacy
        // issue-re-arm shape byte-identical.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(95, { labels: [], branch: 'fix/1074-web-shift-safety', author: 'ai-teammate',
                                      pr: { headSha: 'deadbee' } })],
                pr: { number: 95, labels: [], body: 'web shift safety fix' },
                issue: { number: 1074, state: 'open' },
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [{
            source: 'github', query: { type: 'pr', mergeState: ['DIRTY'], draft: false },
            localAction: 'conflict_rework', limit: 1, id: 'conflict-rework' }] } });

        assert.equal(sm.capturedPrLabelAdds.length, 1, 're-arm lands on the linked issue');
        assert.equal(sm.capturedPrLabelAdds[0].number, 1074, 'resolved from the <n>-slug branch');
        assert.deepEqual(sm.capturedPrLabelAdds[0].labels, ['agent:rework']);
        assert.equal(sm.capturedTriggers.length, 0, 'OPEN issue → no PR-anchored dispatch');
    });

    test('fail_validation: unarms, comments, re-arms agent:rework — pr_approved is STICKY', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(72, { labels: ['pr_approved', 'ai_validating'], author: 'ai-teammate', headSha: 'sha72' })],
                pr: { number: 72, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #503 — boot cost' },
                // Failed-run link (owner 2026-10-01): the RED run on this
                // exact head must land in the report; the green one must not.
                workflowApiRuns: [
                    { id: 601, event: 'workflow_dispatch', head_sha: 'sha72', status: 'completed',
                      conclusion: 'failure', html_url: 'https://github.com/a/b/actions/runs/601',
                      created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z' },
                    { id: 600, event: 'workflow_dispatch', head_sha: 'sha72', status: 'completed',
                      conclusion: 'success', html_url: 'https://github.com/a/b/actions/runs/600',
                      created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T09:05:00Z' }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });

        // Owner rule 2026-09 (token budget): after the first approval the
        // loop NEVER re-reviews — validation red re-arms rework only; the
        // fixed head re-validates via validate-armed and merges. Keeping
        // pr_approved armed would previously burn the workflow cap (fa
        // pr-750) — that loop is now closed by the latch semantics
        // themselves (validate-armed dispatches instead of PAT-pushing).
        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.number + ':' + r.label; }),
            ['72:ai_validating'],
            'only ai_validating is unarmed — pr_approved sticks for the re-validated head');
        assert.equal(sm.capturedPrComments.length, 1, 'PR report comment');
        assert.ok(sm.capturedPrComments[0].body.indexOf('Validation CI went red') !== -1);
        assert.ok(sm.capturedPrComments[0].body.indexOf('no re-review') !== -1);
        assert.ok(sm.capturedPrComments[0].body.indexOf('Failed run: https://github.com/a/b/actions/runs/601') !== -1,
            'report links the red run on this head — the reader skips the runs-tab hunt');
        assert.ok(sm.capturedPrComments[0].body.indexOf('runs/600') === -1,
            'a green run on the same head is never linked');
        assert.ok(sm.capturedPrComments[0].body.indexOf('\u26a0\ufe0f') !== -1,
            'the \u26a0\ufe0f marker stays (an SM PR comment, not site UI)');
        assert.equal(sm.capturedPrLabelAdds.length, 1);
        assert.equal(sm.capturedPrLabelAdds[0].number, 503, 're-arm lands on the linked issue');
        assert.deepEqual(sm.capturedPrLabelAdds[0].labels, ['agent:rework']);
        // Owner directive 2026-10-04 changed the GUEST path only: the
        // machine-author issue-linked re-arm stays exactly as it was — no
        // PR-anchored agent:rework label ever lands on the PR itself.
        assert.ok(!sm.capturedPrLabelAdds.some(function (a) { return a.number === 72; }),
            'machine PR path unchanged — issue re-arm, no PR label');
    });

    test('fail_validation: branch-name fallback when the body lacks a closing keyword (fa pr-750)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(750, { labels: ['pr_approved', 'ai_validating'], branch: 'ai/gh-746', author: 'ai-teammate' })],
                pr: { number: 750, labels: ['pr_approved', 'ai_validating'],
                      body: '### What changed\n\nFixes the Play Store rejection (gh-746) by ...' }
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });

        assert.equal(sm.capturedPrLabelAdds.length, 1, 'issue found via the ai/gh-<n> branch convention');
        assert.equal(sm.capturedPrLabelAdds[0].number, 746);
        assert.deepEqual(sm.capturedPrLabelAdds[0].labels, ['agent:rework']);
        // Sticky approval: no pr_approved removal anywhere (PR or issue).
        assert.ok(!sm.capturedPrLabelRemoves.some(function (r) { return r.label === 'pr_approved'; }),
            'pr_approved is never disarmed — rework re-validates, never re-reviews');
    });

    test('review-on-label: no re-dispatch while the stub run is active (dup guard)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(80, { labels: ['agent:review'] })] },
            workflowRuns: { in_progress: [
                // Stub-titled run for a DIFFERENT key — must not block.
                { name: '\u25b6 review (SM) \u00b7 pr-79', id: 1, updated_at: new Date().toISOString() },
                { name: '\u25b6 review (SM) \u00b7 pr-80', id: 2, updated_at: new Date().toISOString() }
            ] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['agent:review'] },
              workflowFile: 'ai-teammate.yml',
              inputs: { issue: '', leg: 'review', reason: 'sm: agent:review label on PR', pr: '{prNumber}' },
              id: 'review-on-label' }
        ] } });
        assert.equal(sm.capturedTriggers.length, 0,
            'active stub-titled run for the same key blocks the re-dispatch');
    });

    test('fail_validation: external PR (no linked issue) — report + PR-anchored rework arm', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(73, { labels: ['pr_approved', 'ai_validating'], author: 'ai-teammate', headSha: 'sha73' })],
                      pr: { number: 73, labels: ['pr_approved', 'ai_validating'], body: 'no link' } }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });

        assert.equal(sm.capturedPrComments.length, 1);
        // 2026-10-04: no linked issue → the rework leg arms PR-ANCHORED
        // (the #544 pr-<n> dispatch); the report-only branch used to leave
        // these heads motionless until a human ticked the SM.
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }),
            ['73:agent:rework'], 'no issue to re-arm — agent:rework lands on the PR itself');
        assert.ok(sm.capturedPrComments[0].body.indexOf('Failed run') === -1,
            'EMPTY run list (mock default) → no link line — the report still posts, nothing crashes');
        assert.ok(!sm.capturedPrLabelRemoves.some(function (r) { return r.label === 'pr_approved'; }),
            'pr_approved is sticky even without a linked issue — approval survives CI red');
    });

    test('fail_validation: GUEST PR (gh-757) — report + PARK (validation_failed), auto-rework stays machine-only', function () {
        // Guest = any account other than the machine login: they get review
        // + validation only. A guest 'Fixes #191' body must not arm rework on
        // a (possibly machine) linked issue; the ai/gh-<n> branch fallback is
        // machine-only too. gh-757 (live fa#1286, 2026-10-06): the 2026-10-04
        // guest validation-red arm spent an AI rework leg on a VENDOR PR —
        // auto-REWORK is machine-author-ONLY again (owner rule 2026-09-21,
        // reaffirmed by gh-757). Guest recovery = the #1179 park + the #633
        // RESET probe: the guest pushes a fix, the park clears, validation
        // re-runs.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(99, { labels: ['pr_approved', 'ai_validating'], branch: 'ai/gh-191', author: 'someguest', headSha: 'sha99' })],
                pr: { number: 99, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #191 — guest contribution' },
                workflowApiRuns: [
                    { id: 701, event: 'workflow_dispatch', head_sha: 'sha99', status: 'completed',
                      conclusion: 'timed_out', html_url: 'https://github.com/a/b/actions/runs/701',
                      created_at: '2026-10-01T11:00:00Z', updated_at: '2026-10-01T11:40:00Z' }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.number + ':' + r.label; }),
            ['99:ai_validating'], 'ai_validating still disarms');
        // dmtools-agents#1179 fix stays: the PARK label is the guest
        // treatment — the red guest must not stay the OLDEST validate-armed
        // candidate (FIFO froze behind it, live fa 2026-10-02).
        // gh-757: the park is ALL that lands — no agent:rework anywhere.
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }),
            ['99:validation_failed'],
            'GUEST PR parked via validation_failed — and nothing else (gh-757)');
        assert.ok(!sm.capturedPrLabelAdds.some(function (a) { return a.labels.indexOf('agent:rework') !== -1; }),
            'no agent:rework on the PR — auto-rework is machine-only (gh-757)');
        assert.ok(!sm.capturedPrLabelAdds.some(function (a) { return a.number === 191; }),
            "a guest 'Fixes #191' body must never arm rework on the machine issue");
        assert.equal(sm.capturedPrComments.length, 1);
        assert.ok(sm.capturedPrComments[0].body.indexOf('Guest PR') !== -1,
            'the report still addresses the guest');
        assert.ok(sm.capturedPrComments[0].body.indexOf('rebase onto main and push') !== -1,
            'the report gives the guest the recovery path (push clears the park)');
        assert.ok(sm.capturedPrComments[0].body.indexOf('Failed run: https://github.com/a/b/actions/runs/701') !== -1,
            'the GUEST report links its red run too (timed_out counts) — the guest sees WHERE it went red');
        assert.ok(sm.capturedPrComments[0].body.indexOf('rework agent is armed') === -1,
            'the report no longer claims a rework leg (gh-757: none is armed)');
        assert.ok(sm.capturedPrComments[0].body.indexOf('guest rework arm') === -1,
            'the guest-arm counter marker is gone with the arm itself');
    });

    test('fail_validation: gh-757 regression — vendor PR (fa#1286 author, non-ai branch) is parked, NEVER re-armed', function () {
        // Live incident (fa#1286, 2026-10-06): validate-fresh armed the
        // vendor PR 05:27:35, its CI went red, fail_validation armed
        // agent:rework on the PR at 05:30:21 and rework-on-label dispatched
        // the pr-1286 AI leg at 05:31:32. Author matches neither machine
        // login nor the repo owner → the rework arm must not fire; the
        // linked machine issue #1250 must not be re-armed either.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1286, { labels: ['ai_validating'], branch: 'fix/1250-stacked-boards-freeze',
                    author: 'vabhzw17eg2qu4m9-bit', headSha: 'vend01286aa' })],
                pr: { number: 1286, labels: ['ai_validating'], body: 'fix(1250): assert frozen-row invariant. Closes #1250.' }
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
            machineAuthor: 'ai-teammate,github-actions[bot]', rules: [RULES.fail] } });

        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }),
            ['1286:validation_failed'], 'the vendor PR is parked (validation_failed) only');
        assert.ok(!sm.capturedPrLabelAdds.some(function (a) { return a.labels.indexOf('agent:rework') !== -1; }),
            'NO agent:rework — the machine spends no AI leg on a vendor PR (gh-757)');
        assert.ok(!sm.capturedPrLabelAdds.some(function (a) { return a.number === 1250; }),
            'the linked issue #1250 is never re-armed from a vendor PR');
        assert.equal(sm.capturedPrComments.length, 1, 'the report still posts');
        assert.ok(sm.capturedPrComments[0].body.indexOf('Guest PR') !== -1,
            'the report addresses the vendor author');
    });

    test('fail_validation: #703 red-head history still recorded on a GUEST report (gh-757 — park, no arm)', function () {
        // The red-head audit trail is author-agnostic (#703: recording is
        // unconditional); only the REWORK arm is machine-gated (gh-757).
        // First guest red on a fresh head: red 1/3 recorded + park, no leg.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(96, { labels: ['pr_approved', 'ai_validating'], branch: 'feat/z', author: 'someguest', headSha: 'dead0096aa' })],
                pr: { number: 96, labels: ['pr_approved', 'ai_validating'], body: 'guest fix' },
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });

        assert.equal(sm.capturedPrComments.length, 1, 'ONE composed report, not one per feature');
        assert.ok(sm.capturedPrComments[0].body.indexOf('🔴 red head dead0096aa — red 1/3') !== -1,
            '#703 red-head marker present (re-validation audit trail) — recorded for guests too');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }),
            ['96:validation_failed'],
            'guest parked — the fix arm is gone (gh-757)');
        assert.ok(!sm.capturedPrLabelAdds.some(function (a) { return a.labels.indexOf('agent:rework') !== -1; }),
            'no rework arm for guests (gh-757)');
        // Machine-side marker text sanity: the red-head line matches the
        // exact format the arm side's RED_HEAD_MARKER_RE re-reads.
        assert.ok(/\uD83D\uDD34 red head ([0-9a-f]{7,40}) \u2014 red (\d+)\/(\d+)/
            .test(sm.capturedPrComments[0].body), 'the marker line is machine-reparseable');
    });

    test('fail_validation: machineAuthor unconfigured — fail-closed, no rework arm at all', function () {
        // machineAuthor.js invariant: with no machine login configured every
        // machine-keyed guard is inert/fail-closed. Red CI then reports +
        // parks only — rework never arms (gh-757: the park IS the guest
        // treatment; the arm is the machine treatment and never fires).
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(77, { labels: ['pr_approved', 'ai_validating'], author: 'ai-teammate' })],
                pr: { number: 77, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #55' }
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.fail] } });

        assert.equal(sm.capturedPrComments.length, 1, 'the report still posts');
        // With no machine login EVERY PR is a guest — the #1179 park label
        // is the guest treatment, so it fires here too (fail-closed applies
        // to the machine-only rework arm, not to the guest park).
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }),
            ['77:validation_failed'],
            'guest park fires without a machine login — and no rework arm (gh-757)');
    });
});


suite('smAgent: verdict-aware unarm_validation (gh-751 — green-verdict yo-yo)', function () {
    // Live: fa #1295 (gh-1292, 2026-10-05) — the ai_validating arm was
    // stripped FIVE times in one day with zero latches:
    // [ai_validating] → [] → [ai_validating] → [] → … Every main merge
    // made the armed head BEHIND and unarm-stale-validation stripped it
    // with a BARE unarm even though the head's dispatched validation had
    // ALREADY concluded green — the verdict lost the race to the strip
    // (merge-validated needs CLEAN; validated-green sits later in the
    // stack and excludes pr_approved), silent-update refreshed,
    // validate-fresh re-armed and re-dispatched CI: a full re-validation
    // burned per main merge under a saturated queue. The strip is now
    // verdict-aware: a GREEN conclusion on the head latches ai_validated
    // instead of the bare unarm (complete_validation parity — the sweep
    // success-branch shape); red / absent / in-flight / cancelled keep
    // the bare unarm.

    var UNARM_RULE = {
        source: 'github',
        query: { type: 'pr', labels: ['ai_validating'], mergeState: ['BEHIND'], draft: false },
        localAction: 'unarm_validation', limit: 2, id: 'unarm-stale-validation'
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['pr_approved'], issueNumber: null, prNumber: n, draft: false };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    function runsCli(runsByHead) {
        // Mock the dispatched-runs endpoint exactly like the real API:
        // filter by the head_sha in the query string.
        return function (cmd) {
            if (cmd.command.indexOf('actions/workflows/') !== -1 && cmd.command.indexOf('/runs?') !== -1) {
                var m = /head_sha=([^&"]+)/.exec(cmd.command);
                return JSON.stringify({ workflow_runs: (m && runsByHead[m[1]]) || [] });
            }
            return '';
        };
    }
    function concluded(conclusion, headSha, ageMs) {
        var t = new Date(Date.now() -
            (typeof ageMs === 'number' ? ageMs : 60 * 60 * 1000)).toISOString();
        return { status: 'completed', conclusion: conclusion, head_sha: headSha,
                 created_at: t, updated_at: t };
    }
    function dispatched(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh workflow run') === 0; });
    }

    test('BEHIND strip with a concluded GREEN validation on the head → ai_validated latched, no re-dispatch (regression: fa #1295)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1295, { labels: ['pr_approved', 'ai_validating'],
                                        headSha: 'shaG', branch: 'ai/gh-1292' })]
            },
            onCliExecute: runsCli({ shaG: [concluded('success', 'shaG')] })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [UNARM_RULE] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.number + ':' + r.label; }),
            ['1295:ai_validating'], 'the BEHIND strip still releases the mutex');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }),
            ['1295:ai_validated'],
            'the green verdict is CONSUMED, not discarded — validate-fresh excluded, no yo-yo');
        assert.ok(!dispatched(sm.capturedCliCommands),
            'latching never re-dispatches CI — the existing green covers the head');
        assert.ok(sm.capturedIoCacheDrops.some(function (d) { return d.kind === 'openPrs'; }),
            'slot yield: the freed mutex is visible to the arm rule same-tick (owner 2026-10-04)');
    });

    test('two armed BEHIND PRs, green + red heads → only the green head latches (multi-item)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [
                    prItem(301, { labels: ['pr_approved', 'ai_validating'], headSha: 'shaOK' }),
                    prItem(302, { labels: ['pr_approved', 'ai_validating'], headSha: 'shaBAD' })
                ]
            },
            onCliExecute: runsCli({
                shaOK: [concluded('success', 'shaOK')],
                shaBAD: [concluded('failure', 'shaBAD')]
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [UNARM_RULE] } });

        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }),
            ['301:ai_validated'],
            'only the green head latches — the red head keeps the bare unarm');
        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.number; }).sort(),
            [301, 302], 'both arms released');
    });

    test('red conclusion → bare unarm, never a latch', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(303, { labels: ['pr_approved', 'ai_validating'], headSha: 'shaR' })]
            },
            onCliExecute: runsCli({ shaR: [concluded('failure', 'shaR')] })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [UNARM_RULE] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }), ['ai_validating']);
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'red → the bare unarm stands (gh-751)');
        assert.ok(!dispatched(sm.capturedCliCommands), 'the unarm action never dispatches CI');
    });

    test('absent / in-flight / cancelled run → bare unarm (no verdict to consume)', function () {
        // Absent: the dispatched run was lost — revalidate-armed owns that
        // recovery; the unarm must not fabricate a latch.
        var smNone = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(304, { labels: ['ai_validating'], headSha: 'shaN' })] },
            onCliExecute: runsCli({ shaN: [] })
        }));
        smNone.action({ jobParams: { owner: 'a', repo: 'b', rules: [UNARM_RULE] } });
        assert.equal(smNone.capturedPrLabelAdds.length, 0, 'no run → no latch');

        // In-flight: the verdict does not exist yet.
        var now = new Date().toISOString();
        var smActive = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(305, { labels: ['ai_validating'], headSha: 'shaA' })] },
            onCliExecute: runsCli({ shaA: [{ status: 'in_progress', head_sha: 'shaA', created_at: now }] })
        }));
        smActive.action({ jobParams: { owner: 'a', repo: 'b', rules: [UNARM_RULE] } });
        assert.equal(smActive.capturedPrLabelAdds.length, 0, 'in-flight → no latch');

        // CANCELLED is never a verdict (#682 semantics).
        var smCancelled = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [prItem(306, { labels: ['ai_validating'], headSha: 'shaC' })] },
            onCliExecute: runsCli({ shaC: [concluded('cancelled', 'shaC')] })
        }));
        smCancelled.action({ jobParams: { owner: 'a', repo: 'b', rules: [UNARM_RULE] } });
        assert.equal(smCancelled.capturedPrLabelAdds.length, 0, 'cancelled → no latch');

        assert.deepEqual(smNone.capturedPrLabelRemoves.map(function (r) { return r.number; })
            .concat(smActive.capturedPrLabelRemoves.map(function (r) { return r.number; }))
            .concat(smCancelled.capturedPrLabelRemoves.map(function (r) { return r.number; })).sort(),
            [304, 305, 306], 'all three still bare-unarm — refresh + re-validate recovery stands');
    });

    test('gh-748 double-dispatch on ONE head — cancelled/red NEWEST run over an older GREEN run still latches (consumer parity)', function () {
        // The latch consumer (validate-armed's skipIfValidatedHead) accepts
        // ANY completed-green dispatched run on the head (probeDispatchedState
        // .green — hasSuccessfulDispatchedRun), never just the newest one.
        // Two workflow_dispatch runs land on the same head seconds apart in
        // the wild (gh-748 kicker race); when the newest of the pair is
        // cancelled or red while an older run on the SAME head concluded
        // success, a newest-only latch check misses the green, bare-unarms,
        // and the yo-yo survives exactly its saturated-queue target sub-case.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [
                    prItem(307, { labels: ['pr_approved', 'ai_validating'], headSha: 'shaDC' }),
                    prItem(308, { labels: ['pr_approved', 'ai_validating'], headSha: 'shaDR' })
                ]
            },
            onCliExecute: runsCli({
                shaDC: [
                    concluded('success', 'shaDC', 60 * 60 * 1000),
                    concluded('cancelled', 'shaDC', 0) // NEWEST — concurrency-cancel shadow
                ],
                shaDR: [
                    concluded('success', 'shaDR', 60 * 60 * 1000),
                    concluded('failure', 'shaDR', 0) // NEWEST — later red re-run
                ]
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [UNARM_RULE] } });

        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }).sort(),
            ['307:ai_validated', '308:ai_validated'],
            'any green run on the head latches — producer parity with skipIfValidatedHead (hasSuccessfulDispatchedRun)');
        assert.ok(!dispatched(sm.capturedCliCommands),
            'latching never re-dispatches CI — the existing green covers the head');
        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.number; }).sort(),
            [307, 308], 'the stale arm is still released on both heads');
    });
});
suite('smAgent: validation latch-skip + stale-arm sweeper (owner 2026-09-27)', function () {
    // Latch-skip: an approved PR whose head did NOT move since its green
    // validation (ai_validated latch + a completed-green dispatched run on
    // the current SHA + green rollup) must NOT re-run CI — validate-armed
    // arms ai_validating without a dispatch and merge-validated consumes the
    // arm on the existing green. Sweeper: an ai_validating arm whose head's
    // validation run concluded (success or failure) staleMinutes ago and was
    // never consumed gets unarmed — success re-latches ai_validated, failure
    // runs the standard fail path.

    var RULES = {
        validateSkip: { source: 'github', query: { type: 'pr', labels: ['pr_approved'],
            notLabels: ['ai_validating'], notMergeState: ['BEHIND', 'DIRTY'], draft: false },
            localAction: 'validate_pr', skipIfValidatedHead: true, limit: 1, id: 'validate-armed' },
        sweep: { source: 'github', query: { type: 'pr', labels: ['ai_validating'], draft: false },
            localAction: 'sweep_stale_validation', staleMinutes: 15, limit: 10, id: 'sweep-stale-validating' }
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['pr_approved'], issueNumber: null, prNumber: n, draft: false };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    // Completed dispatched run 3h ago (outside every fresh-run window).
    // The mock filters by head_sha exactly like the real API endpoint does.
    function runsCli(opts) {
        return function (cmd) {
            if (cmd.command.indexOf('actions/workflows/') !== -1 && cmd.command.indexOf('/runs?') !== -1) {
                var m = /head_sha=([^&"]+)/.exec(cmd.command);
                if (m && m[1] === opts.run.head_sha) {
                    return JSON.stringify({ workflow_runs: [opts.run] });
                }
                return JSON.stringify({ workflow_runs: [] });
            }
            return '';
        };
    }
    function oldRun(conclusion, headSha) {
        var t = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        return { status: 'completed', conclusion: conclusion, head_sha: headSha,
                 created_at: t, updated_at: t };
    }
    function dispatched(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh workflow run') === 0; });
    }

    test('validate-armed: latch-skip — unchanged validated head arms WITHOUT re-running CI', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(81, { labels: ['pr_approved', 'ai_validated'], branch: 'feat/v', headSha: 'sha111' })],
                prStatus: { checkConclusion: 'green' },
            },
                onCliExecute: runsCli({ run: oldRun('success', 'sha111') })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.validateSkip] } });

        assert.ok(!dispatched(sm.capturedCliCommands), 'NO CI re-dispatch — the existing green covers the head');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.labels.join(','); }),
            ['ai_validating'], 'arm only — merge-validated consumes it on the existing green');
    });

    test('validate-armed: moved head (no green run on the new SHA) → real validation dispatched', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(82, { labels: ['pr_approved', 'ai_validated'], branch: 'feat/w', headSha: 'shaNEW' })],
                prStatus: { checkConclusion: 'green' },
                // The green run sits on the OLD sha — the new head has nothing.
            },
                onCliExecute: runsCli({ run: oldRun('success', 'shaOLD') })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.validateSkip] } });

        assert.ok(dispatched(sm.capturedCliCommands),
            'head moved — the latch-skip must NOT apply; CI re-runs on the fresh head');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.labels.join(','); }),
            ['ai_validating'], 'normal arm on dispatch');
    });

    test('validate-armed: latch-skip fails closed without the ai_validated latch', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(83, { labels: ['pr_approved'], branch: 'feat/x', headSha: 'sha111' })],
                prStatus: { checkConclusion: 'green' },
            },
                onCliExecute: runsCli({ run: oldRun('success', 'sha111') })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.validateSkip] } });

        assert.ok(dispatched(sm.capturedCliCommands),
            'no latch on record — a stray green dispatched run alone never skips validation');
    });

    test('sweep_stale_validation: concluded-green older than staleMinutes → unarm + ai_validated re-latch', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(84, { labels: ['pr_approved', 'ai_validating'], headSha: 'sha222' })],
            },
                onCliExecute: runsCli({ run: oldRun('success', 'sha222') })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.sweep] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.number + ':' + r.label; }),
            ['84:ai_validating'], 'the stale arm is released (mutex freed)');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.labels.join(','); }),
            ['ai_validated'], 'success side re-latches — the merge window re-flows via the latch-skip');
        assert.ok(!dispatched(sm.capturedCliCommands), 'sweep never dispatches CI');
    });

    test('sweep_stale_validation: concluded-red older than staleMinutes → unarm + standard fail path', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(85, { labels: ['pr_approved', 'ai_validating'], headSha: 'sha333' })],
                pr: { number: 85, body: 'no closing keyword' },
            },
                onCliExecute: runsCli({ run: oldRun('failure', 'sha333') })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.sweep] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.number + ':' + r.label; }),
            ['85:ai_validating'], 'the stale arm is released');
        // #1179: the fail path now also PARKS the red guest (validation_failed
        // on the PR) — ai_validated is still never latched on the red side.
        assert.ok(!sm.capturedPrLabelAdds.some(function (a) {
            return a.labels.indexOf('ai_validated') !== -1; }),
            'failure side never latches ai_validated — the fail path owns it');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.labels.indexOf('validation_failed') !== -1; }),
            'the standard fail path parks the red guest (dmtools-agents#1179)');
        assert.equal(sm.capturedPrComments.length, 1,
            'the standard fail report posts (guest PR → report + park + PR-anchored rework arm, 2026-10-04)');
        assert.ok(sm.capturedPrComments[0].body.indexOf('went red') !== -1,
            'the report says validation went red');
    });

    test('sweep_stale_validation: stale red dispatched run but the head rollup is cancelled-only → NO fail path (gh-755)', function () {
        // The sweep probed the DISPATCHED run (concluded failure, stale) —
        // but the head's check rollup at arm time reads cancelled-only (a
        // concurrency cancel superseded the failed attempt's re-stamp, or
        // the kicker wave cancelled everything after the 15m window).
        // CANCELLED is never a verdict: the shared fail-path guard skips —
        // no unarm, no park, no report; the rerun-cancelled-checks remedy
        // re-stamps and the next sweep sees the fresh word.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(756, { labels: ['pr_approved', 'ai_validating'], headSha: 'sha756' })],
                pr: { number: 756, body: 'no closing keyword' },
                commitCheckRuns: { check_runs: [
                    { name: 'quality / validation', conclusion: 'cancelled', status: 'completed' },
                    { name: 'kicker / sm-liveness', conclusion: 'cancelled', status: 'completed' }
                ] }
            },
            onCliExecute: runsCli({ run: oldRun('failure', 'sha756') })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.sweep] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'the ai_validating arm stays on — a cancelled-only rollup is no verdict');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no ai_validated latch, no validation_failed park');
        assert.equal(sm.capturedPrComments.length, 0, 'no red report on a cancelled-only head');
    });

    test('sweep_stale_validation: fresh conclusion (< staleMinutes) → arm stays (verdict race window)', function () {
        var t = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(86, { labels: ['pr_approved', 'ai_validating'], headSha: 'sha444' })],
                onCliExecute: runsCli({ run: { status: 'completed', conclusion: 'success',
                    head_sha: 'sha444', created_at: t, updated_at: t } })
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.sweep] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'a 2-minute-old verdict may still be consumed — no sweep');
        assert.equal(sm.capturedPrLabelAdds.length, 0);
    });

    test('sweep_stale_validation: cancelled conclusion or no run → arm stays (no verdict to sweep)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(87, { labels: ['ai_validating'], headSha: 'sha555' })],
            },
                onCliExecute: runsCli({ run: oldRun('cancelled', 'sha555') })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.sweep] } });
        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'CANCELLED is never a verdict — nothing to sweep');

        var sm2 = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(88, { labels: ['ai_validating'], headSha: 'sha666' })]
            },
            onCliExecute: function () { return JSON.stringify({ workflow_runs: [] }); }
        }));
        sm2.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULES.sweep] } });
        assert.equal(sm2.capturedPrLabelRemoves.length, 0,
            'no dispatched run on the head (dispatch lost) — revalidate-armed owns that recovery');
    });
});

suite('smAgent: red-head park + dry-run dispatch + conclusion grace (fa wave stall 2026-09-27)', function () {
    // Live diagnosis (fa, 2026-09-27 evening): the oldest APPROVED PR was a
    // guest whose head validation had FAILED — validate-armed kept
    // re-dispatching CI on the unchanged red head every dup-guard window,
    // hogging the limit-1 FIFO slot while nine green-latched approved PRs
    // waited behind it for hours (no wave merge). Three fixes:
    //  1. deferRedHead (validate-armed): a head whose latest concluded
    //     dispatched verdict is FAILURE is parked — no dispatch, no arm,
    //     the limit-1 window advances. Machine PRs re-enter on the new head
    //     the rework leg pushes; guest PRs get one park comment per head.
    //  2. dispatchCiWorkflow honors DRY (a dry SM tick really dispatched
    //     CI, leaving an unarmed run whose verdict nobody could consume).
    //  3. The dup-dispatch guard counts its 15-min grace from the prior
    //     run's CONCLUSION, not creation.

    var RULES = {
        armed: { source: 'github', query: { type: 'pr', labels: ['pr_approved'],
            notLabels: ['ai_validating'], notMergeState: ['BEHIND', 'DIRTY'], draft: false },
            localAction: 'validate_pr', skipIfValidatedHead: true, deferRedHead: true,
            limit: 1, id: 'validate-armed' }
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['pr_approved'], issueNumber: null, prNumber: n,
                   draft: false, branch: 'feat/x', headSha: 'shaH', author: 'guest-human' };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }
    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }
    function runsCli(opts) {
        return function (cmd) {
            if (cmd.command.indexOf('actions/workflows/') !== -1 && cmd.command.indexOf('/runs?') !== -1) {
                var m = /head_sha=([^&"]+)/.exec(cmd.command);
                if (m && m[1] === opts.run.head_sha) {
                    return JSON.stringify({ workflow_runs: [opts.run] });
                }
                return JSON.stringify({ workflow_runs: [] });
            }
            return '';
        };
    }
    function run(conclusion, headSha, createdMsAgo, updatedMsAgo) {
        return { status: 'completed', conclusion: conclusion, head_sha: headSha,
                 created_at: new Date(Date.now() - createdMsAgo).toISOString(),
                 updated_at: new Date(Date.now() - updatedMsAgo).toISOString() };
    }
    function dispatched(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh workflow run') === 0; });
    }

    test('deferRedHead: guest PR with a red current head parks — no dispatch, no arm, one park comment', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(91, { headSha: 'ee55ff66aa' })],
                prStatus: { checkConclusion: 'red' }
            },
            onCliExecute: runsCli({ run: run('failure', 'ee55ff66aa', 40 * 60000, 20 * 60000) })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES.armed] } });

        assert.ok(!dispatched(sm.capturedCliCommands), 'red verdict still current — CI must NOT re-dispatch on the same SHA');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no ai_validating arm — the slot is parked, not consumed');
        assert.equal(sm.capturedPrComments.length, 1, 'guest PR gets exactly one park comment');
        assert.ok(sm.capturedPrComments[0].body.indexOf('Validation red') !== -1, 'park marker');
        assert.ok(sm.capturedPrComments[0].body.indexOf('ee55ff66aa') !== -1, 'comment carries the head sha (per-head dedup key)');
    });

    test('deferRedHead: park comment is posted once per head (marker dedup)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(92, { headSha: 'ee55ff66aa' })],
                prComments: [{ body: '🅿️ Validation red — PR parked — the current head `ee55ff66aa` failed validation earlier' }],
                prStatus: { checkConclusion: 'red' }
            },
            onCliExecute: runsCli({ run: run('failure', 'ee55ff66aa', 40 * 60000, 20 * 60000) })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES.armed] } });

        assert.equal(sm.capturedPrComments.length, 0, 'existing marker for this head — no duplicate park comment');
        assert.ok(!dispatched(sm.capturedCliCommands), 'still parked — still no dispatch');
    });

    test('deferRedHead: machine-authored red head defers without a park comment (rework owns the report)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(93, { headSha: 'ee55ff66aa', author: 'ai-teammate' })],
                prStatus: { checkConclusion: 'red' }
            },
            onCliExecute: runsCli({ run: run('failure', 'ee55ff66aa', 40 * 60000, 20 * 60000) })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES.armed] } });

        assert.ok(!dispatched(sm.capturedCliCommands), 'machine PR on an unchanged red head — no wasted CI either');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no arm while the red is current');
        assert.equal(sm.capturedPrComments.length, 0, 'machine PRs get no park comment — the fail path/rework owns reporting');
    });

    test('deferRedHead: a NEW head re-enters normally (dispatch + arm)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(94, { headSha: 'shaNEW', author: 'ai-teammate' })],
                prStatus: { checkConclusion: 'none' }
            },
            // The old red run sits on the OLD sha — the new head has no verdict.
            onCliExecute: runsCli({ run: run('failure', 'shaOLD', 40 * 60000, 20 * 60000) })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES.armed] } });

        assert.ok(dispatched(sm.capturedCliCommands), 'new head — real validation dispatched');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.labels.join(','); }),
            ['ai_validating'], 'armed for the fresh validation');
    });

    test('deferRedHead (gh-728, live fa PR #1249): a github-actions[bot]-authored PR with a red head rides the MACHINE path — never parked', function () {
        // Owner directive 2026-10-05: bot-authored PRs ride the machine
        // path. The machineAuthor knob is a LIST — with github-actions[bot]
        // as the second entry a red bot head must behave EXACTLY like a red
        // ai-teammate head: no validation_failed park, no park comment, no
        // CI re-dispatch on the unchanged head.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(98, { headSha: 'ee55ff66aa', author: 'github-actions[bot]' })],
                prStatus: { checkConclusion: 'red' }
            },
            onCliExecute: runsCli({ run: run('failure', 'ee55ff66aa', 40 * 60000, 20 * 60000) })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
                                 machineAuthor: 'ai-teammate,github-actions[bot]',
                                 rules: [RULES.armed] } });

        assert.ok(!dispatched(sm.capturedCliCommands), 'machine PR on an unchanged red head — no wasted CI');
        assert.equal(sm.capturedPrLabelAdds.length, 0,
            'NOT parked — github-actions[bot] is a machine login under the list config');
        assert.equal(sm.capturedPrComments.length, 0,
            'no park comment — the fail path/rework owns the report for machine PRs');
    });

    test('deferRedHead (gh-728): a github-actions[bot] PR re-enters on a NEW head under a list config', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(99, { headSha: 'shaNEW', author: 'github-actions[bot]' })],
                prStatus: { checkConclusion: 'none' }
            },
            // The old red run sits on the OLD sha — the new head has no verdict.
            onCliExecute: runsCli({ run: run('failure', 'shaOLD', 40 * 60000, 20 * 60000) })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
                                 machineAuthor: 'ai-teammate,github-actions[bot]',
                                 rules: [RULES.armed] } });

        assert.ok(dispatched(sm.capturedCliCommands), 'new head — real validation dispatched for the bot PR');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.labels.join(','); }),
            ['ai_validating'], 'armed for the fresh validation');
    });

    test('dispatchCiWorkflow honors DRY — a dry tick dispatches NO CI', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(95, { headSha: 'shaNEW' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: function () { return JSON.stringify({ workflow_runs: [] }); }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', dryRun: true,
                                 rules: [RULES.armed] } });

        assert.ok(!dispatched(sm.capturedCliCommands),
            'live bug: the 18:24 "SM manual tick (dry)" really dispatched CI — dry must mean no side effects');
    });

    test('dup-dispatch guard grace counts from the run CONCLUSION (updated_at)', function () {
        // Concluded 2 min ago (but created 40 min ago): within the
        // post-conclusion visibility grace → skip re-dispatch.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(96, { labels: ['pr_approved', 'ai_validated'], headSha: 'shaG' })],
                prStatus: { checkConclusion: 'green' }
            },
            onCliExecute: runsCli({ run: run('success', 'shaG', 40 * 60000, 2 * 60000) })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES.armed] } });
        assert.ok(!dispatched(sm.capturedCliCommands),
            'verdict landed 2 min ago — inside the 15-min post-conclusion grace, no duplicate dispatch');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no arm either — the guard skipped before arming');

        // Same run shape but concluded 20 min ago: grace expired → dispatch.
        var sm2 = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(97, { headSha: 'shaG2' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: runsCli({ run: run('cancelled', 'shaG2', 45 * 60000, 20 * 60000) })
        }));
        sm2.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                  rules: [RULES.armed] } });
        assert.ok(dispatched(sm2.capturedCliCommands),
            'cancelled is no verdict and the grace expired 5 min after conclusion — re-dispatch allowed');
    });
});

suite('smAgent: validation_failed sticky park (owner fa#923 2026-09-27)', function () {
    // Live: a guest PR cycled arm→CI red→park→silent-update→pending→re-arm
    // every tick — the #550 red-park keys on the CURRENT head's verdict, and
    // SM's own silent-update moved the head to a pending state, bypassing
    // it; the validate-armed limit-1 slot stayed hostage while 10 latched
    // PRs starved. Owner rule: 'у гостя если красное то следующий должны
    // пробовать мержить'. Mechanism (owner spec):
    //  1. silent-update decision point: a GUEST PR whose current head has
    //     RED checks gets the validation_failed label (idempotent, the head
    //     sha noted in a one-time comment).
    //  2. validate-armed's query excludes the label (sm_github.json).
    //  3. RESET (owner 2026-09-30, live fa pr-1094): the park clears only
    //     on a HUMAN push NEWER than the park event — the head commit's
    //     GitHub login must not be the machineAuthor (the agent legs' WIP
    //     auto-saves land as ai-teammate) and its committer must not be
    //     'sm-silent-update'; machine movement NEVER clears the label.
    //     Machine-authored PRs never get the label (fa pushes their heads).
    //  4. validate_pr refuses to dispatch ANY validation CI while the
    //     label is set (backstops validate-fresh too).

    var RULES_VF = {
        refresh: { source: 'github', query: { type: 'pr', mergeState: ['BEHIND'], draft: false },
                   localAction: 'update_branch', limit: 5, id: 'silent-update-behind' },
        armed: { source: 'github', query: { type: 'pr', labels: ['pr_approved'],
            notLabels: ['ai_validating', 'validation_failed'],
            notMergeState: ['BEHIND', 'DIRTY'], draft: false },
            localAction: 'validate_pr', deferRedHead: true, limit: 1, id: 'validate-armed' }
    };

    function vfConfig(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }
    function vfItem(n, extra) {
        var it = { key: 'pr-' + n, labels: [], prNumber: n, draft: false,
                   branch: 'feat/vf-' + n, headSha: '11ab22cd3' + n, author: 'guest-human' };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }
    function vfCli(opts) {
        // Stub answers the three park probes keyed on command shape:
        //   - /commits/<sha>" --jq '{login:…  → the actor probe (JSON login+date)
        //   - /events?per_page=100            → the park-time probe (ISO string)
        //   - /commits/<sha>" (plain)         → the committer-name probe
        return function (cmd) {
            var m = /\/commits\/([0-9a-fA-Z]+)"/.exec(cmd.command);
            if (m && opts.actors && opts.actors[m[1]] !== undefined) {
                return JSON.stringify(opts.actors[m[1]]);
            }
            if (opts.parkedAt !== undefined && cmd.command.indexOf('/events?per_page=100') !== -1) {
                return '"' + opts.parkedAt + '"';
            }
            if (m && opts.committers && opts.committers[m[1]] !== undefined) {
                return '"' + opts.committers[m[1]] + '"';
            }
            return '';
        };
    }
    function vfDispatched(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh workflow run') === 0; });
    }
    function vfRefreshed(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh repo clone') !== -1; });
    }

    test('silent-update: guest with a RED head gets validation_failed (idempotent set, sha noted)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(201, { headSha: 'ee55ff66aa' })],
                prStatus: { checkConclusion: 'red' }
            },
            onCliExecute: vfCli({})
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.labels.indexOf('validation_failed') !== -1; }), 'park label set');
        assert.equal(sm.capturedPrComments.length, 1, 'one park comment');
        assert.ok(sm.capturedPrComments[0].body.indexOf('validation_failed') !== -1, 'marker');
        assert.ok(sm.capturedPrComments[0].body.indexOf('ee55ff66aa') !== -1, 'head sha noted');
        assert.ok(sm.capturedPrComments[0].body.indexOf('HUMAN push') !== -1,
            'the comment states the human-push requirement');
        assert.ok(vfRefreshed(sm.capturedCliCommands), 'the silent refresh itself still runs');
    });

    test('silent-update: an SM merge does NOT clear the label (last committer sm-silent-update)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(202, { labels: ['validation_failed'], headSha: 'aa11bb22cc' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({ committers: { aa11bb22cc: 'sm-silent-update' } })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'SM head movement must NOT un-park');
        assert.equal(sm.capturedPrComments.length, 0, 'idempotent — no new comment');
        assert.ok(vfRefreshed(sm.capturedCliCommands), 'refresh still runs');
    });

    test('silent-update RESET (gh-1394): ticket WITHOUT headSha (park-reset rule shape, pr:null) — head resolved via github_get_pr, human push clears the park', function () {
        // Live fa 2026-10-07 (#1394): the park-reset rule's query carries no
        // mergeState/checks guard, so queryPrs hands the action pr:null with
        // NO headSha; the old `(ticket.pr && ticket.pr.headSha) ||
        // ticket.headSha` read null, the RESET ladder failed closed with
        // ZERO API calls ("park probe failed" ~1s after the events probe,
        // no /commits call), and nine parked guest PRs stayed frozen while
        // every manual probe succeeded. The head must resolve explicitly.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(203, { labels: ['validation_failed'], headSha: undefined })],
                prStatus: { checkConclusion: 'none' },
                pr: { number: 203, head: { sha: 'bb445566cc', ref: 'feat/vf-203' } }
            },
            onCliExecute: vfCli({
                actors: { bb445566cc: { login: 'guest-human', date: '2026-10-07T20:06:13Z',
                                         committer: 'Guest Human', sha: 'bb445566cc', parents: [] } },
                parkedAt: '2026-10-07T20:02:05Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.ok(sm.capturedPrLabelRemoves.some(function (r) {
            return r.label === 'validation_failed';
        }), 'park cleared after the explicit head resolve');
        assert.ok(vfRefreshed(sm.capturedCliCommands), 'refresh still runs');
    });

    test('silent-update RESET (gh-1394): unresolvable head keeps the park (fail closed preserved)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(205, { labels: ['validation_failed'], headSha: undefined })],
                prStatus: { checkConclusion: 'none' },
                pr: { number: 205, body: '' } // no head → resolve null
            },
            onCliExecute: vfCli({ parkedAt: '2026-10-07T20:02:05Z' })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'a head that cannot be resolved keeps the park (fail closed)');
    });

    test('silent-update: clone/fetch failures are not masked as success (root fix 2026-10-01)', function () {
        // Live: fa approved cohort parked BEHIND since 2026-09-13 — the old
        // chain `clone && fetch && ! ancestor || exit 0 && merge…` swallowed
        // CLONE/NETWORK failures via `|| exit 0` (left-associative shell),
        // the tick logged "branch silently updated", and the head never
        // moved. The no-op skip must scope to the ancestor check only.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(204, { labels: ['validation_failed'], headSha: 'ff44556677' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({ committers: { ff44556677: 'sm-silent-update' } })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        var refresh = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh repo clone') !== -1;
        })[0];
        assert.ok(refresh, 'refresh command captured');
        assert.ok(
            refresh.command.indexOf('if git merge-base --is-ancestor FETCH_HEAD HEAD') !== -1,
            'no-op skip must scope to the ancestor check (if/then), not mask failures');
        assert.ok(refresh.command.indexOf('|| exit 0') === -1,
            'the old failure-masking `|| exit 0` must be gone');
        assert.ok(refresh.command.indexOf('sm-silent-update') !== -1,
            'machine committer identity preserved (sticky-park depends on it)');
    });

    test('silent-update: an AUTHOR PUSH clears the label and re-enters validation', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(203, { labels: ['validation_failed'], headSha: 'dd33ee44ff' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({ committers: { dd33ee44ff: 'real-dev' },
                                  actors: { dd33ee44ff: { login: 'real-dev', date: '2026-09-30T15:00:00Z' } },
                                  parkedAt: '2026-09-30T14:00:00Z' })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['validation_failed'], 'label removed');
        assert.equal(sm.capturedPrComments.length, 1, 'un-park comment');
        assert.ok(sm.capturedPrComments[0].body.indexOf('cleared') !== -1, 'clear marker');
        assert.ok(sm.capturedPrComments[0].body.indexOf('real-dev') !== -1, 'names the non-machine committer');
        assert.ok(sm.capturedPrLabelAdds.length === 0 ||
            !sm.capturedPrLabelAdds.some(function (a) { return a.labels.indexOf('validation_failed') !== -1; }),
            'not re-labeled in the same pass — the fresh head gets a real validation chance');
    });

    test('silent-update: an AGENT push (machineAuthor login) does NOT clear the label (fa pr-1094)', function () {
        // Live: fa pr-1094's rework leg landed WIP auto-save commits as
        // ai-teammate AFTER the park — the old reset (any non-silent-update
        // committer) cleared the label and the red machine PR re-armed every
        // tick. The actor probe must read the LOGIN, not the git name: the
        // agent's identity ("AI Teammate" <agent.ai.native@gmail.com>)
        // differs from the workflow identities but its login is the
        // deployment's machineAuthor.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(205, { labels: ['validation_failed'], headSha: 'aa77bb77cc' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({ committers: { aa77bb77cc: 'AI Teammate' },
                                  actors: { aa77bb77cc: { login: 'ai-teammate', date: '2026-09-30T14:20:38Z' } },
                                  parkedAt: '2026-09-30T14:18:03Z' })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'machine push must NOT un-park');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
        assert.ok(vfRefreshed(sm.capturedCliCommands), 'refresh still runs');
    });

    test('silent-update (gh-728): a github-actions[bot] push does NOT clear the label under a multi-entry machineAuthor', function () {
        // Live fa PR #1249 class: the machineAuthor knob is a LIST
        // ('ai-teammate,github-actions[bot]') — the park RESET must treat a
        // push by ANY list entry as machine movement (the fa pr-1094 rule
        // for the second login), not as the human push that clears the park.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(211, { labels: ['validation_failed'], headSha: 'cc99dd88ee' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({ committers: { cc99dd88ee: 'github-actions[bot]' },
                                  actors: { cc99dd88ee: { login: 'github-actions[bot]', date: '2026-10-05T09:00:00Z' } },
                                  parkedAt: '2026-10-05T08:55:00Z' })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
                                 machineAuthor: 'ai-teammate,github-actions[bot]',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'a second machine login pushing is still machine movement — the park holds');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
    });

    test('silent-update: a HUMAN push OLDER than the park event does NOT clear the label', function () {
        // The park is set ON a red head — that head predates the park event
        // by definition. Only a push landing AFTER the park proves new work.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(206, { labels: ['validation_failed'], headSha: 'bb88cc88dd' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({ committers: { bb88cc88dd: 'real-dev' },
                                  actors: { bb88cc88dd: { login: 'real-dev', date: '2026-09-30T13:00:00Z' } },
                                  parkedAt: '2026-09-30T14:00:00Z' })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'stale human head must NOT un-park');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
    });

    // dmtools-agents#681 (live fa#1213, 2026-10-03 22:56–23:10): the human
    // retrigger 7ecf11d7 landed 22:56; the silent-update bot merged main on
    // top (bot merge b3f9c6b5) BEFORE the next tick — the HEAD-keyed probe
    // saw the machine actor and declined across FOUR real ticks
    // (22:59/23:04/23:06/…) until a human removed the label by hand. The
    // RESET probe must walk back past machine-authored MERGES to the last
    // substantive commit and test THAT actor + date.
    var BOT_MERGE_681 = 'b3f9c6b5b3f9c6b5b3f9c6b5b3f9c6b5b3f9c6b5';
    var HUMAN_FIX_681 = '7ecf11d77ecf11d77ecf11d77ecf11d77ecf11d7';
    var STALE_HUMAN_681 = '4545454545454545454545454545454545454545';
    var MAIN_TIP_681 = '0123456789abcdef0123456789abcdef01234567';

    function vfMergeActors(opts) {
        // sha-keyed actor stubs for the #681 walk tests (bracket-built — a
        // literal key would name the CONSTANT, not the sha it holds)
        var map = {};
        map[opts.mergeSha] = {
            login: 'ai-teammate', date: opts.mergeDate || '2026-10-03T22:57:30Z',
            committer: 'sm-silent-update',
            parents: [opts.tipSha, MAIN_TIP_681]
        };
        if (!opts.selfLoop) {
            map[opts.tipSha] = { login: opts.tipLogin, date: opts.tipDate };
        }
        return map;
    }

    test('silent-update: a bot merge of main BURYING a fresh human push clears the label (#681)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(209, { labels: ['validation_failed'], headSha: BOT_MERGE_681 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({
                // the bot merge (machine login + sm-silent-update committer,
                // TWO parents: branch tip + main) buries the retrigger — its
                // 22:57 date must NOT speak for the branch; the walk lands
                // on the human 22:56 fix, newer than the 22:31 park
                actors: vfMergeActors({ mergeSha: BOT_MERGE_681, tipSha: HUMAN_FIX_681,
                                        tipLogin: 'istinn', tipDate: '2026-10-03T22:56:00Z' }),
                parkedAt: '2026-10-03T22:31:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['validation_failed'], 'the buried retrigger clears the park');
        assert.equal(sm.capturedPrComments.length, 1, 'un-park comment');
        assert.ok(sm.capturedPrComments[0].body.indexOf('istinn') !== -1,
            'names the HUMAN actor of the substantive commit');
        assert.ok(sm.capturedPrComments[0].body.indexOf(HUMAN_FIX_681) !== -1,
            'points at the substantive commit, not the bot-merge head');
    });

    test('silent-update: a bot merge of main with NO human push since the park keeps the label (#681)', function () {
        // The branch sat parked; the bot only refreshed it with main — the
        // walk lands on the very head the park was set on (22:2x, older
        // than the 22:31 park event). The bot merge's fresh date must not
        // be mistaken for a retrigger.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(210, { labels: ['validation_failed'], headSha: BOT_MERGE_681 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({
                // the parked red head itself (22:20) — predates the park
                actors: vfMergeActors({ mergeSha: BOT_MERGE_681, tipSha: STALE_HUMAN_681,
                                        tipLogin: 'vendor-guest', tipDate: '2026-10-03T22:20:00Z',
                                        mergeDate: '2026-10-03T23:04:00Z' }),
                parkedAt: '2026-10-03T22:31:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'no retrigger — the park holds');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
    });

    test('silent-update: a bot merge walking back to a HUMAN push OLDER than the park keeps the label (#681)', function () {
        // Humanness alone must not clear: only a human push NEWER than the
        // park event is a retrigger. A pre-park human fix buried under a
        // post-park bot merge is exactly the head the park punished.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(211, { labels: ['validation_failed'], headSha: BOT_MERGE_681 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({
                actors: vfMergeActors({ mergeSha: BOT_MERGE_681, tipSha: STALE_HUMAN_681,
                                        tipLogin: 'another-human', tipDate: '2026-10-03T22:05:00Z' }),
                parkedAt: '2026-10-03T22:31:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'a stale human push is not a retrigger');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
    });

    test('silent-update: a walk that never finds a substantive commit keeps the label (fail closed, #681)', function () {
        // A pathological all-machine chain must not walk forever: the cap
        // fails closed — the park survives a dead/garbage probe.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(212, { labels: ['validation_failed'], headSha: BOT_MERGE_681 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({
                // self-parenting machine merge — the walk hits its cap
                actors: vfMergeActors({ mergeSha: BOT_MERGE_681, tipSha: BOT_MERGE_681,
                                        selfLoop: true }),
                parkedAt: '2026-10-03T22:31:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'unwalkable chain — park holds');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
    });

    test('silent-update: a failed park probe keeps the label (fail closed)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(207, { labels: ['validation_failed'], headSha: 'cc99dd99ee' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({})
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'dead probes must NOT un-park');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
    });

    test('silent-update: a MACHINE PR with a red head never gets the label', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(204, { author: 'ai-teammate', headSha: 'ee55ff66aa' })],
                prStatus: { checkConclusion: 'red' }
            },
            onCliExecute: vfCli({})
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.ok(!sm.capturedPrLabelAdds.some(function (a) {
            return a.labels.indexOf('validation_failed') !== -1; }),
            'machine-authored PRs keep the re-enter-on-new-head behavior — no label');
        assert.equal(sm.capturedPrComments.length, 0, 'no park comment for machine PRs');
    });

    // dmtools-agents#633 (live fa#1139 2026-10-02): the park verdict belongs
    // to the sha the park comment recorded. A silent rebase moves the head to
    // a sha that has NEVER been validated — the park must not outlive its
    // verdict, or a moved-base red (fixed by the very rebase) parks the PR
    // forever (fa#1114 was the same red, hand-cleared, re-validated GREEN,
    // merged).
    var OLD_HEAD = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
    var NEW_HEAD = '99887766554433221100ffeeddccbbaa99887766';

    test('silent-update: head changed since the park with NO own verdict — park clears (rebase medicine)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(206, { labels: ['validation_failed'], headSha: NEW_HEAD })],
                prComments: [{ body: '🛑 parked-head: ' + OLD_HEAD }],
                prStatus: { checkConclusion: 'none' }
            },
            // Even the HARDEST case clears: the new head was pushed by the
            // machine itself (sm-silent-update committer, machine actor
            // login, STALE date — neither human nor fresh). The sha change
            // is the verdict.
            onCliExecute: (function () {
                var base = vfCli({ parkedAt: '2026-10-01T00:00:00Z' });
                return function (cmd) {
                    var m = /\/commits\/([0-9a-fA-F]+)"/.exec(cmd.command);
                    if (m && m[1] === NEW_HEAD &&
                        cmd.command.indexOf('login') !== -1) {
                        // machine actor, push OLDER than the park event —
                        // neither human nor fresh on purpose
                        return JSON.stringify({ login: 'ai-teammate',
                            date: '2026-09-30T00:00:00Z' });
                    }
                    if (m && m[1] === NEW_HEAD) return '"sm-silent-update"';
                    return base(cmd);
                };
            })()
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.ok(sm.capturedPrLabelRemoves.some(function (r) {
            return r.label === 'validation_failed'; }),
            'the park does not survive its own sha');
        assert.ok(sm.capturedPrComments.some(function (c) {
            return c.body.indexOf('no red verdict of its own') !== -1; }),
            'the un-park comment explains the sha-change rationale');
        assert.ok(vfRefreshed(sm.capturedCliCommands), 'the silent refresh itself still runs');
    });

    test('silent-update: head changed BUT carries its OWN red verdict — park holds', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(207, { labels: ['validation_failed'], headSha: NEW_HEAD })],
                prComments: [{ body: '🛑 parked-head: ' + OLD_HEAD }],
                prStatus: { checkConclusion: 'red' }
            },
            onCliExecute: function (cmd) {
                // The dispatched-verdict probe answers for the NEW head.
                if (cmd.command.indexOf('/runs?head_sha=' + NEW_HEAD) !== -1) {
                    return JSON.stringify({ workflow_runs: [
                        { head_sha: NEW_HEAD, status: 'completed', conclusion: 'failure',
                          updated_at: '2026-10-02T00:00:00Z' }
                    ] });
                }
                return vfCli({ parkedAt: '2026-10-01T00:00:00Z' })(cmd);
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'a fresh red verdict on the new head re-justifies the park');
    });

    test('silent-update: same head as the park — holds (the park sha still matches)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(208, { labels: ['validation_failed'], headSha: OLD_HEAD })],
                prComments: [{ body: '🛑 parked-head: ' + OLD_HEAD }],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({ parkedAt: '2026-10-01T00:00:00Z' })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'no sha change — the human-push RESET path remains the only exit');
    });
    // ── gh-750 (live fa#1227, owner directive 2026-10-05): a MACHINE-
    // authored parked PR has NO self-clear path at all. The RESET above
    // demands a NON-machine substantive push newer than the park — fa
    // pushes their own heads, so it never lands; the #633 comment-sha
    // path needs a park comment legacy parks predate; and the rework
    // armers list validation_failed as an in-flight blocker, so no
    // rework leg fires either (fa#1227: pr_approved + ai_pr_reviewed +
    // MERGEABLE, parked since the CI-storm era — permanent). Owner rule:
    // the SM clears the label ITSELF when the park's verdict is void for
    // the CURRENT head — the check rollup is GREEN, or the head moved
    // past the park carrying no red verdict of its own. Guests keep the
    // 2026-09-27 sticky behavior.
    var MACHINE_HEAD_750 = 'ab1177aa22bb33cc44dd55ee66ff770011223344';

    test('gh-750: a MACHINE-authored parked PR with a GREEN head self-clears the label (fa#1227)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(221, { author: 'ai-teammate', labels: ['validation_failed'],
                                      headSha: MACHINE_HEAD_750 })],
                prStatus: { checkConclusion: 'green' }
            },
            onCliExecute: vfCli({
                actors: { ab1177aa22bb33cc44dd55ee66ff770011223344: {
                    login: 'ai-teammate', date: '2026-09-15T10:00:00Z', parents: [] } },
                parkedAt: '2026-09-20T00:00:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['validation_failed'],
            'machine PR parked with a green head — the label is cleared within a tick');
        assert.ok(sm.capturedPrComments.some(function (c) {
            return c.body.indexOf('cleared') !== -1 &&
                c.body.toUpperCase().indexOf('MACHINE') !== -1; }),
            'the clear comment names the machine self-clear');
    });

    test('gh-750: a MACHINE-authored parked PR whose head moved past the park self-clears (no own red verdict)', function () {
        // The park's red belongs to the sha it was set on; fa pushed a new
        // head AFTER the park and the legacy park comment is lost — the #633
        // sha-keyed path has nothing to key on. The head-date probe clears
        // where the sha probe cannot.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(222, { author: 'ai-teammate', labels: ['validation_failed'],
                                      headSha: MACHINE_HEAD_750 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: function (cmd) {
                if (cmd.command.indexOf('/runs?head_sha=' + MACHINE_HEAD_750) !== -1) {
                    return JSON.stringify({ workflow_runs: [] });
                }
                return vfCli({
                    actors: { ab1177aa22bb33cc44dd55ee66ff770011223344: {
                        login: 'ai-teammate', date: '2026-10-05T09:00:00Z', parents: [] } },
                    parkedAt: '2026-09-20T00:00:00Z'
                })(cmd);
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['validation_failed'],
            'the head moved after the park with no red of its own — cleared');
    });

    test('gh-750: a MACHINE-authored parked PR whose head PREDATES the park and is not green keeps the label', function () {
        // Fail-closed boundary: neither green-now nor moved-past-the-park —
        // the parked red verdict still belongs to this exact head.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(223, { author: 'ai-teammate', labels: ['validation_failed'],
                                      headSha: MACHINE_HEAD_750 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: function (cmd) {
                if (cmd.command.indexOf('/runs?head_sha=' + MACHINE_HEAD_750) !== -1) {
                    return JSON.stringify({ workflow_runs: [] });
                }
                return vfCli({
                    actors: { ab1177aa22bb33cc44dd55ee66ff770011223344: {
                        login: 'ai-teammate', date: '2026-09-15T10:00:00Z', parents: [] } },
                    parkedAt: '2026-09-20T00:00:00Z'
                })(cmd);
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'the parked head still carries the park\'s verdict — the park holds');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
    });

    test('gh-750: a MACHINE-authored parked PR whose moved head carries its OWN red verdict keeps the label', function () {
        // Red does not transfer across shas in either direction: a fresh red
        // dispatched verdict on the moved head re-justifies a park (the
        // machine loop owns it via rework — never this label again).
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(224, { author: 'ai-teammate', labels: ['validation_failed'],
                                      headSha: MACHINE_HEAD_750 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: function (cmd) {
                if (cmd.command.indexOf('/runs?head_sha=' + MACHINE_HEAD_750) !== -1) {
                    return JSON.stringify({ workflow_runs: [
                        { head_sha: MACHINE_HEAD_750, status: 'completed',
                          conclusion: 'failure', updated_at: '2026-10-05T09:05:00Z' }
                    ] });
                }
                return vfCli({
                    actors: { ab1177aa22bb33cc44dd55ee66ff770011223344: {
                        login: 'ai-teammate', date: '2026-10-05T09:00:00Z', parents: [] } },
                    parkedAt: '2026-09-20T00:00:00Z'
                })(cmd);
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'a fresh red verdict on the moved head re-justifies the park');
    });

    test('gh-750: a probe failure keeps a MACHINE-authored parked PR parked even with a green head (fail closed)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(225, { author: 'ai-teammate', labels: ['validation_failed'],
                                      headSha: MACHINE_HEAD_750 })],
                prStatus: { checkConclusion: 'green' }
            },
            onCliExecute: vfCli({})
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'dead probes must NOT un-park a machine PR either');
    });

    test('gh-750: a GUEST parked PR keeps the sticky park — green head and machine pushes never clear it', function () {
        // The owner directive is machine-PR-only. A guest parked red keeps
        // the 2026-09-27 contract: only a fresh HUMAN push clears it (the
        // machine login below is exactly the fa push that must not speak
        // for the guest, and green-now is a machine-PR-only exit).
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(226, { labels: ['validation_failed'],
                                      headSha: MACHINE_HEAD_750 })],
                prStatus: { checkConclusion: 'green' }
            },
            onCliExecute: vfCli({
                actors: { ab1177aa22bb33cc44dd55ee66ff770011223344: {
                    login: 'ai-teammate', date: '2026-10-05T09:00:00Z', parents: [] } },
                parkedAt: '2026-09-20T00:00:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'guests keep the sticky park — the human-push RESET is their only exit');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment while parked');
    });

    test('gh-750: the self-clear rides the park-reset rule route too (non-BEHIND, live fa#1227)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(227, { author: 'ai-teammate',
                                      labels: ['validation_failed', 'pr_approved', 'ai_pr_reviewed'],
                                      headSha: MACHINE_HEAD_750 })],
                prStatus: { checkConclusion: 'green' }
            },
            onCliExecute: vfCli({
                actors: { ab1177aa22bb33cc44dd55ee66ff770011223344: {
                    login: 'ai-teammate', date: '2026-09-15T10:00:00Z', parents: [] } },
                parkedAt: '2026-09-20T00:00:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [{ source: 'github',
            query: { type: 'pr', labels: ['validation_failed'],
                     notLabels: ['ai_validating', 'blocked'], draft: false },
            localAction: 'update_branch', limit: 10, id: 'park-reset' }] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['validation_failed'],
            'the park-reset route (mergeable, not behind) clears a green machine park');
    });

    test('gh-750: the moved-head self-clear fires ONE dispatched-verdict probe per tick (shared #633/gh-750 probe)', function () {
        // Review (pr-752 rework, thread 1): with a park comment present, the
        // #633 head-change path and the gh-750 machine moved-head path each
        // probed the SAME dispatched verdict for the SAME head with the SAME
        // args — two identical `gh api .../runs?head_sha=` calls in one
        // tick. One shared memoized probe serves both consumers.
        var verdictProbeCalls = 0;
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(228, { author: 'ai-teammate', labels: ['validation_failed'],
                                      headSha: MACHINE_HEAD_750 })],
                prComments: [{ body: '🛑 parked-head: ' + OLD_HEAD }],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: function (cmd) {
                if (cmd.command.indexOf('/runs?head_sha=') !== -1) {
                    verdictProbeCalls += 1;
                    return JSON.stringify({ workflow_runs: [] });
                }
                return vfCli({
                    actors: { ab1177aa22bb33cc44dd55ee66ff770011223344: {
                        login: 'ai-teammate', date: '2026-10-05T09:00:00Z', parents: [] } },
                    parkedAt: '2026-09-20T00:00:00Z'
                })(cmd);
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        assert.equal(verdictProbeCalls, 1,
            'the shared verdict probe runs ONCE per tick, not once per consumer');
        assert.ok(sm.capturedPrLabelRemoves.some(function (r) {
            return r.label === 'validation_failed'; }),
            'the park still clears — probe sharing must not change the ladder');
    });

    test('gh-750: the moved-head clear comment cites its evidence (head sha @ date > park time)', function () {
        // Review (pr-752 rework, thread 2): the sibling clear comments cite
        // their evidence (#633 names both shas; the human-push RESET names
        // actor + date) — the machine clear named only the reason class.
        // The moved-head branch carries the same audit trail: which head,
        // when it moved, when the park was set.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(229, { author: 'ai-teammate', labels: ['validation_failed'],
                                      headSha: MACHINE_HEAD_750 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: function (cmd) {
                if (cmd.command.indexOf('/runs?head_sha=' + MACHINE_HEAD_750) !== -1) {
                    return JSON.stringify({ workflow_runs: [] });
                }
                return vfCli({
                    actors: { ab1177aa22bb33cc44dd55ee66ff770011223344: {
                        login: 'ai-teammate', date: '2026-10-05T09:00:00Z', parents: [] } },
                    parkedAt: '2026-09-20T00:00:00Z'
                })(cmd);
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.refresh] } });

        var clear = sm.capturedPrComments.filter(function (c) {
            return c.body.indexOf('MACHINE') !== -1; });
        assert.equal(clear.length, 1, 'the machine clear comment is posted');
        assert.ok(clear[0].body.indexOf('ab1177aa') !== -1,
            'the moved head sha is cited');
        assert.ok(clear[0].body.indexOf('2026-10-05T09:00:00Z') !== -1,
            'the head commit date is cited');
        assert.ok(clear[0].body.indexOf('2026-09-20T00:00:00Z') !== -1,
            'the park time is cited');
    });

    test('validate_pr: a labeled PR gets NO CI dispatch at all (validate-fresh backstop)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(205, { labels: ['pr_approved', 'validation_failed'], headSha: 'ff6600aa11' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: function () { return JSON.stringify({ workflow_runs: [] }); }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_VF.armed] } });

        assert.ok(!vfDispatched(sm.capturedCliCommands),
            'validation_failed — NO validation CI trigger until a non-machine push clears it');
        assert.ok(!sm.capturedPrLabelAdds.some(function (a) {
            return a.labels.indexOf('ai_validating') !== -1; }), 'no arm either');
    });

    test('sm_github.json: validate-armed excludes validation_failed from the arm queue', function () {
        var raw = file_read({ path: 'sm_github.json' });
        var cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || cfg.rules || [];
        var armed = rules.filter(function (r) { return r.id === 'validate-armed'; });
        assert.equal(armed.length, 1, 'exactly one validate-armed rule');
        var notLabels = (armed[0].query && armed[0].query.notLabels) || [];
        assert.ok(notLabels.indexOf('validation_failed') !== -1,
            'parked guests never enter the arm queue (query-level exclusion)');
        assert.ok(notLabels.indexOf('ai_validating') !== -1, 'mutex exclusion preserved');
    });

    test('sm_github.json: park-reset matches parked PRs regardless of merge state (live fa 2026-10-03)', function () {
        // The RESET probe lives inside update_branch, but silent-update-
        // behind only matches BEHIND — five parked fa PRs with fresh 16:01
        // vendor pushes (heads NOT behind) sat frozen for two hours because
        // no rule ever ran the probe. park-reset closes the hole.
        var raw = file_read({ path: 'sm_github.json' });
        var cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || cfg.rules || [];
        var reset = rules.filter(function (r) { return r.id === 'park-reset'; });
        assert.equal(reset.length, 1, 'exactly one park-reset rule');
        var q = reset[0].query || {};
        assert.equal(q.type, 'pr', 'PR-anchored');
        assert.ok((q.labels || []).indexOf('validation_failed') !== -1, 'matches parked PRs');
        assert.equal(q.mergeState, undefined, 'NO merge-state filter — non-BEHIND parked heads reach the RESET probe');
        assert.equal(reset[0].localAction, 'update_branch', 'rides the existing RESET probe inside update_branch');
        assert.ok((q.notLabels || []).indexOf('ai_validating') !== -1, 'never touches a validating PR mid-run');
    });

    test('sm_github.json: the machine self-clear wording states BOTH routes (shared RESET probe)', function () {
        // Review (pr-752 rework, thread 4): park-reset's description claimed
        // to be "the ONLY exit" — false for BEHIND heads, which
        // silent-update-behind serves through the same shared RESET probe.
        // The silent-update-behind note that machine PRs "never get the
        // label" now states the guest-gating explicitly (legacy parks
        // predate it).
        var raw = file_read({ path: 'sm_github.json' });
        var cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || cfg.rules || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });

        assert.ok(byId['park-reset'], 'park-reset exists');
        assert.ok(byId['park-reset'].description.indexOf(
                'only exit when the head is NOT BEHIND') !== -1,
            'park-reset scopes its exclusivity claim to NOT-BEHIND heads');
        assert.equal(byId['park-reset'].description.indexOf(
                'the ONLY exit a MACHINE-authored parked PR will ever get'), -1,
            'the imprecise exclusivity claim is gone');
        assert.ok(byId['silent-update-behind'], 'silent-update-behind exists');
        assert.ok(byId['silent-update-behind'].description.indexOf('guest-gated') !== -1,
            'silent-update-behind states that current SET rules are guest-gated');
    });

    test('validate_pr backstop: a FRESH HUMAN push on a parked PR clears the label and dispatches (live fa 2026-10-03)', function () {
        // Defense-in-depth for any rule that reaches validate_pr with a
        // parked PR (validate-fresh has no validation_failed exclusion):
        // the action itself must self-heal on a fresh non-machine push
        // instead of parking forever — update_branch's RESET never ran for
        // non-BEHIND heads (the hole park-reset closes at the query level).
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(210, { labels: ['pr_approved', 'validation_failed'], headSha: 'cc11992200' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({
                actors: { cc11992200: { login: 'guest-human', date: '2026-10-03T16:01:10Z' } },
                parkedAt: '2026-10-03T08:15:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [{
            source: 'github', query: { type: 'pr', labels: ['pr_approved'],
                notLabels: ['ai_validating'], notMergeState: ['BEHIND', 'DIRTY'], draft: false },
            localAction: 'validate_pr', deferRedHead: true, limit: 1, id: 'validate-armed-no-vf' }] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['validation_failed'], 'park label cleared by the action-level probe');
        assert.ok(vfDispatched(sm.capturedCliCommands), 'validation CI dispatched for the fresh head');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.labels.indexOf('ai_validating') !== -1; }), 'armed');
        assert.ok(sm.capturedPrComments.some(function (c) {
            return c.body.indexOf('cleared') !== -1; }), 'un-park comment posted');
    });

    test('validate_pr backstop: a MACHINE push never clears the park (actor login, not git name)', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(211, { labels: ['pr_approved', 'validation_failed'], headSha: 'dd22113344' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({
                actors: { dd22113344: { login: 'ai-teammate', date: '2026-10-03T16:01:10Z' } },
                parkedAt: '2026-10-03T08:15:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [{
            source: 'github', query: { type: 'pr', labels: ['pr_approved'],
                notLabels: ['ai_validating'], notMergeState: ['BEHIND', 'DIRTY'], draft: false },
            localAction: 'validate_pr', deferRedHead: true, limit: 1, id: 'validate-armed-no-vf' }] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'machine push must NOT un-park');
        assert.ok(!vfDispatched(sm.capturedCliCommands), 'no CI while parked');
    });

    test('validate_pr backstop: a STALE human push (older than the park event) keeps the park', function () {
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(212, { labels: ['pr_approved', 'validation_failed'], headSha: 'ee33445566' })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({
                actors: { ee33445566: { login: 'guest-human', date: '2026-10-03T07:00:00Z' } },
                parkedAt: '2026-10-03T08:15:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [{
            source: 'github', query: { type: 'pr', labels: ['pr_approved'],
                notLabels: ['ai_validating'], notMergeState: ['BEHIND', 'DIRTY'], draft: false },
            localAction: 'validate_pr', deferRedHead: true, limit: 1, id: 'validate-armed-no-vf' }] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0, 'the parked head predates the park — no clear');
        assert.ok(!vfDispatched(sm.capturedCliCommands), 'no CI while parked');
    });

    test('validate_pr backstop: a bot merge of main BURYING a fresh human push clears the park (#681)', function () {
        // Same live race as update_branch's RESET (fa#1213: retrigger
        // 22:56, bot merge 22:57, park 22:31) reaching the action-level
        // backstop — the probe must walk past the bot merge and dispatch.
        var sm = makeSmAgent(Object.assign(vfConfig('a', 'b'), {
            github: {
                items: [vfItem(213, { labels: ['pr_approved', 'validation_failed'],
                                     headSha: BOT_MERGE_681 })],
                prStatus: { checkConclusion: 'none' }
            },
            onCliExecute: vfCli({
                actors: vfMergeActors({ mergeSha: BOT_MERGE_681, tipSha: HUMAN_FIX_681,
                                        tipLogin: 'istinn', tipDate: '2026-10-03T22:56:00Z' }),
                parkedAt: '2026-10-03T22:31:00Z'
            })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [{
            source: 'github', query: { type: 'pr', labels: ['pr_approved'],
                notLabels: ['ai_validating'], notMergeState: ['BEHIND', 'DIRTY'], draft: false },
            localAction: 'validate_pr', deferRedHead: true, limit: 1, id: 'validate-armed-no-vf' }] } });

        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['validation_failed'], 'the buried retrigger clears the park at the backstop too');
        assert.ok(vfDispatched(sm.capturedCliCommands), 'validation CI dispatched for the substantive head');
        assert.ok(sm.capturedPrComments.some(function (c) {
            return c.body.indexOf('machine merges of main walked past') !== -1; }),
            'the un-park comment explains the walk');
    });
});

suite('smAgent: PR priority tiers (owner directive 2026-10-08)', function () {
    // FIFO within a tier: priority_blocker preempts the approved merge
    // window (validation slot + merge priority ahead of older mediums),
    // priority_low sinks below all mediums, no label anywhere = medium.
    // Label carrier: the PR itself OR its linked issue; names configurable
    // via .dmtools/config.js smPriorityLabels. Modeled on the silent-update
    // park tests above, but routed through the REAL github source
    // (makeSmAgent opts.github.realSource) — the items-stub replaces the
    // whole source query and would bypass queryPrs' tier-aware sort.
    // The arm side (validate_pr) makes the pick OBSERVABLE: exactly one
    // PR gets ai_validating + a CI dispatch per tick.

    var RULES_PT = {
        armed: { source: 'github', query: { type: 'pr', labels: ['pr_approved'],
            notLabels: ['ai_validating', 'validation_failed'],
            notMergeState: ['BEHIND', 'DIRTY'], draft: false,
            mutex: 'ai_validating', mutexAmong: ['pr_approved'] },
            localAction: 'validate_pr', skipIfValidatedHead: true, redHeadSkip: true,
            limit: 1, id: 'validate-armed', deferRedHead: true }
    };

    function ptConfig(owner, repo, extraCfg) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" }' +
            (extraCfg ? ', ' + extraCfg : '') + ' };' } };
    }

    // Raw REST /pulls payload (github_list_prs serves it verbatim) — REST
    // returns NEWEST-first, the starvation order the FIFO sort repairs.
    function ptPr(n, labels, body) {
        return { number: n, state: 'open', draft: false, body: body || '',
                 head: { sha: 'ptsha' + n, ref: 'feat/pt-' + n },
                 base: { sha: 'ptbase0' },
                 labels: (labels || []).map(function (l) { return { name: l }; }),
                 user: { login: 'ai-teammate' } };
    }

    // Every workflow-runs probe (dispatched-state, race guard, cancel
    // scan) sees an empty list — nothing in flight anywhere, arm proceeds.
    function ptRunsCli(cmd) {
        if (cmd.command.indexOf('/runs') !== -1) {
            return JSON.stringify({ workflow_runs: [] });
        }
        return '';
    }

    function ptArmed(sm) {
        return sm.capturedPrLabelAdds.filter(function (a) {
            return a.labels.indexOf('ai_validating') !== -1;
        }).map(function (a) { return a.number; });
    }

    function ptDispatched(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh workflow run') === 0; });
    }

    function ptRun(opts) {
        var sm = makeSmAgent(Object.assign(ptConfig('a', 'b', opts.cfg), {
            captureConsole: true,
            github: Object.assign({ realSource: true,
                prStatus: { state: 'OPEN', checkConclusion: 'none', mergeState: 'CLEAN',
                            mergeable: true, headSha: 'ptsha302', branch: 'feat/pt-302' } },
                opts.github || {}),
            onCliExecute: ptRunsCli
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
                                 rules: [RULES_PT.armed] } });
        return sm;
    }

    test('blocker jumps FIFO: a younger priority_blocker takes the arm slot over an older medium', function () {
        var sm = ptRun({ github: { prList: JSON.stringify([
            ptPr(302, ['pr_approved', 'priority_blocker']), // younger, blocker
            ptPr(301, ['pr_approved'])                      // older, medium
        ]) } });

        assert.deepEqual(ptArmed(sm), [302],
            'the BLOCKER is armed — the older medium yields the validation slot');
        assert.ok(ptDispatched(sm.capturedCliCommands), 'validation CI dispatched for the blocker');
        assert.ok(sm.capturedLogs.some(function (l) {
            return l.indexOf('\uD83E\uDD47') !== -1 && l.indexOf('pr-302') !== -1;
        }), 'the \uD83E\uDD47 preemption line names the preempting PR (grep-able in tick logs)');
    });

    test('low sinks: an older priority_low waits while a younger medium arms first', function () {
        var sm = ptRun({ github: { prList: JSON.stringify([
            ptPr(302, ['pr_approved']),                       // younger, medium
            ptPr(301, ['pr_approved', 'priority_low'])        // older, low
        ]) } });

        assert.deepEqual(ptArmed(sm), [302],
            'low sinks below ALL mediums — age never lifts it past one');
        assert.ok(ptDispatched(sm.capturedCliCommands), 'the medium\'s validation dispatched');
        assert.ok(!sm.capturedLogs.some(function (l) {
            return l.indexOf('\uD83E\uDD47') !== -1;
        }), 'no preemption marker — only blockers preempt');
    });

    test('issue carrier: priority_blocker on the LINKED ISSUE counts (either carrier)', function () {
        var lookups = [];
        var sm = ptRun({ github: {
            prList: JSON.stringify([
                ptPr(302, ['pr_approved'], 'Closes #55'), // no PR-side priority label
                ptPr(301, ['pr_approved'])
            ]),
            issues: { 55: { number: 55, state: 'open',
                            labels: [{ name: 'priority_blocker' }] } },
            onIssueLookup: function (n) { lookups.push(n); }
        } });

        assert.deepEqual(ptArmed(sm), [302],
            'the blocker label on the linked issue promotes the PR the same as a PR-side label');
        assert.deepEqual(lookups, [55],
            'the linked issue was read exactly once (per-tick cache, PR-side medium needs no fetch)');
        assert.ok(sm.capturedLogs.some(function (l) {
            return l.indexOf('\uD83E\uDD47') !== -1 && l.indexOf('pr-302') !== -1;
        }), 'the preemption marker fires for the issue-carrier blocker too');
    });

    test('custom mapping: smPriorityLabels {blocker:"sev1"} — sev1 preempts, the default name stops', function () {
        var sm = ptRun({
            cfg: 'smPriorityLabels: { blocker: "sev1" }',
            github: { prList: JSON.stringify([
                ptPr(303, ['pr_approved', 'sev1']),            // youngest, custom blocker
                ptPr(302, ['pr_approved', 'priority_blocker']), // default name — inert after remap
                ptPr(301, ['pr_approved'])                      // oldest, medium
            ]) }
        });

        assert.deepEqual(ptArmed(sm), [303],
            'sev1 (custom blocker name) preempts; priority_blocker is no longer a tier label');
        assert.ok(!ptArmed(sm).some(function (n) {
            return n === 302 || n === 301;
        }), 'the mediums stay FIFO-queued behind the remapped blocker');
    });

    test('no labels anywhere: every PR is medium — plain FIFO untouched (older arms first)', function () {
        var sm = ptRun({ github: { prList: JSON.stringify([
            ptPr(302, ['pr_approved']),
            ptPr(301, ['pr_approved'])
        ]) } });

        assert.deepEqual(ptArmed(sm), [301],
            'no priority label on any carrier — the 2026-09-22 FIFO rule picks the OLDEST');
        assert.ok(ptDispatched(sm.capturedCliCommands), 'the older medium\'s validation dispatched');
        assert.ok(!sm.capturedLogs.some(function (l) {
            return l.indexOf('\uD83E\uDD47') !== -1;
        }), 'no preemption marker without a blocker');
    });
});

suite('smAgent: stamp check-run deep links (owner 2026-09-27)', function () {
    // Owner complaint (live on fa PR checks): bridge stamp check-runs
    // concluded with 'This check concluded as success' + the generic
    // 'View more details on GitHub Actions' — no clickable path to the real
    // workflow run/job. The stamp now carries details_url (failing job on
    // red, umbrella run otherwise) + a markdown jobs table in the summary.

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    // A github PR rule whose query matches nothing — the validation-sync
    // hook (which drives the verdict stamp) runs before the source query.
    function syncOnlyRule() {
        return { source: 'github', query: { type: 'pr', labels: ['no-such-label-xyz'] },
                 localAction: 'validate_pr', limit: 1, id: 'validate-armed' };
    }

    function armedPrList() {
        return JSON.stringify([{ number: 90, head: { sha: 'shaA', ref: 'feat/a' },
                                 labels: [{ name: 'ai_validating' }] }]);
    }

    function concludedRun(conclusion) {
        return [{ id: 777, event: 'workflow_dispatch', head_sha: 'shaA',
                  status: 'completed', conclusion: conclusion,
                  html_url: 'https://github.com/a/b/actions/runs/777',
                  path: '.github/workflows/quality.yml' }];
    }

    function stampPosts(sm) {
        return sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('check-runs') !== -1 && c.command.indexOf('POST') !== -1;
        }).map(function (c) { return c.command; });
    }

    function jobsCli(jobs) {
        return function (cmd) {
            if (cmd.command.indexOf('/actions/runs/777/jobs') !== -1) {
                return JSON.stringify({ jobs: jobs });
            }
            return '';
        };
    }

    test('verdict stamp (green): details_url = umbrella run + markdown jobs table in the summary', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [],
                prList: armedPrList(),
                workflowApiRuns: concludedRun('success')
            },
            onCliExecute: jobsCli([
                { name: 'Quality gate', status: 'completed', conclusion: 'success',
                  html_url: 'https://github.com/a/b/actions/runs/777/jobs/11' },
                { name: 'sm-liveness', status: 'completed', conclusion: 'success',
                  html_url: 'https://github.com/a/b/actions/runs/777/jobs/12' }
            ])
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
            validationChecks: '["Quality gate","sm-liveness"]', rules: [syncOnlyRule()] } });

        var posts = stampPosts(sm);
        assert.equal(posts.length, 2, 'one stamped check per configured validation check name');
        posts.forEach(function (p) {
            assert.ok(p.indexOf('-f details_url="https://github.com/a/b/actions/runs/777"') !== -1,
                'green verdict links the umbrella dispatched run');
            assert.ok(p.indexOf('| [Quality gate](https://github.com/a/b/actions/runs/777/jobs/11) | success |') !== -1,
                'summary carries the real jobs table (name → result → link)');
            assert.ok(p.indexOf('| [sm-liveness](https://github.com/a/b/actions/runs/777/jobs/12) | success |') !== -1,
                'every job is listed');
        });
    });

    test('verdict stamp (red): details_url = the FAILING JOB directly', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [],
                prList: armedPrList(),
                workflowApiRuns: concludedRun('failure')
            },
            onCliExecute: jobsCli([
                { name: 'Quality gate', status: 'completed', conclusion: 'failure',
                  html_url: 'https://github.com/a/b/actions/runs/777/jobs/21' },
                { name: 'sm-liveness', status: 'completed', conclusion: 'success',
                  html_url: 'https://github.com/a/b/actions/runs/777/jobs/22' }
            ])
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
            validationChecks: '["Quality gate","sm-liveness"]', rules: [syncOnlyRule()] } });

        var posts = stampPosts(sm);
        assert.equal(posts.length, 2);
        posts.forEach(function (p) {
            assert.ok(p.indexOf('-f details_url="https://github.com/a/b/actions/runs/777/jobs/21"') !== -1,
                'red verdict lands the reviewer on the failing job, not the umbrella');
            assert.ok(p.indexOf('-f conclusion="failure"') !== -1);
            assert.ok(p.indexOf('| [Quality gate](https://github.com/a/b/actions/runs/777/jobs/21) | failure |') !== -1,
                'the jobs table shows which job went red');
        });
    });

    test('verdict stamp: jobs probe failure degrades to the plain run link — never loses the stamp', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [],
                prList: armedPrList(),
                workflowApiRuns: concludedRun('success')
            },
            onCliExecute: function () { return ''; } // jobs endpoint unreadable
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
            validationChecks: '["Quality gate"]', rules: [syncOnlyRule()] } });

        var posts = stampPosts(sm);
        assert.equal(posts.length, 1, 'the stamp still posts');
        assert.ok(posts[0].indexOf('-f details_url="https://github.com/a/b/actions/runs/777"') !== -1,
            'details_url falls back to the dispatched run');
        assert.ok(posts[0].indexOf('Dispatched run: https://github.com/a/b/actions/runs/777') !== -1,
            'summary keeps at least the run link');
    });

    test('dispatch-time in_progress stamp: no run known yet — no details_url, legacy summary', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [{ key: 'pr-91', labels: ['pr_approved'], issueNumber: null,
                                prNumber: 91, draft: false, branch: 'feat/b', headSha: 'shaB' }] }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
            validationChecks: '["Quality gate"]',
            rules: [{ source: 'github', query: { type: 'pr', labels: ['pr_approved'], draft: false },
                      localAction: 'validate_pr', limit: 1, id: 'validate-armed' }] } });

        var posts = stampPosts(sm);
        assert.equal(posts.length, 1, 'dispatch stamps in_progress once');
        assert.ok(posts[0].indexOf('in_progress') !== -1);
        assert.ok(posts[0].indexOf('details_url') === -1,
            'no run URL exists at dispatch time — nothing to link yet (the verdict stamp adds it)');
        assert.ok(posts[0].indexOf('Stamped by the SM tick (bridge-free mode).') !== -1);
    });
});

suite('smAgent: ticket dispatch', function() {

    test('triggers workflow for each ticket found', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [
                { key: 'P-1', fields: { labels: [] } },
                { key: 'P-2', fields: { labels: [] } },
                { key: 'P-3', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'")
        ]));

        assert.equal(sm.capturedTriggers.length, 3, 'one trigger per ticket');
        assert.equal(sm.capturedTriggers[0].owner, 'o');
        assert.equal(sm.capturedTriggers[0].workflow, 'ai-teammate.yml');
    });

    test('global maxTriggeredWorkflows caps dispatches across all rules', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [
                { key: 'P-1', fields: { labels: [] } },
                { key: 'P-2', fields: { labels: [] } },
                { key: 'P-3', fields: { labels: [] } }
            ]
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'"),
            makeRule("project = {jiraProject} AND status = 'In Review'")
        ]);
        params.jobParams.maxTriggeredWorkflows = 1;

        sm.action(params);

        assert.equal(sm.capturedTriggers.length, 1, 'only one workflow dispatch allowed for whole run');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.concurrency_key, 'P-1', 'first ticket dispatched, others deferred');
    });

    test('global maxTriggeredWorkflows counts already active workflows before dispatch', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [
                { key: 'P-1', fields: { labels: [] } }
            ],
            workflowRuns: {
                in_progress: [
                    { id: 1001, name: 'agents/bug_development.json : bug_development', status: 'in_progress' }
                ]
            }
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'", {
                addLabel: 'sm_bulk_bugs_creation_triggered',
                targetStatus: 'Bug Creation'
            })
        ]);
        params.jobParams.maxTriggeredWorkflows = 1;

        sm.action(params);

        assert.equal(sm.capturedTriggers.length, 0, 'active workflow consumes the only global slot');
        assert.equal(sm.capturedLabels.length, 0, 'trigger label must not be added when cap is full');
        assert.equal(sm.capturedStatusMoves.length, 0, 'ticket should not move when no workflow slot is available');
    });

    test('global maxTriggeredWorkflows ignores stale queued workflows before dispatch', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [
                { key: 'P-1', fields: { labels: [] } }
            ],
            workflowRuns: {
                queued: [
                    {
                        id: 1002,
                        name: 'AI Teammate',
                        status: 'queued',
                        created_at: '2020-01-01T00:00:00Z',
                        updated_at: '2020-01-01T00:00:00Z'
                    }
                ]
            }
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'")
        ]);
        params.jobParams.maxTriggeredWorkflows = 1;

        sm.action(params);

        assert.equal(sm.capturedTriggers.length, 1, 'stale queued workflow should not consume the global slot');
    });

    test('maxWorkflowsPerRun alias also limits dispatches', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [
                { key: 'P-1', fields: { labels: [] } },
                { key: 'P-2', fields: { labels: [] } }
            ]
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'")
        ]);
        params.jobParams.maxWorkflowsPerRun = 1;

        sm.action(params);

        assert.equal(sm.capturedTriggers.length, 1, 'alias field limits dispatches');
    });

    test('encodes ticket key in triggered workflow inputs', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-42', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { configFile: 'agents/story_development.json' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.concurrency_key, 'P-42', 'concurrency key set to ticket key');
        assert.equal(inputs.display_key, 'P-42', 'workflow display key set to ticket key');
        assert.equal(inputs.input_jql, 'key = P-42', 'workflow input JQL set to ticket key');
        assert.equal(inputs.config_file, 'agents/story_development.json', 'config_file passed');
        assert.ok(inputs.encoded_config, 'encoded_config present');

        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.contains(decoded.params.inputJql, 'P-42', 'ticket key in inputJql');
    });

    test('uses rule concurrencyKey override while preserving ticket inputJql', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-42', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/bulk_bugs_creation.json',
                concurrencyKey: 'bulk_bugs_creation'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.concurrency_key, 'bulk_bugs_creation', 'rule concurrency key used');
        assert.equal(inputs.display_key, 'P-42', 'workflow display key preserves ticket key');
        assert.equal(inputs.input_jql, 'key = P-42', 'workflow input JQL remains ticket-specific');

        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.contains(decoded.params.inputJql, 'P-42', 'ticket key still used for agent input');
    });

    test('interpolates project placeholders from target agent params into encoded config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = { jira: { project: "DMC", parentTicket: "DMC-101" }, repository: { owner: "o", repo: "r" } };',
                'agents/test_cases_generator.json': JSON.stringify({
                    name: 'TestCasesGenerator',
                    params: {
                        existingTestCasesJql: "project = {jiraProject} AND issuetype = 'Test Case'",
                        relatedStoriesJql: "parent = {parentTicket}"
                    }
                })
            },
            tickets: [{ key: 'DMC-857', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { configFile: 'agents/test_cases_generator.json' })
        ]));

        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.equal(decoded.params.existingTestCasesJql, "project = DMC AND issuetype = 'Test Case'");
        assert.equal(decoded.params.relatedStoriesJql, 'parent = DMC-101');
    });

    test('no triggers when no tickets found', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: []
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}")
        ]));

        assert.equal(sm.capturedTriggers.length, 0);
    });

    test('uses workflowFile from rule when provided', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule('project = X', {
                workflowFile: 'custom-workflow.yml',
                workflowRef: 'develop'
            })
        ]));

        assert.equal(sm.capturedTriggers[0].workflow, 'custom-workflow.yml');
        assert.equal(sm.capturedTriggers[0].ref, 'develop');
    });

    test('workflowRef {branch} placeholder dispatches on the PR head (PR-linked runs)', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js':
                'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: { items: [{ key: 'pr-42', labels: ['pr_approved'], issueNumber: null,
                                prNumber: 42, draft: false, branch: 'ai/gh-42' }] }
        });

        sm.action({ jobParams: { owner: 'epam', repo: 'dmtools-dart', rules: [
            makeRule('project = X', { source: 'github', id: 'review-after-dev-test',
              query: { type: 'pr', labels: ['pr_approved'], draft: false },
              inputs: { pr: '{prNumber}', leg: 'review' },
              workflowRef: '{branch}' })
        ] } });

        if (!sm.capturedTriggers.length) throw new Error('NO TRIGGER CAPTURED');
        assert.equal(sm.capturedTriggers[0].ref, 'ai/gh-42',
            '{branch} must expand to the item head ref so the run links to the PR');
    });

    test('workflowRef {branch} falls back to main when the item has no branch', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js':
                'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: { items: [{ key: 'pr-43', labels: ['pr_approved'], issueNumber: null,
                                prNumber: 43, draft: false }] }
        });

        sm.action({ jobParams: { owner: 'epam', repo: 'dmtools-dart', rules: [
            makeRule('project = X', { source: 'github', id: 'review-after-dev-test',
              query: { type: 'pr', labels: ['pr_approved'], draft: false },
              inputs: { pr: '{prNumber}', leg: 'review' },
              workflowRef: '{branch}' })
        ] } });

        if (!sm.capturedTriggers.length) throw new Error('NO TRIGGER CAPTURED (fallback)');
        assert.equal(sm.capturedTriggers[0].ref, 'main',
            'empty expansion must fall back to main, never dispatch on an empty ref');
    });

    test('skips dispatch when matching workflow is already active', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-42', fields: { labels: [] } }],
            workflowRuns: {
                in_progress: [
                    { name: 'agents/pr_rework.json : P-42', status: 'in_progress' }
                ]
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/pr_rework.json',
                addLabel: 'sm_story_rework_triggered'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 0, 'duplicate active workflow should not be dispatched');
        assert.equal(sm.capturedLabels.length, 0, 'skip label should not be added for skipped duplicate');
    });

    test('skips dispatch when a stub-titled GitHub run is in flight (display_title precedence)', function() {
        // Live bug (gh-702 review dispatched twice): the workflow-runs API
        // returns name='AI Teammate' (the WORKFLOW name) and display_title
        //='▶ review (SM) · gh-42' — name-first made the stub-title match
        // dead code, so the in-flight run never suppressed the next tick.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-42', fields: { labels: [] } }],
            workflowRuns: {
                in_progress: [
                    { name: 'AI Teammate', display_title: '▶ review (SM) · P-42', status: 'in_progress' }
                ]
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/pr_rework.json',
                addLabel: 'sm_story_rework_triggered'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 0, 'in-flight stub-titled run must suppress the re-dispatch');
    });

    test('in-flight guard resolves the scm against the TARGET repo, not the engine checkout', function() {
        // Live bug (flutter_agent_harness gh-691 review dispatched twice):
        // the rule config carried no repository, so createScm fell back to
        // git-remote autodetect — the ENGINE checkout (IstiN/dmtools-agents)
        // — and the guard listed workflow runs in the wrong repo, never
        // seeing the in-flight review in flutter_agent_harness.
        // createTargetScm pins every scm client to the rule's effective repo.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" } };' },
            tickets: [{ key: 'P-42', fields: { labels: [] } }],
            workflowRuns: {
                in_progress: [
                    { name: 'AI Teammate', display_title: '▶ review (SM) · P-42', status: 'in_progress' }
                ]
            }
        });

        sm.action(baseParams('target-org', 'target-repo', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/pr_rework.json',
                addLabel: 'sm_story_rework_triggered'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 0, 'in-flight run suppresses the re-dispatch');
        assert.ok(sm.capturedScmConfigs.length > 0, 'scm client was created');
        sm.capturedScmConfigs.forEach(function(cfg) {
            assert.ok(cfg && cfg.repository, 'every createScm config carries repository');
            assert.equal(cfg.repository.owner, 'target-org', 'guard lists runs in the TARGET org');
            assert.equal(cfg.repository.repo, 'target-repo', 'guard lists runs in the TARGET repo');
        });
    });

});

// ── localTeammate execution mode ────────────────────────────────────────────

// runTeammateLocally() issues two cli_execute_command calls per ticket: the actual
// run-teammate-local.sh invocation, plus a best-effort `rm -f` cleanup of the temp
// encoded-config file. Filter to just the script invocations for assertions below.
function localRunCommands(sm) {
    return sm.capturedCliCommands.filter(function(c) {
        return c.command.indexOf('run-teammate-local.sh') !== -1;
    });
}

suite('smAgent: localTeammate execution mode', function() {

    test('runs local script instead of dispatching a workflow', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'", {
                configFile: 'agents/story_development.json',
                localTeammate: true
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 0, 'no GitHub Actions workflow should be dispatched');
        var runs = localRunCommands(sm);
        assert.equal(runs.length, 1, 'exactly one local run invoked');
        var cmd = runs[0].command;
        assert.ok(cmd.indexOf('scripts/run-teammate-local.sh') !== -1, 'invokes run-teammate-local.sh');
        assert.ok(cmd.indexOf('--config-file agents/story_development.json') !== -1, 'passes config file');
        assert.ok(cmd.indexOf('--ticket P-1') !== -1, 'passes ticket key');
    });

    test('passes --base-branch from config.git.baseBranch (e.g. repos defaulting to master)', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" }, git: { baseBranch: "master" } };'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'", {
                configFile: 'agents/story_development.json',
                localTeammate: true
            })
        ]));

        var runs = localRunCommands(sm);
        assert.equal(runs.length, 1, 'exactly one local run invoked');
        assert.ok(runs[0].command.indexOf('--base-branch master') !== -1,
            'passes the project-configured base branch instead of silently defaulting to "main"');
    });

    test('adds rule labels after a successful local run', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };',
                // Stub the target config without a matching removeLabel so
                // ruleTargetSelfManagesLabel() is false and the label IS
                // re-added after the local run (hermetic — no disk read).
                'agents/story_development.json': JSON.stringify({
                    params: { customParams: {} }
                })
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/story_development.json',
                localTeammate: true,
                addLabel: 'sm_story_development_triggered'
            })
        ]));

        assert.equal(sm.capturedLabels.length, 1);
        assert.equal(sm.capturedLabels[0].label, 'sm_story_development_triggered');
    });

    test('does not add rule labels when the local run throws', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-1', fields: { labels: [] } }],
            onCliExecute: function() { throw new Error('script failed'); }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/story_development.json',
                localTeammate: true,
                addLabel: 'sm_story_development_triggered'
            })
        ]));

        assert.equal(sm.capturedLabels.length, 0, 'no label added when the local run fails');
    });

    // Regression test for a real production bug: pr_review.json/pr_rework.json's own
    // postJSAction removes its addLabel (sm_story_review_triggered / sm_story_rework_triggered)
    // as part of completing, to let a ticket cycle between In Review <-> In Rework. Since
    // runTeammateLocally() runs that entire job synchronously, re-adding the label afterward
    // would immediately undo that cleanup and permanently stick the ticket (no stale-label
    // recovery exists for local rules) — this is exactly what happened to SOHO-131.
    test('does not re-add the label after a local run when the target job self-manages it', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };',
                'agents/pr_review.json': JSON.stringify({
                    params: { customParams: { removeLabel: 'sm_story_review_triggered' } }
                })
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/pr_review.json',
                localTeammate: true,
                addLabel: 'sm_story_review_triggered'
            })
        ]));

        assert.equal(sm.capturedLabels.length, 0,
            'smAgent must not re-add a label the target job manages/removes itself');
    });

    test('does not re-add any addLabels when the target job self-manages one of them via removeLabels', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };',
                'agents/pr_rework.json': JSON.stringify({
                    params: { customParams: { removeLabels: ['sm_story_rework_triggered', 'sm_story_review_triggered'] } }
                })
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/pr_rework.json',
                localTeammate: true,
                addLabel: 'sm_story_rework_triggered'
            })
        ]));

        assert.equal(sm.capturedLabels.length, 0,
            'smAgent must not re-add sm_story_rework_triggered either, since pr_rework.json manages it');
    });

    test('still adds the label for a non-self-managing local rule (unaffected by the self-managing check)', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };',
                'agents/story_solution.json': JSON.stringify({ params: { customParams: {} } })
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/story_solution.json',
                localTeammate: true,
                addLabel: 'sm_story_solution_triggered'
            })
        ]));

        assert.equal(sm.capturedLabels.length, 1, 'label is still added when the target job does not self-manage it');
        assert.equal(sm.capturedLabels[0].label, 'sm_story_solution_triggered');
    });

    test('respects skipIfLabel without checking GitHub Actions run state', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-1', fields: { labels: ['sm_story_development_triggered'] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/story_development.json',
                localTeammate: true,
                skipIfLabel: 'sm_story_development_triggered'
            })
        ]));

        assert.equal(localRunCommands(sm).length, 0, 'labelled ticket should be skipped, not run locally');
    });

    test('processes tickets one at a time regardless of maxTriggeredWorkflows', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [
                { key: 'P-1', fields: { labels: [] } },
                { key: 'P-2', fields: { labels: [] } },
                { key: 'P-3', fields: { labels: [] } }
            ]
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/story_development.json',
                localTeammate: true
            })
        ]);
        // A tight global cap must not throttle localTeammate rules — they run
        // synchronously in-process, so there is no outstanding-workflow budget to spend.
        params.jobParams.maxTriggeredWorkflows = 1;

        var result = sm.action(params);

        assert.equal(localRunCommands(sm).length, 3, 'all three tickets should run locally, uncapped');
        assert.equal(result.processed, 3);
    });

    test('writes the encoded config to a temp file and passes its path', function() {
        var writtenFiles = [];
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-7', fields: { labels: [] } }],
            onFileWrite: function(writeOpts) { writtenFiles.push(writeOpts); }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/story_development.json',
                localTeammate: true
            })
        ]));

        assert.equal(writtenFiles.length, 1, 'encoded config should be written once');
        assert.ok(writtenFiles[0].path.indexOf('P-7') !== -1, 'temp file name includes the ticket key');
        var cmd = sm.capturedCliCommands[0].command;
        assert.ok(cmd.indexOf('--encoded-config-file') !== -1, 'passes the encoded config file path');
    });

});

suite('smAgent: forceLocalTeammate CLI override', function() {

    test('switches a default-dispatch rule to local execution', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'", {
                configFile: 'agents/story_development.json'
            })
        ]);
        params.jobParams.forceLocalTeammate = true;

        sm.action(params);

        assert.equal(sm.capturedTriggers.length, 0, 'no GitHub Actions workflow should be dispatched');
        assert.equal(localRunCommands(sm).length, 1, 'rule runs locally instead of dispatching');
    });

    test('leaves localExecution:true rules untouched', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };',
                'agents/test.json': MINIMAL_AGENT_CONFIG
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { localExecution: true })
        ]);
        params.jobParams.forceLocalTeammate = true;

        sm.action(params);

        assert.equal(localRunCommands(sm).length, 0, 'localExecution rules do not go through run-teammate-local.sh');
        assert.equal(sm.capturedTriggers.length, 0, 'localExecution rules never dispatch either');
    });

    test('respects an explicit localTeammate:false opt-out', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configFile: 'agents/story_development.json',
                localTeammate: false
            })
        ]);
        params.jobParams.forceLocalTeammate = true;

        sm.action(params);

        assert.equal(localRunCommands(sm).length, 0, 'opted-out rule must not run locally');
        assert.equal(sm.capturedTriggers.length, 1, 'opted-out rule dispatches as normal');
    });

    test('is a no-op when not set (default remote dispatch)', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        var params = baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { configFile: 'agents/story_development.json' })
        ]);
        // forceLocalTeammate intentionally omitted

        sm.action(params);

        assert.equal(sm.capturedTriggers.length, 1, 'default behavior still dispatches to GitHub Actions');
        assert.equal(localRunCommands(sm).length, 0);
    });

});

// ── localExecution module loading ─────────────────────────────────────────────

suite('smAgent: localExecution module loading', function() {

    test('local post action can require common/scm.js', function() {
        var sm = makeSmAgent({
            fileMap: {
                'agents/local_scm_test.json': JSON.stringify({
                    name: 'JSRunner',
                    params: {
                        postJSAction: 'js/unit-tests/_fixtures/local_scm_check.js'
                    }
                }),
                'js/unit-tests/_fixtures/local_scm_check.js':
                    'var scmModule = require("./common/scm.js");\n' +
                    'function action(params) {\n' +
                    '  if (!scmModule || typeof scmModule.createScm !== "function") throw new Error("createScm missing");\n' +
                    '  return { success: true, action: "scm ok" };\n' +
                    '}\n' +
                    'module.exports = { action: action };'
            },
            tickets: [{ key: 'T-1', fields: { labels: [] } }],
            fullTicket: { key: 'T-1', fields: { labels: [], summary: 'Ticket' } }
        });

        var result = sm.action(baseParams('o', 'r', [
            makeRule('project = X', {
                configFile: 'agents/local_scm_test.json',
                localExecution: true
            })
        ]));

        assert.equal(result.processed, 1, 'local action processed ticket');
        assert.deepEqual(result.processedKeys, ['T-1']);
    });

});

// ── skipIfLabel ───────────────────────────────────────────────────────────────

suite('smAgent: skipIfLabel', function() {

    test('skips ticket that already has the label', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-1', fields: { labels: ['sm_triggered'] } },
                { key: 'T-2', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { skipIfLabel: 'sm_triggered' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1, 'only T-2 triggered');
        assert.equal(sm.capturedTriggers[0].owner, 'o');
        // Check which ticket was triggered
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.contains(inputs.encoded_config, 'T-2', 'T-2 was triggered, not T-1');
    });

    test('adds label after successful trigger', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-10', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { addLabel: 'sm_dev_triggered' })
        ]));

        assert.equal(sm.capturedLabels.length, 1);
        assert.equal(sm.capturedLabels[0].key, 'T-10');
        assert.equal(sm.capturedLabels[0].label, 'sm_dev_triggered');
    });

    test('does not recover trigger label when explicitly disabled', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-1', fields: { labels: ['sm_triggered'] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", {
                skipIfLabel: 'sm_triggered',
                addLabel: 'sm_triggered',
                recoverStaleTriggerLabel: false
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 0, 'no trigger for skipped ticket');
        assert.equal(sm.capturedLabels.length, 0, 'no label added for skipped ticket');
    });

    test('recovers stale trigger label by default when no active workflow exists', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-1', fields: { labels: ['sm_triggered'] } }
            ],
            workflowRuns: {
                queued: [],
                in_progress: []
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", {
                skipIfLabel: 'sm_triggered',
                addLabel: 'sm_triggered'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 1, 'stale label should not deadlock ticket');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.contains(inputs.encoded_config, 'T-1', 'T-1 was retriggered');
    });

    test('uses shared concurrencyKey when checking active workflow for stale label recovery', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-1', fields: { labels: ['sm_bulk_bugs_creation_triggered'] } }
            ],
            workflowRuns: {
                queued: [
                    {
                        display_title: 'agents/bulk_bugs_creation.json : T-1 : bulk_bugs_creation',
                        status: 'queued'
                    }
                ],
                in_progress: []
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", {
                configFile: 'agents/bulk_bugs_creation.json',
                concurrencyKey: 'bulk_bugs_creation',
                skipIfLabel: 'sm_bulk_bugs_creation_triggered',
                addLabel: 'sm_bulk_bugs_creation_triggered',
                recoverStaleTriggerLabel: true
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 0, 'active shared-concurrency run should prevent relaunch');
    });

    test('skips ticket that has any skipIfLabels entry', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'TOLD-1', fields: { labels: ['sm_story_acceptance_criterias_triggered'] } },
                { key: 'TNEW-2', fields: { labels: ['sm_story_acceptance_criteria_triggered'] } },
                { key: 'TOPEN-3', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", {
                skipIfLabels: [
                    'sm_story_acceptance_criteria_triggered',
                    'sm_story_acceptance_criterias_triggered'
                ]
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 1, 'only unlabeled ticket triggered');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.contains(inputs.encoded_config, 'TOPEN-3', 'TOPEN-3 was triggered');
    });

    test('adds all configured addLabels after successful trigger', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-20', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", {
                addLabel: 'primary_label',
                addLabels: ['secondary_label']
            })
        ]));

        assert.equal(sm.capturedLabels.length, 2);
        assert.equal(sm.capturedLabels[0].label, 'primary_label');
        assert.equal(sm.capturedLabels[1].label, 'secondary_label');
    });

    // The self-managing skip only applies to localTeammate (synchronous) rules — for the
    // async workflow_dispatch path the label really is the only in-flight guard (the actual
    // job runs later on a GitHub Actions runner and clears it on completion), so it must
    // still be added right after a successful dispatch even if the target config also
    // happens to declare a matching removeLabel.
    test('still adds the label after an async dispatch even if the target config declares a matching removeLabel', function() {
        var sm = makeSmAgent({
            fileMap: {
                'agents/pr_review.json': JSON.stringify({
                    params: { customParams: { removeLabel: 'sm_story_review_triggered' } }
                })
            },
            tickets: [{ key: 'T-21', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", {
                configFile: 'agents/pr_review.json',
                addLabel: 'sm_story_review_triggered'
            })
        ]));

        assert.equal(sm.capturedLabels.length, 1,
            'async dispatch must still add its idempotency label regardless of the self-managing check');
    });

});

// ── Rule enabled flag ─────────────────────────────────────────────────────────

suite('smAgent: rule enabled flag', function() {

    test('skips rule with enabled: false', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { enabled: false })
        ]));

        assert.equal(sm.capturedJqls.length, 0, 'JQL not executed for disabled rule');
        assert.equal(sm.capturedTriggers.length, 0);
    });

    test('runs rule with enabled: true (explicit)', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: []
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { enabled: true })
        ]));

        assert.equal(sm.capturedJqls.length, 1, 'enabled rule executed');
    });

    test('limit caps tickets processed', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-1', fields: { labels: [] } },
                { key: 'T-2', fields: { labels: [] } },
                { key: 'T-3', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { limit: 2 })
        ]));

        assert.equal(sm.capturedTriggers.length, 2, 'only 2 tickets processed (limit: 2)');
    });

    test('limit applies after skipped tickets so stale labels do not starve later tickets', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'TSKIP-1', fields: { labels: ['sm_triggered'] } },
                { key: 'TOPEN-2', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { skipIfLabel: 'sm_triggered', limit: 1 })
        ]));

        assert.equal(sm.capturedTriggers.length, 1, 'one non-skipped ticket should be triggered');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.contains(inputs.encoded_config, 'TOPEN-2', 'limit should not be consumed by skipped ticket');
    });

});

// ── additionalInstructions injection ─────────────────────────────────────────

suite('smAgent: additionalInstructions in encoded_config', function() {

    test('injects additionalInstructions from config into encoded_config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  additionalInstructions: {' +
                    '    story_development: ["https://my-wiki/pages/123", "./custom/rules.md"]' +
                    '  }' +
                    '};'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { configFile: 'agents/story_development.json' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.ok(decoded.params.additionalInstructions, 'additionalInstructions present in encoded_config');
        assert.equal(decoded.params.additionalInstructions.length, 2);
        assert.contains(decoded.params.additionalInstructions[0], 'my-wiki', 'first instruction');
    });

    test('no additionalInstructions field in encoded_config when not configured', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { configFile: 'agents/story_development.json' })
        ]));

        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.notOk(decoded.params.additionalInstructions, 'no additionalInstructions when not configured');
        assert.ok(decoded.params.agentParams, 'agentParams present');
        // The story_development agent now keeps its default instructions in cliPrompts,
        // not in agentParams.instructions, so we verify the default cliPrompts survive.
        var storyDevRaw = file_read({ path: 'agents/story_development.json' }) ||
                          file_read({ path: 'story_development.json' });
        var storyDevJson = JSON.parse(storyDevRaw);
        var defaultCliPrompts = storyDevJson.params.cliPrompts;
        assert.ok(Array.isArray(decoded.params.cliPrompts) && decoded.params.cliPrompts.length > 0,
            'default cliPrompts preserved');
        assert.deepEqual(decoded.params.cliPrompts, defaultCliPrompts,
            'default cliPrompts match the agent JSON');
    });

    test('injects cliPrompts and agent/job param patches from config into encoded_config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  cliPromptOverrides: {' +
                    '    story_development: "./.dmtools/prompts/main.md"' +
                    '  },' +
                    '  cliPrompts: {' +
                    '    story_development: ["./.dmtools/prompts/role.md", "./.dmtools/prompts/focus.md"]' +
                    '  },' +
                    '  agentParamPatches: {' +
                    '    story_development: { aiRole: "Senior Engineer", customFlag: true }' +
                    '  },' +
                    '  jobParamPatches: {' +
                    '    story_development: { confluencePages: ["./.dmtools/instructions/project.md"], isGenerateNew: false }' +
                    '  }' +
                    '};'
            },
            tickets: [{ key: 'P-2', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { configFile: 'agents/story_development.json' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.equal(decoded.params.cliPrompt, './.dmtools/prompts/main.md');
        // cliPrompts = agent JSON cliPrompts + config cliPrompts (role, focus)
        var storyDevRaw = file_read({ path: 'agents/story_development.json' }) ||
                          file_read({ path: 'story_development.json' });
        var storyDevJson = JSON.parse(storyDevRaw);
        var expectedCliPrompts = storyDevJson.params.cliPrompts.concat([
            './.dmtools/prompts/role.md',
            './.dmtools/prompts/focus.md'
        ]);
        assert.deepEqual(decoded.params.cliPrompts, expectedCliPrompts);
        assert.equal(decoded.params.agentParams.aiRole, 'Senior Engineer');
        assert.equal(decoded.params.agentParams.customFlag, true);
        assert.deepEqual(decoded.params.confluencePages, ['./.dmtools/instructions/project.md']);
        assert.equal(decoded.params.isGenerateNew, false);
    });

    test('inputJql in encoded_config is always the real ticket key, not the agent JSON placeholder', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'P-99', fields: { labels: [] } }]
        });

        // story_questions.json has inputJql: "key = JD-82" — must NOT appear in encoded_config
        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { configFile: 'agents/story_questions.json' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.equal(decoded.params.inputJql, 'key = P-99', 'inputJql must be the real ticket, not agent JSON default');
    });

    test('agentParams is always present in encoded_config (never null)', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-42', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { configFile: 'agents/story_questions.json' })
        ]));

        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.ok(decoded.params.agentParams !== null && decoded.params.agentParams !== undefined,
            'agentParams must always be present to prevent NPE in Teammate.java');
    });

    test('primitive and array params from agent JSON are copied to encoded_config', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-5', fields: { labels: [] } }]
        });

        // story_questions.json has skipAIProcessing:true, alwaysPostComments:true, cliCommands, cliPrompts
        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { configFile: 'agents/story_questions.json' })
        ]));

        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.equal(decoded.params.skipAIProcessing, true, 'skipAIProcessing copied from agent JSON');
        assert.equal(decoded.params.alwaysPostComments, true, 'alwaysPostComments copied from agent JSON');
        assert.ok(Array.isArray(decoded.params.cliCommands) && decoded.params.cliCommands.length > 0,
            'cliCommands array copied from agent JSON');
        assert.ok(Array.isArray(decoded.params.cliPrompts) && decoded.params.cliPrompts.length > 0,
            'cliPrompts array copied from agent JSON');
    });

});

// ── targetStatus ──────────────────────────────────────────────────────────────

suite('smAgent: targetStatus', function() {

    test('moves ticket to targetStatus before triggering workflow', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { targetStatus: 'In Development' })
        ]));

        assert.equal(sm.capturedStatusMoves.length, 1);
        assert.equal(sm.capturedStatusMoves[0].key, 'T-1');
        assert.equal(sm.capturedStatusMoves[0].statusName, 'In Development');
        assert.equal(sm.capturedTriggers.length, 1, 'workflow also triggered');
    });

});

// ── Per-rule configPath (multi-project) ───────────────────────────────────────

suite('smAgent: per-rule configPath (multi-project)', function() {

    test('rule with configPath uses its own jiraProject for JQL', function() {
        var sm = makeSmAgent({
            fileMap: {
                'projects/web/.dmtools/config.js':
                    'module.exports = { jira: { project: "WEB", parentTicket: "WEB-1" }, repository: { owner: "web-org", repo: "web-repo" } };'
            }
        });

        sm.action(baseParams('global-org', 'global-repo', [
            makeRule("project = {jiraProject} AND status = 'Ready'", {
                configPath: 'projects/web/.dmtools/config.js'
            })
        ]));

        assert.equal(sm.capturedJqls.length, 1);
        assert.contains(sm.capturedJqls[0], 'project = WEB', 'per-rule jiraProject used');
        assert.notContains(sm.capturedJqls[0], 'global', 'global config not used in JQL');
    });

    test('rule with configPath triggers workflow against its own repo', function() {
        var sm = makeSmAgent({
            fileMap: {
                'projects/web/.dmtools/config.js':
                    'module.exports = { jira: { project: "WEB" }, repository: { owner: "web-org", repo: "web-repo" } };'
            },
            tickets: [{ key: 'WEB-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('global-org', 'global-repo', [
            makeRule("project = {jiraProject}", {
                configPath: 'projects/web/.dmtools/config.js'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        assert.equal(sm.capturedTriggers[0].owner, 'web-org', 'web-org used for trigger');
        assert.equal(sm.capturedTriggers[0].repo, 'web-repo', 'web-repo used for trigger');
    });

    test('mixed rules: some with configPath, some using global', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = { jira: { project: "GLOBAL", parentTicket: "GLOBAL-1" }, repository: { owner: "global-org", repo: "global-repo" } };',
                'projects/mobile/.dmtools/config.js':
                    'module.exports = { jira: { project: "MOBILE" }, repository: { owner: "mobile-org", repo: "mobile-repo" } };'
            }
        });

        sm.action(baseParams('global-org', 'global-repo', [
            makeRule("project = {jiraProject} AND status = 'Backlog'"),
            makeRule("project = {jiraProject} AND status = 'Ready'", {
                configPath: 'projects/mobile/.dmtools/config.js'
            })
        ]));

        assert.equal(sm.capturedJqls.length, 2);
        assert.contains(sm.capturedJqls[0], 'project = GLOBAL', 'global rule uses global config');
        assert.contains(sm.capturedJqls[1], 'project = MOBILE', 'per-rule config used for mobile');
    });

    test('per-rule configPath is propagated to encoded_config customParams', function() {
        var sm = makeSmAgent({
            fileMap: {
                'projects/web/.dmtools/config.js':
                    'module.exports = { jira: { project: "WEB" }, repository: { owner: "web-org", repo: "web-repo" } };'
            },
            tickets: [{ key: 'WEB-5', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configPath: 'projects/web/.dmtools/config.js'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.ok(decoded.params.customParams, 'customParams present');
        assert.equal(decoded.params.customParams.configPath, 'projects/web/.dmtools/config.js',
            'configPath propagated downstream');
    });

    test('rule with configPath that fails to load falls back to global config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "GLOBAL" }, repository: { owner: "g-org", repo: "g-repo" } };'
            }
        });

        sm.action(baseParams('g-org', 'g-repo', [
            makeRule("project = {jiraProject}", {
                configPath: 'nonexistent/path/config.js'  // doesn't exist in fileMap
            })
        ]));

        assert.equal(sm.capturedJqls.length, 1);
        assert.contains(sm.capturedJqls[0], 'project = GLOBAL', 'falls back to global when configPath fails');
    });

});

// ── agentConfigsDir — config.js owns agent paths ─────────────────────────────

suite('smAgent: agentConfigsDir (config.js owns agent paths)', function() {

    test('short configFile resolved against agentConfigsDir', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  agentConfigsDir: "projects/demo",' +
                    '  smRules: [{ jql: "project = {jiraProject}", configFile: "StoryAgent.json" }]' +
                    '};'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [])); // rules from config (smRules override)

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.config_file, 'projects/demo/StoryAgent.json',
            'short configFile prefixed with agentConfigsDir');
    });

    test('full configFile path (contains "/") is NOT modified by agentConfigsDir', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  agentConfigsDir: "projects/demo",' +
                    '  smRules: [{ jql: "project = {jiraProject}", configFile: "agents/story_development.json" }]' +
                    '};'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', []));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.config_file, 'agents/story_development.json',
            'full path left unchanged');
    });

    test('agentConfigsDir config discovery: sm.json can use agentConfigsDir instead of configPath', function() {
        var sm = makeSmAgent({
            fileMap: {
                'projects/alpha/.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "ALPHA" },' +
                    '  repository: { owner: "test-org", repo: "alpha-repo" },' +
                    '  agentConfigsDir: "projects/alpha",' +
                    '  smRules: [{ jql: "project = {jiraProject}", configFile: "StoryAgent.json" }]' +
                    '};'
            },
            tickets: [{ key: 'ALPHA-5', fields: { labels: [] } }]
        });

        // sm.json passes agentConfigsDir instead of configPath — no configPath needed
        sm.action({ jobParams: { agentConfigsDir: 'projects/alpha' } });

        assert.equal(sm.capturedTriggers.length, 1);
        assert.equal(sm.capturedTriggers[0].owner, 'test-org');
        assert.equal(sm.capturedTriggers[0].repo, 'alpha-repo');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.contains(sm.capturedJqls[0], 'project = ALPHA', 'ALPHA project from config');
        assert.equal(inputs.config_file, 'projects/alpha/StoryAgent.json',
            'short configFile resolved to full path');
    });

    test('agentConfigsDir trailing slash is stripped', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  agentConfigsDir: "projects/demo/",' + // trailing slash
                    '  smRules: [{ jql: "project = {jiraProject}", configFile: "ReviewAgent.json" }]' +
                    '};'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', []));

        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.config_file, 'projects/demo/ReviewAgent.json',
            'no double slash from trailing agentConfigsDir slash');
    });

});

// ── Targeted mode ─────────────────────────────────────────────────────────────

suite('smAgent: targeted mode', function() {

    test('targetTicket + targetAgent bypasses all rules and dispatches exactly that ticket', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "JD" }, repository: { owner: "o", repo: "r" } };'
            },
            tickets: [{ key: 'JD-123', fields: { labels: [] } }]
        });

        sm.action({
            jobParams: {
                targetTicket: 'JD-123',
                targetAgent: 'agents/story_solution.json'
            }
        });

        assert.equal(sm.capturedJqls.length, 1, 'exactly one JQL executed');
        assert.equal(sm.capturedJqls[0], 'key = JD-123', 'JQL targets exact ticket');
        assert.equal(sm.capturedTriggers.length, 1, 'one workflow triggered');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.config_file, 'agents/story_solution.json', 'correct agent used');
        assert.contains(inputs.input_jql, 'JD-123', 'input_jql contains ticket key');
    });

    test('inherits localExecution and concurrencyKey from matching rule', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'P-7', fields: { labels: [] } }]
        });

        // sm.json has a rule for bulk_bugs_creation with localExecution=false and concurrencyKey
        // Use story_solution rule which exists in sm.json
        sm.action({
            jobParams: {
                targetTicket: 'P-7',
                targetAgent: 'agents/story_solution.json',
                rules: [
                    {
                        description: 'Story solution rule',
                        jql: "project = TEST AND status = 'Solution Architecture'",
                        configFile: 'agents/story_solution.json',
                        skipIfLabel: 'sm_story_solution_triggered',
                        addLabel: 'sm_story_solution_triggered',
                        enabled: true
                    }
                ],
                owner: 'o',
                repo: 'r'
            }
        });

        assert.equal(sm.capturedJqls.length, 1, 'only targeted JQL ran');
        assert.equal(sm.capturedJqls[0], 'key = P-7', 'JQL overridden to ticket key');
        // addLabel is inherited, skipIfLabel is stripped
        assert.equal(sm.capturedTriggers.length, 1, 'workflow triggered');
    });

    test('strips skipIfLabel from inherited rule so label on ticket does not block run', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'X-9', fields: { labels: ['sm_story_solution_triggered'] } }]
        });

        sm.action({
            jobParams: {
                targetTicket: 'X-9',
                targetAgent: 'agents/story_solution.json',
                rules: [
                    {
                        description: 'Story solution rule',
                        jql: "project = TEST AND status = 'Solution Architecture'",
                        configFile: 'agents/story_solution.json',
                        skipIfLabel: 'sm_story_solution_triggered',
                        enabled: true
                    }
                ],
                owner: 'o',
                repo: 'r'
            }
        });

        assert.equal(sm.capturedTriggers.length, 1, 'skipIfLabel stripped — run proceeds');
    });

    test('falls back to minimal synthetic rule when no matching rule found', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'Z-1', fields: { labels: [] } }]
        });

        sm.action({
            jobParams: {
                targetTicket: 'Z-1',
                targetAgent: 'agents/story_solution.json',
                rules: [], // no rules — no match possible
                owner: 'o',
                repo: 'r'
            }
        });

        assert.equal(sm.capturedJqls.length, 1, 'synthetic rule JQL ran');
        assert.equal(sm.capturedJqls[0], 'key = Z-1', 'synthetic JQL correct');
        assert.equal(sm.capturedTriggers.length, 1, 'workflow triggered via synthetic rule');
    });

    test('matches rule by configFile regardless of agents/ prefix', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'M-2', fields: { labels: [] } }]
        });

        sm.action({
            jobParams: {
                targetTicket: 'M-2',
                targetAgent: 'story_solution.json',  // no agents/ prefix
                rules: [
                    {
                        description: 'Story solution rule',
                        jql: "project = TEST AND status = 'Solution Architecture'",
                        configFile: 'agents/story_solution.json', // has agents/ prefix
                        enabled: true
                    }
                ],
                owner: 'o',
                repo: 'r'
            }
        });

        assert.equal(sm.capturedTriggers.length, 1, 'rule matched despite agents/ prefix mismatch');
    });

    test('targeted mode disables workflow cap', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-5', fields: { labels: [] } }]
        });

        sm.action({
            jobParams: {
                targetTicket: 'T-5',
                targetAgent: 'agents/pr_review.json',
                maxTriggeredWorkflows: 0,
                rules: [],
                owner: 'o',
                repo: 'r'
            }
        });

        assert.equal(sm.capturedTriggers.length, 1, 'trigger not blocked by workflow cap');
    });

    test('targeted mode does not trigger when targetTicket is missing', function() {
        var sm = makeSmAgent({ fileMap: {}, tickets: [] });

        var result = sm.action({
            jobParams: {
                targetAgent: 'agents/story_solution.json',
                owner: 'o',
                repo: 'r',
                rules: []
            }
        });

        assert.equal(result.success, false, 'fails without rules when no targetTicket');
    });

    test('targeted mode does not trigger when targetAgent is missing', function() {
        var sm = makeSmAgent({ fileMap: {}, tickets: [] });

        var result = sm.action({
            jobParams: {
                targetTicket: 'P-1',
                owner: 'o',
                repo: 'r',
                rules: []
            }
        });

        assert.equal(result.success, false, 'falls through to no-rules error without targetAgent');
    });

});

suite('probeDispatchedState bundle (runAsync read fan-out)', function () {

    var HEAD = [
        { id: 2, status: 'completed', conclusion: 'failure',
          updated_at: '2026-09-27T11:00:00Z', created_at: '2026-09-27T10:30:00Z' },
        { id: 1, status: 'completed', conclusion: 'success',
          updated_at: '2026-09-27T10:00:00Z', created_at: '2026-09-27T09:00:00Z' }
    ];

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    test('fallback: assembles the four facets via the existing helpers (mocked cli)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [] },
            onCliExecute: function () {
                return { output: JSON.stringify({ workflow_runs: HEAD }) };
            }
        }));
        var probe = sm.probeDispatchedState({ owner: 'a', repo: 'b' }, 'quality.yml', 'sha1');
        assert.equal(probe.active, false, 'concluded runs older than the 15-min grace are not active');
        assert.equal(probe.verdict, 'failure', 'newest concluded non-cancelled verdict');
        assert.equal(probe.green, true, 'a completed success covers the head');
        assert.equal(probe.newest.id, 2, 'newest run by updated_at, any conclusion');
        assert.equal(sm.capturedCliCommands.length, 4, 'fallback: the four helpers each probe once');
        assert.ok(sm.capturedCliCommands.every(function (c) {
            return c.command.indexOf('runs?head_sha=sha1') !== -1;
        }), 'all probes key on this exact head');
    });

    test('fallback: defaults mirror the per-helper warn-and-default (empty / failing cli)', function () {
        var defaults = { active: false, verdict: null, green: false, newest: null };
        var smEmpty = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [] },
            onCliExecute: function () { return { output: JSON.stringify({ workflow_runs: [] }) }; }
        }));
        assert.deepEqual(smEmpty.probeDispatchedState({ owner: 'a', repo: 'b' }, 'q.yml', 'sha'),
            defaults, 'no dispatched runs on the head → all defaults');

        var smFail = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [] },
            onCliExecute: function () { throw new Error('net down'); }
        }));
        assert.doesNotThrow(function () {
            assert.deepEqual(smFail.probeDispatchedState({ owner: 'a', repo: 'b' }, 'q.yml', 'sha'),
                defaults, 'a probe failure degrades to the same defaults, never throws');
        });
    });

    test('runAsync wired: ONE worker round returns the identical shape', function () {
        var dispatches = [];
        var cliCalls = 0;
        // Worker-engine parity: map() evals the worker source inside the
        // smAgent module scope and hands the FAKE the function object (the
        // real runAsync contract — it re-serializes fn.toString() for a
        // fresh worker engine wired with the same tool surface). The
        // worker's cli_execute_command therefore resolves to the smAgent
        // module mock — route the response through onCliExecute.
        var fakeRunAsync = function (fn, args) {
            assert.equal(typeof fn, 'function', 'runAsync receives the FUNCTION, not a string');
            dispatches.push({ src: fn.toString(), args: args });
            return { wait: function () { return fn(args); } };
        };
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [] },
            onCliExecute: function () {
                cliCalls++;
                return { output: JSON.stringify({ workflow_runs: HEAD }) };
            },
            runAsync: fakeRunAsync
        }));
        var probe = sm.probeDispatchedState({ owner: 'a', repo: 'b' }, 'quality.yml', 'sha1');
        assert.equal(dispatches.length, 1, 'exactly ONE worker dispatch');
        assert.equal(cliCalls, 1, 'the worker computed all four facets in ONE round');
        assert.deepEqual(probe, {
            active: false, verdict: 'failure', green: true,
            newest: { id: 2, status: 'completed', conclusion: 'failure',
                      updated_at: '2026-09-27T11:00:00Z', created_at: '2026-09-27T10:30:00Z' }
        }, 'same shape as the fallback');
        assert.deepEqual(dispatches[0].args,
            { repo: { owner: 'a', repo: 'b' }, ciWorkflow: 'quality.yml', headSha: 'sha1' },
            'everything travels via args');
    });

    test('validate_pr guards consume the bundle on the fallback path (active run → no dispatch, no arm)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [{ key: 'pr-75', labels: ['pr_approved'], prNumber: 75,
                                branch: 'ai/gh-60', headSha: 'sha60' }] },
            onCliExecute: function (cmdOpts) {
                if (cmdOpts.command.indexOf('runs?head_sha=') !== -1) {
                    return { output: JSON.stringify({ workflow_runs: [
                        { id: 5, status: 'in_progress', head_sha: 'sha60' }
                    ] }) };
                }
                return undefined;
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'] },
              localAction: 'validate_pr', limit: 1, id: 'validate-armed' }
        ] } });

        var probes = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('runs?head_sha=') !== -1; });
        assert.equal(probes.length, 4, 'the fallback probe bundle ran all four helpers for the guards');
        assert.ok(!sm.capturedCliCommands.some(function (c) {
            return c.command.indexOf('workflow run') !== -1; }), 'no CI dispatch while a run is active');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no ai_validating arm while a run is active');
    });

    test('sweep_stale_validation consumes the bundle newest facet on the fallback path', function () {
        var old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [{ key: 'pr-84', labels: ['ai_validating'], prNumber: 84,
                                headSha: 'sha222' }] },
            onCliExecute: function (cmdOpts) {
                if (cmdOpts.command.indexOf('runs?head_sha=') !== -1) {
                    return { output: JSON.stringify({ workflow_runs: [
                        { id: 7, status: 'completed', conclusion: 'success',
                          head_sha: 'sha222', created_at: old, updated_at: old }
                    ] }) };
                }
                return undefined;
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [
            { source: 'github', query: { type: 'pr', labels: ['ai_validating'] },
              localAction: 'sweep_stale_validation', staleMinutes: 15, limit: 10, id: 'sweep' }
        ] } });

        var probes = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('runs?head_sha=') !== -1; });
        assert.equal(probes.length, 4, 'the sweep reads the probe bundle (fallback: four helpers)');
        assert.deepEqual(sm.capturedPrLabelRemoves.map(function (r) { return r.label; }),
            ['ai_validating'], 'the stale arm is released from the bundle newest facet');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.labels.join(','); }),
            ['ai_validated'], 'success side re-latches (complete_validation parity)');
    });

});

// ─── gh-683 rule-action reliability: conflict re-arm (C), label consume (D),
// PR-anchored manual rework (E). Live evidence 2026-10-03/04: fa #677 DIRTY
// since 21:09Z with issue #676 never labelled (owner armed it by hand 05:10Z,
// leg fired 05:12Z); fa #1194 re-dispatch loop (consume call without
// owner/repo → tool error; {issueNumber} scrape anchored stale #327 while the
// real issue was gh-1044 → guard run=false, 75s no-op). ─────────────────────

suite('smAgent: conflict_rework re-arm reliability (gh-683 bug C)', function () {

    var CONFLICT_RULE = {
        description: 'branch conflicts with main -> report + machine re-arm',
        source: 'github',
        query: { type: 'pr', mergeState: ['DIRTY'], draft: false },
        localAction: 'conflict_rework',
        limit: 1,
        id: 'conflict-rework'
    };

    function conflictParams(overrides) {
        var p = baseParams('epam', 'dmtools-dart', [CONFLICT_RULE]);
        p.jobParams.machineAuthor = 'ai-teammate';
        return Object.assign(p, overrides || {});
    }

    test('starved PR-anchored dispatch posts NO marker comment — retried next tick, not suppressed forever', function () {
        // fa #677 shape: marker used to land BEFORE arming; a dispatch that
        // starved (global cap / active run / trigger failure) left a
        // "reported" corpse that suppressed every later tick.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [{ key: 'pr-677', labels: [], issueNumber: null, prNumber: 677,
                          branch: 'ai/cleanup-reports', author: 'ai-teammate', pr: { headSha: 'deadbeef77' } }],
                // no closes/fixes ref and no gh-<n> branch grammar -> the
                // PR-anchored dispatch path
                pr: { number: 677, body: 'some rework', head: { sha: 'deadbeef77' } },
                prComments: []
            },
            onTrigger: function () { throw new Error('workflow cap'); }
        });

        sm.action(conflictParams());

        assert.equal(sm.capturedTriggers.length, 1, 'the rework dispatch was attempted');
        assert.equal(sm.capturedPrComments.length, 0,
            'the marker comment must NOT post when arming failed — the next tick retries');
    });

    test('marker present + linked issue OPEN but UNLABELLED -> self-heal re-arms agent:rework', function () {
        // fa #677/#676 corpse: marker present, issue #676 had no
        // agent:rework. Suppression keys on the LABEL, not the comment.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [{ key: 'pr-677', labels: [], issueNumber: null, prNumber: 677,
                          branch: 'ai/gh-676', author: 'ai-teammate', pr: { headSha: 'deadbeef77' } }],
                pr: { number: 677, body: 'Closes #676', head: { sha: 'deadbeef77' } },
                prComments: [{ body: '⚠️ Merge conflict with main — cannot merge (head `deadbeef77`)' }],
                issue: { number: 676, state: 'open', labels: [] }
            }
        });

        sm.action(conflictParams());

        assert.equal(sm.capturedPrLabelAdds.length, 1, 'the linked issue is re-armed');
        assert.equal(sm.capturedPrLabelAdds[0].number, 676);
        assert.equal(sm.capturedPrLabelAdds[0].labels.join(','), 'agent:rework');
        assert.equal(sm.capturedPrLabelAdds[0].workspace, 'epam', 'owner/repo ride the call (bug D family)');
        assert.equal(sm.capturedPrLabelAdds[0].repository, 'dmtools-dart');
        assert.equal(sm.capturedTriggers.length, 0, 'no dispatch — the issue-rework rule owns it');
        assert.equal(sm.capturedPrComments.length, 0, 'no duplicate marker report');
    });

    test('marker present + linked issue ALREADY labelled -> quiet (once-per-head pacing holds)', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [{ key: 'pr-677', labels: [], issueNumber: null, prNumber: 677,
                          branch: 'ai/gh-676', author: 'ai-teammate', pr: { headSha: 'deadbeef77' } }],
                pr: { number: 677, body: 'Closes #676', head: { sha: 'deadbeef77' } },
                prComments: [{ body: '⚠️ Merge conflict with main — cannot merge (head `deadbeef77`)' }],
                issue: { number: 676, state: 'open', labels: [{ name: 'agent:rework' }] }
            }
        });

        sm.action(conflictParams());

        assert.equal(sm.capturedPrLabelAdds.length, 0, 'already armed — no duplicate');
        assert.equal(sm.capturedPrComments.length, 0, 'no duplicate marker report');
        assert.equal(sm.capturedTriggers.length, 0, 'no dispatch');
    });
});

suite('smAgent: trigger-label consume carries owner/repo (gh-683 bug D)', function () {

    test('consumeLabels removes the PR label with workspace/repository + singular label param', function () {
        // fa #1194 loop: the consume call was {"number":1194,"labels":
        // ["agent:rework"]} — no owner/repo, plural param — the bridge
        // errored "Issue reference requires owner/repo/number", the label
        // never left, every tick re-dispatched the same no-op leg.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [{ key: 'pr-1194', labels: ['agent:rework'], issueNumber: null,
                          prNumber: 1194, branch: 'ai/gh-1194', author: 'ai-teammate' }]
            }
        });

        sm.action(baseParams('epam', 'dmtools-dart', [{
            description: 'manual rework label on the PR',
            source: 'github',
            query: { type: 'pr', labels: ['agent:rework'] },
            workflowFile: 'ai-teammate.yml',
            inputs: { issue: '', leg: 'rework', reason: 'sm: manual', pr: '{prNumber}' },
            consumeLabels: ['agent:rework'],
            limit: 1,
            id: 'rework-on-label',
            workflowRef: '{branch}'
        }]));

        assert.equal(sm.capturedTriggers.length, 1, 'dispatch happened');
        assert.equal(sm.capturedPrLabelRemoves.length, 1, 'the trigger label is consumed');
        var rm = sm.capturedPrLabelRemoves[0];
        assert.equal(rm.number, 1194, 'consumed from the PR');
        assert.equal(rm.label, 'agent:rework', 'singular label param the bridge reads');
        assert.equal(rm.workspace, 'epam', 'owner present (the live error named its absence)');
        assert.equal(rm.repository, 'dmtools-dart', 'repo present');
    });
});

suite('smAgent: manual rework is PR-anchored, no body scrape (gh-683 bug E)', function () {

    test('rework-on-label dispatches inputs.pr — never {issueNumber}', function () {
        // fa #1194: the {issueNumber} scrape picked a stale bare '#327'
        // mention — wrong but EXISTING, so the #544 existence guard passed
        // it (real issue gh-1044) — the factory guard rejected the anchor,
        // run=false, 75s no-op. The label is on the PR; anchor on the PR.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [{ key: 'pr-1194', labels: ['agent:rework'], issueNumber: 327,
                          prNumber: 1194, branch: 'ai/gh-1194', author: 'ai-teammate' }]
            }
        });

        sm.action(baseParams('epam', 'dmtools-dart', [{
            description: 'manual rework label on the PR',
            source: 'github',
            query: { type: 'pr', labels: ['agent:rework'] },
            workflowFile: 'ai-teammate.yml',
            inputs: { issue: '', leg: 'rework', reason: 'sm: manual', pr: '{prNumber}' },
            consumeLabels: ['agent:rework'],
            limit: 1,
            id: 'rework-on-label',
            workflowRef: '{branch}'
        }]));

        assert.equal(sm.capturedTriggers.length, 1, 'dispatch happened');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.pr, '1194', 'anchored on the PR number');
        assert.equal(inputs.issue, '', 'no issue anchor to mis-resolve');
        assert.equal(sm.capturedPrLabelRemoves.length, 1, 'label consumed — no re-fire loop');
    });

    test('sm_github.json pins it: rework-on-label inputs are PR-anchored like its review siblings', function () {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });

        var rule = byId['rework-on-label'];
        assert.ok(rule, 'rework-on-label exists');
        assert.equal(rule.inputs.pr, '{prNumber}', 'PR-anchored');
        assert.equal(rule.inputs.issue, '', 'no issue anchor');
        assert.equal(JSON.stringify(rule.inputs).indexOf('{issueNumber}'), -1,
            'no body-scrape anchor anywhere in its inputs');
        // The PR-anchored shape is the established family pattern:
        ['review-on-label', 'review-external-once', 'review-machine-unlinked'].forEach(function (id) {
            assert.equal(byId[id].inputs.pr, '{prNumber}', id + ' is PR-anchored (family parity)');
        });
    });
});

// ─── gh-715: duplicate rework dispatch — 2s apart, same SHA (fa gh-1226,
// 2026-10-04 18:47:11/13, runs 37225765526/37225768365). agent:rework was
// armed on BOTH carriers — the linked issue (review post-action) and the
// PR (rework-unresolved-threads) — so one SM tick matched both rework
// dispatch rules; each passed its own in-flight guard because the guards
// key on the run-title anchor token ('· gh-1226' vs '· pr-1227') and the
// two carriers anchor the SAME work differently. One leg must win. ────────

suite('smAgent: duplicate rework dispatch — one leg wins (gh-715)', function () {

    function deployedRules(ids) {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });
        return ids.map(function (id) {
            assert.ok(byId[id], 'deployed rule ' + id + ' exists');
            return byId[id];
        });
    }

    function ghParams(rules, extra) {
        var p = { jobParams: { owner: 'epam', repo: 'dmtools-dart',
            machineAuthor: 'ai-teammate', rules: rules } };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) p.jobParams[k] = extra[k]; } }
        return p;
    }

    // Source stub with minimal guard fidelity: applies the deployed
    // query's labels/notPrLabels (item side) and prLabels/notPrLabels
    // (linked-PR side, against the state fixture) — the same contract the
    // real matchesGuards implements, covered directly (with the real
    // deployed query) in test_smGithubSource.js.
    function armedBothSource(state) {
        return function (rule, ctx) {
            var q = (rule && rule.query) || {};
            var out = [];
            var has = function (arr, l) { return (arr || []).indexOf(l) !== -1; };
            var issue = { key: 'gh-1226', labels: ['agent:rework'], issueNumber: 1226,
                          prNumber: 1227, branch: 'ai/gh-1226', author: 'ai-teammate',
                          pr: { labels: state.prLabels } };
            var pr = { key: 'pr-1227', labels: state.prLabels, issueNumber: 1226,
                       prNumber: 1227, branch: 'ai/gh-1226', author: 'ai-teammate' };
            var candidates = q.type === 'issue' ? [issue] : [pr];
            candidates.forEach(function (c) {
                if (q.labels && !q.labels.every(function (l) { return has(c.labels, l); })) return;
                if (q.notLabels && q.notLabels.some(function (l) { return has(c.labels, l); })) return;
                var prLs = (c.pr && c.pr.labels) || [];
                if (q.prLabels && !q.prLabels.some(function (l) { return has(prLs, l); })) return;
                if (q.notPrLabels && q.notPrLabels.some(function (l) { return has(prLs, l); })) return;
                out.push(c);
            });
            return out;
        };
    }

    test('sm_github.json pins it: rework-on-red-ci defers to the armed PR (notPrLabels agent:rework)', function () {
        var rules = deployedRules(['rework-on-red-ci', 'rework-on-label']);
        var auto = rules[0];
        assert.equal(auto.query.type, 'issue', 'issue carrier');
        assert.ok((auto.query.notPrLabels || []).indexOf('agent:rework') !== -1,
            'issue-carrier rule defers while the PR carries agent:rework (gh-715)');
        assert.ok(!auto.consumeLabels,
            'the issue arm survives dispatch — the dead-letter re-fire design stays intact');
        var manual = rules[1];
        assert.ok((manual.consumeLabels || []).indexOf('agent:rework') !== -1,
            'PR-carrier rule keeps consuming its label on dispatch');
    });

    test('both carriers armed in one tick → exactly ONE rework dispatch (the PR-anchored leg)', function () {
        // The exact fa gh-1226 evidence: one tick, agent:rework on the
        // issue AND the PR — the SM fired both rules 2 seconds apart on
        // the same head SHA.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: armedBothSource({ prLabels: ['agent:rework'] }),
                issue: { number: 1226, state: 'open', labels: [{ name: 'agent:rework' }] }
            }
        });

        sm.action(ghParams(deployedRules(['rework-on-red-ci', 'rework-on-label'])));

        assert.equal(sm.capturedTriggers.length, 1, 'one leg wins — no duplicate rework dispatch');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.pr, '1227', 'the PR-anchored leg is the winner (self-consuming)');
        assert.equal(sm.capturedPrLabelRemoves.length, 1, 'the winning rule consumed the PR label');
    });

    test('cross-anchor guard: an issue-anchored leg in flight suppresses the PR-carrier dispatch', function () {
        // The cross-tick race: tick N dispatches the issue-anchored leg and
        // rework-unresolved-threads arms the PR later in the SAME tick; on
        // tick N+1 the PR-carrier rule must recognize the running
        // '· gh-1226' leg as the SAME work — and consume the PR label so a
        // finished run never re-fires a duplicate leg on the next quiet tick.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [{ key: 'pr-1227', labels: ['agent:rework'], issueNumber: 1226,
                          prNumber: 1227, branch: 'ai/gh-1226', author: 'ai-teammate' }]
            },
            workflowRuns: { in_progress: [
                { id: 37225765526, name: 'AI Teammate', status: 'in_progress',
                  display_title: '▶ rework (SM) · gh-1226' }
            ] }
        });

        sm.action(ghParams(deployedRules(['rework-on-label'])));

        assert.equal(sm.capturedTriggers.length, 0, 'the in-flight issue-anchored leg is the same work — no second dispatch');
        assert.equal(sm.capturedPrLabelRemoves.length, 1, 'request consumed — the active leg fulfills it');
        assert.equal(sm.capturedPrLabelRemoves[0].label, 'agent:rework');
        assert.equal(sm.capturedPrLabelRemoves[0].number, 1227, 'consumed from the PR');
    });

    test('cross-anchor guard: a PR-anchored leg in flight suppresses the issue-carrier dispatch', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [{ key: 'gh-1226', labels: ['agent:rework'], issueNumber: 1226,
                          prNumber: 1227, branch: 'ai/gh-1226', author: 'ai-teammate' }],
                issue: { number: 1226, state: 'open', labels: [{ name: 'agent:rework' }] }
            },
            workflowRuns: { in_progress: [
                { id: 37225768365, name: 'AI Teammate', status: 'in_progress',
                  display_title: '▶ rework (SM) · pr-1227' }
            ] }
        });

        sm.action(ghParams(deployedRules(['rework-on-red-ci'])));

        assert.equal(sm.capturedTriggers.length, 0, 'the in-flight PR-anchored leg is the same work — no second dispatch');
    });

    test('cross-anchor guard: an active run for a DIFFERENT issue does not suppress', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "epam", repo: "dmtools-dart" } };' },
            github: {
                items: [{ key: 'pr-1227', labels: ['agent:rework'], issueNumber: 1226,
                          prNumber: 1227, branch: 'ai/gh-1226', author: 'ai-teammate' }]
            },
            workflowRuns: { in_progress: [
                { id: 37225810446, name: 'AI Teammate', status: 'in_progress',
                  display_title: '▶ rework (SM) · gh-999' }
            ] }
        });

        sm.action(ghParams(deployedRules(['rework-on-label'])));

        assert.equal(sm.capturedTriggers.length, 1, 'unrelated active run — the dispatch proceeds');
        assert.equal(sm.capturedPrLabelRemoves.length, 1, 'label consumed on the real dispatch');
    });
});

// ─── gh-682: standing cancelled-checks remedy. Live evidence: fa#1202
// (head 898efd4) — all 4 kicker push-runs on ai/gh-1171 CANCELLED
// 21:43–23:05 as refresh pushes landed, required checks ended CANCELLED →
// PR BLOCKED until a manual rerun (23:26); fa#1203 twice more (23:47,
// 23:57); still reproducing 2026-10-04 06:21–06:22 — eight branches'
// kicker runs cancelled in one 36-second dev-wave (a queued run in a
// shared concurrency group always supersedes the pending one;
// cancel-in-progress:false shields only the RUNNING run). ────────────────

suite('smAgent: rerun_cancelled_checks (gh-682)', function () {

    var RULE = {
        description: 'cancelled required checks -> rerun',
        source: 'github',
        query: {
            type: 'pr',
            labels: ['ai_validating', 'ai_validated'],
            notLabels: ['agent:rework'],
            notMergeState: ['BEHIND', 'DIRTY'],
            draft: false
        },
        localAction: 'rerun_cancelled_checks',
        requiredContexts: ['kicker / sm-liveness', 'kicker / head-completeness'],
        limit: 1,
        id: 'rerun-cancelled-checks'
    };

    function prItem682(n, extra) {
        var it = { key: 'pr-' + n, labels: ['ai_validating'], issueNumber: null,
                   prNumber: n, draft: false, branch: 'ai/gh-1202',
                   pr: { headSha: '898efd4' } };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    // cli mock: routes the three gh calls the action makes —
    //   gh api .../actions/runs?head_sha=  → headRuns
    //   gh api .../actions/runs/<id>/jobs  → jobsByRun
    //   gh run rerun <id>                  → captured by capturedCliCommands
    function cli682(opts) {
        opts = opts || {};
        return function (cmdOpts) {
            var c = cmdOpts.command;
            if (c.indexOf('runs?head_sha=') !== -1) {
                return JSON.stringify({ workflow_runs: opts.headRuns || [] });
            }
            var m = /runs\/(\d+)\/jobs/.exec(c);
            if (m) {
                return JSON.stringify({ jobs: (opts.jobsByRun || {})[m[1]] || [] });
            }
            return '';
        };
    }

    function cancelledKickerRuns() {
        // fa#1202 shape: the kicker run on the head died cancelled (attempt 1)
        return [{ id: 555001, status: 'completed', conclusion: 'cancelled',
                  head_sha: '898efd4', run_attempt: 1,
                  created_at: '2026-10-03T23:05:00Z', updated_at: '2026-10-03T23:05:02Z' }];
    }

    function cancelledCheckRuns() {
        return { check_runs: [
            { name: 'kicker / sm-liveness', conclusion: 'cancelled', status: 'completed' },
            { name: 'kicker / head-completeness', conclusion: 'cancelled', status: 'completed' }
        ] };
    }

    function kickerJobs() {
        return { 555001: [
            { name: 'kicker / sm-liveness' }, { name: 'kicker / head-completeness' }
        ] };
    }

    function params682(overrides) {
        var p = { jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            rules: [RULE] } };
        return Object.assign(p, overrides || {});
    }

    test('cancelled required contexts + no in-flight run -> gh run rerun + evidence marker comment', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: []
            },
            onCliExecute: cli682({ headRuns: cancelledKickerRuns(), jobsByRun: kickerJobs() })
        });

        sm.action(params682());

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 1, 'one rerun covers both contexts (same cancelled run)');
        assert.equal(reruns[0].command, 'gh run rerun 555001 --repo IstiN/flutter_agent_harness');
        assert.equal(sm.capturedPrComments.length, 1, 'one marker comment');
        var body = sm.capturedPrComments[0].body;
        assert.equal(sm.capturedPrComments[0].number, 1202, 'comment on the PR');
        assert.ok(body.indexOf('Cancelled required checks re-run') !== -1, 'stable marker prefix');
        assert.ok(body.indexOf('898efd4') !== -1, 'carries the head sha (per-head dedup key)');
        assert.ok(body.indexOf('fa#1202/#1203') !== -1, 'cites the live evidence');
        assert.ok(body.indexOf('2026-10-04 06:21') !== -1, 'cites the still-reproducing timestamp');
        assert.ok(body.indexOf('kicker / sm-liveness') !== -1 && body.indexOf('kicker / head-completeness') !== -1,
            'names the re-run contexts');
    });

    test('marker comment lands AFTER the rerun (gh-683 bug C invariant: no marker without the action)', function () {
        // Ordering is structural (reruns dispatch, then the comment posts),
        // but assert the contract the invariant rests on: a failing rerun
        // command must leave NO marker — the next tick retries.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: []
            },
            onCliExecute: function (cmdOpts) {
                if (cmdOpts.command.indexOf('gh run rerun') === 0) {
                    throw new Error('gh: 422 rerun not allowed');
                }
                return cli682({ headRuns: cancelledKickerRuns(), jobsByRun: kickerJobs() })(cmdOpts);
            }
        });

        sm.action(params682());

        assert.equal(sm.capturedPrComments.length, 0,
            'rerun failure must not post the marker — retried next tick, not suppressed forever');
    });

    test('green/pending contexts never act (CANCELLED-only; failure belongs to fail_validation)', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: { check_runs: [
                    { name: 'kicker / sm-liveness', conclusion: 'success', status: 'completed' },
                    { name: 'kicker / head-completeness', conclusion: 'failure', status: 'completed' }
                ] },
                prComments: []
            },
            onCliExecute: cli682({ headRuns: cancelledKickerRuns(), jobsByRun: kickerJobs() })
        });

        sm.action(params682());

        assert.equal(sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        }).length, 0, 'no cancelled context -> no rerun (red is fail_validation territory)');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment');
    });

    test('#695 regression: stale CANCELLED + fresh green re-stamp on the same context does NOT act (branch-protection semantics)', function () {
        // The rollup keeps the superseded check run in the head's history:
        // sm-liveness was cancelled at 23:05, then re-ran green at 23:12.
        // Any-historical-CANCELLED matching (the reviewed bug) re-fired
        // forever here and parked mergeable PRs red — the LATEST run per
        // context is the verdict branch protection reads.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: { check_runs: [
                    { name: 'kicker / sm-liveness', conclusion: 'cancelled', status: 'completed',
                      id: 111, started_at: '2026-10-03T23:05:00Z', completed_at: '2026-10-03T23:05:02Z' },
                    { name: 'kicker / sm-liveness', conclusion: 'success', status: 'completed',
                      id: 222, started_at: '2026-10-03T23:12:00Z', completed_at: '2026-10-03T23:12:40Z' },
                    { name: 'kicker / head-completeness', conclusion: 'success', status: 'completed',
                      id: 333, started_at: '2026-10-03T23:12:00Z', completed_at: '2026-10-03T23:12:41Z' }
                ] },
                prComments: []
            },
            onCliExecute: cli682({ headRuns: cancelledKickerRuns(), jobsByRun: kickerJobs() })
        });

        sm.action(params682());

        assert.equal(sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        }).length, 0, 'stale cancel under a fresh green re-stamp is NOT cancelled');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment');
    });

    test('#695 regression: latest check run CANCELLED (stale green underneath) DOES act', function () {
        // The mirror pair: green at 23:05, cancelled at 23:12 — the newest
        // word on the context IS a cancel, so the remedy fires exactly as
        // before the fix.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: { check_runs: [
                    { name: 'kicker / sm-liveness', conclusion: 'success', status: 'completed',
                      id: 111, started_at: '2026-10-03T23:05:00Z', completed_at: '2026-10-03T23:05:02Z' },
                    { name: 'kicker / sm-liveness', conclusion: 'cancelled', status: 'completed',
                      id: 222, started_at: '2026-10-03T23:12:00Z', completed_at: '2026-10-03T23:12:40Z' },
                    { name: 'kicker / head-completeness', conclusion: 'success', status: 'completed',
                      id: 333, started_at: '2026-10-03T23:12:00Z', completed_at: '2026-10-03T23:12:41Z' }
                ] },
                prComments: []
            },
            onCliExecute: cli682({ headRuns: cancelledKickerRuns(), jobsByRun: kickerJobs() })
        });

        sm.action(params682());

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 1, 'latest-cancelled context rerun (green head-completeness untouched)');
        assert.equal(reruns[0].command, 'gh run rerun 555001 --repo IstiN/flutter_agent_harness');
        assert.equal(sm.capturedPrComments.length, 1, 'full coverage (the one cancelled context) -> marker posts');
        assert.ok(sm.capturedPrComments[0].body.indexOf('kicker / sm-liveness') !== -1, 'names the rerun context');
    });

    test('#695 regression: per-context independence — no timestamps, page order breaks the tie', function () {
        // Mocks (and degraded rollups) can carry no timestamps/ids: REST
        // sorts check runs by id ascending, so later page position IS
        // newer. sm-liveness ends green, head-completeness ends cancelled.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: { check_runs: [
                    { name: 'kicker / sm-liveness', conclusion: 'cancelled', status: 'completed' },
                    { name: 'kicker / sm-liveness', conclusion: 'success', status: 'completed' },
                    { name: 'kicker / head-completeness', conclusion: 'success', status: 'completed' },
                    { name: 'kicker / head-completeness', conclusion: 'cancelled', status: 'completed' }
                ] },
                prComments: []
            },
            onCliExecute: cli682({
                headRuns: cancelledKickerRuns(),
                jobsByRun: { 555001: [{ name: 'kicker / head-completeness' }] }
            })
        });

        sm.action(params682());

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 1, 'only the context whose LATEST run is cancelled acts');
        assert.equal(reruns[0].command, 'gh run rerun 555001 --repo IstiN/flutter_agent_harness');
        assert.equal(sm.capturedPrComments.length, 1, 'full coverage -> marker posts');
        assert.ok(sm.capturedPrComments[0].body.indexOf('kicker / head-completeness') !== -1,
            'marker names the acted-on context only');
        assert.ok(sm.capturedPrComments[0].body.indexOf('kicker / sm-liveness') === -1,
            'the green-latest context is not claimed as cancelled');
    });

    test('in-flight run on the head -> skip (the run re-stamps the contexts itself)', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: []
            },
            onCliExecute: cli682({
                headRuns: cancelledKickerRuns().concat([
                    { id: 555009, status: 'in_progress', conclusion: null,
                      head_sha: '898efd4', created_at: '2026-10-03T23:06:00Z' }
                ]),
                jobsByRun: kickerJobs()
            })
        });

        sm.action(params682());

        assert.equal(sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        }).length, 0, 'in-flight run present -> no rerun');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment');
    });

    test('marker present for this head -> once-per-head pacing holds', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: [
                    { body: '🔁 Cancelled required checks re-run: ... (head `898efd4`)' },
                    // Different head — must NOT suppress the current one.
                    { body: '🔁 Cancelled required checks re-run: ... (head `older012`)' }
                ]
            },
            onCliExecute: cli682({ headRuns: cancelledKickerRuns(), jobsByRun: kickerJobs() })
        });

        sm.action(params682());

        assert.equal(sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        }).length, 0, 'same-head marker suppresses re-runs');
        assert.equal(sm.capturedPrComments.length, 0, 'no duplicate comment');
    });

    test('already-rerun run (run_attempt 2) is not re-run again — no automatic retry loop', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: []
            },
            onCliExecute: cli682({
                headRuns: [{ id: 555001, status: 'completed', conclusion: 'cancelled',
                             head_sha: '898efd4', run_attempt: 2,
                             created_at: '2026-10-03T23:05:00Z', updated_at: '2026-10-03T23:40:00Z' }],
                jobsByRun: kickerJobs()
            })
        });

        sm.action(params682());

        assert.equal(sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        }).length, 0, 'the remedy already fired on this run — no loop');
        assert.equal(sm.capturedPrComments.length, 0, 'no comment');
    });

    test('newest cancelled run wins per context (refresh waves leave several)', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: []
            },
            onCliExecute: cli682({
                headRuns: [
                    { id: 555001, status: 'completed', conclusion: 'cancelled',
                      head_sha: '898efd4', run_attempt: 1,
                      created_at: '2026-10-03T21:43:00Z', updated_at: '2026-10-03T21:43:05Z' },
                    { id: 555002, status: 'completed', conclusion: 'cancelled',
                      head_sha: '898efd4', run_attempt: 1,
                      created_at: '2026-10-03T23:05:00Z', updated_at: '2026-10-03T23:05:02Z' }
                ],
                jobsByRun: {
                    555001: [{ name: 'kicker / sm-liveness' }],
                    555002: [{ name: 'kicker / sm-liveness' }, { name: 'kicker / head-completeness' }]
                }
            })
        });

        sm.action(params682());

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 1, 'both contexts resolved to the NEWEST cancelled run');
        assert.equal(reruns[0].command, 'gh run rerun 555002 --repo IstiN/flutter_agent_harness');
    });

    test('#695 regression: partial rerun coverage reruns the covered context but defers the marker', function () {
        // Both contexts read CANCELLED, but only sm-liveness maps to an
        // attempt-1 cancelled run (555001 carries just that job) — the
        // once-per-head marker must NOT post over the partial set: it is
        // keyed on the head sha alone, so it would latch the gate shut and
        // head-completeness would never be retried. The covered run still
        // reruns; the uncovered context stays actionable next tick.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: []
            },
            onCliExecute: cli682({
                headRuns: cancelledKickerRuns(),
                jobsByRun: { 555001: [{ name: 'kicker / sm-liveness' }] }
            })
        });

        sm.action(params682());

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 1, 'the covered context still reruns');
        assert.equal(reruns[0].command, 'gh run rerun 555001 --repo IstiN/flutter_agent_harness');
        assert.equal(sm.capturedPrComments.length, 0,
            'partial coverage must not post the head marker — uncovered context retried next tick');
    });

    test('#695 regression: uncovered context is still actionable on the NEXT tick (marker never latched)', function () {
        // Continuation of the partial-coverage scenario: the rerun of
        // 555001 restamps sm-liveness green (attempt 2), head-completeness
        // stays cancelled and only NOW maps to a rerunnable run — the
        // remedy must fire for it exactly as on a first visit, with full
        // coverage posting the marker.
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: { check_runs: [
                    { name: 'kicker / sm-liveness', conclusion: 'success', status: 'completed' },
                    { name: 'kicker / head-completeness', conclusion: 'cancelled', status: 'completed' }
                ] },
                prComments: [] // no marker was ever posted (it was deferred)
            },
            onCliExecute: cli682({
                headRuns: cancelledKickerRuns(),
                jobsByRun: kickerJobs()
            })
        });

        sm.action(params682());

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 1, 'the previously-uncovered context reruns once it maps');
        assert.equal(sm.capturedPrComments.length, 1, 'full coverage now -> the marker posts');
    });

    test('dryRun: reruns log only, no comment, no command', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: []
            },
            onCliExecute: cli682({ headRuns: cancelledKickerRuns(), jobsByRun: kickerJobs() })
        });

        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness', dryRun: true,
                                 rules: [RULE] } });

        assert.equal(sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        }).length, 0, 'dry means no side effects');
        assert.equal(sm.capturedPrComments.length, 0, 'no marker in dry');
    });

    test('no requiredContexts configured -> rule warns and skips (no crash)', function () {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem682(1202)],
                commitCheckRuns: cancelledCheckRuns(),
                prComments: []
            },
            onCliExecute: cli682({})
        });

        sm.action(params682({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            rules: [Object.assign({}, RULE, { requiredContexts: undefined })] } }));

        assert.equal(sm.capturedPrComments.length, 0, 'no comment without config');
        assert.equal(sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        }).length, 0, 'no rerun without config');
    });

    test('sm_github.json pins it: FIRST rule, ahead of merge-validated and sweep-stale-validating', function () {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = cfg.params.jobParams.rules;
        var byId = {};
        rules.forEach(function (r, i) { byId[r.id] = { rule: r, index: i }; });

        var own = byId['rerun-cancelled-checks'];
        assert.ok(own, 'rerun-cancelled-checks exists in the deployed rules');
        assert.equal(own.rule.localAction, 'rerun_cancelled_checks');
        assert.ok(Array.isArray(own.rule.requiredContexts) && own.rule.requiredContexts.length,
            'the dart deployment carries its branch-protection contexts');
        // #637 invariant untouched: merge-validated stays before the sweep.
        assert.ok(byId['merge-validated'].index < byId['sweep-stale-validating'].index,
            'merge-validated still precedes sweep-stale-validating');
        assert.ok(own.index < byId['merge-validated'].index,
            'the remedy runs before any verdict rule can act on the dead head');
        assert.ok(own.index < byId['sweep-stale-validating'].index,
            'and before the 15-min sweep (cancelled conclusions never sweep, but order is belt-and-suspenders)');
    });
});
suite('smAgent: gh-755 deployed rerun rules are author-disjoint (sm_github.json shape)', function () {
    // gh-755 (owner directive 2026-10-05): cancelled checks must auto-rerun
    // and never arm rework. The rerun remedy splits by authorship:
    // rerun-cancelled-checks keeps the named branch-protection contexts for
    // GUEST heads (query.notMachine); the new rerun-any-cancelled-checks
    // sibling reruns ANY cancelled context on MACHINE-authored heads
    // (query.prMachineAuthor + rule.anyCancelled). Disjointness is what
    // keeps the rerun single-shot: exactly one rerun rule matches any PR,
    // so no run is rerun twice and the once-per-head markers never
    // interfere.

    function deployed() {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = cfg.params.jobParams.rules;
        var byId = {};
        rules.forEach(function (r, i) { byId[r.id] = { rule: r, index: i }; });
        return byId;
    }

    test('the ANY-cancelled sibling exists, machine-only, directly after the named rule', function () {
        var byId = deployed();
        var named = byId['rerun-cancelled-checks'];
        var sib = byId['rerun-any-cancelled-checks'];
        assert.ok(sib, 'rerun-any-cancelled-checks exists in the deployed rules');
        assert.equal(sib.rule.localAction, 'rerun_cancelled_checks', 'same localAction, ANY mode');
        assert.equal(sib.rule.anyCancelled, true, 'ANY-cancelled mode flag is set');
        assert.ok(!sib.rule.requiredContexts,
            'ANY mode carries no name list (requiredContexts would narrow the rerun set)');
        assert.equal(sib.rule.query.prMachineAuthor, true,
            'auto-rerun of ANY context is machine-author-gated (fails closed)');
        assert.equal(named.rule.query.notMachine, true,
            'the named rule is now guest-only — author-disjoint twins');
        assert.equal(sib.index, named.index + 1,
            'the sibling sits immediately after the named rule (cancel remedies stay first)');
        assert.ok(sib.index < byId['merge-validated'].index,
            'still ahead of every verdict rule');
        // Query parity with the named rule (same armed audience, same
        // exclusions) — only the authorship gate differs.
        assert.deepEqual(sib.rule.query.labels, named.rule.query.labels);
        assert.deepEqual(sib.rule.query.notLabels, named.rule.query.notLabels);
        assert.deepEqual(sib.rule.query.notMergeState, named.rule.query.notMergeState);
        assert.equal(sib.rule.query.draft, false);
        assert.equal(sib.rule.limit, named.rule.limit, 'same per-tick pacing');
    });
});
suite('smAgent: rerun_cancelled_checks ANY mode (gh-755)', function () {

    var RULE_ANY = {
        description: 'any cancelled check -> rerun (machine-authored heads)',
        source: 'github',
        query: {
            type: 'pr',
            labels: ['ai_validating', 'ai_validated'],
            notLabels: ['agent:rework'],
            notMergeState: ['BEHIND', 'DIRTY'],
            draft: false,
            prMachineAuthor: true
        },
        localAction: 'rerun_cancelled_checks',
        anyCancelled: true,
        limit: 2,
        id: 'rerun-any-cancelled-checks'
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['ai_validating'], issueNumber: null,
                   prNumber: n, draft: false, branch: 'ai/gh-755',
                   pr: { headSha: '755abc' } };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function cliAny(opts) {
        return function (cmdOpts) {
            var c = cmdOpts.command;
            if (c.indexOf('runs?head_sha=') !== -1) {
                return JSON.stringify({ workflow_runs: opts.headRuns || [] });
            }
            var m = /runs\/(\d+)\/jobs/.exec(c);
            if (m) {
                return JSON.stringify({ jobs: (opts.jobsByRun || {})[m[1]] || [] });
            }
            return '';
        };
    }

    function paramsAny() {
        return { jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            machineAuthor: 'ai-teammate', rules: [RULE_ANY] } };
    }

    function smAny(checkRuns, cliOpts, prComments) {
        return makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [prItem(755)],
                commitCheckRuns: checkRuns,
                prComments: prComments || []
            },
            onCliExecute: cliAny(cliOpts || {})
        });
    }

    test('ANY mode reruns cancelled contexts across MULTIPLE runs (two runs -> two reruns)', function () {
        // The live gap (gh-755): sm-liveness died on the kicker run,
        // docs-freshness on its own workflow run — neither is a
        // branch-protection requiredContext, the named rule never saw
        // them. ANY mode remediates both in one pass.
        var sm = smAny(
            { check_runs: [
                { name: 'kicker / sm-liveness', conclusion: 'cancelled', status: 'completed' },
                { name: 'docs-freshness', conclusion: 'cancelled', status: 'completed' }
            ] },
            { headRuns: [
                { id: 555001, status: 'completed', conclusion: 'cancelled',
                  head_sha: '755abc', run_attempt: 1,
                  created_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:02Z' },
                { id: 555002, status: 'completed', conclusion: 'cancelled',
                  head_sha: '755abc', run_attempt: 1,
                  created_at: '2026-10-05T10:00:01Z', updated_at: '2026-10-05T10:00:03Z' }
            ],
              jobsByRun: {
                  555001: [{ name: 'kicker / sm-liveness' }],
                  555002: [{ name: 'docs-freshness' }]
              } });

        sm.action(paramsAny());

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 2, 'one rerun per cancelled RUN');
        assert.ok(reruns.some(function (r) { return r.command.indexOf('gh run rerun 555001 ') === 0; }));
        assert.ok(reruns.some(function (r) { return r.command.indexOf('gh run rerun 555002 ') === 0; }));
        assert.equal(sm.capturedPrComments.length, 1, 'full coverage -> marker posts');
        var body = sm.capturedPrComments[0].body;
        assert.ok(body.indexOf('755abc') !== -1, 'carries the head sha (per-head dedup key)');
        assert.ok(body.indexOf('kicker / sm-liveness') !== -1 && body.indexOf('docs-freshness') !== -1,
            'names every rerun context');
        assert.ok(body.indexOf('gh-755') !== -1, 'cites the gh-755 evidence (not the #682 wave)');
    });

    test('ANY mode ignores a present requiredContexts list — every latest-cancelled context acts', function () {
        // anyCancelled is a superset by definition: a name list would only
        // narrow the remedy back into the #752/#753 gap. Deliberate:
        // anyCancelled WINS when both fields are present.
        var sm = smAny(
            { check_runs: [
                { name: 'static', conclusion: 'success', status: 'completed' },
                { name: 'docs-freshness', conclusion: 'cancelled', status: 'completed' }
            ] },
            { headRuns: [
                { id: 555002, status: 'completed', conclusion: 'cancelled',
                  head_sha: '755abc', run_attempt: 1,
                  created_at: '2026-10-05T10:00:01Z', updated_at: '2026-10-05T10:00:03Z' }
            ],
              jobsByRun: { 555002: [{ name: 'docs-freshness' }] } });
        var rule = Object.assign({}, RULE_ANY, { requiredContexts: ['static'] });

        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            machineAuthor: 'ai-teammate', rules: [rule] } });

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 1, 'the non-required cancelled context reran (name list ignored)');
        assert.equal(reruns[0].command, 'gh run rerun 555002 --repo IstiN/flutter_agent_harness');
    });

    test('#695 parity in ANY mode: stale cancel under a fresh green re-stamp does NOT act; a fresh cancel does', function () {
        var sm = smAny(
            { check_runs: [
                { name: 'docs-freshness', conclusion: 'cancelled', status: 'completed',
                  id: 11, started_at: '2026-10-05T10:00:00Z', completed_at: '2026-10-05T10:00:02Z' },
                { name: 'docs-freshness', conclusion: 'success', status: 'completed',
                  id: 12, started_at: '2026-10-05T10:05:00Z', completed_at: '2026-10-05T10:05:40Z' },
                { name: 'kicker / sm-liveness', conclusion: 'success', status: 'completed',
                  id: 13, started_at: '2026-10-05T10:00:00Z', completed_at: '2026-10-05T10:00:41Z' },
                { name: 'kicker / sm-liveness', conclusion: 'cancelled', status: 'completed',
                  id: 14, started_at: '2026-10-05T10:06:00Z', completed_at: '2026-10-05T10:06:40Z' }
            ] },
            { headRuns: [
                { id: 555003, status: 'completed', conclusion: 'cancelled',
                  head_sha: '755abc', run_attempt: 1,
                  created_at: '2026-10-05T10:06:00Z', updated_at: '2026-10-05T10:06:40Z' }
            ],
              jobsByRun: { 555003: [{ name: 'kicker / sm-liveness' }] } });

        sm.action(paramsAny());

        var reruns = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        });
        assert.equal(reruns.length, 1, 'only the context whose LATEST run is cancelled acts');
        assert.equal(reruns[0].command, 'gh run rerun 555003 --repo IstiN/flutter_agent_harness');
        assert.equal(sm.capturedPrComments.length, 1, 'full coverage -> marker posts');
        assert.ok(sm.capturedPrComments[0].body.indexOf('`kicker / sm-liveness`') !== -1);
        assert.ok(sm.capturedPrComments[0].body.indexOf('`docs-freshness`') === -1,
            'the re-stamped context is not claimed (backticked names = the rerun set only)');
    });

    test('once-per-head marker holds in ANY mode; attempt-2 runs are never re-rerun', function () {
        var marker = '🔁 Cancelled required checks re-run: `docs-freshness` ended CANCELLED on this head — ' +
            'evidence. (head `755abc`)';
        var sm = smAny(
            { check_runs: [
                { name: 'docs-freshness', conclusion: 'cancelled', status: 'completed' }
            ] },
            { headRuns: [
                { id: 555002, status: 'completed', conclusion: 'cancelled',
                  head_sha: '755abc', run_attempt: 2,
                  created_at: '2026-10-05T10:00:01Z', updated_at: '2026-10-05T10:00:03Z' }
            ],
              jobsByRun: { 555002: [{ name: 'docs-freshness' }] } },
            [{ body: marker }]);

        sm.action(paramsAny());

        assert.equal(sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh run rerun') === 0;
        }).length, 0, 'marker on this head -> already remedied, waiting on the rerun');
        assert.equal(sm.capturedPrComments.length, 0, 'no duplicate marker');
    });
});
suite('smAgent: cancelled-only red is no-verdict — fail path skips (gh-755)', function () {
    // gh-755 ask 2: fail-validation / rework armers must treat a
    // cancelled-only rollup as NO verdict (skip, wait for the rerun) —
    // never arm rework on it. The headline regression: a PR whose only
    // red is a cancelled check gets a rerun (the remedy above), not an
    // agent:rework leg.

    var RULES = {
        fail: { source: 'github', query: { type: 'pr', labels: ['pr_approved', 'ai_validating'], checks: 'red' },
                localAction: 'fail_validation', limit: 1, id: 'fail-validation' }
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['pr_approved', 'ai_validating'], issueNumber: null,
                   prNumber: n, draft: false, branch: 'ai/gh-755', author: 'ai-teammate',
                   headSha: 'dead755aa' };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    function failRuns(checkRuns, extra) {
        return Object.assign(config('a', 'b'), {
            github: Object.assign({
                items: [prItem(755)],
                pr: { number: 755, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #750 — the thing' },
                commitCheckRuns: checkRuns,
                prComments: []
            }, extra || {})
        });
    }

    test('headline regression: only red is a cancelled check -> NO unarm, NO rework arm, NO report', function () {
        // Query matched checks:red (the rollup snapshot read a red), but
        // at ARM time every latest conclusion on the head is CANCELLED:
        // the fail path must skip entirely — the rerun-cancelled-checks
        // remedy re-stamps the contexts under the still-held ai_validating
        // arm.
        var sm = makeSmAgent(failRuns({ check_runs: [
            { name: 'kicker / sm-liveness', conclusion: 'cancelled', status: 'completed' },
            { name: 'docs-freshness', conclusion: 'cancelled', status: 'completed' }
        ] }));

        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });

        assert.equal(sm.capturedPrLabelRemoves.length, 0,
            'ai_validating stays armed — no verdict, the rerun re-stamps under it');
        assert.equal(sm.capturedPrLabelAdds.length, 0,
            'no agent:rework armed anywhere (issue or PR)');
        assert.equal(sm.capturedPrComments.length, 0, 'no red report on a cancelled-only head');
    });

    test('a real FAILURE next to the cancels is still a verdict — the fail path proceeds', function () {
        var sm = makeSmAgent(failRuns({ check_runs: [
            { name: 'quality / validation', conclusion: 'failure', status: 'completed' },
            { name: 'docs-freshness', conclusion: 'cancelled', status: 'completed' }
        ] }));

        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });

        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.number + ':' + a.labels.join(','); }),
            ['750:agent:rework'], 'the genuine failure re-arms rework on the linked issue');
        assert.ok(sm.capturedPrLabelRemoves.some(function (r) { return r.label === 'ai_validating'; }),
            'the arm is consumed as usual');
        assert.equal(sm.capturedPrComments.length, 1, 'the red report posts');
    });

    test('#695 semantics in the guard: a FAILURE superseded by a fresh green re-stamp is no longer a verdict', function () {
        // Latest-run-per-context: the failure history stays in the rollup,
        // but the context now reads success — the guard mirrors
        // computePrStatus (which would not call this head red either).
        var sm = makeSmAgent(failRuns({ check_runs: [
            { name: 'quality / validation', conclusion: 'failure', status: 'completed',
              id: 21, started_at: '2026-10-05T10:00:00Z', completed_at: '2026-10-05T10:01:00Z' },
            { name: 'quality / validation', conclusion: 'success', status: 'completed',
              id: 22, started_at: '2026-10-05T10:05:00Z', completed_at: '2026-10-05T10:06:00Z' },
            { name: 'docs-freshness', conclusion: 'cancelled', status: 'completed' }
        ] }));

        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });

        assert.equal(sm.capturedPrLabelAdds.length, 0,
            'a re-stamped head is not a red head — no rework arm');
        assert.equal(sm.capturedPrComments.length, 0, 'and no report');
    });

    test('TIMED_OUT counts as a real verdict; a bookkeeping FAILURE does not (#628 parity)', function () {
        var timedOut = makeSmAgent(failRuns({ check_runs: [
            { name: 'quality / validation', conclusion: 'timed_out', status: 'completed' }
        ] }));
        timedOut.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });
        assert.equal(timedOut.capturedPrLabelAdds.length, 1,
            'TIMED_OUT is a verdict — the fail path proceeds');

        var bookkeeping = makeSmAgent(failRuns({ check_runs: [
            { name: 'kicker / sm-liveness', conclusion: 'failure', status: 'completed' },
            { name: 'docs-freshness', conclusion: 'cancelled', status: 'completed' }
        ] }));
        bookkeeping.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });
        assert.equal(bookkeeping.capturedPrLabelAdds.length, 0,
            'a bookkeeping FAILURE is not a verdict (#628: kicker noise is not CI) — no rework arm');
    });

    test('unreadable or empty action-time rollup fails OPEN — a degraded probe never launders a red', function () {
        var errored = makeSmAgent(failRuns(null, { commitCheckRunsError: 'gh: 502 bad gateway' }));
        errored.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });
        assert.equal(errored.capturedPrLabelAdds.length, 1,
            'probe error -> the query-time red stands, rework arms');

        var empty = makeSmAgent(failRuns({ check_runs: [] }));
        empty.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [RULES.fail] } });
        assert.equal(empty.capturedPrLabelAdds.length, 1,
            'empty rollup (no check runs visible) is NOT a cancelled-only rollup — fail open');
    });
});
suite('smAgent: red yields the slot (owner directive 2026-10-04)', function () {
    // Live fa 11:0x: #1194 held ai_validating while its validations went
    // red over and over (rework pushed WIP saves, re-arm, red, loop) and
    // seven approved PRs (#1215..#1223) sat 'FIFO-queued' 40+ min. The
    // directive: (1) a concluded red frees the validate slot in the SAME
    // tick (fail-validation now runs BEFORE validate-armed and drops the
    // open-PRs ioCache after unarming); (2) a head that already went red
    // redHeadCap (default 3) times is never re-armed until a NEW head
    // lands — counted via the 🔴 marker lines fail reports append (#701
    // guest-rework-cap pattern); (3) the arm re-verifies the mutex at
    // ACTION time on a live list (live fa 12:0x: #1194 + #1215 both held
    // ai_validating after a manual strip — the query-time scan had read a
    // stale list). jobParams.redHeadSkip=false is the escape hatch.

    var RULES = {
        fail: { source: 'github',
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'], checks: 'red' },
            localAction: 'fail_validation', limit: 10, id: 'fail-validation' },
        validate: { source: 'github',
            query: { type: 'pr', labels: ['pr_approved'],
                notLabels: ['ai_validating', 'validation_failed'],
                notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                mutex: 'ai_validating', mutexAmong: ['pr_approved'] },
            localAction: 'validate_pr', skipIfValidatedHead: true, redHeadSkip: true,
            limit: 1, id: 'validate-armed', deferRedHead: true },
        // Mirrors sm_github.json revalidate-armed: candidates SELF-HOLD
        // ai_validating (the query requires it) and mutexExcludeSelf: true
        // scopes the drain semantics (#577).
        revalidate: { source: 'github',
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'],
                notMergeState: ['BEHIND', 'DIRTY'], checks: ['none', 'pending'], draft: false,
                mutex: 'ai_validating', mutexAmong: ['pr_approved'], mutexExcludeSelf: true },
            localAction: 'validate_pr', limit: 10, id: 'revalidate-armed' }
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['pr_approved'], issueNumber: null,
            prNumber: n, draft: false };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    function redMarker(sha, n, cap) {
        return '\uD83D\uDD34 red head ' + sha + ' \u2014 red ' + n + '/' + (cap || 3) +
            ' (owner directive 2026-10-04: red yields the slot \u2014 after ' + (cap || 3) +
            ' reds on the same head, validation waits for a NEW head)';
    }

    function runsCli(opts) {
        return function (cmd) {
            if (cmd.command.indexOf('actions/workflows/') !== -1 && cmd.command.indexOf('/runs?') !== -1) {
                var m = /head_sha=([^&"]+)/.exec(cmd.command);
                if (m && m[1] === opts.run.head_sha) {
                    return JSON.stringify({ workflow_runs: [opts.run] });
                }
                return JSON.stringify({ workflow_runs: [] });
            }
            return '';
        };
    }

    function dispatched(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh workflow run') === 0; });
    }

    test('fail_validation → same-tick arm of the NEXT candidate (mock sequence)', function () {
        // One action() = one tick. The items() function models the engine's
        // re-query per rule: rule 1 (fail-validation) sees the red armed
        // #1194; rule 2 (validate-armed, which in sm_github.json now runs
        // AFTER fail-validation) sees the post-unarm world where #1194 is
        // disarmed and #1215 is the oldest eligible candidate.
        var calls = 0;
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: function (rule) {
                    calls++;
                    if (rule.id === 'fail-validation') {
                        return [prItem(1194, { labels: ['pr_approved', 'ai_validating'],
                            author: 'ai-teammate', headSha: 'dead1194aa', branch: 'ai/gh-1194' })];
                    }
                    return [prItem(1215, { labels: ['pr_approved'], branch: 'feat/1215',
                        headSha: 'dead1215aa', author: 'ai-teammate' })];
                },
                pr: { number: 1194, labels: ['pr_approved', 'ai_validating'],
                      body: 'Fixes #1190 — the thing' },
                // The action-time mutex probe reads this LIVE list: after
                // the unarm nobody holds ai_validating → the arm proceeds.
                prList: [
                    { number: 1194, labels: [{ name: 'pr_approved' }], head: { sha: 'dead1194aa' } },
                    { number: 1215, labels: [{ name: 'pr_approved' }], head: { sha: 'dead1215aa' } }
                ],
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.fail, RULES.validate] } });

        assert.equal(calls, 2, 'both rules queried in the same tick');
        // Fail side: the red holder unarms and reports with the red marker.
        assert.ok(sm.capturedPrLabelRemoves.some(function (r) {
            return r.number === 1194 && r.label === 'ai_validating';
        }), '#1194 releases the slot');
        assert.ok(sm.capturedPrComments.some(function (c) {
            return c.number === 1194 && c.body.indexOf(redMarker('dead1194aa', 1, 3)) !== -1;
        }), 'report carries the 1/3 red-head marker');
        // Same-tick yield: the per-tick open-PRs cache is dropped so the
        // arm rule's mutex re-scan sees the freed slot THIS tick.
        assert.ok(sm.capturedIoCacheDrops.some(function (d) {
            return d.kind === 'openPrs' && d.owner === 'a' && d.repo === 'b';
        }), 'fail_validation drops the openPrs ioCache after unarming');
        // Arm side: the NEXT oldest candidate is armed + dispatched in the
        // SAME action() run — no next-tick wait.
        assert.ok(dispatched(sm.capturedCliCommands), '#1215 CI dispatched this tick');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.number === 1215 && a.labels.join(',') === 'ai_validating';
        }), '#1215 takes over the validate slot this tick');
    });

    test('validate-arm SKIPS a candidate whose head equals a recorded red head (cap reached)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(73, { labels: ['pr_approved'], branch: 'feat/73',
                    headSha: 'dead0073aa', author: 'ai-teammate' })],
                prComments: [
                    { body: redMarker('dead0073aa', 1, 3) },
                    { body: redMarker('dead0073aa', 2, 3) },
                    { body: redMarker('dead0073aa', 3, 3) }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.validate] } });

        assert.ok(!dispatched(sm.capturedCliCommands),
            'no CI burn on a head that already went red 3×');
        assert.equal(sm.capturedPrLabelAdds.length, 0,
            'no ai_validating arm — the slot advances to the next approved PR');
    });

    test('validate-arm arms the PR again after a NEW head lands', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(73, { labels: ['pr_approved'], branch: 'feat/73',
                    headSha: 'dead0074aa', author: 'ai-teammate' })],
                // sha73 burned out; the rework landed sha74 — a fresh head.
                prComments: [
                    { body: redMarker('dead0073aa', 1, 3) },
                    { body: redMarker('dead0073aa', 2, 3) },
                    { body: redMarker('dead0073aa', 3, 3) }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.validate] } });

        assert.ok(dispatched(sm.capturedCliCommands),
            'a genuinely new head re-enters validation');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.number === 73 && a.labels.join(',') === 'ai_validating';
        }), 'the arm lands on the fresh head');
    });

    test('jobParams.redHeadSkip=false disables the skip (escape hatch)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(73, { labels: ['pr_approved'], branch: 'feat/73',
                    headSha: 'dead0073aa', author: 'ai-teammate' })],
                prComments: [
                    { body: redMarker('dead0073aa', 1, 3) },
                    { body: redMarker('dead0073aa', 2, 3) },
                    { body: redMarker('dead0073aa', 3, 3) }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            redHeadSkip: false, rules: [RULES.validate] } });

        assert.ok(dispatched(sm.capturedCliCommands),
            'the escape hatch keeps the old always-revalidate behavior');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.number === 73 && a.labels.join(',') === 'ai_validating';
        }), 'armed despite the recorded reds');
    });

    test('fail_validation records the per-head counter (prior 1/3 → new 2/3)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(72, { labels: ['pr_approved', 'ai_validating'],
                    author: 'ai-teammate', headSha: 'dead0072aa', branch: 'ai/gh-71' })],
                pr: { number: 72, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #71' },
                prComments: [{ body: redMarker('dead0072aa', 1, 3) }]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.fail] } });

        assert.equal(sm.capturedPrComments.length, 1, 'exactly one report');
        assert.ok(sm.capturedPrComments[0].body.indexOf(redMarker('dead0072aa', 2, 3)) !== -1,
            'the counter increments per head: 1/3 prior → 2/3 now');
        // A DIFFERENT head's history must not leak into this one.
        assert.ok(sm.capturedPrComments[0].body.indexOf('dead0999aa') === -1,
            'per-head counting — other heads do not inflate the counter');
    });

    test('action-time mutex re-check: latch-skip arm REFUSED while another approved PR holds the slot (live fa 12:0x)', function () {
        // The exact live double-arm: a manual strip left #1194 unarmed; the
        // next tick's query-time mutex scan read a STALE cached list (no
        // holder) and the latch-skip armed #1194 while #1215 already held
        // ai_validating. The action-time probe re-reads the LIVE list and
        // refuses the arm.
        var greenRun = { status: 'completed', conclusion: 'success', head_sha: 'dead1194aa',
            created_at: '2026-10-04T10:00:00Z', updated_at: '2026-10-04T10:05:00Z' };
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1194, { labels: ['pr_approved', 'ai_validated'],
                    branch: 'ai/gh-1194', headSha: 'dead1194aa', author: 'ai-teammate' })],
                prStatus: { checkConclusion: 'green' },
                // LIVE list: #1215 already holds the mutex (approved scope).
                prList: [
                    { number: 1194, labels: [{ name: 'pr_approved' }, { name: 'ai_validated' }],
                      head: { sha: 'dead1194aa' } },
                    { number: 1215, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { sha: 'dead1215aa' } }
                ],
                prComments: []
            },
            onCliExecute: runsCli({ run: greenRun })
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.validate] } });

        assert.equal(sm.capturedPrLabelAdds.length, 0,
            'NO second ai_validating holder — the one-validation invariant holds');
        assert.ok(!dispatched(sm.capturedCliCommands), 'no dispatch either');
    });

    test('action-time mutex re-check: dispatch arm REFUSED behind an existing holder', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1216, { labels: ['pr_approved'], branch: 'feat/1216',
                    headSha: 'sha1216', author: 'ai-teammate' })],
                prList: [
                    { number: 1215, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { sha: 'dead1215aa' } },
                    { number: 1216, labels: [{ name: 'pr_approved' }], head: { sha: 'sha1216' } }
                ],
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.validate] } });

        assert.ok(!dispatched(sm.capturedCliCommands), 'no CI dispatch behind a held mutex');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no arm — the holder keeps the slot');
    });

    test('action-time mutex re-check: dev-lane (unapproved) holder does NOT block the merge window', function () {
        // mutexAmong parity: only APPROVED arms serialize validate-armed —
        // an unapproved dev-lane ai_validating arm must not freeze the
        // merge window (owner priority rule 2026-09-22, live fa #801).
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1216, { labels: ['pr_approved'], branch: 'feat/1216',
                    headSha: 'sha1216', author: 'ai-teammate' })],
                prList: [
                    { number: 900, labels: [{ name: 'ai_validating' }, { name: 'ai_developed' }],
                      head: { sha: 'sha900' } },
                    { number: 1216, labels: [{ name: 'pr_approved' }], head: { sha: 'sha1216' } }
                ],
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.validate] } });

        assert.ok(dispatched(sm.capturedCliCommands),
            'dev-lane arm is outside mutexAmong — the approved candidate proceeds');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.number === 1216 && a.labels.join(',') === 'ai_validating';
        }));
    });

    test('action-time mutex re-check honors mutexExcludeSelf: a SELF-HOLDING revalidate candidate drains a leaked stack (review #703 🚨 / fa#1068)', function () {
        // 🚨 post-merge review finding on #703: the re-check blocked a
        // self-holding revalidate-armed candidate on ANY other live holder —
        // githubSource's exclude-self contract (blocked = !selfHolds &&
        // otherHolds) inverted. Live freeze profile (fa#1068): approved
        // #1068 + #1088 both hold ai_validating and the dispatched CI never
        // ran; the verdict rules match nothing, validate-armed defers at
        // query time, and revalidate-armed is the ONLY drain — it MUST fire
        // on the self-holding candidate even while #1088 also holds.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1068, { labels: ['pr_approved', 'ai_validating'],
                    branch: 'ai/gh-1068', headSha: 'dead1068aa', author: 'ai-teammate' })],
                // LIVE probe: the candidate self-holds AND a second approved
                // PR holds — the leaked 2-holder stack.
                prList: [
                    { number: 1068, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { sha: 'dead1068aa' } },
                    { number: 1088, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { sha: 'dead1088aa' } }
                ],
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.revalidate] } });

        assert.ok(dispatched(sm.capturedCliCommands),
            'self-holding candidate re-dispatches CI even with another live holder — the stack drains oldest-first');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.number === 1068 && a.labels.join(',') === 'ai_validating';
        }), 'the revalidate arm lands on the self-holder');
    });

    test('action-time mutex re-check honors mutexExcludeSelf: self as the ONLY live holder proceeds', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1068, { labels: ['pr_approved', 'ai_validating'],
                    branch: 'ai/gh-1068', headSha: 'dead1068aa', author: 'ai-teammate' })],
                prList: [
                    { number: 1068, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { sha: 'dead1068aa' } },
                    { number: 1215, labels: [{ name: 'pr_approved' }], head: { sha: 'dead1215aa' } }
                ],
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.revalidate] } });

        assert.ok(dispatched(sm.capturedCliCommands),
            'the only holder is the candidate itself — nothing blocks the re-validation');
    });

    test('action-time mutex re-check honors mutexExcludeSelf: a candidate NOT holding the mutex still defers to another holder', function () {
        // Mirror case (githubSource parity: blocked = !selfHolds &&
        // otherHolds): the candidate's arm was stripped between the query
        // and the action (manual unarm / racing fail_validation), so it no
        // longer occupies its own slot — another live holder blocks it.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1068, { labels: ['pr_approved', 'ai_validating'],
                    branch: 'ai/gh-1068', headSha: 'dead1068aa', author: 'ai-teammate' })],
                prList: [
                    { number: 1068, labels: [{ name: 'pr_approved' }], head: { sha: 'dead1068aa' } },
                    { number: 1088, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { sha: 'dead1088aa' } }
                ],
                prComments: []
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.revalidate] } });

        assert.ok(!dispatched(sm.capturedCliCommands),
            'no self-hold → the live holder keeps the slot');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no re-arm behind another holder');
    });

    test('sm_github.json: fail-validation runs BEFORE validate-armed; #637 order invariant intact', function () {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var idx = {};
        rules.forEach(function (r, i) { idx[r.id] = i; });

        assert.ok(idx['fail-validation'] < idx['validate-armed'],
            'the red verdict frees the slot in the same tick the arm rule queries (owner directive 2026-10-04)');
        // #637 rule-order invariant: rerun-cancelled-checks stays FIRST
        // (gh-682: cancelled required checks re-run ahead of everything),
        // and merge-validated still precedes sweep-stale-validating.
        assert.equal(rules[0].id, 'rerun-cancelled-checks',
            '#637/gh-682: rerun_cancelled_checks keeps the head of the list — only fail-validation moved');
        assert.ok(idx['merge-validated'] < idx['sweep-stale-validating'],
            '#637: merge-validated consumes a green arm before the sweeper can eat it');
        assert.equal(rules[idx['validate-armed']].redHeadSkip, true,
            'the arm rule carries the red-head skip flag');
    });
});

suite('smAgent: empty rework-lap cap (owner finding 2026-10-04, live fa#1211)', function () {
    // Lap-2 run 37196297279: the rework leg ran the FULL teammate cycle
    // (~7m), closed the rework cycle 'success', uploaded the trace — and
    // pushed ZERO fix commits (threads untouched, head unchanged). The
    // machine believes it worked, so red→rework→red never ends. Backstop
    // at the fail_validation re-arm: a red on the SAME head as the
    // previous red = an EMPTY lap (counted via marker lines, #701
    // pattern); after emptyLapMax (default 1, review #703 retune — was 2,
    // dead code at redHeadCap=3 because the arm-side red-head skip kills
    // the 4th same-head validation the old default needed; reachability:
    // redHeadCap >= emptyLapMax + 2) the agent:rework arm is withheld,
    // ONE owner-escalation comment is posted (review #703 ⚠️ — a capped PR
    // must not exit the conveyor silently), and the report says a human
    // owns the PR. Conveyor trace at the defaults (redHeadCap=3,
    // emptyLapMax=1): red 1/3 arms → empty lap '1/1' (LAST CHANCE) arms →
    // red 3/3 WITHHOLDS + escalates.

    var RULES = {
        fail: { source: 'github',
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'], checks: 'red' },
            localAction: 'fail_validation', limit: 10, id: 'fail-validation' }
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['pr_approved'], issueNumber: null,
            prNumber: n, draft: false };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    function redMarker(sha, n, cap) {
        return '\uD83D\uDD34 red head ' + sha + ' \u2014 red ' + n + '/' + (cap || 3) +
            ' (owner directive 2026-10-04: red yields the slot \u2014 after ' + (cap || 3) +
            ' reds on the same head, validation waits for a NEW head)';
    }
    function emptyLapMarker(sha, n, cap) {
        return '\uD83C\uDF00 empty rework lap ' + n + '/' + (cap || 1) + ' \u2014 head ' + sha +
            ' unchanged since the previous red (owner finding 2026-10-04)';
    }

    test('red again on the SAME head → empty lap 1/1 (LAST CHANCE) counted, arm still fires', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1211, { labels: ['pr_approved', 'ai_validating'],
                    author: 'ai-teammate', headSha: 'dead1211aa', branch: 'ai/gh-1210' })],
                pr: { number: 1211, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #1210' },
                // Previous red was ALSO on shaX — the lap in between moved nothing.
                prComments: [{ body: redMarker('dead1211aa', 1, 3) }]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.fail] } });

        assert.ok(sm.capturedPrComments[0].body.indexOf(emptyLapMarker('dead1211aa', 1, 1).substring(0, 40)) !== -1,
            'the report counts the empty lap (1/1)');
        assert.ok(sm.capturedPrComments[0].body.indexOf('LAST CHANCE') !== -1,
            'at cap 1 the lap line warns the NEXT same-head red withholds the arm');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.number === 1210 && a.labels.join(',') === 'agent:rework';
        }), 'below the cap the rework arm still fires — one more chance to move the head');
    });

    test('cap reached (1 prior empty lap, red 3/3) → rework arm WITHHELD + owner escalation, report says a human owns it', function () {
        // The CONVEYOR-REACHABLE capped state (review #703 ⚠️): red 1/3
        // armed, empty lap '1/1' (LAST CHANCE) armed, THIS fail is the 3rd
        // red on the unchanged head — red 3/3, one prior empty-lap marker.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1211, { labels: ['pr_approved', 'ai_validating'],
                    author: 'ai-teammate', headSha: 'dead1211aa', branch: 'ai/gh-1210' })],
                pr: { number: 1211, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #1210' },
                prComments: [
                    { body: redMarker('dead1211aa', 1, 3) },
                    { body: redMarker('dead1211aa', 2, 3) },
                    { body: emptyLapMarker('dead1211aa', 1, 1) }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.fail] } });

        assert.ok(!sm.capturedPrLabelAdds.some(function (a) {
            return a.labels.join(',') === 'agent:rework';
        }), 'NO rework arm — successful laps that push nothing must not loop forever');
        assert.ok(sm.capturedPrComments[0].body.indexOf('WITHHELD') !== -1,
            'the report says the arm is withheld');
        assert.ok(sm.capturedPrComments[0].body.indexOf('human owns this PR') !== -1,
            'ownership is handed to a human explicitly');
        assert.ok(sm.capturedPrComments[0].body.indexOf(redMarker('dead1211aa', 3, 3)) !== -1,
            'the red-head marker still records red 3/3 for the audit trail');
        // Review #703 ⚠️: the capped PR must not exit the conveyor
        // silently — ONE escalation comment naming the owner follows the
        // report (#701 guest-cap marker style).
        assert.equal(sm.capturedPrComments.length, 2, 'report + exactly one escalation comment');
        assert.ok(sm.capturedPrComments[1].body.indexOf('@a') !== -1,
            'the escalation @-mentions the owner');
        assert.ok(sm.capturedPrComments[1].body.indexOf('needs a human') !== -1,
            'the escalation says a human is needed');
        assert.ok(sm.capturedPrComments[1].body.indexOf('empty-lap cap 1/1') !== -1,
            'the escalation carries the cap state');
        assert.ok(sm.capturedPrLabelRemoves.some(function (r) {
            return r.number === 1211 && r.label === 'ai_validating';
        }), 'the slot is still yielded — only the re-arm is withheld');
    });

    test('cap reached on a machine PR with NO linked issue → PR-anchored arm withheld too + escalation', function () {
        // Composition gap (review #703 rebase): #701 arms UNLINKED machine
        // PRs PR-anchored in the else branch — the empty-lap cap must gate
        // that arm as well, not only the linked-issue arm.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1211, { labels: ['pr_approved', 'ai_validating'],
                    author: 'ai-teammate', headSha: 'dead1211aa', branch: 'ai/plain-branch' })],
                pr: { number: 1211, labels: ['pr_approved', 'ai_validating'], body: 'no closing keyword' },
                prComments: [
                    { body: redMarker('dead1211aa', 1, 3) },
                    { body: redMarker('dead1211aa', 2, 3) },
                    { body: emptyLapMarker('dead1211aa', 1, 1) }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.fail] } });

        assert.ok(!sm.capturedPrLabelAdds.some(function (a) {
            return a.labels.join(',') === 'agent:rework';
        }), 'NO PR-anchored rework arm either — the cap bounds the machine loop regardless of linkage');
        assert.ok(sm.capturedPrComments.some(function (c) {
            return c.body.indexOf('@a') !== -1 && c.body.indexOf('needs a human') !== -1;
        }), 'the owner escalation posts for the unlinked machine PR too');
    });

    test('head MOVED since the previous red → not an empty lap, normal re-arm', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1211, { labels: ['pr_approved', 'ai_validating'],
                    author: 'ai-teammate', headSha: 'beef1212aa', branch: 'ai/gh-1210' })],
                pr: { number: 1211, labels: ['pr_approved', 'ai_validating'], body: 'Fixes #1210' },
                // Previous reds + empty laps were all on shaX; the head moved.
                prComments: [
                    { body: redMarker('dead1211aa', 3, 3) },
                    { body: emptyLapMarker('dead1211aa', 1, 1) }
                ]
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate',
            rules: [RULES.fail] } });

        assert.ok(sm.capturedPrComments[0].body.indexOf('empty rework lap') === -1,
            'a moved head is progress — no empty-lap line for the fresh head');
        assert.ok(sm.capturedPrLabelAdds.some(function (a) {
            return a.number === 1210 && a.labels.join(',') === 'agent:rework';
        }), 'normal re-arm on a fresh head');
    });
});

// ─── gh-748: validate_pr dispatch-race guard ─────────────────────────────────
// Live fa ai/gh-1292 (PR #1295, 2026-10-05 17:45): the kicker push-handler
// and the SM tick both covered the same codeless head with no shared
// 'already ordered' marker. The kicker's workflow_dispatch CI run registers
// in the Actions API SECONDS after `gh workflow run` returns, so the
// dispatch-only duplicate guard probed the lag window, failed OPEN, and a
// second CI run landed 4s after the first (2x queue latency on a single
// runner). The fix: before dispatching, validate_pr counts ANY run on the
// head — any workflow (the kicker's own push run IS visible even when its
// CI child is not), any event, any triggering actor — active now, or
// completed within a short grace (jobParams.dispatchRaceGraceMs, default
// 60s: a run that just finished may have ordered CI that is not registered
// yet).
suite('smAgent: validate_pr dispatch-race guard (gh-748)', function () {

    var RULE = { source: 'github',
        query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'], draft: false },
        localAction: 'validate_pr', limit: 1, id: 'validate-armed' };

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    function pr(n, headSha) {
        return { key: 'pr-' + n, labels: ['pr_approved'], issueNumber: null,
                 prNumber: n, draft: false, branch: 'ai/gh-748', headSha: headSha };
    }

    // Route the THREE head-probe shapes apart: the widened rollup probe
    // (actions/runs?head_sha=), the dispatch-only guard probes
    // (actions/workflows/<wf>/runs?head_sha=), and the stale-head cancel
    // probe (runs?event=workflow_dispatch).
    function cliRouter(headRollup, dispatchedRuns) {
        return function (cmdOpts) {
            var c = cmdOpts.command;
            if (c.indexOf('actions/runs?head_sha=') !== -1) {
                return { output: JSON.stringify({ workflow_runs: headRollup }) };
            }
            if (c.indexOf('/workflows/') !== -1 && c.indexOf('runs?head_sha=') !== -1) {
                return { output: JSON.stringify({ workflow_runs: dispatchedRuns }) };
            }
            if (c.indexOf('runs?event=workflow_dispatch') !== -1) {
                return { output: JSON.stringify({ workflow_runs: [] }) };
            }
            return undefined;
        };
    }

    function dispatchCommands(sm) {
        return sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('gh workflow run ') === 0; });
    }

    function kickerRun(status, doneAgoMs) {
        var r = { name: 'SM kicker', event: 'push', status: status,
                  head_sha: 'beef7480aa', created_at: new Date(Date.now() - 60 * 1000).toISOString() };
        if (status === 'completed') {
            r.conclusion = 'success';
            r.updated_at = new Date(Date.now() - doneAgoMs).toISOString();
        }
        return r;
    }

    test('REGRESSION: an in-flight kicker run on the head blocks the second dispatch', function () {
        // The exact gh-748 shape: the kicker (push event) is mid-grace on the
        // codeless head; its workflow_dispatch CI child has NOT registered in
        // the API yet (the dispatch-only probe reads empty). The SM tick must
        // not order a second CI run — the kicker owns this head's CI order.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [pr(1295, 'beef7480aa')] },
            onCliExecute: cliRouter([kickerRun('in_progress')], [])
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULE] } });

        assert.equal(dispatchCommands(sm).length, 0,
            'exactly one CI run on the head — the kicker dispatched it, the SM stays out');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no ai_validating arm without an SM dispatch');
    });

    test('a run completed within the grace window also blocks (registration lag after a finished kicker)', function () {
        // The kicker completed 4s ago having just ordered CI; that CI run is
        // still invisible to the event-filtered probe. The finished kicker
        // itself is the evidence — skip.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [pr(1296, 'cafe7481bb')] },
            onCliExecute: cliRouter([kickerRun('completed', 4 * 1000)], [])
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULE] } });

        assert.equal(dispatchCommands(sm).length, 0, 'no dispatch inside the grace window');
    });

    test('a run completed OUTSIDE the grace window does not block (the head still gets its validation)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [pr(1297, 'd00d7482cc')] },
            onCliExecute: cliRouter([kickerRun('completed', 9 * 60 * 1000)], [])
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULE] } });

        assert.equal(dispatchCommands(sm).length, 1, 'stale kicker evidence — the SM dispatches');
        assert.deepEqual(sm.capturedPrLabelAdds.map(function (a) { return a.labels.join(','); }),
            ['ai_validating'], 'armed after the clean dispatch');
    });

    test('the guard scans the WHOLE rollup: an old CI run next to a fresh kicker still blocks', function () {
        // Multi-item pin: the race evidence is not required to be entry 0.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [pr(1298, 'f00f7483dd')] },
            onCliExecute: cliRouter([
                { name: 'Quality', event: 'workflow_dispatch', status: 'completed',
                  conclusion: 'success', head_sha: 'f00f7483dd',
                  created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
                  updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
                kickerRun('queued')], [])
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULE] } });

        assert.equal(dispatchCommands(sm).length, 0, 'the queued kicker anywhere in the rollup blocks');
    });

    test('probe failure fails OPEN: the dispatch proceeds (worst case is the duplicate, never a wedge)', function () {
        var router = cliRouter([], []);
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [pr(1299, 'aa7474844e')] },
            onCliExecute: function (cmdOpts) {
                if (cmdOpts.command.indexOf('actions/runs?head_sha=') !== -1) {
                    throw new Error('API rolled over');
                }
                return router(cmdOpts);
            }
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [RULE] } });

        assert.equal(dispatchCommands(sm).length, 1, 'fail OPEN — the arm is never wedged by the guard');
    });

    test('jobParams.dispatchRaceGraceMs = 0 disables the widened guard (legacy single-probe behavior)', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [pr(1300, 'bb7474855f')] },
            onCliExecute: cliRouter([kickerRun('in_progress')], [])
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', dispatchRaceGraceMs: 0, rules: [RULE] } });

        assert.equal(dispatchCommands(sm).length, 1, 'escape hatch: the guard is off');
        assert.ok(!sm.capturedCliCommands.some(function (c) {
            return c.command.indexOf('actions/runs?head_sha=') !== -1; }),
            'guard off — the widened rollup probe never runs');
    });

    test('jobParams.dispatchRaceGraceMs tunes the completed-run window', function () {
        // A 120s window catches a kicker completed 90s ago that the default
        // 60s window would release.
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: { items: [pr(1301, 'cc7474866a')] },
            onCliExecute: cliRouter([kickerRun('completed', 90 * 1000)], [])
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', dispatchRaceGraceMs: 120 * 1000, rules: [RULE] } });

        assert.equal(dispatchCommands(sm).length, 0, 'the deployment-tuned window still blocks');
    });

    test('hasRecentHeadRun semantics (direct pin)', function () {
        var sm = makeSmAgent(config('a', 'b'));
        var grace = 60 * 1000;
        var run = function (over) {
            var r = { id: 1, status: 'queued', head_sha: 's',
                      created_at: new Date().toISOString() };
            if (over) { for (var k in over) { r[k] = over[k]; } }
            return r;
        };
        ['queued', 'in_progress', 'waiting', 'pending', 'requested'].forEach(function (s) {
            assert.equal(sm.hasRecentHeadRun([run({ status: s })], grace), true,
                'active status ' + s + ' blocks');
        });
        assert.equal(sm.hasRecentHeadRun([run({
            status: 'completed', conclusion: 'failure',
            created_at: new Date(Date.now() - 90 * 1000).toISOString(),
            updated_at: new Date(Date.now() - (grace - 1000)).toISOString() })], grace),
            true, 'completed just inside the grace blocks (any conclusion)');
        assert.equal(sm.hasRecentHeadRun([run({
            status: 'completed', conclusion: 'success',
            created_at: new Date(Date.now() - 90 * 1000).toISOString(),
            updated_at: new Date(Date.now() - grace).toISOString() })], grace),
            false, 'exactly at the grace boundary the run no longer blocks');
        assert.equal(sm.hasRecentHeadRun([run({
            status: 'completed', created_at: new Date().toISOString(),
            updated_at: 'not-a-date' })], grace),
            false, 'a completed run with an unparseable timestamp never blocks');
        assert.equal(sm.hasRecentHeadRun([], grace), false, 'empty rollup — no race');
        assert.equal(sm.hasRecentHeadRun(null, grace), false, 'null rollup (failed probe) — fail OPEN');
    });

    test('dispatchRaceGraceMs knob parsing (direct pin)', function () {
        var sm = makeSmAgent(config('a', 'b'));
        assert.equal(sm.dispatchRaceGraceMs({}), 60 * 1000, 'default 60s');
        assert.equal(sm.dispatchRaceGraceMs(undefined), 60 * 1000, 'no jobParams — default');
        assert.equal(sm.dispatchRaceGraceMs({ dispatchRaceGraceMs: 0 }), 0, 'explicit 0 disables');
        assert.equal(sm.dispatchRaceGraceMs({ dispatchRaceGraceMs: '45000' }), 45000, 'string form parses');
        assert.equal(sm.dispatchRaceGraceMs({ dispatchRaceGraceMs: -5 }), 60 * 1000, 'negative falls back');
        assert.equal(sm.dispatchRaceGraceMs({ dispatchRaceGraceMs: 'junk' }), 60 * 1000, 'junk falls back');
    });

});

suite('smAgent: validate-fresh-masked-green (gh-759 post-dev dead zone)', function () {

    // Live fa 2026-10-06, PRs #1305/#1306/#1309/#1311/#1312: the dev leg
    // completes (issue ai_developed + status:In Review) and the fresh PR
    // head immediately carries GREEN check runs from the repo's kicker /
    // CodeQL / analyze workflows — while the DISPATCH-ONLY validation CI
    // (ci.yml, no push trigger) has never been ordered. The check rollup
    // reads 'green', so validate-fresh (checks [none, pending]) never
    // matches; every verdict/re-dispatch rule needs ai_validating or
    // pr_approved — the PR has zero labels. Nothing arms the validation
    // and the PR dead-locks BLOCKED until a human hand-arms it.
    //
    // Fix: the un-armed twin of revalidate-armed-green (the gh-922
    // dead-zone rule). Green rollup + BLOCKED + no ai_validating /
    // pr_approved / ai_validated → validate_pr, which probes the head for
    // a dispatched CI run: none → dispatch + arm; a completed green run →
    // skipIfGreenCi stops the loop (the blocker is another workflow's
    // required check).

    var MASKED_GREEN_RULE = {
        source: 'github',
        query: {
            type: 'pr',
            checks: 'green',
            notLabels: ['ai_validating', 'pr_approved', 'ai_validated', 'chore:pin', 'validation_failed'],
            notMergeState: ['BEHIND', 'DIRTY', 'CLEAN'],
            draft: false
        },
        localAction: 'validate_pr',
        skipIfGreenCi: true,
        limit: 1,
        id: 'validate-fresh-masked-green'
    };

    test('config: rule deployed right after validate-fresh with the masked-green shape', function () {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });
        var rule = byId['validate-fresh-masked-green'];
        assert.ok(rule, 'validate-fresh-masked-green exists in sm_github.json');
        assert.equal(rules.indexOf(rule), rules.indexOf(byId['validate-fresh']) + 1,
            'sits immediately after validate-fresh (its fallback for the shape validate-fresh cannot see)');
        assert.equal(rule.source, 'github');
        assert.equal(rule.localAction, 'validate_pr', 'arms + dispatches via validate_pr');
        assert.equal(rule.skipIfGreenCi, true,
            'a completed green CI run on the head must stop the re-dispatch loop');
        assert.equal(rule.limit, 1, 'validate-fresh pacing — one masked head per tick');
        assert.equal(rule.query.checks, 'green', 'the masked-green rollup is the trigger');
        assert.deepEqual(rule.query.notMergeState, ['BEHIND', 'DIRTY', 'CLEAN'],
            'BLOCKED-only: BEHIND refreshes first, DIRTY is conflict-rework, CLEAN+green is merge-validated');
        ['ai_validating', 'pr_approved', 'ai_validated', 'chore:pin', 'validation_failed'].forEach(function (l) {
            assert.ok((rule.query.notLabels || []).indexOf(l) !== -1, 'excludes ' + l);
        });
        assert.equal(rule.query.draft, false);
    });

    test('engine: arms ai_validating + dispatches CI for the un-armed masked-green head', function () {
        var CUR = '0e33b153c02e861469ea4107cb7ad237cc14bfd6';
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js':
                'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [{
                    key: 'pr-1305', labels: [], issueNumber: 1303, prNumber: 1305,
                    draft: false, branch: 'ai/gh-1303', headSha: CUR
                }]
            },
            onCliExecute: function (cmdOpts) {
                var c = cmdOpts.command;
                if (c.indexOf('runs?head_sha=') !== -1) return { workflow_runs: [] };
                return undefined;
            }
        });
        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            ciWorkflow: 'ci.yml', rules: [MASKED_GREEN_RULE] } });

        var dispatch = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('workflow run ci.yml') !== -1; });
        assert.equal(dispatch.length, 1,
            'the never-ordered validation CI is dispatched on the head');
        assert.equal(dispatch[0].command,
            'gh workflow run ci.yml --repo IstiN/flutter_agent_harness --ref ai/gh-1303');
        assert.equal(sm.capturedPrLabelAdds.length, 1, 'the arm lands');
        assert.equal(sm.capturedPrLabelAdds[0].number, 1305);
        assert.deepEqual(sm.capturedPrLabelAdds[0].labels, ['ai_validating']);
    });

    test('engine: skipIfGreenCi — a completed green CI run on the head stops the arm', function () {
        // The masked-green head whose validation CI ALREADY concluded green
        // (BLOCKED persists because another required context is red): the
        // blocker is not this CI — re-running it every tick would loop.
        var CUR = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js':
                'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [{
                    key: 'pr-1305', labels: [], issueNumber: 1303, prNumber: 1305,
                    draft: false, branch: 'ai/gh-1303', headSha: CUR
                }]
            },
            onCliExecute: function (cmdOpts) {
                var c = cmdOpts.command;
                if (c.indexOf('runs?head_sha=') !== -1) {
                    return { workflow_runs: [
                        { id: 555, event: 'workflow_dispatch', head_branch: 'ai/gh-1303',
                          head_sha: CUR, status: 'completed', conclusion: 'success',
                          created_at: '2026-09-20T00:00:00Z' }
                    ] };
                }
                return undefined;
            }
        });
        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            ciWorkflow: 'ci.yml', rules: [MASKED_GREEN_RULE] } });

        var dispatch = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('workflow run ci.yml') !== -1; });
        assert.equal(dispatch.length, 0, 'green cover already on the head — no re-dispatch');
        assert.equal(sm.capturedPrLabelAdds.length, 0, 'no arm churn');
    });

    test('engine: cancelled CI on the masked head is no cover — CI is dispatched', function () {
        // The concurrency-cancelled dispatch is a non-verdict (gh-922
        // parity): the validation has still never concluded — order it.
        var CUR = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js':
                'module.exports = { repository: { owner: "IstiN", repo: "flutter_agent_harness" } };' },
            github: {
                items: [{
                    key: 'pr-1311', labels: [], issueNumber: 1308, prNumber: 1311,
                    draft: false, branch: 'ai/gh-1308', headSha: CUR
                }]
            },
            onCliExecute: function (cmdOpts) {
                var c = cmdOpts.command;
                if (c.indexOf('runs?head_sha=') !== -1) {
                    return { workflow_runs: [
                        { id: 556, event: 'workflow_dispatch', head_branch: 'ai/gh-1308',
                          head_sha: CUR, status: 'completed', conclusion: 'cancelled',
                          created_at: '2026-09-20T00:00:00Z' }
                    ] };
                }
                return undefined;
            }
        });
        sm.action({ jobParams: { owner: 'IstiN', repo: 'flutter_agent_harness',
            ciWorkflow: 'ci.yml', rules: [MASKED_GREEN_RULE] } });

        var dispatch = sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('workflow run ci.yml') !== -1; });
        assert.equal(dispatch.length, 1, 'cancelled is not a verdict — CI dispatched');
        assert.equal(sm.capturedPrLabelAdds.length, 1, 'arm applied');
    });

    test('config disjointness: validate-fresh and validate-fresh-masked-green never share a candidate', function () {
        // none/pending heads belong to validate-fresh; masked-green heads
        // to this rule. A same-tick double arm on one PR must be impossible.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });
        var fresh = byId['validate-fresh'].query;
        var masked = byId['validate-fresh-masked-green'].query;

        function matches(q, labels, checks) {
            if ((q.labels || []).some(function (l) { return labels.indexOf(l) === -1; })) return false;
            if ((q.notLabels || []).some(function (l) { return labels.indexOf(l) !== -1; })) return false;
            if (q.checks) {
                var want = Array.isArray(q.checks) ? q.checks : [q.checks];
                if (want.indexOf(checks) === -1) return false;
            }
            return true;
        }
        ['none', 'pending', 'green', 'red'].forEach(function (rollup) {
            var a = matches(fresh, [], rollup);
            var b = matches(masked, [], rollup);
            assert.ok(!(a && b), 'rollup ' + rollup + ': both rules match — double arm');
        });
    });

});

// ── Factory state publish: per-leg tokens (gh-781) ───────────────────────────
// The tick's tokens pipeline: LOCAL outputs/token_usage/factory_tokens.json
// first (pack-carrying factories keep working), factory-data branch
// data/fa-tokens.json as the fallback (the leg-side producer's publish).
// Any branch miss → token-less cards, the tick stays green.

suite('smAgent: statePublish tokens — local file first, branch fallback', function() {

    var SP = { channel: 'release', repo: 'o/r', asset: 'fa-state.json' };
    var LOCAL_PATH = 'outputs/token_usage/factory_tokens.json';
    var TOKENS_FETCH =
        'gh api repos/o/r/contents/data/fa-tokens.json?ref=factory-data --jq .content | base64 -d';
    var BRANCH_TOKENS = JSON.stringify({
        'pr-31': [{ leg: 'dev', at: '2026-10-08T10:00:00Z', prompt: 10, completion: 5, total: 15 }],
        'issue-7': [{ leg: 'review', at: '2026-10-08T11:00:00Z', prompt: 1, completion: 2, total: 3 }]
    });
    var PR31 = JSON.stringify([{ number: 31, title: 'feat: tokens', labels: [],
        head: { ref: 'ai/gh-31', sha: 'abc123' }, user: { login: 'me' },
        created_at: '2026-10-08T09:00:00Z' }]);

    /** One tick with statePublish on; returns {sm, state} — state parsed
     *  from the fa-state.json PUT payload. Setting opts.github switches
     *  the source stub to the items list — one quiet ticket walks
     *  processRule past its per-ticket loop into the statePublish block
     *  (an empty source returns before it). Bridge defaults keep every
     *  source local: no real gh calls, no node-harness ReferenceErrors. */
    function publishTick(opts) {
        opts = opts || {};
        opts.github = opts.github || {};
        if (!opts.github.items) {
            opts.github.items = [{ key: 'T-1', labels: [], pr: null }];
        }
        if (!opts.github.prList) opts.github.prList = '[]';
        if (!opts.github.workflowApiRuns) opts.github.workflowApiRuns = [];
        var sm = makeSmAgent(opts);
        sm.action({ jobParams: {
            owner: 'o', repo: 'r', rules: [makeRule('project = T')], statePublish: SP
        } });
        var putCmd = null;
        sm.capturedCliCommands.forEach(function (c) {
            if (c.command.indexOf('-X PUT repos/o/r/contents/data/fa-state.json ') !== -1) {
                putCmd = c.command;
            }
        });
        assert.ok(putCmd, 'fa-state.json PUT captured — the tick published');
        var m = putCmd.match(/printf %s '(.*)' \| base64/);
        assert.ok(m, 'snapshot payload extractable from the PUT');
        return { sm: sm, state: JSON.parse(m[1]) };
    }

    function branchServes(payload) {
        return function (cmdOpts) {
            if (cmdOpts.command === TOKENS_FETCH) return { output: payload };
            return undefined;
        };
    }

    test('AC1: no local file + branch file present → published cards carry tokens rows', function() {
        var run = publishTick({
            fileMap: {},   // no local tokens file
            github: { prList: PR31 },
            onCliExecute: branchServes(BRANCH_TOKENS)
        });
        assert.equal(run.state.schema, 2, 'snapshot schema stays 2 (AC4)');
        var card = run.state.lanes.pr_created.filter(function (c) { return c.pr === 31; })[0];
        assert.ok(card, 'pr-31 card published');
        assert.ok(card.tokens && card.tokens.length === 1, 'card carries tokens rows');
        assert.equal(card.tokens[0].leg, 'dev');
        assert.equal(card.tokens[0].total, 15);
    });

    test('AC2: branch 404 → snapshot publishes WITHOUT tokens, tick stays green', function() {
        var run = publishTick({
            fileMap: {},
            github: { prList: PR31 },
            onCliExecute: function (cmdOpts) {
                if (cmdOpts.command === TOKENS_FETCH) throw new Error('gh: Not Found (HTTP 404)');
                return undefined;
            }
        });
        var card = run.state.lanes.pr_created.filter(function (c) { return c.pr === 31; })[0];
        assert.ok(card, 'card still published');
        assert.equal(card.tokens, undefined, 'token-less card — degradation pinned');
    });

    test('AC2: branch garbage JSON / non-map → snapshot publishes WITHOUT tokens', function() {
        ['<<garbage>>', '[]', '{"pr-31":"not-an-array"}'].forEach(function (payload) {
            var run = publishTick({
                fileMap: {},
                github: { prList: PR31 },
                onCliExecute: branchServes(payload)
            });
            var card = run.state.lanes.pr_created.filter(function (c) { return c.pr === 31; })[0];
            assert.equal(card.tokens, undefined,
                'payload ' + payload + ' → token-less card');
        });
    });

    test('AC3: local file present → branch NOT fetched, LOCAL rows win', function() {
        var fileMap = {};
        fileMap[LOCAL_PATH] = JSON.stringify({
            'pr-31': [{ leg: 'rework', at: '2026-10-08T12:00:00Z', prompt: 2, completion: 3, total: 5 }]
        });
        var run = publishTick({
            fileMap: fileMap,
            github: { prList: PR31 },
            onCliExecute: function (cmdOpts) {
                if (cmdOpts.command.indexOf('fa-tokens.json') !== -1) {
                    throw new Error('local file present — the branch must not be fetched');
                }
                return undefined;
            }
        });
        var branchFetches = run.sm.capturedCliCommands.filter(function (c) {
            return c.command.indexOf('fa-tokens.json') !== -1;
        });
        assert.equal(branchFetches.length, 0, 'branch never fetched when the local file wins');
        var card = run.state.lanes.pr_created.filter(function (c) { return c.pr === 31; })[0];
        assert.ok(card.tokens && card.tokens[0].leg === 'rework', 'LOCAL rows attach');
    });

    test('AC3 edge: local file garbage → null → branch fallback (?? semantics)', function() {
        var fileMap = {};
        fileMap[LOCAL_PATH] = 'not json';
        var run = publishTick({
            fileMap: fileMap,
            github: { prList: PR31 },
            onCliExecute: branchServes(BRANCH_TOKENS)
        });
        var card = run.state.lanes.pr_created.filter(function (c) { return c.pr === 31; })[0];
        assert.ok(card.tokens && card.tokens[0].leg === 'dev',
            'unreadable local file falls through to the branch');
    });

});
