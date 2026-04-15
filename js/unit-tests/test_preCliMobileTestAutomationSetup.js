/**
 * Unit tests for agents/js/preCliMobileTestAutomationSetup.js
 *
 * Tests: ticket status move, linked TC fetching, file writing,
 *        branch checkout logic, fallback JQL, error resilience.
 *
 * Uses: configModule, configLoaderModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function loadPreCli(mocks) {
    var fileReadMock = mocks.file_read || function(opts) {
        var p = opts.path;
        if (p.indexOf('.dmtools/config') !== -1) return null;
        try { return file_read(opts); } catch (e) { return null; }
    };

    var freshConfigLoader = loadModule(
        'agents/js/configLoader.js',
        makeRequire({ './config.js': configModule }),
        { file_read: fileReadMock }
    );

    var allMocks = Object.assign({
        jira_move_to_status: function() {},
        jira_search_by_jql: function() { return []; },
        jira_get_ticket: function(opts) { return { key: opts.key || opts, fields: { comment: { comments: [] } } }; },
        file_write: function() {},
        file_read: fileReadMock,
        cli_execute_command: function() { return ''; }
    }, mocks);

    var m = loadModule(
        'agents/js/preCliMobileTestAutomationSetup.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './config.js': configModule
        }),
        allMocks
    );
    return m;
}

/**
 * Build the params object that matches what dmtools passes to the preCliJSAction.
 * workingDir comes through customParams.targetRepository.workingDir → configLoader.
 */
function makeParams(ticketKey, workingDir, overrides) {
    return Object.assign({
        inputFolderPath: 'input/' + ticketKey,
        jobParams: {
            customParams: {
                targetRepository: workingDir ? {
                    owner: 'PostNL-BitDigital',
                    repo: 'PostNL-commercial-mobileApp-automation',
                    baseBranch: 'main',
                    workingDir: workingDir
                } : undefined
            }
        }
    }, overrides || {});
}

// ── Suite: ticket status move ─────────────────────────────────────────────────

suite('preCliMobileTestAutomationSetup — ticket status move', function() {

    test('moves ticket to In Development', function() {
        var moves = [];
        var m = loadPreCli({
            jira_move_to_status: function(opts) { moves.push(opts); },
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: function() { return ''; }
        });
        m.action(makeParams('MAPC-9999', '/tmp/automation-repo'));
        assert.equal(moves.length, 1, 'should move ticket once');
        assert.equal(moves[0].key, 'MAPC-9999', 'should use correct key');
    });

    test('continues even if status move throws', function() {
        var written = [];
        var m = loadPreCli({
            jira_move_to_status: function() { throw new Error('Status move failed'); },
            jira_search_by_jql: function() { return []; },
            file_write: function(p) { written.push(p); },
            cli_execute_command: function() { return ''; }
        });
        // Should not throw; file_write should still be called (linked_test_cases.md)
        m.action(makeParams('MAPC-9999', '/tmp/automation-repo'));
        assert.ok(written.length > 0, 'should still write linked_test_cases.md despite status error');
    });

});

// ── Suite: linked test case fetching ─────────────────────────────────────────

suite('preCliMobileTestAutomationSetup — linked TC fetching', function() {

    test('writes linked_test_cases.md when TCs found via primary JQL', function() {
        var writtenFiles = {};
        var searchCalls = [];

        var m = loadPreCli({
            jira_search_by_jql: function(opts) {
                searchCalls.push(opts.jql);
                if (opts.jql.indexOf('is tested by') !== -1) {
                    return [
                        { key: 'MAPC-TC-1', fields: { summary: 'VoiceOver on modal', status: { name: 'Ready' }, priority: { name: 'High' }, description: 'Step 1: Open modal' } },
                        { key: 'MAPC-TC-2', fields: { summary: 'Close button label', status: { name: 'Draft' }, priority: { name: 'Medium' }, description: 'Verify close button' } }
                    ];
                }
                return [];
            },
            jira_get_ticket: function(opts) {
                return { key: opts.key || opts, fields: { comment: { comments: [] } } };
            },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));

        var mdPath = 'input/MAPC-6618/linked_test_cases.md';
        assert.ok(writtenFiles.hasOwnProperty(mdPath), 'linked_test_cases.md should be written');
        assert.ok(writtenFiles[mdPath].indexOf('MAPC-TC-1') !== -1, 'should contain first TC key');
        assert.ok(writtenFiles[mdPath].indexOf('MAPC-TC-2') !== -1, 'should contain second TC key');
        assert.ok(writtenFiles[mdPath].indexOf('VoiceOver on modal') !== -1, 'should contain TC summary');
    });

    test('falls back to broader JQL when primary JQL returns empty', function() {
        var searchCalls = [];
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function(opts) {
                searchCalls.push(opts.jql);
                // Primary JQL returns empty; fallback returns one TC
                if (opts.jql.indexOf('is tested by') !== -1) return [];
                return [
                    { key: 'MAPC-TC-3', fields: { summary: 'Fallback TC', status: { name: 'Ready' }, priority: { name: 'Low' }, description: null } }
                ];
            },
            jira_get_ticket: function(opts) {
                return { key: opts.key || opts, fields: { comment: { comments: [] } } };
            },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));

        assert.equal(searchCalls.length, 2, 'should try both JQL queries');
        assert.ok(searchCalls[0].indexOf('is tested by') !== -1, 'first call uses primary JQL');
        var mdContent = writtenFiles['input/MAPC-6618/linked_test_cases.md'];
        assert.ok(mdContent.indexOf('MAPC-TC-3') !== -1, 'should contain fallback TC');
    });

    test('writes no-TCs message when both JQL queries return empty', function() {
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));

        var mdContent = writtenFiles['input/MAPC-6618/linked_test_cases.md'];
        assert.ok(mdContent.indexOf('No linked Test Case') !== -1, 'should mention no TCs');
    });

    test('includes recent TC comments in linked_test_cases.md', function() {
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function(opts) {
                if (opts.jql.indexOf('is tested by') !== -1) {
                    return [{ key: 'MAPC-TC-10', fields: { summary: 'Modal TC', status: { name: 'Ready' }, priority: { name: 'High' }, description: 'Steps here' } }];
                }
                return [];
            },
            jira_get_ticket: function(opts) {
                return {
                    key: opts.key || opts,
                    fields: {
                        comment: {
                            comments: [
                                { author: { displayName: 'QA Bot' }, body: 'Run passed on 2026-04-01' },
                                { author: { displayName: 'QA Bot' }, body: 'Run failed on 2026-04-10' }
                            ]
                        }
                    }
                };
            },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));

        var md = writtenFiles['input/MAPC-6618/linked_test_cases.md'];
        assert.ok(md.indexOf('QA Bot') !== -1, 'should include comment author');
        assert.ok(md.indexOf('Run failed on 2026-04-10') !== -1, 'should include recent comment');
    });

});

// ── Suite: Bitrise artifact download ─────────────────────────────────────────

suite('preCliMobileTestAutomationSetup — Bitrise artifact download', function() {

    function makeBitriseMocks(opts) {
        opts = opts || {};
        return {
            jira_move_to_status: function() {},
            jira_search_by_jql: function() { return []; },
            file_write: opts.onFileWrite || function() {},
            cli_execute_command: opts.onCliCommand || function(o) {
                if (o.command && o.command.indexOf('find') !== -1) return 'input/MAPC-6618/app/PostNL Zakelijk.app\n';
                return '';
            },
            github_list_prs: opts.onListPrs || function() {
                return JSON.stringify({ data: [
                    { number: 963, head: { ref: 'story/MAPC-6618' } }
                ]});
            },
            bitrise_list_builds: opts.onListBuilds || function() {
                return JSON.stringify({ data: [
                    { slug: 'build-abc', build_number: 10317, status: 1, status_text: 'success', branch: 'story/MAPC-6618' }
                ]});
            },
            bitrise_list_build_artifacts: opts.onListArtifacts || function() {
                return JSON.stringify({ data: [
                    { slug: 'artifact-xyz', title: 'PostNL Zakelijk-simulator.zip', file_size_bytes: 32000000 }
                ]});
            },
            bitrise_get_build_artifact: opts.onGetArtifact || function() {
                return JSON.stringify({ data: { expiring_download_url: 'https://example.com/app.zip', slug: 'artifact-xyz', title: 'PostNL Zakelijk-simulator.zip' } });
            }
        };
    }

    function makeParamsWithBitrise(ticketKey) {
        return {
            inputFolderPath: 'input/' + ticketKey,
            jobParams: {
                customParams: {
                    targetRepository: {
                        owner: 'PostNL-BitDigital',
                        repo: 'PostNL-commercial-mobileApp-automation',
                        baseBranch: 'main',
                        workingDir: '/tmp/automation-repo'
                    },
                    featurePR: { owner: 'PostNL-BitDigital', repo: 'PostNL-commercial-mobileApp' },
                    bitriseBuild: {
                        appSlug: 'e739ec8c-app-slug',
                        workflowId: 'build_ios_simulator'
                    }
                }
            }
        };
    }

    test('writes app_info.md with App Path when .app found', function() {
        var writtenFiles = {};
        var cliCommands = [];

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(opts) {
                cliCommands.push(opts.command);
                if (opts.command && opts.command.indexOf('find') !== -1) {
                    return 'input/MAPC-6618/app/PostNL Zakelijk.app\n';
                }
                return '';
            }
        }));

        m.action(makeParamsWithBitrise('MAPC-6618'));

        var md = writtenFiles['input/MAPC-6618/app_info.md'];
        assert.ok(md, 'app_info.md should be written');
        assert.ok(md.indexOf('App Path') !== -1, 'should contain App Path');
        assert.ok(md.indexOf('PostNL Zakelijk.app') !== -1, 'should contain .app name');
        assert.ok(md.indexOf('build_ios_simulator') !== -1, 'should contain workflow name');
    });

    test('downloads artifact using curl and unzips', function() {
        var cliCommands = [];

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function() {},
            onCliCommand: function(opts) {
                cliCommands.push(opts.command);
                if (opts.command && opts.command.indexOf('find') !== -1) return 'input/MAPC-6618/app/PostNL Zakelijk.app';
                return '';
            }
        }));

        m.action(makeParamsWithBitrise('MAPC-6618'));

        var curlCmd = cliCommands.find(function(c) { return c && c.indexOf('curl') !== -1; });
        var unzipCmd = cliCommands.find(function(c) { return c && c.indexOf('unzip') !== -1; });
        assert.ok(curlCmd, 'should run curl to download');
        assert.ok(curlCmd.indexOf('https://example.com/app.zip') !== -1, 'curl should use the expiring URL');
        assert.ok(unzipCmd, 'should run unzip');
    });

    test('finds feature branch from open PRs', function() {
        var listPrsCalled = false;
        var listBuildsArgs = [];

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function() {},
            onListPrs: function(opts) {
                listPrsCalled = true;
                assert.equal(opts.workspace, 'PostNL-BitDigital', 'should use workspace param');
                assert.equal(opts.repository, 'PostNL-commercial-mobileApp', 'should use repository param');
                return JSON.stringify({ data: [{ number: 963, head: { ref: 'story/MAPC-6618' } }] });
            },
            onListBuilds: function(opts) {
                listBuildsArgs.push(opts);
                return JSON.stringify({ data: [{ slug: 'build-abc', build_number: 1, status: 1, status_text: 'success' }] });
            },
            onListArtifacts: function() { return JSON.stringify({ data: [{ slug: 's', title: 'app.zip', file_size_bytes: 1000 }] }); },
            onGetArtifact: function() { return JSON.stringify({ data: { expiring_download_url: 'https://x.com/a.zip' } }); }
        }));

        m.action(makeParamsWithBitrise('MAPC-6618'));

        assert.ok(listPrsCalled, 'should call github_list_prs');
        assert.ok(listBuildsArgs.length > 0, 'should call bitrise_list_builds');
        assert.equal(listBuildsArgs[0].branch, 'story/MAPC-6618', 'should filter builds by feature branch');
    });

    test('skips artifact download when bitriseBuild not configured', function() {
        var listBuildsCalled = false;
        var writtenFiles = {};

        var m = loadPreCli(Object.assign(makeBitriseMocks({
            onListBuilds: function() { listBuildsCalled = true; return JSON.stringify({ data: [] }); },
            onFileWrite: function(path, content) { writtenFiles[path] = content; }
        }), { bitrise_list_builds: function() { listBuildsCalled = true; return JSON.stringify({ data: [] }); } }));

        // No bitriseBuild in customParams
        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));

        assert.ok(!listBuildsCalled, 'should NOT call bitrise_list_builds when not configured');
        assert.ok(!writtenFiles['input/MAPC-6618/app_info.md'], 'should NOT write app_info.md');
    });

    test('does not throw when no successful builds found', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListBuilds: function() { return JSON.stringify({ data: [] }); }
        }));

        m.action(makeParamsWithBitrise('MAPC-6618'));

        // Should complete without throwing; linked_test_cases.md still written
        assert.ok(writtenFiles['input/MAPC-6618/linked_test_cases.md'], 'linked_test_cases.md should still be written');
        assert.ok(!writtenFiles['input/MAPC-6618/app_info.md'], 'app_info.md should NOT be written when no builds');
    });

});


suite('preCliMobileTestAutomationSetup — branch checkout', function() {

    test('runs git commands in the configured workingDir', function() {
        var commands = [];

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: function(opts) {
                commands.push({ cmd: opts.command, dir: opts.workingDirectory });
                return '';
            }
        });

        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));

        var gitCommands = commands.filter(function(c) { return c.cmd.indexOf('git') !== -1; });
        assert.ok(gitCommands.length > 0, 'should run git commands');
        gitCommands.forEach(function(c) {
            assert.equal(c.dir, '/tmp/automation-repo', 'git commands should run in workingDir');
        });
    });

    test('creates new branch test/{ticketKey} from baseBranch when not existing', function() {
        var commands = [];

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                // Simulate: branch does not exist locally or remotely
                if (opts.command.indexOf('git branch --list') !== -1) return '';
                if (opts.command.indexOf('git ls-remote') !== -1) return '';
                return '';
            }
        });

        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));

        var checkoutB = commands.find(function(c) { return c.indexOf('checkout -b test/MAPC-6618') !== -1; });
        assert.ok(checkoutB, 'should create branch test/MAPC-6618');
    });

    test('checks out existing local branch without creating', function() {
        var commands = [];

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                // Simulate: branch exists locally
                if (opts.command.indexOf('git branch --list') !== -1) return '  test/MAPC-6618';
                return '';
            }
        });

        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));

        var checkoutExisting = commands.find(function(c) {
            return c.indexOf('git checkout test/MAPC-6618') !== -1 && c.indexOf('-b') === -1;
        });
        assert.ok(checkoutExisting, 'should checkout existing branch without -b');

        var createB = commands.find(function(c) { return c.indexOf('checkout -b test/MAPC-6618') !== -1; });
        assert.ok(!createB, 'should NOT use -b for existing branch');
    });

    test('skips branch checkout when no workingDir configured', function() {
        var commands = [];

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                return '';
            }
        });

        // No workingDir → no targetRepository
        m.action(makeParams('MAPC-6618', null));

        var gitCommands = commands.filter(function(c) { return c && c.indexOf('git') !== -1; });
        assert.equal(gitCommands.length, 0, 'should run no git commands when workingDir absent');
    });

    test('does not throw when branch checkout fails', function() {
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { throw new Error('git fatal error'); }
        });

        // Should not throw; linked_test_cases.md still written
        m.action(makeParams('MAPC-6618', '/tmp/automation-repo'));
        assert.ok(writtenFiles.hasOwnProperty('input/MAPC-6618/linked_test_cases.md'),
            'should write linked_test_cases.md even if git commands fail');
    });

});
