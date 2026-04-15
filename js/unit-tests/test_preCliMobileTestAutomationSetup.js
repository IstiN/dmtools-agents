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

// ── Suite: branch checkout ────────────────────────────────────────────────────

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
