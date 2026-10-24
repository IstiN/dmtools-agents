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
    var scm = loadModule(
        'js/common/scm.js',
        makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js'),
            './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js', makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') })) }),
        Object.assign({}, rawMocks, {
            github_list_workflow_runs: wrapListWorkflowRunsMock(rawMocks.github_list_workflow_runs),
            github_trigger_workflow: wrapTriggerWorkflowMock(rawMocks.github_trigger_workflow)
        })
    );
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
