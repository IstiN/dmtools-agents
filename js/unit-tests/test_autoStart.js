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
        buildEncodedConfig: function(ticketKey, rule, effectiveConfig, isLocal) {
            return encodeURIComponent(JSON.stringify({
                params: {
                    inputJql: 'key = ' + ticketKey,
                    configFile: rule && rule.configFile,
                    projectKey: rule && rule.projectKey || '',
                    fromSharedBuilder: true,
                    customParams: isLocal ? { localTeammate: true } : undefined
                }
            }));
        }
    };
}

function wrapListWorkflowRunsMock(fn) {
    if (!fn) return function() { return JSON.stringify({ workflow_runs: [] }); };
    return function(a, b, c, d, e) {
        if (a && typeof a === 'object') {
            return fn(a.workspace, a.repository, a.status, a.workflowId, a.perPage);
        }
        return fn(a, b, c, d, e);
    };
}

function wrapTriggerWorkflowMock(fn) {
    if (!fn) return function() {};
    return function(a, b, c, d, e) {
        if (a && typeof a === 'object') {
            return fn(a.workspace, a.repository, a.workflowId, a.inputs, a.ref);
        }
        return fn(a, b, c, d, e);
    };
}

function loadAutoStartHelper(scmMocks, builderMock, extraMocks) {
    var rawMocks = scmMocks || {};
    var scm = scmReal(Object.assign({}, rawMocks, {
            github_list_workflow_runs: wrapListWorkflowRunsMock(rawMocks.github_list_workflow_runs),
            github_trigger_workflow: wrapTriggerWorkflowMock(rawMocks.github_trigger_workflow)
        }));
    var buildEncodedConfig = builderMock || makeBuildEncodedConfigMock();
    return loadModule(
        'js/common/autoStart.js',
        makeRequire({ './scm.js': scm, './buildEncodedConfig.js': buildEncodedConfig }),
        extraMocks || {}
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

    test('dispatches against config.git.baseBranch instead of assuming main', function() {
        var triggeredPayload = null;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function(owner, repo, workflowFile, payload, ref) {
                triggeredPayload = { ref: ref };
            }
        });

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'trackstate' }, git: { baseBranch: 'master' } },
            customParams: {},
            configFile: 'agents/pr_test_automation_rework.json'
        });

        assert.equal(result, true);
        assert.equal(triggeredPayload.ref, 'master', 'should dispatch against the repo default branch, not a hardcoded main');
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

suite('triggerConfiguredWorkflowForTicket local-execution chaining', function() {

    test('runs the next stage locally instead of dispatching to GitHub Actions when customParams.localTeammate is true', function() {
        var remoteTriggered = false;
        var executedCommands = [];
        var writtenFiles = {};
        var autoStart = loadAutoStartHelper(
            {
                github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); },
                github_trigger_workflow: function() { remoteTriggered = true; }
            },
            null,
            {
                file_write: function(opts) { writtenFiles[opts.path] = opts.content; },
                cli_execute_command: function(opts) { executedCommands.push(opts.command); return ''; }
            }
        );

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'SOHO-132',
            config: { repository: { owner: 'example-org', repo: 'example-repo' } },
            customParams: { localTeammate: true },
            configFile: 'agents/pr_rework.json'
        });

        assert.equal(result, true);
        assert.equal(remoteTriggered, false, 'must not dispatch a GitHub Actions workflow_dispatch in local mode');
        assert.equal(executedCommands.length, 2, 'expected one dmtools run command + one cleanup rm command');
        assert.contains(executedCommands[0], 'dmtools --debug run agents/pr_rework.json');
        assert.contains(executedCommands[0], '--inputJql "key = SOHO-132"');
        assert.contains(executedCommands[0], '--ciRunUrl "local://autochain/SOHO-132/');
        assert.contains(executedCommands[1], 'rm -f');

        var writtenPaths = Object.keys(writtenFiles);
        assert.equal(writtenPaths.length, 1, 'should write exactly one encoded-config temp file');
        var decoded = JSON.parse(decodeURIComponent(writtenFiles[writtenPaths[0]]));
        assert.equal(decoded.params.configFile, 'agents/pr_rework.json');
        assert.deepEqual(decoded.params.customParams, { localTeammate: true },
            'chained job must also be marked localTeammate so further auto-chaining stays local too');
    });

    test('falls back to GitHub Actions dispatch when customParams.localTeammate is not set', function() {
        var remoteTriggered = false;
        var localCommandsRan = false;
        var autoStart = loadAutoStartHelper(
            {
                github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); },
                github_trigger_workflow: function() { remoteTriggered = true; }
            },
            null,
            {
                file_write: function() { localCommandsRan = true; },
                cli_execute_command: function() { localCommandsRan = true; }
            }
        );

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'SOHO-132',
            config: { repository: { owner: 'example-org', repo: 'example-repo' } },
            customParams: {},
            configFile: 'agents/pr_rework.json'
        });

        assert.equal(result, true);
        assert.equal(remoteTriggered, true, 'default (non-local) behavior must be unchanged: dispatch via GitHub Actions');
        assert.equal(localCommandsRan, false, 'must not touch local execution helpers when not in local mode');
    });

    test('returns false and does not throw when writing the encoded config file fails', function() {
        var remoteTriggered = false;
        var autoStart = loadAutoStartHelper(
            {
                github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); },
                github_trigger_workflow: function() { remoteTriggered = true; }
            },
            null,
            {
                file_write: function() { throw new Error('disk full'); },
                cli_execute_command: function() { return ''; }
            }
        );

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'SOHO-132',
            config: { repository: { owner: 'example-org', repo: 'example-repo' } },
            customParams: { localTeammate: true },
            configFile: 'agents/pr_rework.json'
        });

        assert.equal(result, false);
        assert.equal(remoteTriggered, false);
    });

    test('returns false when the local dmtools run command fails', function() {
        var autoStart = loadAutoStartHelper(
            {
                github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); },
                github_trigger_workflow: function() {}
            },
            null,
            {
                file_write: function() {},
                cli_execute_command: function(opts) {
                    if (opts.command.indexOf('dmtools --debug run') !== -1) {
                        throw new Error('job exited non-zero');
                    }
                    return '';
                }
            }
        );

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'SOHO-132',
            config: { repository: { owner: 'example-org', repo: 'example-repo' } },
            customParams: { localTeammate: true },
            configFile: 'agents/pr_rework.json'
        });

        assert.equal(result, false, 'a failed local dmtools run must be reported as a failure, not silently swallowed');
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

    test('dispatches SM fallback against config.git.baseBranch instead of assuming main', function() {
        var triggeredWorkflow = null;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function(owner, repo, workflowFile, payload, ref) {
                triggeredWorkflow = { ref: ref };
            }
        });

        var result = autoStart.triggerSmIfIdle({
            config: { repository: { owner: 'IstiN', repo: 'trackstate' }, git: { baseBranch: 'master' } },
            customParams: { smFallback: true }
        });

        assert.equal(result, true, 'should trigger SM when idle');
        assert.equal(triggeredWorkflow.ref, 'master', 'should dispatch against the repo default branch, not a hardcoded main');
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

suite('autoStart — AI-repo dispatch ref (aiRepository.ref)', function() {

    test('workflow dispatch uses aiRepository.ref over target baseBranch', function() {
        var triggeredPayload = null;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function(owner, repo, workflowFile, payload, ref) {
                triggeredPayload = { owner: owner, repo: repo, ref: ref };
            }
        });

        // Target repo's baseBranch ('develop') does not exist in the AI repo —
        // dispatching there must use the AI repo's own ref.
        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'target-repo' }, git: { baseBranch: 'develop' } },
            customParams: {
                aiRepository: { owner: 'IstiN', repo: 'ai-repo', ref: 'main' }
            },
            configFile: 'agents/pr_review.json'
        });

        assert.equal(result, true);
        assert.equal(triggeredPayload.repo, 'ai-repo');
        assert.equal(triggeredPayload.ref, 'main', 'should dispatch against aiRepository.ref, not the target baseBranch');
    });

    test('workflow dispatch accepts aiRepository.branch as alias', function() {
        var triggeredPayload = null;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function(owner, repo, workflowFile, payload, ref) {
                triggeredPayload = { ref: ref };
            }
        });

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'target-repo' }, git: { baseBranch: 'develop' } },
            customParams: {
                aiRepository: { owner: 'IstiN', repo: 'ai-repo', branch: 'main' }
            },
            configFile: 'agents/pr_review.json'
        });

        assert.equal(result, true);
        assert.equal(triggeredPayload.ref, 'main');
    });

    test('workflow dispatch falls back to target baseBranch when aiRepository has no ref', function() {
        var triggeredPayload = null;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function(owner, repo, workflowFile, payload, ref) {
                triggeredPayload = { ref: ref };
            }
        });

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'trackstate' }, git: { baseBranch: 'master' } },
            customParams: {
                aiRepository: { owner: 'IstiN', repo: 'trackstate' }
            },
            configFile: 'agents/pr_review.json'
        });

        assert.equal(result, true);
        assert.equal(triggeredPayload.ref, 'master', 'same-repo setups keep dispatching against baseBranch');
    });

    test('SM fallback uses aiRepository.ref over target baseBranch', function() {
        var triggeredWorkflow = null;
        var autoStart = loadAutoStartHelper({
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_trigger_workflow: function(owner, repo, workflowFile, payload, ref) {
                triggeredWorkflow = { ref: ref };
            }
        });

        var result = autoStart.triggerSmIfIdle({
            config: { repository: { owner: 'IstiN', repo: 'target-repo' }, git: { baseBranch: 'develop' } },
            customParams: {
                smFallback: true,
                aiRepository: { owner: 'IstiN', repo: 'ai-repo', ref: 'main' }
            }
        });

        assert.equal(result, true);
        assert.equal(triggeredWorkflow.ref, 'main', 'SM fallback should dispatch against aiRepository.ref');
    });

});

// ── gh-1183: characterization tests for previously-untested guard branches ──

suite('autoStart — trigger guard branches (gh-1183 characterization)', function() {

    test('returns false and does not touch scm when ticketKey is missing', function() {
        var scm = makeStubScm();
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } },
            configFile: 'agents/pr_review.json'
        });

        assert.equal(result, false, 'missing ticketKey must skip the trigger');
        assert.deepEqual(scm.listed, [], 'no workflow runs may be listed for an invalid target');
        assert.deepEqual(scm.triggered, [], 'no workflow may be triggered for an invalid target');
    });

    test('returns false and does not touch scm when configFile is missing (label falls back to workflowFile)', function() {
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'trackstate' } }
        });

        assert.equal(result, false, 'missing configFile must skip the trigger');
    });

    test('returns false when neither aiRepository nor config.repository resolve owner/repo', function() {
        var scm = makeStubScm();
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            configFile: 'agents/pr_review.json',
            scm: scm
        });

        assert.equal(result, false, 'unresolvable owner/repo must skip the trigger');
        assert.deepEqual(scm.listed, [], 'no workflow runs may be listed when owner/repo are unresolved');
        assert.deepEqual(scm.triggered, [], 'no workflow may be triggered when owner/repo are unresolved');
    });

    test('honors a pre-built options.scm and never builds its own', function() {
        var scm = makeStubScm(function(status) {
            return JSON.stringify({ workflow_runs: [] });
        });
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'target-repo' } },
            customParams: { aiRepository: { owner: 'IstiN', repo: 'ai-repo' } },
            configFile: 'agents/pr_review.json',
            scm: scm
        });

        assert.equal(result, true);
        var listedStatuses = [];
        for (var i = 0; i < scm.listed.length; i++) listedStatuses.push(scm.listed[i].status);
        assert.deepEqual(listedStatuses, ['queued', 'in_progress', 'waiting', 'pending'],
            'the injected scm must be polled across all four active statuses');
        assert.equal(scm.listed[0].owner, 'IstiN');
        assert.equal(scm.listed[0].repo, 'ai-repo');
        assert.equal(scm.triggered.length, 1, 'the injected scm must receive the dispatch');
        assert.equal(scm.triggered[0].workflowFile, 'ai-teammate.yml');
        assert.equal(scm.triggered[0].ref, 'main');
    });

    test('dispatches a custom workflowFile and keeps label/workflowFile defaults', function() {
        var scm = makeStubScm();
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'target-repo' } },
            customParams: { aiRepository: { owner: 'IstiN', repo: 'ai-repo' } },
            configFile: 'agents/pr_review.json',
            workflowFile: 'custom-teammate.yml',
            scm: scm
        });

        assert.equal(result, true);
        assert.equal(scm.triggered[0].workflowFile, 'custom-teammate.yml',
            'options.workflowFile must override the ai-teammate.yml default');
    });

    test('propagates customParams.projectKey into the dispatch payload', function() {
        var scm = makeStubScm();
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'target-repo' } },
            customParams: { aiRepository: { owner: 'IstiN', repo: 'ai-repo' }, projectKey: 'PROJ' },
            configFile: 'agents/pr_review.json',
            scm: scm
        });

        assert.equal(result, true);
        var payload = JSON.parse(scm.triggered[0].inputs);
        assert.equal(payload.project_key, 'PROJ', 'project_key must come from customParams.projectKey');
        assert.equal(payload.concurrency_key, 'TS-90');
        assert.equal(payload.display_key, 'TS-90');
        assert.equal(payload.config_file, 'agents/pr_review.json');
    });

    test('omits project_key when customParams carry no project key', function() {
        var scm = makeStubScm();
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            config: { repository: { owner: 'IstiN', repo: 'target-repo' } },
            customParams: { aiRepository: { owner: 'IstiN', repo: 'ai-repo' } },
            configFile: 'agents/pr_review.json',
            scm: scm
        });

        assert.equal(result, true);
        var payload = JSON.parse(scm.triggered[0].inputs);
        assert.equal(payload.project_key, '', 'project_key must default to the empty string');
    });

    test('defaults customParams and config when omitted entirely', function() {
        var scm = makeStubScm();
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: 'TS-90',
            configFile: 'agents/pr_review.json',
            scm: scm,
            customParams: { aiRepository: { owner: 'IstiN', repo: 'ai-repo' } }
        });

        assert.equal(result, true, 'a minimal options object (no customParams/config objects) must still dispatch');
        assert.equal(scm.triggered[0].ref, 'main');
    });

});

suite('autoStart — triggerSmIfIdle characterization (gh-1183)', function() {

    test('throws on missing options and returns false for an empty options object (current contract)', function() {
        var scm = makeStubScm();
        var autoStart = loadAutoStartHelper(null, null, {});

        var threw = null;
        try { autoStart.triggerSmIfIdle(); } catch (e) { threw = e; }
        assert.ok(threw, 'calling triggerSmIfIdle() with no options preserves the current dereference error');

        assert.equal(autoStart.triggerSmIfIdle({}), false, 'no options means no smFallback opt-in');
        assert.deepEqual(scm.listed, []);
        assert.deepEqual(scm.triggered, []);
    });

    test('honors options.scm, custom sm and agent workflow files', function() {
        var scm = makeStubScm();
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerSmIfIdle({
            config: {},
            customParams: {
                smFallback: true,
                aiRepository: { owner: 'IstiN', repo: 'ai-repo' }
            },
            smWorkflowFile: 'custom-sm.yml',
            agentWorkflowFile: 'custom-teammate.yml',
            scm: scm
        });

        assert.equal(result, true);
        var listedFiles = [];
        for (var i = 0; i < scm.listed.length; i++) listedFiles.push(scm.listed[i].workflowFile);
        assert.deepEqual(listedFiles, ['custom-teammate.yml', 'custom-teammate.yml', 'custom-teammate.yml', 'custom-teammate.yml'],
            'the agent workflow file must be polled across all four active statuses');
        assert.equal(scm.triggered.length, 1);
        assert.equal(scm.triggered[0].workflowFile, 'custom-sm.yml');
        assert.equal(scm.triggered[0].inputs, '{}');
        assert.equal(scm.triggered[0].ref, 'main');
    });

    test('returns false when the SM trigger call fails', function() {
        var scm = makeStubScm(null, function() {
            throw new Error('dispatch quota exceeded');
        });
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerSmIfIdle({
            config: {},
            customParams: { smFallback: true, aiRepository: { owner: 'IstiN', repo: 'ai-repo' } },
            scm: scm
        });

        assert.equal(result, false, 'a failed SM dispatch must be reported as false, not thrown');
    });

    test('returns false when the SM trigger fails with a non-Error reason', function() {
        var scm = makeStubScm(null, function() {
            throw 'plain string failure';
        });
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.triggerSmIfIdle({
            config: {},
            customParams: { smFallback: true, aiRepository: { owner: 'IstiN', repo: 'ai-repo' } },
            scm: scm
        });

        assert.equal(result, false, 'non-Error throw must still be swallowed into false');
    });

    test('still counts idle when one status listing fails and skips SM when the rest add up busy', function() {
        var autoStart = loadAutoStartHelper(null, null, {});

        var idleScm = makeStubScm(function(status) {
            if (status === 'waiting') throw 'boom'; // non-Error throw exercises the raw-message path
            if (status === 'in_progress') {
                return JSON.stringify({ workflow_runs: [{ name: 'agents/pr_rework.json : TS-99', status: 'in_progress' }] });
            }
            return JSON.stringify({ workflow_runs: [] });
        });
        assert.equal(autoStart.triggerSmIfIdle({
            config: {},
            customParams: { smFallback: true, aiRepository: { owner: 'IstiN', repo: 'ai-repo' } },
            scm: idleScm
        }), true, 'a failed status listing counts as zero, remaining single run keeps the system idle');

        var busyScm = makeStubScm(function(status) {
            if (status === 'waiting') throw new Error('boom');
            if (status === 'in_progress') {
                return JSON.stringify({ workflow_runs: [
                    { name: 'agents/pr_rework.json : TS-99', status: 'in_progress' },
                    { name: 'agents/test_case.json : TS-100', status: 'in_progress' }
                ] });
            }
            return JSON.stringify({ workflow_runs: [] });
        });
        assert.equal(autoStart.triggerSmIfIdle({
            config: {},
            customParams: { smFallback: true, aiRepository: { owner: 'IstiN', repo: 'ai-repo' } },
            scm: busyScm
        }), false, 'a failed status listing counts as zero, two remaining runs still block the trigger');
    });

});

// ── gh-1183: extracted pure helpers ──

suite('autoStart — extracted pure helpers (gh-1183)', function() {

    test('resolveDispatchRef follows the documented precedence chain', function() {
        assert.equal(autoStartModule().resolveDispatchRef('explicit', { ref: 'ai-ref' }, { git: { baseBranch: 'base' } }),
            'explicit', 'options.ref must win');
        assert.equal(autoStartModule().resolveDispatchRef(null, { ref: 'ai-ref' }, { git: { baseBranch: 'base' } }),
            'ai-ref', 'aiRepository.ref must beat the target baseBranch');
        assert.equal(autoStartModule().resolveDispatchRef(undefined, { branch: 'ai-branch' }, { git: { baseBranch: 'base' } }),
            'ai-branch', 'aiRepository.branch is an accepted alias');
        assert.equal(autoStartModule().resolveDispatchRef(null, { owner: 'o' }, { git: { baseBranch: 'base' } }),
            'base', 'target baseBranch applies when the AI repo declares no ref');
        assert.equal(autoStartModule().resolveDispatchRef(null, null, { git: { baseBranch: 'base' } }),
            'base', 'a missing aiRepository must not break the baseBranch fallback');
        assert.equal(autoStartModule().resolveDispatchRef(null, undefined, {}),
            'main', 'everything absent falls back to main');
        assert.equal(autoStartModule().resolveDispatchRef(null, null, {}),
            'main', 'config without git must fall back to main');
    });

    test('resolveAiOwnerRepo prefers aiRepository and falls back to config.repository', function() {
        assert.deepEqual(autoStartModule().resolveAiOwnerRepo(
            { aiRepository: { owner: 'ai-owner', repo: 'ai-repo' } },
            { repository: { owner: 'cfg-owner', repo: 'cfg-repo' } }
        ), { owner: 'ai-owner', repo: 'ai-repo' }, 'aiRepository wins');

        assert.deepEqual(autoStartModule().resolveAiOwnerRepo(
            { aiRepository: { owner: 'ai-owner' } },
            { repository: { owner: 'cfg-owner', repo: 'cfg-repo' } }
        ), { owner: 'ai-owner', repo: 'cfg-repo' }, 'owner and repo resolve independently');

        assert.deepEqual(autoStartModule().resolveAiOwnerRepo(
            {},
            { repository: { owner: 'cfg-owner', repo: 'cfg-repo' } }
        ), { owner: 'cfg-owner', repo: 'cfg-repo' }, 'config.repository is the fallback');

        assert.deepEqual(autoStartModule().resolveAiOwnerRepo({}, {}),
            { owner: undefined, repo: undefined }, 'nothing set resolves to undefined');
    });

    test('resolveTriggerContext applies the documented defaults', function() {
        var ctx = autoStartModule().resolveTriggerContext({
            ticketKey: 'TS-1',
            configFile: 'agents/pr_review.json'
        });
        assert.deepEqual(ctx, {
            ticketKey: 'TS-1',
            customParams: {},
            config: {},
            configFile: 'agents/pr_review.json',
            workflowFile: 'ai-teammate.yml',
            label: 'agents/pr_review.json'
        }, 'missing optional fields get their defaults');

        var ctxOverrides = autoStartModule().resolveTriggerContext({
            ticketKey: 'TS-1',
            configFile: 'agents/pr_review.json',
            customParams: { a: 1 },
            config: { b: 2 },
            workflowFile: 'other.yml',
            label: 'my-label'
        });
        assert.equal(ctxOverrides.workflowFile, 'other.yml');
        assert.equal(ctxOverrides.label, 'my-label', 'explicit label wins');

        assert.equal(autoStartModule().resolveTriggerContext({ configFile: 'x.json' }).label,
            'x.json', 'label falls back to configFile');
        assert.equal(autoStartModule().resolveTriggerContext({}).label,
            'ai-teammate.yml', 'label falls back to workflowFile when configFile is absent too');
    });

    test('workflowRunDisplayName resolves the title chain', function() {
        assert.equal(autoStartModule().workflowRunDisplayName({ display_title: 'T' }), 'T');
        assert.equal(autoStartModule().workflowRunDisplayName({ displayTitle: 'T2' }), 'T2');
        assert.equal(autoStartModule().workflowRunDisplayName({ name: 'N' }), 'N');
        assert.equal(autoStartModule().workflowRunDisplayName({}), '');
        assert.equal(autoStartModule().workflowRunDisplayName(null), '');
        assert.equal(autoStartModule().workflowRunDisplayName(undefined), '');
    });

    test('workflowRunMatchesTicket requires prefix and suffix to agree', function() {
        assert.equal(autoStartModule().workflowRunMatchesTicket('a.json : TS-1', 'a.json', 'TS-1'), true,
            'legacy exact name matches');
        assert.equal(autoStartModule().workflowRunMatchesTicket('a.json : TS-1 : TS-1', 'a.json', 'TS-1'), true,
            'displayName form (config : ticket : ticket) matches');
        assert.equal(autoStartModule().workflowRunMatchesTicket('b.json : TS-1', 'a.json', 'TS-1'), false,
            'matching suffix with wrong prefix must not match');
        assert.equal(autoStartModule().workflowRunMatchesTicket('a.json : TS-2', 'a.json', 'TS-1'), false,
            'matching prefix with wrong ticket suffix must not match');
        assert.equal(autoStartModule().workflowRunMatchesTicket('a.json : TS-1 extra', 'a.json', 'TS-1'), false,
            'extra text after the ticket must not match');
        assert.equal(autoStartModule().workflowRunMatchesTicket('', 'a.json', 'TS-1'), false);
    });

    test('returns false when every status listing fails (list errors never throw)', function() {
        var scm = makeStubScm(function(status) {
            if (status === 'queued') throw new Error('rate limited');
            if (status === 'waiting') throw 'raw failure';
            return JSON.stringify({ workflow_runs: [] });
        });
        var autoStart = loadAutoStartHelper(null, null, {});

        var result = autoStart.hasActiveTargetRun(scm, 'a.json', 'TS-1', 'ai-teammate.yml', 'o', 'r');

        assert.equal(result, false, 'listing failures are skipped, not fatal');
        assert.equal(scm.listed.length, 4, 'all four statuses are still attempted');
    });

    test('findActiveTargetRun skips stale and blank entries and returns the first match', function() {
        var stale = { display_title: 'a.json : TS-1', status: 'queued', updated_at: '2020-01-01T00:00:00Z' };
        var live = { display_title: 'a.json : TS-1', status: 'queued', run_number: 7 };

        assert.equal(autoStartModule().findActiveTargetRun([stale, live], 'a.json', 'TS-1', 'queued'), live,
            'a stale queued run is ignored, the live one is returned');
        assert.equal(autoStartModule().findActiveTargetRun([], 'a.json', 'TS-1', 'queued'), null);
        assert.equal(autoStartModule().findActiveTargetRun([null, undefined], 'a.json', 'TS-1', 'queued'), null,
            'null/undefined run entries are tolerated');
        assert.equal(autoStartModule().findActiveTargetRun(
            [{ display_title: 'other.json : TS-1', status: 'queued' }], 'a.json', 'TS-1', 'queued'), null,
            'runs for other configs never match');
    });

    test('duplicateRunNotice renders the run number/status fallback chain', function() {
        assert.equal(autoStartModule().duplicateRunNotice('a.json : TS-1', { run_number: 584, status: 'in_progress' }, 'queued'),
            'autoStart: skipped duplicate a.json : TS-1 because run #584 is in_progress');
        assert.equal(autoStartModule().duplicateRunNotice('a.json : TS-1', { runNumber: 7 }, 'queued'),
            'autoStart: skipped duplicate a.json : TS-1 because run #7 is queued');
        assert.equal(autoStartModule().duplicateRunNotice('a.json : TS-1', { id: 99 }, 'queued'),
            'autoStart: skipped duplicate a.json : TS-1 because run #99 is queued');
        assert.equal(autoStartModule().duplicateRunNotice('a.json : TS-1', {}, 'waiting'),
            'autoStart: skipped duplicate a.json : TS-1 because run #? is waiting');
    });

    test('countListedWorkflowRuns sums run counts across statuses and tolerates listing failures', function() {
        var scm = makeStubScm(function(status) {
            if (status === 'queued') return JSON.stringify({ workflow_runs: [{ id: 1 }, { id: 2 }] });
            if (status === 'in_progress') return JSON.stringify({ workflow_runs: [{ id: 3 }] });
            if (status === 'waiting') throw 'raw failure';
            return JSON.stringify({ workflow_runs: [] });
        });
        assert.equal(autoStartModule().countListedWorkflowRuns(scm, 'ai-teammate.yml', 'o', 'r'), 3,
            'failed status listings count as zero, successful ones sum up');
        assert.equal(scm.listed.length, 4, 'all four statuses are polled');
        assert.equal(scm.listed[0].perPage, 50, 'runs are listed with the canonical per-page size of 50');
    });

    test('buildWorkflowDispatchPayload carries the dispatch input contract', function() {
        assert.deepEqual(autoStartModule().buildWorkflowDispatchPayload('TS-1', 'agents/x.json', 'ENC', 'PROJ'), {
            concurrency_key: 'TS-1',
            display_key: 'TS-1',
            config_file: 'agents/x.json',
            encoded_config: 'ENC',
            project_key: 'PROJ'
        });
        assert.equal(autoStartModule().buildWorkflowDispatchPayload('TS-1', 'agents/x.json', 'ENC', '').project_key, '');
    });

    test('projectLogSuffix renders only when a project key exists', function() {
        assert.equal(autoStartModule().projectLogSuffix('PROJ'), ', project=PROJ');
        assert.equal(autoStartModule().projectLogSuffix(''), '');
        assert.equal(autoStartModule().projectLogSuffix(null), '');
    });

    test('resolveSmFallbackOptions applies the documented defaults', function() {
        assert.deepEqual(autoStartModule().resolveSmFallbackOptions({}), {
            config: {},
            customParams: {},
            smWorkflowFile: 'sm.yml',
            agentWorkflowFile: 'ai-teammate.yml'
        });
        var opts = autoStartModule().resolveSmFallbackOptions({
            config: { a: 1 },
            customParams: { b: 2 },
            smWorkflowFile: 's.yml',
            agentWorkflowFile: 'a.yml'
        });
        assert.deepEqual(opts, { config: { a: 1 }, customParams: { b: 2 }, smWorkflowFile: 's.yml', agentWorkflowFile: 'a.yml' });
    });

    test('resolveAiTargetOrWarn returns null and warns when owner/repo cannot be resolved', function() {
        assert.deepEqual(autoStartModule().resolveAiTargetOrWarn(
            { aiRepository: { owner: 'o', repo: 'r' } }, {}, 'autoStart: '),
            { owner: 'o', repo: 'r' }, 'resolvable targets pass through');
        assert.equal(autoStartModule().resolveAiTargetOrWarn({}, {}, 'autoStart: '), null,
            'unresolvable owner/repo returns null');
        assert.equal(autoStartModule().resolveAiTargetOrWarn(
            { aiRepository: { owner: 'o' } }, {}, 'SM fallback: '), null,
            'owner without repo is not a valid target');
    });

});

// ── gh-122: characterization of formatWorkflowRunSummary / collectActiveWorkflowRuns ──
// Pins every fallback chain BEFORE the helper extraction — these must stay green
// across the refactor verbatim.

suite('autoStart — formatWorkflowRunSummary characterization (gh-122)', function() {

    test('a null run renders the workflow-run title, active status and ? age/id', function() {
        assert.equal(autoStartModule().formatWorkflowRunSummary(null, undefined),
            'workflow run [active, age ?, id ?]');
    });

    test('fallbackStatus fills in when the run carries no status of its own', function() {
        assert.equal(autoStartModule().formatWorkflowRunSummary({ run_number: 7 }, 'queued'),
            'workflow run [queued, age ?, id 7]');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ run_number: 7 }),
            'workflow run [active, age ?, id 7]', 'no fallback status at all → active');
    });

    test('id chain prefers id, then databaseId, then run_number, then runNumber, then ?', function() {
        assert.equal(autoStartModule().formatWorkflowRunSummary({ id: 1, databaseId: 2, run_number: 3, runNumber: 4 }, 'queued'),
            'workflow run [queued, age ?, id 1]', 'id wins');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ databaseId: 2, run_number: 3, runNumber: 4 }, 'queued'),
            'workflow run [queued, age ?, id 2]', 'databaseId is next');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ run_number: 3, runNumber: 4 }, 'queued'),
            'workflow run [queued, age ?, id 3]', 'run_number is next');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ runNumber: 4 }, 'queued'),
            'workflow run [queued, age ?, id 4]', 'runNumber is next');
        assert.equal(autoStartModule().formatWorkflowRunSummary({}, 'queued'),
            'workflow run [queued, age ?, id ?]', 'nothing set renders ?');
    });

    test('title chain prefers display_title, then displayTitle, then name, then the default', function() {
        assert.equal(autoStartModule().formatWorkflowRunSummary(
            { display_title: 'T', displayTitle: 'T2', name: 'N', id: 9 }, 'queued'), 'T [queued, age ?, id 9]');
        assert.equal(autoStartModule().formatWorkflowRunSummary(
            { displayTitle: 'T2', name: 'N', id: 9 }, 'queued'), 'T2 [queued, age ?, id 9]');
        assert.equal(autoStartModule().formatWorkflowRunSummary(
            { name: 'N', id: 9 }, 'queued'), 'N [queued, age ?, id 9]');
    });

    test('url is appended when any alias is present and omitted otherwise', function() {
        assert.equal(autoStartModule().formatWorkflowRunSummary({ id: 9, html_url: 'https://x/1' }, 'queued'),
            'workflow run [queued, age ?, id 9] https://x/1', 'html_url wins');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ id: 9, htmlUrl: 'https://x/2' }, 'queued'),
            'workflow run [queued, age ?, id 9] https://x/2', 'htmlUrl is next');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ id: 9, url: 'https://x/3' }, 'queued'),
            'workflow run [queued, age ?, id 9] https://x/3', 'url is last');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ id: 9 }, 'queued'),
            'workflow run [queued, age ?, id 9]', 'no url → no trailing space');
    });

    test('unparseable timestamps render age ?', function() {
        assert.equal(autoStartModule().formatWorkflowRunSummary(
            { id: 9, updated_at: 'not-a-date' }, 'queued'),
            'workflow run [queued, age ?, id 9]');
    });

    test('fresh timestamps render minute and hour+minute ages', function() {
        var minutesAgo = function(m) { return new Date(Date.now() - m * 60000).toISOString(); };
        assert.equal(autoStartModule().formatWorkflowRunSummary({ id: 9, updated_at: minutesAgo(5) }, 'queued'),
            'workflow run [queued, age 5m, id 9]');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ id: 9, updated_at: minutesAgo(125) }, 'queued'),
            'workflow run [queued, age 2h 5m, id 9]');
        assert.equal(autoStartModule().formatWorkflowRunSummary({ id: 9, updated_at: minutesAgo(120) }, 'queued'),
            'workflow run [queued, age 2h, id 9]', 'a whole hour renders without minutes');
    });

});

suite('autoStart — collectActiveWorkflowRuns characterization (gh-122)', function() {

    var FRESH = function() { return new Date(Date.now() - 60000).toISOString(); };

    function scmReturningRuns(perStatus) {
        return {
            listWorkflowRuns: function(status) {
                if (perStatus[status] === 'throw') throw new Error('rate limited');
                return JSON.stringify({ workflow_runs: perStatus[status] || [] });
            }
        };
    }

    test('collects one summary per run across all four statuses', function() {
        var result = autoStartModule().collectActiveWorkflowRuns(scmReturningRuns({
            queued: [{ id: 1, display_title: 'a.json : TS-1', status: 'queued', updated_at: FRESH() }],
            in_progress: [{ id: 2, display_title: 'b.json : TS-2', status: 'in_progress', updated_at: FRESH() }],
            waiting: [{ id: 3, display_title: 'c.json : TS-3', status: 'waiting', updated_at: FRESH() }],
            pending: [{ id: 4, display_title: 'd.json : TS-4', status: 'pending', updated_at: FRESH() }]
        }), 'ai-teammate.yml', 'o', 'r');

        assert.equal(result.count, 4);
        assert.deepEqual(result.summaries, [
            'a.json : TS-1 [queued, age 1m, id 1]',
            'b.json : TS-2 [in_progress, age 1m, id 2]',
            'c.json : TS-3 [waiting, age 1m, id 3]',
            'd.json : TS-4 [pending, age 1m, id 4]'
        ]);
    });

    test('deduplicates the same run id re-listed under multiple statuses', function() {
        var run = { id: 42, display_title: 'a.json : TS-1', status: 'queued', updated_at: FRESH() };
        var result = autoStartModule().collectActiveWorkflowRuns(scmReturningRuns({
            queued: [run], in_progress: [run]
        }), 'ai-teammate.yml', 'o', 'r');

        assert.equal(result.count, 1, 'the second sighting of the same id is ignored');
        assert.equal(result.summaries.length, 1);
    });

    test('skips stale non-running runs; null entries become anonymous counted runs', function() {
        var stale = { id: 1, display_title: 'a.json : TS-1', status: 'queued', updated_at: '2020-01-01T00:00:00Z' };
        var result = autoStartModule().collectActiveWorkflowRuns(scmReturningRuns({
            queued: [stale, null, { id: 2, display_title: 'live', status: 'queued', updated_at: FRESH() }],
            in_progress: [{ id: 3, display_title: 'old-but-running', status: 'in_progress', updated_at: '2020-01-01T00:00:00Z' }]
        }), 'ai-teammate.yml', 'o', 'r');

        assert.equal(result.count, 3, 'stale queued skipped; null entry counted as an anonymous run');
        assert.contains(result.summaries[0], ' [queued, age ?, id ?]',
            'the null entry renders with every fallback and comes first');
        assert.contains(result.summaries[1], 'live [queued');
        assert.contains(result.summaries[2], 'old-but-running [in_progress',
            'an old in_progress run is never stale');
    });

    test('listing failures for some statuses are skipped, the rest still counted', function() {
        var result = autoStartModule().collectActiveWorkflowRuns(scmReturningRuns({
            queued: 'throw',
            waiting: 'throw',
            in_progress: [{ id: 8, display_title: 'b.json : TS-2', status: 'in_progress', updated_at: FRESH() }],
            pending: []
        }), 'ai-teammate.yml', 'o', 'r');

        assert.equal(result.count, 1, 'failed listings contribute zero, not a crash');
    });

    test('runs without ids get distinct display-title:index:status identities', function() {
        var result = autoStartModule().collectActiveWorkflowRuns(scmReturningRuns({
            queued: [
                { display_title: 'no-id-a', status: 'queued', updated_at: FRESH() },
                { display_title: 'no-id-b', status: 'queued', updated_at: FRESH() },
                { status: 'queued', updated_at: FRESH() }
            ]
        }), 'ai-teammate.yml', 'o', 'r');

        assert.equal(result.count, 3, 'title-less fallback keys stay unique via index:status');
    });

});

// ── gh-122: extracted pure helpers (tests written first, then the extraction) ──

suite('autoStart — extracted summary helpers (gh-122)', function() {

    test('workflowRunTitle resolves the display chain with the workflow-run default', function() {
        assert.equal(autoStartModule().workflowRunTitle({ display_title: 'T' }), 'T');
        assert.equal(autoStartModule().workflowRunTitle({ displayTitle: 'T2' }), 'T2');
        assert.equal(autoStartModule().workflowRunTitle({ name: 'N' }), 'N');
        assert.equal(autoStartModule().workflowRunTitle({}), 'workflow run');
        assert.equal(autoStartModule().workflowRunTitle(null), 'workflow run');
    });

    test('workflowRunStatus prefers the run status, then the fallback, then active', function() {
        assert.equal(autoStartModule().workflowRunStatus({ status: 'queued' }, 'waiting'), 'queued');
        assert.equal(autoStartModule().workflowRunStatus({}, 'waiting'), 'waiting');
        assert.equal(autoStartModule().workflowRunStatus({}, undefined), 'active');
        assert.equal(autoStartModule().workflowRunStatus({}, null), 'active');
    });

    test('workflowRunId resolves the identifier fallback chain', function() {
        assert.equal(autoStartModule().workflowRunId({ id: 1, databaseId: 2 }), 1);
        assert.equal(autoStartModule().workflowRunId({ databaseId: 2, run_number: 3 }), 2);
        assert.equal(autoStartModule().workflowRunId({ run_number: 3, runNumber: 4 }), 3);
        assert.equal(autoStartModule().workflowRunId({ runNumber: 4 }), 4);
        assert.equal(autoStartModule().workflowRunId({}), '?');
    });

    test('workflowRunUrl resolves the url alias chain', function() {
        assert.equal(autoStartModule().workflowRunUrl({ html_url: 'u1' }), 'u1');
        assert.equal(autoStartModule().workflowRunUrl({ htmlUrl: 'u2' }), 'u2');
        assert.equal(autoStartModule().workflowRunUrl({ url: 'u3' }), 'u3');
        assert.equal(autoStartModule().workflowRunUrl({}), '');
    });

    test('activeRunKey prefers ids and falls back to title:index:status', function() {
        assert.equal(autoStartModule().activeRunKey({ id: 7 }, 'queued', 0), 7);
        assert.equal(autoStartModule().activeRunKey({ databaseId: 8 }, 'queued', 0), 8);
        assert.equal(autoStartModule().activeRunKey({ run_number: 9 }, 'queued', 0), 9);
        assert.equal(autoStartModule().activeRunKey({ display_title: 'T' }, 'queued', 2), 'T:2:queued');
        assert.equal(autoStartModule().activeRunKey({ name: 'N' }, 'waiting', 3), 'N:3:waiting');
        assert.equal(autoStartModule().activeRunKey({}, 'pending', 1), ':1:pending');
    });

    test('collectActiveRunsForStatus appends unique non-stale runs and returns how many', function() {
        var seen = {};
        var summaries = [];
        var fresh = new Date(Date.now() - 60000).toISOString();
        var stale = { id: 1, display_title: 'stale', status: 'queued', updated_at: '2020-01-01T00:00:00Z' };
        var first = { id: 2, display_title: 'first', status: 'queued', updated_at: fresh };
        var dupe = { id: 2, display_title: 'first again', status: 'queued', updated_at: fresh };

        assert.equal(autoStartModule().collectActiveRunsForStatus([stale, first, dupe, null], 'queued', seen, summaries), 2,
            'stale skipped, first added, duplicate skipped, null counted as anonymous');
        assert.deepEqual(summaries, ['first [queued, age 1m, id 2]', 'workflow run [queued, age ?, id ?]']);
        assert.equal(autoStartModule().collectActiveRunsForStatus([first], 'queued', seen, summaries), 0,
            'a run already in seen is never added twice');
        assert.equal(summaries.length, 2);
    });

});

// ── gh-1183 test scaffolding ──

function autoStartModule() {
    return loadModule(
        'js/common/autoStart.js',
        makeRequire({
            './scm.js': {},
            './buildEncodedConfig.js': makeBuildEncodedConfigMock()
        }),
        {}
    );
}

function makeStubScm(listImpl, triggerImpl) {
    return {
        listed: [],
        triggered: [],
        listWorkflowRuns: function(status, workflowFile, perPage, owner, repo) {
            this.listed.push({ status: status, workflowFile: workflowFile, perPage: perPage, owner: owner, repo: repo });
            if (listImpl) return listImpl(status, workflowFile, perPage, owner, repo);
            return JSON.stringify({ workflow_runs: [] });
        },
        triggerWorkflow: function(owner, repo, workflowFile, inputs, ref) {
            this.triggered.push({ owner: owner, repo: repo, workflowFile: workflowFile, inputs: inputs, ref: ref });
            if (triggerImpl) return triggerImpl(owner, repo, workflowFile, inputs, ref);
            return null;
        }
    };
}

// ── gh-1230 CRAP characterization: buildEncodedConfig mock contract ──────────

suite('autoStart — buildEncodedConfig mock contract (gh-1230 characterization)', function() {

    test('extractAgentName: empty/missing config file and nested paths', function() {
        var m = makeBuildEncodedConfigMock();
        assert.equal(m.extractAgentName(undefined), '');
        assert.equal(m.extractAgentName(''), '');
        assert.equal(m.extractAgentName('story_development.json'), 'story_development');
        assert.equal(m.extractAgentName('agents/nested/dir/bug_development.json'), 'bug_development');
    });

    test('resolveConfigFile: rule without configFile and with one', function() {
        var m = makeBuildEncodedConfigMock();
        assert.equal(m.resolveConfigFile(undefined), undefined);
        assert.equal(m.resolveConfigFile({}), undefined);
        assert.equal(m.resolveConfigFile({ configFile: 'agents/pr_review.json' }), 'agents/pr_review.json');
    });

    test('buildEncodedConfig: local and remote shapes, projectKey default', function() {
        var m = makeBuildEncodedConfigMock();
        var local = JSON.parse(decodeURIComponent(m.buildEncodedConfig('GH-1', { configFile: 'a.json', projectKey: 'PROJ' }, null, true)));
        assert.equal(local.params.inputJql, 'key = GH-1');
        assert.equal(local.params.configFile, 'a.json');
        assert.equal(local.params.projectKey, 'PROJ');
        assert.equal(local.params.fromSharedBuilder, true);
        assert.deepEqual(local.params.customParams, { localTeammate: true });
        var remote = JSON.parse(decodeURIComponent(m.buildEncodedConfig('GH-2', { configFile: 'b.json' }, null, false)));
        assert.equal(remote.params.projectKey, '', 'missing projectKey defaults to empty string');
        assert.equal(remote.params.customParams, undefined, 'remote shape has no customParams');
    });
});

// ---------------------------------------------------------------------------
// gh-1242: parseWorkflowRuns — every parse path (string/object/array/invalid)
// ---------------------------------------------------------------------------

suite('autoStart — parseWorkflowRuns', function() {

    test('falsy raw (null / empty string) → empty list', function() {
        var autoStart = loadAutoStartHelper();
        assert.deepEqual(autoStart.parseWorkflowRuns(null), []);
        assert.deepEqual(autoStart.parseWorkflowRuns(''), []);
    });

    test('JSON string array → the parsed runs (2+ items)', function() {
        var autoStart = loadAutoStartHelper();
        var runs = autoStart.parseWorkflowRuns('[{"id":1},{"id":2}]');
        assert.equal(runs.length, 2);
        assert.equal(runs[1].id, 2);
    });

    test('JSON string object → its workflow_runs (2+ items)', function() {
        var autoStart = loadAutoStartHelper();
        var runs = autoStart.parseWorkflowRuns('{"workflow_runs":[{"id":10},{"id":11}]}');
        assert.equal(runs.length, 2);
        assert.equal(runs[0].id, 10);
    });

    test('JSON string object without workflow_runs → empty list', function() {
        var autoStart = loadAutoStartHelper();
        assert.deepEqual(autoStart.parseWorkflowRuns('{"total_count":0}'), []);
    });

    test('invalid JSON string → empty list (warn, never throws)', function() {
        var autoStart = loadAutoStartHelper();
        assert.deepEqual(autoStart.parseWorkflowRuns('not-json{'), []);
    });

    test('object payload → array passthrough / workflow_runs extraction', function() {
        var autoStart = loadAutoStartHelper();
        var arr = [{ id: 1 }, { id: 2 }];
        assert.equal(autoStart.parseWorkflowRuns(arr), arr, 'an array payload is returned as-is');
        var runs = autoStart.parseWorkflowRuns({ workflow_runs: [{ id: 3 }] });
        assert.equal(runs.length, 1);
        assert.equal(runs[0].id, 3);
        assert.deepEqual(autoStart.parseWorkflowRuns({ other: true }), [],
            'object without workflow_runs → empty list');
    });

});
