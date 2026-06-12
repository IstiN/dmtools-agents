/**
 * Unit tests for js/common/autoStart.js
 */

function makeBuildEncodedConfigMock() {
    return {
        extractAgentName: function(configFile) {
            return (configFile || '').replace(/^.*\//, '').replace(/\.json$/, '');
        },
        resolveConfigFile: function(rule) {
            return rule && rule.configFile;
        },
        buildEncodedConfig: function(ticketKey, rule, effectiveConfig) {
            return encodeURIComponent(JSON.stringify({
                params: {
                    inputJql: 'key = ' + ticketKey,
                    configFile: rule && rule.configFile,
                    projectKey: rule && rule.projectKey || '',
                    fromSharedBuilder: true
                }
            }));
        }
    };
}

function loadAutoStartHelper(scmMocks, builderMock) {
    var scm = loadModule(
        'js/common/scm.js',
        null,
        Object.assign({
            github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); },
            github_trigger_workflow: function() {}
        }, scmMocks || {})
    );
    var buildEncodedConfig = builderMock || makeBuildEncodedConfigMock();
    return loadModule(
        'js/common/autoStart.js',
        makeRequire({ './scm.js': scm, './buildEncodedConfig.js': buildEncodedConfig })
    );
}

suite('autoStart helper', function() {

    test('skips trigger when same target workflow is already in progress', function() {
        var triggered = false;
        var listedStatuses = [];
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function(workspace, repository, status) {
                listedStatuses.push(status);
                if (status === 'in_progress') {
                    return JSON.stringify({
                        workflow_runs: [{
                            name: 'agents/pr_test_automation_rework.json : TS-90 : TS-90',
                            status: 'in_progress',
                            run_number: 584
                        }]
                    });
                }
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function() {
                triggered = true;
            }
        });

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } },
            customParams: {},
            configFile: 'agents/pr_test_automation_rework.json'
        });

        assert.equal(result, false);
        assert.deepEqual(listedStatuses, ['queued', 'in_progress']);
        assert.equal(triggered, false, 'duplicate active target run should not trigger another workflow');
    });

    test('triggers workflow when no active target run exists', function() {
        var triggeredPayload = null;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function(owner, repo, workflowFile, payload, ref) {
                triggeredPayload = {
                    owner: owner,
                    repo: repo,
                    workflowFile: workflowFile,
                    payload: JSON.parse(payload),
                    ref: ref
                };
            }
        });

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } },
            customParams: { configPath: '.dmtools/config.js' },
            configFile: 'agents/pr_test_automation_rework.json'
        });

        assert.equal(result, true);
        assert.equal(triggeredPayload.owner, 'IstiN');
        assert.equal(triggeredPayload.repo, 'trackstate');
        assert.equal(triggeredPayload.workflowFile, 'ai-teammate.yml');
        assert.equal(triggeredPayload.payload.concurrency_key, 'TS-90');
        assert.equal(triggeredPayload.payload.display_key, 'TS-90');
        assert.equal(triggeredPayload.payload.config_file, 'agents/pr_test_automation_rework.json');
        assert.equal(triggeredPayload.ref, 'main');
        assert.ok(triggeredPayload.payload.encoded_config, 'encoded_config should be present');
        var decoded = JSON.parse(decodeURIComponent(triggeredPayload.payload.encoded_config));
        assert.equal(decoded.params.inputJql, 'key = TS-90', 'encoded_config should contain ticket inputJql');
        assert.equal(decoded.params.configFile, 'agents/pr_test_automation_rework.json', 'encoded_config should come from shared builder');
        assert.equal(decoded.params.fromSharedBuilder, true, 'encoded_config should be built by shared builder');
    });

    test('skips trigger when global active workflow cap is reached', function() {
        var triggered = false;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function(workspace, repository, status) {
                if (status === 'in_progress') {
                    return JSON.stringify({
                        workflow_runs: [{
                            id: 9001,
                            name: 'agents/pr_rework.json : TS-91',
                            status: 'in_progress'
                        }]
                    });
                }
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function() {
                triggered = true;
            }
        });

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'trackstate' }, smMaxWorkflows: 1 },
            customParams: {},
            configFile: 'agents/pr_review.json'
        });

        assert.equal(result, false);
        assert.equal(triggered, false, 'global cap should prevent follow-up auto-starts');
    });

    test('ignores stale queued runs when applying global active workflow cap', function() {
        var triggered = false;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function(workspace, repository, status) {
                if (status === 'queued') {
                    return JSON.stringify({
                        workflow_runs: [{
                            id: 9002,
                            name: 'AI Teammate',
                            status: 'queued',
                            created_at: '2020-01-01T00:00:00Z',
                            updated_at: '2020-01-01T00:00:00Z'
                        }]
                    });
                }
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function() {
                triggered = true;
            }
        });

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'trackstate' }, smMaxWorkflows: 1 },
            customParams: {},
            configFile: 'agents/pr_review.json'
        });

        assert.equal(result, true);
        assert.equal(triggered, true, 'stale queued workflow should not consume the global slot');
    });

});

suite('triggerSmIfIdle', function() {

    test('triggers SM when smFallback=true and no other agent runs are active', function() {
        var triggeredWorkflow = null;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function(owner, repo, workflowFile, payload, ref) {
                triggeredWorkflow = { owner: owner, repo: repo, workflowFile: workflowFile, ref: ref };
            }
        });

        var result = autoStart.triggerSmIfIdle({
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } },
            customParams: { smFallback: true }
        });

        assert.equal(result, true, 'should trigger SM when idle');
        assert.equal(triggeredWorkflow.workflowFile, 'sm.yml');
        assert.equal(triggeredWorkflow.owner, 'IstiN');
        assert.equal(triggeredWorkflow.repo, 'trackstate');
        assert.equal(triggeredWorkflow.ref, 'main');
    });

    test('triggers SM when only 1 run active (the current finishing one)', function() {
        var triggered = false;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function(workspace, repository, status) {
                if (status === 'in_progress') {
                    return JSON.stringify({ workflow_runs: [{ name: 'agents/pr_rework.json : TS-99', status: 'in_progress' }] });
                }
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function() { triggered = true; }
        });

        var result = autoStart.triggerSmIfIdle({
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } },
            customParams: { smFallback: true }
        });

        assert.equal(result, true, 'should trigger SM when only 1 run (current) is active');
        assert.equal(triggered, true);
    });

    test('skips SM when multiple agent runs are active', function() {
        var triggered = false;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function(workspace, repository, status) {
                if (status === 'in_progress') {
                    return JSON.stringify({
                        workflow_runs: [
                            { name: 'agents/pr_rework.json : TS-99', status: 'in_progress' },
                            { name: 'agents/test_case.json : TS-100', status: 'in_progress' }
                        ]
                    });
                }
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function() { triggered = true; }
        });

        var result = autoStart.triggerSmIfIdle({
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } },
            customParams: { smFallback: true }
        });

        assert.equal(result, false, 'should not trigger SM when other agents are running');
        assert.equal(triggered, false);
    });

    test('skips SM when smFallback is not set (opt-in required)', function() {
        var triggered = false;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); },
            github_trigger_workflow: function() { triggered = true; }
        });

        var result = autoStart.triggerSmIfIdle({
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } },
            customParams: {}
        });

        assert.equal(result, false, 'should skip SM when smFallback is not set');
        assert.equal(triggered, false);
    });

    test('skips SM when customParams is empty (no opt-in)', function() {
        var triggered = false;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); },
            github_trigger_workflow: function() { triggered = true; }
        });

        var result = autoStart.triggerSmIfIdle({
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } }
        });

        assert.equal(result, false, 'should skip SM when no customParams');
        assert.equal(triggered, false);
    });

    test('skips SM when config.repository is missing', function() {
        var triggered = false;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); },
            github_trigger_workflow: function() { triggered = true; }
        });

        var result = autoStart.triggerSmIfIdle({
            config: {},
            customParams: { smFallback: true }
        });

        assert.equal(result, false);
        assert.equal(triggered, false);
    });

});
