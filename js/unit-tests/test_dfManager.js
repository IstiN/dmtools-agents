/**
 * Unit tests for agents/js/dfManager.js
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

    var df = loadModule(
        'agents/js/dfManager.js',
        makeRequire({ './configLoader.js': configLoader, './common/scm.js': scmModule }),
        {
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
        }
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
