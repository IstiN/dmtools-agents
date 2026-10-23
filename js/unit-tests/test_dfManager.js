/**
 * Unit tests for js/dfManager.js
 */

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
                commands.push(args.command);
                if (opts.cliThrow) throw new Error(opts.cliThrow);
                return '';
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
