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
            return {
                repository: { owner: 'test-org', repo: 'test-repo' },
                jira: { project: 'TS' }
            };
        }
    };

    var fileReadMock = function(readOpts) {
        var path = typeof readOpts === 'string' ? readOpts : readOpts.path;
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
