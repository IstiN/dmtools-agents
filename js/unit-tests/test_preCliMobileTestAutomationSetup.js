/**
 * Unit tests for js/preCliMobileTestAutomationSetup.js
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
        'js/configLoader.js',
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
        'js/preCliMobileTestAutomationSetup.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './config.js': configModule,
            './common/mergeState.js': loadModule('js/common/mergeState.js'),
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './preCliMobileTestAutomationSetupHelpers.js': loadModule('js/preCliMobileTestAutomationSetupHelpers.js'),
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), allMocks),
            // Real PR helper (gh-912): cleanCommandOutput + the remote-existence
            // probe live there — the strict ref-line parser must be exercised.
            './common/pullRequest.js': loadModule('js/common/pullRequest.js',
                makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }))
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
                    owner: 'ExampleOrg',
                    repo: 'example-mobile-app-automation',
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
        m.action(makeParams('PROJ-9999', '/tmp/automation-repo'));
        assert.equal(moves.length, 1, 'should move ticket once');
        assert.equal(moves[0].key, 'PROJ-9999', 'should use correct key');
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
        m.action(makeParams('PROJ-9999', '/tmp/automation-repo'));
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
                        { key: 'PROJ-TC-1', fields: { summary: 'VoiceOver on modal', status: { name: 'Ready' }, priority: { name: 'High' }, description: 'Step 1: Open modal' } },
                        { key: 'PROJ-TC-2', fields: { summary: 'Close button label', status: { name: 'Draft' }, priority: { name: 'Medium' }, description: 'Verify close button' } }
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

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        var mdPath = 'input/PROJ-5678/linked_test_cases.md';
        assert.ok(writtenFiles.hasOwnProperty(mdPath), 'linked_test_cases.md should be written');
        assert.ok(writtenFiles[mdPath].indexOf('PROJ-TC-1') !== -1, 'should contain first TC key');
        assert.ok(writtenFiles[mdPath].indexOf('PROJ-TC-2') !== -1, 'should contain second TC key');
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
                    { key: 'PROJ-TC-3', fields: { summary: 'Fallback TC', status: { name: 'Ready' }, priority: { name: 'Low' }, description: null } }
                ];
            },
            jira_get_ticket: function(opts) {
                return { key: opts.key || opts, fields: { comment: { comments: [] } } };
            },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        assert.equal(searchCalls.length, 2, 'should try both JQL queries');
        assert.ok(searchCalls[0].indexOf('is tested by') !== -1, 'first call uses primary JQL');
        var mdContent = writtenFiles['input/PROJ-5678/linked_test_cases.md'];
        assert.ok(mdContent.indexOf('PROJ-TC-3') !== -1, 'should contain fallback TC');
    });

    test('writes no-TCs message when both JQL queries return empty', function() {
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        var mdContent = writtenFiles['input/PROJ-5678/linked_test_cases.md'];
        assert.ok(mdContent.indexOf('No linked Test Case') !== -1, 'should mention no TCs');
    });

    test('includes recent TC comments in linked_test_cases.md', function() {
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function(opts) {
                if (opts.jql.indexOf('is tested by') !== -1) {
                    return [{ key: 'PROJ-TC-10', fields: { summary: 'Modal TC', status: { name: 'Ready' }, priority: { name: 'High' }, description: 'Steps here' } }];
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

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        var md = writtenFiles['input/PROJ-5678/linked_test_cases.md'];
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
                if (o.command && o.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app\n';
                return '';
            },
            github_list_prs: opts.onListPrs || function() {
                return JSON.stringify({ data: [
                    { number: 963, head: { ref: 'story/PROJ-5678' } }
                ]});
            },
            bitrise_list_builds: opts.onListBuilds || function() {
                return JSON.stringify({ data: [
                    { slug: 'build-abc', build_number: 10317, status: 1, status_text: 'success', branch: 'story/PROJ-5678' }
                ]});
            },
            bitrise_list_build_artifacts: opts.onListArtifacts || function() {
                return JSON.stringify({ data: [
                    { slug: 'artifact-xyz', title: 'Example Business-simulator.zip', file_size_bytes: 32000000 }
                ]});
            },
            bitrise_get_build_artifact: opts.onGetArtifact || function() {
                return JSON.stringify({ data: { expiring_download_url: 'https://example.com/app.zip', slug: 'artifact-xyz', title: 'Example Business-simulator.zip' } });
            }
        };
    }

    function makeParamsWithBitrise(ticketKey) {
        return {
            inputFolderPath: 'input/' + ticketKey,
            jobParams: {
                customParams: {
                    targetRepository: {
                        owner: 'ExampleOrg',
                        repo: 'example-mobile-app-automation',
                        baseBranch: 'main',
                        workingDir: '/tmp/automation-repo'
                    },
                    featurePR: { owner: 'ExampleOrg', repo: 'example-mobile-app' },
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
                    return 'input/PROJ-5678/app/Example Business.app\n';
                }
                return '';
            }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md, 'app_info.md should be written');
        assert.ok(md.indexOf('App Path') !== -1, 'should contain App Path');
        assert.ok(md.indexOf('Example Business.app') !== -1, 'should contain .app name');
        assert.ok(md.indexOf('build_ios_simulator') !== -1, 'should contain workflow name');
    });

    test('downloads artifact using curl and unzips', function() {
        var cliCommands = [];

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function() {},
            onCliCommand: function(opts) {
                cliCommands.push(opts.command);
                if (opts.command && opts.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app';
                return '';
            }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

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
                assert.equal(opts.workspace, 'ExampleOrg', 'should use workspace param');
                assert.equal(opts.repository, 'example-mobile-app', 'should use repository param');
                return JSON.stringify({ data: [{ number: 963, head: { ref: 'story/PROJ-5678' } }] });
            },
            onListBuilds: function(opts) {
                listBuildsArgs.push(opts);
                return JSON.stringify({ data: [{ slug: 'build-abc', build_number: 1, status: 1, status_text: 'success' }] });
            },
            onListArtifacts: function() { return JSON.stringify({ data: [{ slug: 's', title: 'app.zip', file_size_bytes: 1000 }] }); },
            onGetArtifact: function() { return JSON.stringify({ data: { expiring_download_url: 'https://x.com/a.zip' } }); }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        assert.ok(listPrsCalled, 'should call github_list_prs');
        assert.ok(listBuildsArgs.length > 0, 'should call bitrise_list_builds');
        // Code lists recent builds by workflowId without branch param (filters by commit message instead)
        assert.equal(listBuildsArgs[0].workflowId, 'build_ios_simulator', 'should filter builds by workflowId');
        assert.equal(listBuildsArgs[0].appSlug, 'e739ec8c-app-slug', 'should use correct appSlug');
    });

    test('skips artifact download when bitriseBuild not configured', function() {
        var listBuildsCalled = false;
        var writtenFiles = {};

        var m = loadPreCli(Object.assign(makeBitriseMocks({
            onListBuilds: function() { listBuildsCalled = true; return JSON.stringify({ data: [] }); },
            onFileWrite: function(path, content) { writtenFiles[path] = content; }
        }), { bitrise_list_builds: function() { listBuildsCalled = true; return JSON.stringify({ data: [] }); } }));

        // No bitriseBuild in customParams
        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        assert.ok(!listBuildsCalled, 'should NOT call bitrise_list_builds when not configured');
        assert.ok(!writtenFiles['input/PROJ-5678/app_info.md'], 'should NOT write app_info.md');
    });

    test('throws when no successful builds found', function() {
        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function() {},
            onListBuilds: function() { return JSON.stringify({ data: [] }); }
        }));

        var threw = false;
        try {
            m.action(makeParamsWithBitrise('PROJ-5678'));
        } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('No successful') !== -1, 'error should mention no successful builds: ' + e.message);
        }
        assert.ok(threw, 'should throw when no builds found');
    });

    test('filters builds by commit message matching the feature branch', function() {
        var writtenFiles = {};
        var listBuildsArgs = [];

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListBuilds: function(opts) {
                listBuildsArgs.push(opts);
                return JSON.stringify({ data: [
                    { slug: 'other-build', build_number: 10316, status: 1, status_text: 'success', commit_message: 'unrelated work' },
                    { slug: 'matching-build', build_number: 10317, status: 1, status_text: 'success', commit_message: 'iOS build for story/PROJ-5678' }
                ]});
            },
            onListArtifacts: function() {
                return JSON.stringify({ data: [{ slug: 's', title: 'app.zip', file_size_bytes: 1000 }] });
            },
            onGetArtifact: function() { return JSON.stringify({ data: { expiring_download_url: 'https://x.com/a.zip' } }); }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md, 'app_info.md should be written');
        assert.ok(md.indexOf('| Build Slug | matching-build |') !== -1,
            'should use the branch-matched build: ' + md);
    });

    test('warns and uses latest successful build when no commit message matches', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListBuilds: function() {
                return JSON.stringify({ data: [
                    { slug: 'latest-build', build_number: 10320, status: 1, status_text: 'success', commit_message: 'some other ticket' }
                ]});
            },
            onListArtifacts: function() {
                return JSON.stringify({ data: [{ slug: 's', title: 'app.zip', file_size_bytes: 1000 }] });
            },
            onGetArtifact: function() { return JSON.stringify({ data: { expiring_download_url: 'https://x.com/a.zip' } }); }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md.indexOf('| Build Slug | latest-build |') !== -1,
            'should fall back to the latest successful build');
    });

    test('returns early when the build has no artifacts', function() {
        var writtenFiles = {};
        var getArtifactCalled = false;

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListArtifacts: function() { return JSON.stringify({ data: [] }); },
            onGetArtifact: function() { getArtifactCalled = true; return JSON.stringify({ data: {} }); }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        assert.ok(!getArtifactCalled, 'should not fetch download URL without an artifact');
        assert.ok(!writtenFiles['input/PROJ-5678/app_info.md'], 'should NOT write app_info.md');
    });

    test('falls back to the first artifact when none matches .zip/.app/simulator', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListArtifacts: function() {
                return JSON.stringify({ data: [
                    { slug: 'log-slug', title: 'build-log.txt', file_size_bytes: 100 },
                    { slug: 'bin-slug', title: 'report.bin', file_size_bytes: 1000 }
                ]});
            },
            onGetArtifact: function() { return JSON.stringify({ data: { expiring_download_url: 'https://x.com/a.zip' } }); }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md.indexOf('| Artifact | build-log.txt |') !== -1,
            'should use the first artifact as fallback');
    });

    test('returns early when the artifact response has no download URL', function() {
        var writtenFiles = {};
        var cliCommands = [];

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(opts) { cliCommands.push(opts.command); return ''; },
            onGetArtifact: function() { return JSON.stringify({ data: { slug: 's' } }); }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        assert.ok(!writtenFiles['input/PROJ-5678/app_info.md'], 'should NOT write app_info.md');
        assert.ok(!cliCommands.some(function(c) { return c && c.indexOf('curl') !== -1; }),
            'should NOT download without a URL');
    });

    test('returns early when artifact listing throws', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListArtifacts: function() { throw new Error('bitrise API down'); }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        assert.ok(!writtenFiles['input/PROJ-5678/app_info.md'], 'should NOT write app_info.md');
    });

    test('returns early when download/unzip fails', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(opts) {
                if (opts.command && opts.command.indexOf('curl') !== -1) {
                    throw new Error('network error');
                }
                return '';
            }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        assert.ok(!writtenFiles['input/PROJ-5678/app_info.md'],
            'should NOT write app_info.md when download fails');
    });

    test('writes App Dir manual-locate markdown when no .app is found after unzip', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function() { return ''; }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md, 'app_info.md should still be written');
        assert.ok(md.indexOf('| App Dir | `input/PROJ-5678/app` |') !== -1,
            'should contain the App Dir fallback row: ' + md);
        assert.ok(md.indexOf('locate the `.app` bundle manually') !== -1,
            'should instruct manual locate');
        assert.ok(md.indexOf('| App Path |') === -1, 'should NOT contain an App Path row');
    });

    test('skips .dSYM entries when locating the .app bundle', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(opts) {
                if (opts.command && opts.command.indexOf('find') !== -1) {
                    return 'input/PROJ-5678/app/Example Business.app.dSYM/Contents\n';
                }
                return '';
            }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md.indexOf('| App Dir |') !== -1, 'dSYM-only find output must not become the app path');
    });

    test('still writes app_info.md when the find command throws', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(opts) {
                if (opts.command && opts.command.indexOf('find') !== -1) {
                    throw new Error('find failed');
                }
                return '';
            }
        }));

        m.action(makeParamsWithBitrise('PROJ-5678'));

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md, 'app_info.md should be written despite find failure');
        assert.ok(md.indexOf('| App Dir |') !== -1, 'should fall back to App Dir row');
    });

    test('writes environment.md and overrides workflowId for a configured environment', function() {
        var writtenFiles = {};

        var params = makeParamsWithBitrise('PROJ-5678');
        params.jobParams.customParams.testEnvironment = 'staging';
        params.jobParams.customParams.bitriseBuild = {
            appSlug: 'e739ec8c-app-slug',
            workflowId: 'build_ios_simulator',
            environments: {
                staging: {
                    workflowId: 'build_ios_simulator_staging',
                    appId: 'com.example.staging',
                    userEnvVar: 'STAGE_USER',
                    passwordEnvVar: 'STAGE_PASS',
                    pinEnvVar: 'STAGE_PIN'
                }
            }
        };

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; }
        }));

        m.action(params);

        var envMd = writtenFiles['input/PROJ-5678/environment.md'];
        assert.ok(envMd, 'environment.md should be written');
        assert.ok(envMd.indexOf('# Test Environment: STAGING') !== -1);
        assert.ok(envMd.indexOf('| Bitrise Workflow | build_ios_simulator_staging |') !== -1,
            'should use the environment-specific workflow');
        assert.ok(envMd.indexOf('`STAGE_USER`') !== -1, 'should use custom credential env var');
        var appMd = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(appMd.indexOf('| Bitrise Workflow | build_ios_simulator_staging |') !== -1,
            'download should use the overridden workflow');
    });

    test('passes the environment appId through to the simulator install block', function() {
        var writtenFiles = {};

        var params = makeParamsWithBitrise('PROJ-5678');
        params.jobParams.customParams.testEnvironment = 'staging';
        params.jobParams.customParams.bitriseBuild = {
            appSlug: 'e739ec8c-app-slug',
            workflowId: 'build_ios_simulator',
            environments: {
                staging: { appId: 'com.example.staging' }
            }
        };

        var m = loadPreCli(makeBitriseMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(opts) {
                if (opts.command && opts.command.indexOf('SIMULATOR_UDID') !== -1) {
                    return 'SIM-UDID-1234';
                }
                if (opts.command && opts.command.indexOf('find') !== -1) {
                    return 'input/PROJ-5678/app/Example Business.app';
                }
                return '';
            }
        }));

        m.action(params);

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md.indexOf('## Simulator & Maestro') !== -1, 'simulator block should be appended');
        assert.ok(md.indexOf('| APP_ID | `com.example.staging` |') !== -1,
            'should use the env-configured appId: ' + md);
    });

});

// ── Suite: simulator install ─────────────────────────────────────────────────

suite('preCliMobileTestAutomationSetup — simulator install', function() {

    function makeInstallParams() {
        var params = {
            inputFolderPath: 'input/PROJ-5678',
            jobParams: {
                customParams: {
                    targetRepository: {
                        owner: 'ExampleOrg',
                        repo: 'example-mobile-app-automation',
                        baseBranch: 'main',
                        workingDir: '/tmp/automation-repo'
                    },
                    featurePR: { owner: 'ExampleOrg', repo: 'example-mobile-app' },
                    bitriseBuild: {
                        appSlug: 'e739ec8c-app-slug',
                        workflowId: 'build_ios_simulator'
                    }
                }
            }
        };
        return params;
    }

    function defaultInstallCliHandler(o) {
        if (o.command && o.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app';
        if (o.command && o.command.indexOf('SIMULATOR_UDID') !== -1) return 'SIM-UDID-1234';
        return '';
    }

    function makeInstallMocks(opts) {
        opts = opts || {};
        var mocks = {
            jira_move_to_status: function() {},
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            file_read: function() { return '# existing app_info'; },
            cli_execute_command: defaultInstallCliHandler,
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, head: { ref: 'story/PROJ-5678' } }]});
            },
            bitrise_list_builds: function() {
                return JSON.stringify({ data: [{ slug: 'build-abc', build_number: 1, status: 1, status_text: 'success' }]});
            },
            bitrise_list_build_artifacts: function() {
                return JSON.stringify({ data: [{ slug: 's', title: 'app.zip', file_size_bytes: 1000 }]});
            },
            bitrise_get_build_artifact: function() {
                return JSON.stringify({ data: { expiring_download_url: 'https://x.com/a.zip' }});
            }
        };
        if (opts.onFileWrite) mocks.file_write = opts.onFileWrite;
        if (opts.onFileRead) mocks.file_read = opts.onFileRead;
        if (opts.onCliCommand) mocks.cli_execute_command = opts.onCliCommand;
        return mocks;
    }

    test('install flow works end-to-end with the default cli handler', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeInstallMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; }
        }));

        m.action(makeInstallParams());

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md, 'app_info.md should be written');
        assert.ok(md.indexOf('## Simulator & Maestro') !== -1,
            'default handler should carry the app path all the way to the install: ' + md);
        assert.ok(md.indexOf('| MAESTRO_DEVICE | `SIM-UDID-1234` |') !== -1,
            'should use the default env UDID');
        assert.ok(md.indexOf('`com.example.internal.business.app`') !== -1,
            'should use the default appId');
    });

    test('installs app on simulator using SIMULATOR_UDID from env', function() {
        var commands = [];
        var writtenFiles = {};

        var m = loadPreCli(makeInstallMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(o) {
                commands.push(o.command);
                if (o.command && o.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app';
                if (o.command && o.command.indexOf('SIMULATOR_UDID') !== -1) return 'SIM-UDID-1234';
                return '';
            }
        }));

        m.action(makeInstallParams());

        var installCmd = commands.find(function(c) { return c && c.indexOf('xcrun simctl install') !== -1; });
        assert.ok(installCmd, 'should run xcrun simctl install');
        assert.ok(installCmd.indexOf('SIM-UDID-1234') !== -1, 'should install on the env UDID');
        assert.ok(installCmd.indexOf('Example Business.app') !== -1, 'should install the app bundle');
        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md.indexOf('| MAESTRO_DEVICE | `SIM-UDID-1234` |') !== -1, 'should append simulator info');
        assert.ok(md.indexOf('`com.example.internal.business.app`') !== -1, 'should use default appId');
    });

    test('falls back to a booted simulator when SIMULATOR_UDID is empty', function() {
        var commands = [];

        var m = loadPreCli(makeInstallMocks({
            onCliCommand: function(o) {
                commands.push(o.command);
                if (o.command && o.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app';
                if (o.command && o.command.indexOf('SIMULATOR_UDID') !== -1) return '';
                if (o.command && o.command.indexOf('simctl list devices booted') !== -1) {
                    return '    iPhone 15 (ABCD1234-1111-2222-3333-444455556666) (Booted)';
                }
                return '';
            }
        }));

        m.action(makeInstallParams());

        var installCmd = commands.find(function(c) { return c && c.indexOf('xcrun simctl install') !== -1; });
        assert.ok(installCmd, 'should install via the booted-simulator fallback');
        assert.ok(installCmd.indexOf('ABCD1234-1111-2222-3333-444455556666') !== -1,
            'should use the UDID parsed from simctl output');
    });

    test('skips install when no booted simulator is found', function() {
        var commands = [];

        var m = loadPreCli(makeInstallMocks({
            onCliCommand: function(o) {
                commands.push(o.command);
                if (o.command && o.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app';
                return '';
            }
        }));

        m.action(makeInstallParams());

        var installCmd = commands.find(function(c) { return c && c.indexOf('xcrun simctl install') !== -1; });
        assert.ok(!installCmd, 'should NOT install without a booted simulator');
    });

    test('continues when listing booted simulators throws', function() {
        var commands = [];

        var m = loadPreCli(makeInstallMocks({
            onCliCommand: function(o) {
                commands.push(o.command);
                if (o.command && o.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app';
                if (o.command && o.command.indexOf('simctl list devices booted') !== -1) {
                    throw new Error('xcrun not found');
                }
                return '';
            }
        }));

        m.action(makeInstallParams());

        var installCmd = commands.find(function(c) { return c && c.indexOf('xcrun simctl install') !== -1; });
        assert.ok(!installCmd, 'should NOT install when simctl listing fails');
    });

    test('does not append simulator info when the install command fails', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeInstallMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(o) {
                if (o.command && o.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app';
                if (o.command && o.command.indexOf('SIMULATOR_UDID') !== -1) return 'SIM-UDID-1234';
                if (o.command && o.command.indexOf('xcrun simctl install') !== -1) {
                    throw new Error('install failed');
                }
                return '';
            }
        }));

        m.action(makeInstallParams());

        var md = writtenFiles['input/PROJ-5678/app_info.md'];
        assert.ok(md, 'app_info.md from download should still exist');
        assert.ok(md.indexOf('## Simulator & Maestro') === -1,
            'should NOT append simulator info after a failed install');
    });

    test('warns but completes when appending simulator info fails', function() {
        var commands = [];

        var m = loadPreCli(makeInstallMocks({
            onFileRead: function() { throw new Error('read denied'); },
            onCliCommand: function(o) {
                commands.push(o.command);
                if (o.command && o.command.indexOf('find') !== -1) return 'input/PROJ-5678/app/Example Business.app';
                if (o.command && o.command.indexOf('SIMULATOR_UDID') !== -1) return 'SIM-UDID-1234';
                return '';
            }
        }));

        // install itself succeeds; only the app_info.md append fails — action must not throw
        m.action(makeInstallParams());

        var installCmd = commands.find(function(c) { return c && c.indexOf('xcrun simctl install') !== -1; });
        assert.ok(installCmd, 'install should still run');
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

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

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

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        var checkoutB = commands.find(function(c) { return c.indexOf('checkout -b test/PROJ-5678') !== -1; });
        assert.ok(checkoutB, 'should create branch test/PROJ-5678');
    });

    test('checks out existing local branch without creating', function() {
        var commands = [];

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                // Simulate: branch exists locally
                if (opts.command.indexOf('git branch --list') !== -1) return '  test/PROJ-5678';
                return '';
            }
        });

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        var checkoutExisting = commands.find(function(c) {
            return c.indexOf('git checkout test/PROJ-5678') !== -1 && c.indexOf('-b') === -1;
        });
        assert.ok(checkoutExisting, 'should checkout existing branch without -b');

        var createB = commands.find(function(c) { return c.indexOf('checkout -b test/PROJ-5678') !== -1; });
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
        m.action(makeParams('PROJ-5678', null));

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
        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));
        assert.ok(writtenFiles.hasOwnProperty('input/PROJ-5678/linked_test_cases.md'),
            'should write linked_test_cases.md even if git commands fail');
    });

    // ── gh-761: never rebase/merge (or auto-abort) on top of an unconcluded merge ──

    test('gh-761: MERGE_HEAD present — skips base-branch sync entirely, leaves the in-flight merge untouched', function() {
        var commands = [];

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                // Branch exists locally → syncWithBase() is reached
                if (opts.command.indexOf('git branch --list') !== -1) return '  test/PROJ-5678';
                // Canonical merge-state probe: a merge IS in progress
                if (opts.command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
                    return '9a7e2aecommitsha\n';
                }
                return '';
            }
        });

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        assert.ok(commands.some(function(c) { return c.indexOf('git checkout test/PROJ-5678') !== -1; }),
            'checkout itself still runs');
        assert.equal(commands.filter(function(c) { return c.indexOf('git rebase') === 0; }).length, 0,
            'must not rebase on top of an unconcluded merge');
        assert.equal(commands.filter(function(c) { return c.indexOf('git merge') === 0; }).length, 0,
            'must not start a second merge on top of MERGE_HEAD');
        assert.equal(commands.filter(function(c) { return c.indexOf('git merge --abort') !== -1; }).length, 0,
            'must never silently abort the agent\'s in-flight merge');
    });

    test('gh-761: no MERGE_HEAD — base-branch sync still runs (rebase attempted)', function() {
        var commands = [];

        var m = loadPreCli({
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command.indexOf('git branch --list') !== -1) return '  test/PROJ-5678';
                if (opts.command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
                    throw new Error('Command execution failed (exit code 1)'); // no merge in progress
                }
                return '';
            }
        });

        m.action(makeParams('PROJ-5678', '/tmp/automation-repo'));

        assert.ok(commands.some(function(c) { return c.indexOf('git rebase origin/main') === 0; }),
            'without a merge in progress the sync must behave exactly as before');
    });

});

// ── Suite: gh-1189 characterization (pinned before the CRAP split) ───────────
// Pins the observable behavior of fetchLinkedTestCases, findFeatureBranch and
// downloadBitriseApp — the functions named by the gh-1189 CRAP ticket —
// including the branches the existing suites do not reach. These tests must
// keep passing unchanged through the helper extraction.

suite('preCliMobileTestAutomationSetup — gh-1189 characterization: linked TC fetching', function() {

    test('falls back to the broader JQL when the primary search throws', function() {
        var jqls = [];
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function(opts) {
                jqls.push(opts.jql);
                if (opts.jql.indexOf('"is tested by"') !== -1) throw new Error('primary query failed');
                return [{ key: 'PROJ-TC-F', fields: { summary: 'Fallback TC', status: { name: 'Ready' }, priority: { name: 'Low' } } }];
            },
            jira_get_ticket: function(opts) { return { key: opts.key || opts, fields: { comment: { comments: [] } } }; },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('PROJ-9001', null));

        assert.equal(jqls.length, 2, 'both the primary and the fallback JQL must run');
        var md = writtenFiles['input/PROJ-9001/linked_test_cases.md'];
        assert.ok(md.indexOf('PROJ-TC-F') !== -1, 'fallback results must land in the file');
    });

    test('writes the no-linked-TCs marker when both JQL searches throw', function() {
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function() { throw new Error('tracker down'); },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('PROJ-9002', null));

        var md = writtenFiles['input/PROJ-9002/linked_test_cases.md'];
        assert.ok(md.indexOf('No linked Test Case tickets found for PROJ-9002') !== -1,
            'marker file must be written when both searches fail: ' + md);
    });

    test('caps recent TC comments at the last five with an N-of-M header', function() {
        var writtenFiles = {};
        var comments = [];
        for (var i = 1; i <= 7; i++) {
            comments.push({ author: { displayName: 'QA' }, body: 'run-' + i });
        }

        var m = loadPreCli({
            jira_search_by_jql: function(opts) {
                if (opts.jql.indexOf('is tested by') !== -1) {
                    return [{ key: 'PROJ-TC-C', fields: { summary: 'Modal', status: { name: 'Ready' }, priority: { name: 'High' } } }];
                }
                return [];
            },
            jira_get_ticket: function() { return { fields: { comment: { comments: comments } } }; },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('PROJ-9003', null));

        var md = writtenFiles['input/PROJ-9003/linked_test_cases.md'];
        assert.ok(md.indexOf('**Recent Test Run Comments** (5 of 7)') !== -1,
            'header must report 5 of 7: ' + md);
        assert.ok(md.indexOf('run-3') !== -1, 'first of the last five must be kept');
        assert.ok(md.indexOf('run-7') !== -1, 'latest comment must be kept');
        assert.equal(md.indexOf('run-1'), -1, 'oldest comment must be dropped');
        assert.equal(md.indexOf('run-2'), -1, 'second-oldest comment must be dropped');
    });

    test('renders Unknown status/priority and (no summary) for sparse TC fields', function() {
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function(opts) {
                if (opts.jql.indexOf('is tested by') !== -1) {
                    return [{ key: 'PROJ-TC-S', fields: {} }];
                }
                return [];
            },
            jira_get_ticket: function(opts) { return { key: opts.key || opts, fields: { comment: { comments: [] } } }; },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('PROJ-9004', null));

        var md = writtenFiles['input/PROJ-9004/linked_test_cases.md'];
        assert.ok(md.indexOf('## PROJ-TC-S: (no summary)') !== -1, 'sparse summary fallback: ' + md);
        assert.ok(md.indexOf('**Status**: Unknown  **Priority**: Unknown') !== -1,
            'sparse status/priority fallback: ' + md);
    });

    test('tolerates a TC detail fetch failure and keeps the earlier entries', function() {
        var writtenFiles = {};

        var m = loadPreCli({
            jira_search_by_jql: function(opts) {
                if (opts.jql.indexOf('is tested by') !== -1) {
                    return [
                        { key: 'PROJ-TC-1', fields: { summary: 'First', status: { name: 'Ready' }, priority: { name: 'High' } } },
                        { key: 'PROJ-TC-2', fields: { summary: 'Second', status: { name: 'Draft' }, priority: { name: 'Low' } } }
                    ];
                }
                return [];
            },
            jira_get_ticket: function() { throw new Error('detail fetch failed'); },
            file_write: function(path, content) { writtenFiles[path] = content; },
            cli_execute_command: function() { return ''; }
        });

        m.action(makeParams('PROJ-9005', null));

        var md = writtenFiles['input/PROJ-9005/linked_test_cases.md'];
        assert.ok(md, 'file must still be written');
        assert.ok(md.indexOf('## PROJ-TC-1: First') !== -1, 'first entry kept');
        assert.ok(md.indexOf('## PROJ-TC-2: Second') !== -1, 'second entry kept despite comment failure');
        assert.equal(md.indexOf('Recent Test Run Comments'), -1, 'no comments section after detail failure');
    });

});

suite('preCliMobileTestAutomationSetup — gh-1189 characterization: feature branch lookup', function() {

    function makeLookupParams(ticketKey, withFeaturePR) {
        var params = {
            inputFolderPath: 'input/' + ticketKey,
            jobParams: {
                customParams: {
                    bitriseBuild: { appSlug: 'app-slug', workflowId: 'build_ios_simulator' }
                }
            }
        };
        if (withFeaturePR) {
            params.jobParams.customParams.featurePR = { owner: 'ExampleOrg', repo: 'example-mobile-app' };
        }
        return params;
    }

    function makeLookupMocks(opts) {
        opts = opts || {};
        return {
            jira_move_to_status: function() {},
            jira_search_by_jql: function() { return []; },
            file_write: opts.onFileWrite || function() {},
            cli_execute_command: opts.onCliCommand || function(o) {
                if (o.command && o.command.indexOf('find') !== -1) return 'input/x/app/Example.app';
                return '';
            },
            github_list_prs: opts.onListPrs || function() {
                return JSON.stringify({ data: [{ number: 9, head: { ref: 'story/PROJ-X' } }] });
            },
            bitrise_list_builds: opts.onListBuilds || function() {
                return JSON.stringify({ data: [
                    { slug: 'latest-build', build_number: 7, status: 1, status_text: 'success', commit_message: 'some other ticket' }
                ]});
            },
            bitrise_list_build_artifacts: function() {
                return JSON.stringify({ data: [{ slug: 's', title: 'app.zip', file_size_bytes: 1000 }] });
            },
            bitrise_get_build_artifact: function() {
                return JSON.stringify({ data: { expiring_download_url: 'https://x.com/a.zip' } });
            }
        };
    }

    test('skips the feature-PR lookup entirely when featurePR is not configured', function() {
        var listPrsCalled = false;
        var writtenFiles = {};

        var m = loadPreCli(makeLookupMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListPrs: function() { listPrsCalled = true; return JSON.stringify({ data: [] }); }
        }));

        m.action(makeLookupParams('PROJ-9006', false));

        assert.equal(listPrsCalled, false, 'github_list_prs must not be called without featurePR');
        assert.ok(writtenFiles['input/PROJ-9006/app_info.md'], 'download must still complete');
        var md = writtenFiles['input/PROJ-9006/app_info.md'];
        assert.ok(md.indexOf('| Build Slug | latest-build |') !== -1, 'unfiltered latest build used');
    });

    test('PR lookup failure does not abort the artifact download', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeLookupMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListPrs: function() { throw new Error('github down'); }
        }));

        m.action(makeLookupParams('PROJ-9007', true));

        var md = writtenFiles['input/PROJ-9007/app_info.md'];
        assert.ok(md, 'download must still complete when the PR listing throws');
        assert.ok(md.indexOf('| Build Slug | latest-build |') !== -1, 'unfiltered latest build used');
    });

    test('matches the feature branch via pr.source_branch when head.ref is absent', function() {
        var writtenFiles = {};

        var m = loadPreCli(makeLookupMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListPrs: function() {
                return JSON.stringify({ data: [{ number: 5, source_branch: 'bug/PROJ-9008' }] });
            },
            onListBuilds: function() {
                return JSON.stringify({ data: [
                    { slug: 'other-build', build_number: 10, status: 1, status_text: 'success', commit_message: 'unrelated work' },
                    { slug: 'matching-build', build_number: 11, status: 1, status_text: 'success', commit_message: 'iOS build for bug/PROJ-9008' }
                ]});
            }
        }));

        m.action(makeLookupParams('PROJ-9008', true));

        var md = writtenFiles['input/PROJ-9008/app_info.md'];
        assert.ok(md.indexOf('| Build Slug | matching-build |') !== -1,
            'source_branch must satisfy the ticket-key match: ' + md);
    });

});

suite('preCliMobileTestAutomationSetup — gh-1189 characterization: Bitrise download', function() {

    function makeDownloadParams(ticketKey) {
        return {
            inputFolderPath: 'input/' + ticketKey,
            jobParams: {
                customParams: {
                    featurePR: { owner: 'ExampleOrg', repo: 'example-mobile-app' },
                    bitriseBuild: { appSlug: 'app-slug', workflowId: 'build_ios_simulator' }
                }
            }
        };
    }

    function defaultDownloadCliHandler(o) {
        if (o.command && o.command.indexOf('find') !== -1) return 'input/x/app/Example.app';
        return '';
    }

    function openPrListStub() {
        return JSON.stringify({ data: [{ number: 9, head: { ref: 'story/PROJ-X' } }] });
    }

    function successfulBuildsStub() {
        return JSON.stringify({ data: [
            { slug: 'build-abc', build_number: 10317, status: 1, status_text: 'success' }
        ]});
    }

    function artifactZipStub() {
        return JSON.stringify({ data: [
            { slug: 'artifact-xyz', title: 'app-simulator.zip', file_size_bytes: 32000000 }
        ]});
    }

    function expiringUrlStub() {
        return JSON.stringify({ data: { expiring_download_url: 'https://example.com/app.zip' } });
    }

    function makeDownloadMocks(opts) {
        opts = opts || {};
        var mocks = {
            jira_move_to_status: function() {},
            jira_search_by_jql: function() { return []; },
            file_write: function() {},
            cli_execute_command: defaultDownloadCliHandler,
            github_list_prs: openPrListStub,
            bitrise_list_builds: successfulBuildsStub,
            bitrise_list_build_artifacts: artifactZipStub,
            bitrise_get_build_artifact: expiringUrlStub
        };
        if (opts.onFileWrite) mocks.file_write = opts.onFileWrite;
        if (opts.onCliCommand) mocks.cli_execute_command = opts.onCliCommand;
        if (opts.onListPrs) mocks.github_list_prs = opts.onListPrs;
        if (opts.onListBuilds) mocks.bitrise_list_builds = opts.onListBuilds;
        if (opts.onListArtifacts) mocks.bitrise_list_build_artifacts = opts.onListArtifacts;
        if (opts.onGetArtifact) mocks.bitrise_get_build_artifact = opts.onGetArtifact;
        return mocks;
    }

    test('throws the canonical no-successful-builds error when every build failed', function() {
        var m = loadPreCli(makeDownloadMocks({
            onListBuilds: function() {
                return JSON.stringify({ data: [
                    { slug: 'b1', build_number: 1, status: 2, status_text: 'failed' }
                ]});
            }
        }));

        var threw = false;
        try {
            m.action(makeDownloadParams('PROJ-9010'));
        } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('No successful build_ios_simulator builds found') !== -1,
                'canonical error expected: ' + e.message);
        }
        assert.ok(threw, 'should throw when no build succeeded');
    });

    test('treats a builds response without a data array as no builds', function() {
        var m = loadPreCli(makeDownloadMocks({
            onListBuilds: function() { return JSON.stringify({}); }
        }));

        var threw = false;
        try {
            m.action(makeDownloadParams('PROJ-9011'));
        } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('No successful') !== -1, 'canonical error expected: ' + e.message);
        }
        assert.ok(threw, 'missing data array must behave like an empty build list');
    });

    test('wraps build-listing failures as "Failed to list Bitrise builds"', function() {
        var m = loadPreCli(makeDownloadMocks({
            onListBuilds: function() { throw new Error('bitrise down'); }
        }));

        var threw = false;
        try {
            m.action(makeDownloadParams('PROJ-9012'));
        } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('Failed to list Bitrise builds') !== -1,
                'wrapped error expected: ' + e.message);
        }
        assert.ok(threw, 'listing failure must surface as the wrapped error');
    });

    test('removes the zip after a successful unzip', function() {
        var commands = [];

        var m = loadPreCli(makeDownloadMocks({
            onCliCommand: function(opts) {
                commands.push(opts.command);
                if (opts.command && opts.command.indexOf('find') !== -1) return 'input/PROJ-9013/app/Example.app';
                return '';
            }
        }));

        m.action(makeDownloadParams('PROJ-9013'));

        var unzipIdx = -1, rmIdx = -1;
        for (var i = 0; i < commands.length; i++) {
            if (commands[i].indexOf('unzip -o') !== -1) unzipIdx = i;
            if (commands[i].indexOf('rm -f "input/PROJ-9013/app.zip"') !== -1) rmIdx = i;
        }
        assert.ok(unzipIdx !== -1, 'unzip must run');
        assert.ok(rmIdx !== -1, 'zip cleanup must run');
        assert.ok(rmIdx > unzipIdx, 'zip cleanup must run after the unzip');
    });

    test('skips the download when the artifact listing has no data array', function() {
        var writtenFiles = {};
        var getArtifactCalled = false;

        var m = loadPreCli(makeDownloadMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onListArtifacts: function() { return JSON.stringify({}); },
            onGetArtifact: function() { getArtifactCalled = true; return JSON.stringify({ data: {} }); }
        }));

        m.action(makeDownloadParams('PROJ-9014'));

        assert.equal(getArtifactCalled, false, 'no artifact detail call without a listing');
        assert.equal(writtenFiles['input/PROJ-9014/app_info.md'], undefined, 'no app_info.md without an artifact');
    });

    test('skips the download when the artifact detail call throws', function() {
        var writtenFiles = {};
        var cliCommands = [];

        var m = loadPreCli(makeDownloadMocks({
            onFileWrite: function(path, content) { writtenFiles[path] = content; },
            onCliCommand: function(opts) { cliCommands.push(opts.command); return ''; },
            onGetArtifact: function() { throw new Error('artifact detail failed'); }
        }));

        m.action(makeDownloadParams('PROJ-9015'));

        assert.ok(!cliCommands.some(function(c) { return c && c.indexOf('curl') !== -1; }),
            'must not download without an expiring URL');
        assert.equal(writtenFiles['input/PROJ-9015/app_info.md'], undefined, 'no app_info.md without a URL');
    });

});
