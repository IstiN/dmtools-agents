/**
 * Unit tests for js/dfManager.js
 */

// gh-1198: module-level mock bodies keep makeDfManager's closure complexity
// at its baseline (the CRAP ratchet covers test files too).
function dfReadFile(opts, readOpts) {
    var path = typeof readOpts === 'string' ? readOpts : readOpts.path;
    if (opts.files && opts.files[path] !== undefined) return opts.files[path];
    if (path === 'agents/sm.json') {
        return JSON.stringify({
            params: {
                jobParams: {
                    rules: [
                        {
                            jql: "project = {jiraProject} AND status = 'In Review'",
                            configFile: 'agents/pr_review.json',
                            skipIfLabel: 'sm_story_review_triggered',
                            addLabel: 'sm_story_review_triggered'
                        }
                    ]
                }
            }
        });
    }
    return null;
}

function dfExecCommand(opts, commands, args) {
    commands.push(args.command);
    if (opts.cliThrow) throw new Error(opts.cliThrow);
    return '';
}

function makeDfManager(opts) {
    opts = opts || {};
    var removedLabels = [];
    var triggered = [];
    var written = [];
    var commands = [];
    var jqls = [];

    var scmProvider = {
        listPrs: function() { return opts.prs || []; },
        listWorkflowRuns: function(status) {
            if (opts.runsByStatus && opts.runsByStatus[status]) return opts.runsByStatus[status];
            return [];
        },
        triggerWorkflow: function(owner, repo, workflowFile, payload, ref) {
            triggered.push({ owner: owner, repo: repo, workflowFile: workflowFile, payload: payload, ref: ref });
        },
        getRemoteRepoInfo: function() { return { owner: 'test-org', repo: 'test-repo' }; }
    };
    var scmModule = {
        createScm: function() { return scmProvider; }
    };
    var configLoader = {
        loadProjectConfig: function() {
            return Object.assign({
                repository: { owner: 'test-org', repo: 'test-repo' },
                jira: { project: 'TS' }
            }, opts.projectConfig);
        },
        resolveDefaultWorkflowRef: configLoaderModule.resolveDefaultWorkflowRef
    };

    var fileReadMock = function(readOpts) {
        return dfReadFile(opts, readOpts);
    };

    var dfMocks = {
            file_read: fileReadMock,
            file_write: function(arg1, arg2) {
                if (typeof arg1 === 'string') {
                    written.push({ path: arg1, content: arg2 });
                } else {
                    written.push({ path: arg1.path, content: arg1.content });
                }
            },
            jira_search_by_jql: function(search) {
                jqls.push(search.jql);
                return opts.tickets || [];
            },
            jira_remove_label: function(args) {
                removedLabels.push(args);
            },
            cli_execute_command: function(args) {
                return dfExecCommand(opts, commands, args);
            }
    };
    var df = loadModule(
        'js/dfManager.js',
        makeRequire({
            './configLoader.js': configLoader,
            './common/scm.js': scmModule,
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), dfMocks)
        }),
        dfMocks
    );

    return {
        action: df.action,
        module: df,
        removedLabels: removedLabels,
        triggered: triggered,
        written: written,
        commands: commands,
        jqls: jqls
    };
}

suite('dfManager', function() {
    test('builds SM label JQL from project and labels', function() {
        var df = makeDfManager().module;
        assert.equal(
            df.buildSmLabelJql('TS', ['sm_a', 'sm_b']),
            'project = TS AND labels in ("sm_a", "sm_b") ORDER BY updated ASC'
        );
    });

    test('reports stale SM labels when no active run references ticket', function() {
        var df = makeDfManager({
            tickets: [
                {
                    key: 'TS-86',
                    fields: {
                        status: { name: 'In Rework' },
                        labels: ['sm_story_rework_triggered'],
                        updated: '2026-05-09T15:00:00.000Z'
                    }
                }
            ],
            runsByStatus: { in_progress: [] }
        });

        var report = df.action({
            jobParams: {
                customParams: {
                    nowMs: Date.parse('2026-05-09T17:00:00.000Z'),
                    staleMinutes: 45
                }
            }
        });

        assert.equal(report.counts.anomalies, 1);
        assert.equal(report.anomalies[0].type, 'stale-sm-label');
        assert.equal(report.anomalies[0].ticketKey, 'TS-86');
        assert.equal(df.removedLabels.length, 0, 'audit mode must not mutate Jira');
        assert.ok(df.written.length > 0, 'report should be written');
    });

    test('flags repeated failure loops on the same ticket', function() {
        var df = makeDfManager({
            tickets: [
                {
                    key: 'TS-909',
                    fields: {
                        status: { name: 'Failed' },
                        labels: ['sm_bug_creation_triggered'],
                        updated: '2026-05-09T16:59:00.000Z'
                    }
                }
            ],
            runsByStatus: {
                completed: [
                    {
                        status: 'completed',
                        conclusion: 'failure',
                        workflowName: 'bug_creation',
                        display_title: 'agents/bug_creation.json : TS-909'
                    },
                    {
                        status: 'completed',
                        conclusion: 'failure',
                        workflowName: 'bug_creation',
                        display_title: 'agents/bug_creation.json : TS-909'
                    },
                    {
                        status: 'completed',
                        conclusion: 'failure',
                        workflowName: 'bug_creation',
                        display_title: 'agents/bug_creation.json : TS-909'
                    }
                ]
            }
        });

        var report = df.action({
            jobParams: {
                customParams: {
                    nowMs: Date.parse('2026-05-09T17:00:00.000Z'),
                    staleMinutes: 45
                }
            }
        });

        var repeated = null;
        for (var i = 0; i < report.anomalies.length; i++) {
            if (report.anomalies[i].type === 'repeated-failure-loop') {
                repeated = report.anomalies[i];
                break;
            }
        }

        assert.ok(repeated, 'should report repeated failure loop');
        assert.equal(repeated.ticketKey, 'TS-909');
        assert.equal(repeated.workflowRuns, 3);
        assert.equal(repeated.severity, 'blocking');
    });

    test('does not report stale labels while matching run is active', function() {
        var df = makeDfManager({
            tickets: [
                {
                    key: 'TS-86',
                    fields: {
                        status: { name: 'In Rework' },
                        labels: ['sm_story_rework_triggered'],
                        updated: '2026-05-09T15:00:00.000Z'
                    }
                }
            ],
            runsByStatus: {
                in_progress: [
                    { status: 'in_progress', display_title: 'agents/pr_rework.json : TS-86' }
                ]
            }
        });

        var report = df.action({
            jobParams: {
                customParams: {
                    nowMs: Date.parse('2026-05-09T17:00:00.000Z'),
                    staleMinutes: 45
                }
            }
        });

        assert.equal(report.counts.anomalies, 0);
    });

    test('safe recovery removes stale label and triggers SM once', function() {
        var df = makeDfManager({
            tickets: [
                {
                    key: 'TS-86',
                    fields: {
                        status: { name: 'In Rework' },
                        labels: ['sm_story_rework_triggered'],
                        updated: '2026-05-09T15:00:00.000Z'
                    }
                }
            ]
        });

        var report = df.action({
            jobParams: {
                customParams: {
                    autoRecover: true,
                    nowMs: Date.parse('2026-05-09T17:00:00.000Z'),
                    staleMinutes: 45
                }
            }
        });

        assert.equal(report.actions.length, 2);
        assert.deepEqual(df.removedLabels[0], { key: 'TS-86', label: 'sm_story_rework_triggered' });
        assert.equal(df.triggered.length, 1);
        assert.equal(df.triggered[0].workflowFile, 'sm.yml');
        assert.equal(df.triggered[0].payload, '{}');
        assert.equal(report.actions[1].reason, 'released stale SM label for TS-86');
    });

    test('classifies labels from previous statuses as obsolete cleanup', function() {
        var df = makeDfManager({
            tickets: [
                {
                    key: 'TS-23',
                    fields: {
                        status: { name: 'In Testing' },
                        labels: ['sm_story_review_triggered'],
                        updated: '2026-05-09T15:00:00.000Z'
                    }
                }
            ]
        });

        var report = df.action({
            jobParams: {
                customParams: {
                    autoRecover: true,
                    nowMs: Date.parse('2026-05-09T17:00:00.000Z'),
                    staleMinutes: 45
                }
            }
        });

        assert.equal(report.anomalies[0].type, 'obsolete-sm-label');
        assert.equal(df.removedLabels.length, 1);
        assert.equal(df.triggered.length, 0, 'obsolete cleanup should not retrigger SM');
    });

    test('reports approved clean PR that did not merge', function() {
        var df = makeDfManager({
            tickets: [
                {
                    key: 'TS-100',
                    fields: {
                        status: { name: 'In Review' },
                        labels: ['pr_approved'],
                        updated: '2026-05-09T16:50:00.000Z'
                    }
                }
            ],
            prs: [
                {
                    number: 42,
                    title: 'TS-100 implement feature',
                    head: { ref: 'ai/TS-100' },
                    mergeable_state: 'clean',
                    html_url: 'https://github.test/pr/42'
                }
            ]
        });

        var report = df.action({
            jobParams: {
                customParams: {
                    nowMs: Date.parse('2026-05-09T17:00:00.000Z')
                }
            }
        });

        assert.equal(report.anomalies.length, 1);
        assert.equal(report.anomalies[0].type, 'approved-pr-not-merged');
        assert.equal(report.anomalies[0].prNumber, 42);
    });

    test('triggers SM workflow on configured git.baseBranch when params.workflowRef is omitted (epam/dm.ai#765)', function() {
        var df = makeDfManager({
            projectConfig: {
                repository: { owner: 'test-org', repo: 'test-repo' },
                jira: { project: 'TS' },
                git: { baseBranch: 'master' }
            },
            tickets: [
                {
                    key: 'TS-86',
                    fields: {
                        status: { name: 'In Rework' },
                        labels: ['sm_story_rework_triggered'],
                        updated: '2026-05-09T15:00:00.000Z'
                    }
                }
            ]
        });

        df.action({
            jobParams: {
                customParams: {
                    autoRecover: true,
                    nowMs: Date.parse('2026-05-09T17:00:00.000Z'),
                    staleMinutes: 45
                }
            }
        });

        assert.equal(df.triggered.length, 1);
        assert.equal(df.triggered[0].ref, 'master');
    });
});

suite('dfManager.asArray', function() {
    function loadDf() {
        return makeDfManager().module;
    }

    test('returns [] for falsy input', function() {
        var asArray = loadDf().asArray;
        assert.deepEqual(asArray(null), []);
        assert.deepEqual(asArray(undefined), []);
        assert.deepEqual(asArray(0), []);
        assert.deepEqual(asArray(''), []);
        assert.deepEqual(asArray(false), []);
    });

    test('returns the input array as-is', function() {
        var arr = [{ key: 'TS-1' }, { key: 'TS-2' }];
        assert.deepEqual(loadDf().asArray(arr), arr);
    });

    test('unwraps a values container', function() {
        assert.deepEqual(loadDf().asArray({ values: ['a', 'b'] }), ['a', 'b']);
    });

    test('unwraps an items container', function() {
        assert.deepEqual(loadDf().asArray({ items: ['x'] }), ['x']);
    });

    test('unwraps a workflow_runs container', function() {
        assert.deepEqual(loadDf().asArray({ workflow_runs: [{ id: 1 }] }), [{ id: 1 }]);
    });

    test('unwraps a result container', function() {
        assert.deepEqual(loadDf().asArray({ result: ['r1', 'r2'] }), ['r1', 'r2']);
    });

    test('prefers values over later container keys', function() {
        var value = { values: ['v'], items: ['i'], workflow_runs: ['w'], result: ['r'] };
        assert.deepEqual(loadDf().asArray(value), ['v']);
    });

    test('skips container keys that do not hold arrays', function() {
        assert.deepEqual(loadDf().asArray({ values: 'nope', items: ['i'] }), ['i']);
        assert.deepEqual(loadDf().asArray({ values: { nested: true }, items: 42 }), []);
    });

    test('returns [] when no known container key holds an array', function() {
        assert.deepEqual(loadDf().asArray({ total: 3 }), []);
        assert.deepEqual(loadDf().asArray('plain-string'), []);
        assert.deepEqual(loadDf().asArray(42), []);
    });
});

suite('isActiveRun', function() {
    function loadDf() {
        return makeDfManager().module;
    }

    test('the five active run statuses are active (gh-1085 characterization)', function() {
        assert.equal(loadDf().isActiveRun({ status: 'queued' }), true);
        assert.equal(loadDf().isActiveRun({ status: 'pending' }), true);
        assert.equal(loadDf().isActiveRun({ status: 'requested' }), true);
        assert.equal(loadDf().isActiveRun({ status: 'waiting' }), true);
        assert.equal(loadDf().isActiveRun({ status: 'in_progress' }), true);
    });

    test('status casing is normalized (runStatus lowercases before the check)', function() {
        assert.equal(loadDf().isActiveRun({ status: 'IN_PROGRESS' }), true);
        assert.equal(loadDf().isActiveRun({ status: 'Queued' }), true);
    });

    test('terminal / unknown statuses are NOT active', function() {
        assert.equal(loadDf().isActiveRun({ status: 'completed', conclusion: 'success' }), false);
        assert.equal(loadDf().isActiveRun({ status: 'completed', conclusion: 'failure' }), false);
        assert.equal(loadDf().isActiveRun({ status: 'completed', conclusion: 'cancelled' }), false);
        assert.equal(loadDf().isActiveRun({ status: '' }), false);
        assert.equal(loadDf().isActiveRun({ status: 'mystery' }), false);
    });

    test('missing status or missing run is NOT active', function() {
        assert.equal(loadDf().isActiveRun({}), false);
        assert.equal(loadDf().isActiveRun(null), false);
        assert.equal(loadDf().isActiveRun(undefined), false);
    });

    test('MULTI-ITEM: a mixed workflow-run batch classifies every run (same verdicts as single calls)', function() {
        var runs = [
            { status: 'completed', conclusion: 'success' },
            { status: 'queued' },
            { status: 'in_progress' },
            { status: 'completed', conclusion: 'failure' },
            { status: 'waiting' }
        ];
        var mod = loadDf();
        var active = runs.filter(function(run) { return mod.isActiveRun(run); });
        assert.equal(active.length, 3);
        assert.equal(mod.isActiveRun(runs[0]) + mod.isActiveRun(runs[3]), 0);
    });
});

// ── gh-1198 CRAP extraction: loadSmRules helpers ────────────────────────────

suite('dfManager.loadSmRules + helpers (gh-1198 CRAP extraction)', function() {
    function loadDf(opts) {
        return makeDfManager(opts || {}).module;
    }

    test('helpers exist (extraction landed)', function() {
        var df = loadDf();
        assert.equal(typeof df.loadSmRules, 'function');
        assert.equal(typeof df.embeddedSmRules, 'function');
        assert.equal(typeof df.rulesOfParsedSmConfig, 'function');
        assert.equal(typeof df.smConfigPathOf, 'function');
        assert.equal(typeof df.applySafeRecovery, 'function');
        assert.equal(typeof df.recoverAnomaly, 'function');
        assert.equal(typeof df.releaseAnomalyLabels, 'function');
        assert.equal(typeof df.requestPrBranchUpdate, 'function');
    });

    suite('embeddedSmRules (pure precedence)', function() {
        test('params.rules (array) wins over smRules and the file', function() {
            var rules = [{ jql: 'a', configFile: 'x.json' }];
            var out = loadDf().embeddedSmRules({ rules: rules, smRules: [{ jql: 'b' }] });
            assert.equal(out, rules, 'the params.rules array reference wins');
        });

        test('params.smRules (array) wins when rules is absent', function() {
            var rules = [{ jql: 'b' }];
            assert.equal(loadDf().embeddedSmRules({ smRules: rules }), rules);
        });

        test('non-array rules/smRules fall through (null = read the file)', function() {
            assert.equal(loadDf().embeddedSmRules({ rules: 'nope', smRules: 42 }), null);
            assert.equal(loadDf().embeddedSmRules({}), null);
            assert.equal(loadDf().embeddedSmRules({ rules: null }), null);
        });
    });

    suite('smConfigPathOf + rulesOfParsedSmConfig (pure)', function() {
        test('smConfigPath override, else the agents pack default', function() {
            assert.equal(loadDf().smConfigPathOf({ smConfigPath: 'cfg/sm.json' }), 'cfg/sm.json');
            assert.equal(loadDf().smConfigPathOf({}), 'agents/sm.json');
            assert.equal(loadDf().smConfigPathOf({ smConfigPath: '' }), 'agents/sm.json');
        });

        test('rulesOfParsedSmConfig digs params.jobParams.rules', function() {
            var rules = [{ jql: 'k = v' }];
            var parsed = { params: { jobParams: { rules: rules } } };
            assert.equal(loadDf().rulesOfParsedSmConfig(parsed), rules);
        });

        test('rulesOfParsedSmConfig degrades to [] on every missing link', function() {
            var df = loadDf();
            assert.deepEqual(df.rulesOfParsedSmConfig(null), []);
            assert.deepEqual(df.rulesOfParsedSmConfig({}), []);
            assert.deepEqual(df.rulesOfParsedSmConfig({ params: {} }), []);
            assert.deepEqual(df.rulesOfParsedSmConfig({ params: { jobParams: {} } }), []);
            assert.deepEqual(df.rulesOfParsedSmConfig({ params: { jobParams: { rules: null } } }), []);
        });
    });

    suite('loadSmRules (file path)', function() {
        test('reads the default agents/sm.json and digs jobParams.rules', function() {
            var rules = loadDf().loadSmRules({});
            assert.equal(rules.length, 1);
            assert.equal(rules[0].skipIfLabel, 'sm_story_review_triggered');
        });

        test('smConfigPath overrides the read path', function() {
            var df = loadDf({ files: { 'cfg/other.json': JSON.stringify({ params: { jobParams: { rules: [{ jql: 'custom' }] } } }) } });
            var out = df.loadSmRules({ smConfigPath: 'cfg/other.json' });
            assert.equal(out.length, 1);
            assert.equal(out[0].jql, 'custom');
        });

        test('unreadable file degrades to [] (null read → JSON null → no rules)', function() {
            assert.deepEqual(loadDf({ files: {} }).loadSmRules({ smConfigPath: 'missing.json' }), []);
        });

        test('unparsable JSON degrades to []', function() {
            assert.deepEqual(loadDf({ files: { 'cfg/bad.json': '{nope' } })
                .loadSmRules({ smConfigPath: 'cfg/bad.json' }), []);
        });
    });
});

// ── gh-1198 CRAP extraction: applySafeRecovery helpers ──────────────────────

suite('dfManager.applySafeRecovery branches (gh-1198 CRAP extraction)', function() {
    function recoveryDf(opts) {
        return makeDfManager(opts);
    }

    test('autoRecover=false (audit) never mutates anything', function() {
        var df = recoveryDf({
            tickets: [{
                key: 'TS-86',
                fields: {
                    status: { name: 'In Rework' },
                    labels: ['sm_story_rework_triggered'],
                    updated: '2026-05-09T15:00:00.000Z'
                }
            }],
            runsByStatus: { in_progress: [] }
        });
        var report = df.action({ jobParams: { customParams: { nowMs: Date.parse('2026-05-09T17:00:00.000Z') } } });
        assert.equal(report.mode, 'audit');
        assert.equal(df.removedLabels.length, 0);
        assert.equal(df.triggered.length, 0);
        assert.equal(df.commands.length, 0);
    });

    test('approved-pr-not-merged recovery triggers SM with the retry-merge reason', function() {
        var df = recoveryDf({
            tickets: [{
                key: 'TS-100',
                fields: {
                    status: { name: 'In Review' },
                    labels: ['pr_approved'],
                    updated: '2026-05-09T16:50:00.000Z'
                }
            }],
            prs: [{
                number: 42,
                title: 'TS-100 implement feature',
                head: { ref: 'ai/TS-100' },
                mergeable_state: 'clean',
                html_url: 'https://github.test/pr/42'
            }]
        });
        var report = df.action({
            jobParams: { customParams: { autoRecover: true, nowMs: Date.parse('2026-05-09T17:00:00.000Z') } }
        });
        var merge = report.actions.filter(function(a) { return a.action === 'trigger-sm'; });
        assert.equal(merge.length, 1);
        assert.equal(merge[0].reason, 'retry merge for approved PR #42');
        assert.equal(df.triggered.length, 1);
        assert.equal(df.removedLabels.length, 0, 'no labels to release');
    });

    test('approved-pr-not-mergeable with safeAction=request-branch-update runs the gh api update-branch', function() {
        var df = recoveryDf({
            tickets: [{
                key: 'TS-140',
                fields: {
                    status: { name: 'In Review' },
                    labels: ['pr_approved'],
                    updated: '2026-05-09T16:50:00.000Z'
                }
            }],
            prs: [{
                number: 7,
                title: 'TS-140 fix bug',
                head: { ref: 'ai/TS-140' },
                mergeable_state: 'behind',
                html_url: 'https://github.test/pr/7'
            }]
        });
        var report = df.action({
            jobParams: { customParams: { autoRecover: true, nowMs: Date.parse('2026-05-09T17:00:00.000Z') } }
        });
        assert.equal(report.anomalies[0].type, 'approved-pr-not-mergeable');
        assert.equal(report.anomalies[0].safeAction, 'request-branch-update');
        assert.deepEqual(df.commands, ['gh api repos/test-org/test-repo/pulls/7/update-branch -X PUT']);
        assert.deepEqual(report.actions.filter(function(a) { return a.action === 'request-branch-update'; }),
            [{ action: 'request-branch-update', prNumber: 7 }]);
        assert.equal(df.triggered.length, 0, 'branch update does not trigger SM');
    });

    test('approved-pr-not-mergeable with safeAction=null (dirty) takes no recovery action', function() {
        var df = recoveryDf({
            tickets: [{
                key: 'TS-141',
                fields: {
                    status: { name: 'In Review' },
                    labels: ['pr_approved'],
                    updated: '2026-05-09T16:50:00.000Z'
                }
            }],
            prs: [{
                number: 8,
                title: 'TS-141 fix bug',
                head: { ref: 'ai/TS-141' },
                mergeable_state: 'dirty',
                html_url: 'https://github.test/pr/8'
            }]
        });
        var report = df.action({
            jobParams: { customParams: { autoRecover: true, nowMs: Date.parse('2026-05-09T17:00:00.000Z') } }
        });
        assert.equal(report.anomalies[0].type, 'approved-pr-not-mergeable');
        assert.equal(report.anomalies[0].safeAction, null);
        assert.equal(df.commands.length, 0);
        assert.equal(df.triggered.length, 0);
        assert.equal(report.actions.length, 0);
    });

    test('failed update-branch transport lands in the actions log (request-branch-update-failed)', function() {
        var df = recoveryDf({
            cliThrow: 'gh: rate limit',
            tickets: [{
                key: 'TS-142',
                fields: {
                    status: { name: 'In Review' },
                    labels: ['pr_approved'],
                    updated: '2026-05-09T16:50:00.000Z'
                }
            }],
            prs: [{
                number: 9,
                title: 'TS-142 fix bug',
                head: { ref: 'ai/TS-142' },
                mergeable_state: 'behind',
                html_url: 'https://github.test/pr/9'
            }]
        });
        var report = df.action({
            jobParams: { customParams: { autoRecover: true, nowMs: Date.parse('2026-05-09T17:00:00.000Z') } }
        });
        assert.deepEqual(df.commands, ['gh api repos/test-org/test-repo/pulls/9/update-branch -X PUT']);
        var failed = report.actions.filter(function(a) { return a.action === 'request-branch-update-failed'; });
        assert.equal(failed.length, 1);
        assert.equal(failed[0].prNumber, 9);
        assert.equal(failed[0].error, 'gh: rate limit');
    });

    test('recoverAnomaly dispatches by anomaly type (direct unit)', function() {
        var df = makeDfManager().module;
        var removed = [];
        var actions = [];
        var triggered = [];
        var ctx = {
            autoRecover: true,
            recoveryState: {},
            repoInfo: { owner: 'o', repo: 'r' },
            params: {},
            config: null,
            tracker: { removeLabel: function(key, label) { removed.push({ key: key, label: label }); } },
            scm: { triggerWorkflow: function(o, r, w, p, ref) { triggered.push({ o: o, r: r, w: w, p: p, ref: ref }); } },
            actions: actions
        };

        // stale-sm-label: labels released, SM triggered
        df.recoverAnomaly(ctx, { type: 'stale-sm-label', ticketKey: 'TS-1', labels: ['l1', 'l2'] });
        assert.deepEqual(removed, [{ key: 'TS-1', label: 'l1' }, { key: 'TS-1', label: 'l2' }]);
        assert.equal(triggered.length, 1);
        assert.deepEqual(actions, [
            { action: 'remove-label', ticketKey: 'TS-1', label: 'l1' },
            { action: 'remove-label', ticketKey: 'TS-1', label: 'l2' },
            { action: 'trigger-sm', reason: 'released stale SM label for TS-1' }
        ]);

        // obsolete-sm-label: labels released, NO SM trigger
        df.recoverAnomaly(ctx, { type: 'obsolete-sm-label', ticketKey: 'TS-2', labels: ['l3'] });
        assert.deepEqual(removed.slice(2), [{ key: 'TS-2', label: 'l3' }]);
        assert.equal(triggered.length, 1, 'obsolete cleanup does not retrigger SM');

        // approved-pr-not-merged: SM triggered (fresh recoveryState — the
        // smTriggered latch suppresses a second trigger within one pass)
        ctx.recoveryState = {};
        df.recoverAnomaly(ctx, { type: 'approved-pr-not-merged', prNumber: 5 });
        assert.equal(triggered.length, 2);

        // the smTriggered latch holds within one recovery pass
        df.recoverAnomaly(ctx, { type: 'approved-pr-not-merged', prNumber: 6 });
        assert.equal(triggered.length, 2, 'second trigger in the same pass is suppressed');

        // approved-pr-not-mergeable without the branch-update safeAction: nothing
        df.recoverAnomaly(ctx, { type: 'approved-pr-not-mergeable', prNumber: 6, safeAction: null });
        assert.equal(triggered.length, 2, 'no trigger for the dirty shape');
        assert.equal(actions.length, 5, 'no action pushed (2+1 remove-label, 2 trigger-sm)');

        // unknown anomaly type: nothing
        df.recoverAnomaly(ctx, { type: 'failed-workflow-run' });
        assert.equal(triggered.length, 2);
        assert.equal(actions.length, 5);
    });

    test('applySafeRecovery no-ops when autoRecover is off (direct unit)', function() {
        var df = makeDfManager().module;
        var ctx = { autoRecover: false, anomalies: [{ type: 'stale-sm-label', ticketKey: 'TS-1', labels: ['l1'] }],
                    tracker: { removeLabel: function() { throw new Error('must not be called'); } }, actions: [] };
        df.applySafeRecovery(ctx);
        assert.deepEqual(ctx.actions, []);
    });
});

// ── gh-1227 CRAP — characterization suites ───────────────────────────────────
// These lock the current branch behavior of detectPrMergeGaps /
// detectRepeatedFailureLoops / parseJsonMaybe / action BEFORE the helper
// extraction; the extraction must keep every assertion green.

suite('dfManager.detectPrMergeGaps (gh-1227 characterization)', function() {
    function gapContext(prs, ticketByKey) {
        return { prs: prs || [], ticketByKey: ticketByKey || {}, anomalies: [] };
    }
    function gapPr(over) {
        return Object.assign({
            number: 42,
            title: 'TS-100 fix the thing',
            head: { ref: 'ai/TS-100' },
            labels: ['pr_approved'],
            mergeable_state: 'clean',
            html_url: 'https://github.test/pr/42'
        }, over || {});
    }
    function firstAnomaly(ctx) { return ctx.anomalies[0] || null; }

    test('PR whose title/ref carries no ticket key is skipped', function() {
        var ctx = gapContext([gapPr({ title: 'no key here', head: { ref: 'main' } })]);
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(ctx.anomalies.length, 0);
    });

    test('PR without number/pullRequestId/id is skipped', function() {
        var ctx = gapContext([gapPr({ number: undefined })]);
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(ctx.anomalies.length, 0);
    });

    test('number falls back to pullRequestId, then id', function() {
        var viaPullRequestId = gapContext([gapPr({ number: undefined, pullRequestId: 7 })]);
        makeDfManager().module.detectPrMergeGaps(viaPullRequestId);
        assert.equal(firstAnomaly(viaPullRequestId).prNumber, 7);

        var viaId = gapContext([gapPr({ number: undefined, pullRequestId: undefined, id: 9 })]);
        makeDfManager().module.detectPrMergeGaps(viaId);
        assert.equal(firstAnomaly(viaId).prNumber, 9);
    });

    test('approved + clean → blocking approved-pr-not-merged with retry-merge action', function() {
        var ctx = gapContext([gapPr({ mergeable_state: 'clean' })]);
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(ctx.anomalies.length, 1);
        var a = firstAnomaly(ctx);
        assert.equal(a.type, 'approved-pr-not-merged');
        assert.equal(a.severity, 'blocking');
        assert.equal(a.ticketKey, 'TS-100');
        assert.equal(a.prNumber, 42);
        assert.equal(a.prUrl, 'https://github.test/pr/42');
        assert.equal(a.mergeState, 'clean');
        assert.equal(a.safeAction, 'trigger-sm-retry-merge');
        assert.equal(a.message, 'PR is approved and clean but still open.');
    });

    test('approved + mergeable behaves like clean', function() {
        var ctx = gapContext([gapPr({ mergeable_state: 'mergeable' })]);
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(firstAnomaly(ctx).type, 'approved-pr-not-merged');
        assert.equal(firstAnomaly(ctx).mergeState, 'mergeable');
    });

    test('approval via the Jira ticket labels alone + dirty → warning, no safe action', function() {
        var ctx = gapContext(
            [gapPr({ labels: [], mergeable_state: 'dirty' })],
            { 'TS-100': { key: 'TS-100', fields: { labels: ['pr_approved'] } } });
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(ctx.anomalies.length, 1);
        var a = firstAnomaly(ctx);
        assert.equal(a.type, 'approved-pr-not-mergeable');
        assert.equal(a.severity, 'warning');
        assert.equal(a.mergeState, 'dirty');
        assert.equal(a.safeAction, null);
    });

    test('approved + behind → request-branch-update safe action', function() {
        var ctx = gapContext([gapPr({ mergeable_state: 'behind' })]);
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(firstAnomaly(ctx).type, 'approved-pr-not-mergeable');
        assert.equal(firstAnomaly(ctx).safeAction, 'request-branch-update');
    });

    test('approved + unknown merge state → no anomaly', function() {
        var ctx = gapContext([gapPr({ mergeable_state: 'unstable' })]);
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(ctx.anomalies.length, 0);
    });

    test('not approved → no anomaly even when clean', function() {
        var ctx = gapContext([gapPr({ labels: [] })]);
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(ctx.anomalies.length, 0);
    });

    test('PR labels normalize to name objects (GitHub label shape)', function() {
        var ctx = gapContext([gapPr({ labels: [{ name: 'pr_approved' }] })]);
        makeDfManager().module.detectPrMergeGaps(ctx);
        assert.equal(ctx.anomalies.length, 1);
    });
});

suite('dfManager.detectRepeatedFailureLoops (gh-1227 characterization)', function() {
    function loopContext(failedRuns, ticketByKey, smLabelSet) {
        return {
            failedRuns: failedRuns || [],
            ticketByKey: ticketByKey || {},
            smLabelSet: smLabelSet || {},
            anomalies: []
        };
    }
    function failedRun(over) {
        return Object.assign({
            status: 'completed',
            conclusion: 'failure',
            workflowName: 'wf_a',
            display_title: 'agents/dev.json : TS-909',
            html_url: 'https://github.test/run/1'
        }, over || {});
    }
    function firstAnomaly(ctx) { return ctx.anomalies[0] || null; }

    test('runs without a ticket key are skipped entirely', function() {
        var ctx = loopContext([failedRun({ display_title: 'no digits' }),
                               failedRun({ display_title: 'still none' }),
                               failedRun({ display_title: 'nope' })]);
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        assert.equal(ctx.anomalies.length, 0);
    });

    test('two failures on one ticket stay silent', function() {
        var ctx = loopContext([failedRun(), failedRun()]);
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        assert.equal(ctx.anomalies.length, 0);
    });

    test('three failures with no ticket → warning, bare message', function() {
        var ctx = loopContext([failedRun(), failedRun(), failedRun()]);
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        assert.equal(ctx.anomalies.length, 1);
        var a = firstAnomaly(ctx);
        assert.equal(a.type, 'repeated-failure-loop');
        assert.equal(a.severity, 'warning', 'no Failed status / label / >=5');
        assert.equal(a.ticketKey, 'TS-909');
        assert.equal(a.workflowRuns, 3);
        assert.deepEqual(a.workflows, { wf_a: 3 });
        assert.deepEqual(a.runUrls, ['https://github.test/run/1']);
        assert.equal(a.status, '');
        assert.equal(a.message, 'Ticket has 3 failed workflow runs (wf_a×3).');
    });

    test('status Failed → blocking', function() {
        var ctx = loopContext([failedRun(), failedRun(), failedRun()],
            { 'TS-909': { key: 'TS-909', fields: { status: { name: 'Failed' }, labels: [] } } });
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        assert.equal(firstAnomaly(ctx).severity, 'blocking');
    });

    test('an SM trigger label on the ticket → blocking', function() {
        var ctx = loopContext([failedRun(), failedRun(), failedRun()],
            { 'TS-909': { key: 'TS-909',
                          fields: { status: { name: 'In Progress' },
                                    labels: ['sm_bug_development_triggered'] } } },
            { sm_bug_development_triggered: true });
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        assert.equal(firstAnomaly(ctx).severity, 'blocking');
    });

    test('five failures → blocking even without ticket context', function() {
        var ctx = loopContext([failedRun(), failedRun(), failedRun(), failedRun(), failedRun()]);
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        assert.equal(firstAnomaly(ctx).severity, 'blocking');
        assert.equal(firstAnomaly(ctx).workflowRuns, 5);
    });

    test('workflow fallbacks: name, then unknown-workflow; summary rides the message', function() {
        var ctx = loopContext([
            failedRun({ workflowName: undefined, name: 'deploy' }),
            failedRun({ workflowName: undefined, name: undefined }),
            failedRun({ workflowName: undefined, name: undefined })
        ]);
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        var a = firstAnomaly(ctx);
        assert.deepEqual(a.workflows, { deploy: 1, 'unknown-workflow': 2 });
        assert.equal(a.message,
            'Ticket has 3 failed workflow runs (deploy×1, unknown-workflow×2).');
    });

    test('run urls collected, deduped; url-less runs contribute nothing', function() {
        var ctx = loopContext([
            failedRun({ html_url: 'https://github.test/run/1' }),
            failedRun({ html_url: 'https://github.test/run/1' }),
            failedRun({ html_url: undefined, url: 'https://github.test/run/2' }),
            failedRun({ html_url: undefined, url: undefined })
        ]);
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        assert.deepEqual(firstAnomaly(ctx).runUrls,
            ['https://github.test/run/1', 'https://github.test/run/2']);
    });

    test('message mentions the status when the ticket is tracked', function() {
        var ctx = loopContext([failedRun(), failedRun(), failedRun()],
            { 'TS-909': { key: 'TS-909',
                          fields: { status: { name: 'In Review' }, labels: [] } } });
        makeDfManager().module.detectRepeatedFailureLoops(ctx);
        assert.equal(firstAnomaly(ctx).message,
            'Ticket has 3 failed workflow runs (wf_a×3) while still in In Review.');
    });
});

suite('dfManager.parseJsonMaybe (gh-1227 characterization)', function() {
    function dfm() { return makeDfManager().module; }

    test('null / undefined / empty string → fallback', function() {
        var df = dfm();
        assert.equal(df.parseJsonMaybe(null, 'fb'), 'fb');
        assert.equal(df.parseJsonMaybe(undefined, 'fb'), 'fb');
        assert.equal(df.parseJsonMaybe('', 'fb'), 'fb');
    });

    test('non-string values pass through untouched', function() {
        var df = dfm();
        var obj = { values: [1] };
        var arr = ['a'];
        assert.equal(df.parseJsonMaybe(obj, 'fb'), obj);
        assert.equal(df.parseJsonMaybe(42, 'fb'), 42);
        assert.equal(df.parseJsonMaybe(arr, 'fb'), arr);
    });

    test('valid JSON string parses', function() {
        var df = dfm();
        assert.deepEqual(df.parseJsonMaybe('{"a":1}', 'fb'), { a: 1 });
        assert.deepEqual(df.parseJsonMaybe('[1,2]', 'fb'), [1, 2]);
    });

    test('invalid JSON string → fallback', function() {
        var df = dfm();
        assert.equal(df.parseJsonMaybe('{not json', 'fb'), 'fb');
        assert.deepEqual(df.parseJsonMaybe('{not json', null), null);
    });
});

suite('dfManager.action params resolution (gh-1227 characterization)', function() {
    test('throws when repository info is missing', function() {
        var df = makeDfManager({ projectConfig: { repository: {} } });
        var threw = null;
        try {
            df.action({ jobParams: { customParams: { nowMs: 0 } } });
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, 'must throw');
        assert.equal(threw.message,
            'DF Manager requires repository.owner/repo in config or an SCM remote.');
    });

    test('params.customParams is honored when jobParams is absent', function() {
        var df = makeDfManager();
        var report = df.action({ customParams: { jiraProject: 'TS', outputPath: 'outputs/custom-report.json' } });
        assert.equal(report.jiraProject, 'TS');
        assert.equal(df.written[0].path, 'outputs/custom-report.json');
    });

    test('params.jobParams without customParams is the params bag', function() {
        var df = makeDfManager();
        var report = df.action({ jobParams: { jiraProject: 'TS', outputPath: 'outputs/jp-report.json' } });
        assert.equal(report.jiraProject, 'TS');
        assert.equal(df.written[0].path, 'outputs/jp-report.json');
    });

    test('bare params (no jobParams/customParams) is the params bag', function() {
        var df = makeDfManager();
        var report = df.action({ jiraProject: 'TS', outputPath: 'outputs/bare-report.json' });
        assert.equal(report.jiraProject, 'TS');
        assert.equal(df.written[0].path, 'outputs/bare-report.json');
    });

    test('falsy primitive params degrade to an empty params bag', function() {
        var df = makeDfManager();
        var report = df.action(0);
        assert.equal(report.jiraProject, 'TS', 'project falls back to config.jira.project');
        assert.equal(report.counts.anomalies, 0);
        assert.equal(df.written[0].path, 'outputs/df_manager_report.json');
    });

    test('report mode mirrors autoRecover (audit vs safe-recover)', function() {
        assert.equal(makeDfManager().action({ jobParams: { customParams: { nowMs: 0 } } }).mode, 'audit');
        assert.equal(makeDfManager().action({
            jobParams: { customParams: { nowMs: 0, autoRecover: true } }
        }).mode, 'safe-recover');
    });

    test('report counts mirror the context lists', function() {
        var df = makeDfManager();
        var report = df.action({ jobParams: { customParams: { nowMs: 0 } } });
        assert.equal(report.success, true);
        assert.ok(report.counts.smLabels > 0, 'default SM labels resolved');
        assert.ok(report.counts.ticketsWithSmLabels === 0);
        assert.ok(report.counts.activeRuns === 0);
        assert.ok(report.counts.failedRuns === 0);
        assert.ok(report.counts.actions === 0);
    });
});
