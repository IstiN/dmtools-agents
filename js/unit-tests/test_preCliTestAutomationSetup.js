/**
 * Unit tests for js/preCliTestAutomationSetup.js (gh-1223 characterization)
 *
 * Pins the action() step sequence — ticket move, branch checkout, stale-output
 * cleanup, linked-bug fetch — and its failure tolerance (every step is
 * non-fatal) ahead of the gh-1223 helper extraction. These tests must keep
 * passing unchanged through the refactor.
 */

function loadTestAutomationSetup(mocks) {
    var cfg = {
        git: { baseBranch: 'main', branchPrefix: { test: 'test' }, authorName: 'Test Agent', authorEmail: 'agent@example.com' },
        jira: {},
        workingDir: mocks.workingDir || null
    };

    var allMocks = Object.assign({
        jira_move_to_status: function() {},
        jira_search_by_jql: function() { return []; },
        jira_get_ticket: function(opts) { return { key: opts.key || opts, fields: {} }; },
        file_write: function() {},
        file_read: function() { return null; },
        cli_execute_command: function() { return ''; }
    }, mocks);

    var fetchLinkedBugs = mocks.fetchLinkedBugsModule || { action: function() {} };

    return loadModule(
        'js/preCliTestAutomationSetup.js',
        makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
            './configLoader.js': { loadProjectConfig: function() { return cfg; } },
            './config.js': configModule,
            './fetchLinkedBugsToInput.js': fetchLinkedBugs,
            './common/trackers.js': loadModule(
                'js/common/trackers.js',
                makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'), '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }),
                allMocks
            ),
            './common/pullRequest.js': loadModule(
                'js/common/pullRequest.js',
                makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
                    './config.js': configModule,
                    './mergeState.js': loadModule('js/common/mergeState.js'),
                    './common/mergeState.js': loadModule('js/common/mergeState.js')
                }),
                allMocks
            )
        }),
        allMocks
    );
}

suite('preCliTestAutomationSetup — gh-1223 characterization: action steps', function() {

    test('happy path moves the ticket, clears stale outputs and fetches linked bugs', function() {
        var moves = [];
        var commands = [];
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            jira_move_to_status: function(opts) { moves.push(opts); },
            cli_execute_command: function(opts) { commands.push(opts.command); return ''; },
            fetchLinkedBugsModule: { action: function(params) { bugFetches.push(params); } }
        });

        mod.action({ inputFolderPath: 'input/TS-9' });

        assert.deepEqual(moves, [{ key: 'TS-9', statusName: 'In Development' }],
            'ticket must move to In Development');
        assert.ok(commands.some(function(c) { return c.indexOf('rm -f outputs/test_automation_result.json') !== -1; }),
            'stale output files must be cleared');
        assert.equal(bugFetches.length, 1, 'linked bugs fetched once');
        assert.equal(bugFetches[0].inputFolderPath, 'input/TS-9', 'bug fetch receives the action params');
    });

    test('a failing ticket move is non-fatal — the remaining steps still run', function() {
        var commands = [];
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            jira_move_to_status: function() { throw new Error('jira down'); },
            cli_execute_command: function(opts) { commands.push(opts.command); return ''; },
            fetchLinkedBugsModule: { action: function() { bugFetches.push(true); } }
        });

        mod.action({ inputFolderPath: 'input/TS-10' });

        assert.ok(commands.some(function(c) { return c.indexOf('rm -f outputs/test_automation_result.json') !== -1; }),
            'stale output cleanup still runs after a failed move');
        assert.equal(bugFetches.length, 1, 'linked bugs still fetched after a failed move');
    });

    test('a failing branch checkout is non-fatal — cleanup and bug fetch still run', function() {
        var commands = [];
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command.indexOf('git') === 0 || opts.command.indexOf('git ') !== -1) {
                    throw new Error('git fatal');
                }
                return '';
            },
            fetchLinkedBugsModule: { action: function() { bugFetches.push(true); } }
        });

        mod.action({ inputFolderPath: 'input/TS-11' });

        assert.ok(commands.some(function(c) { return c.indexOf('rm -f outputs/test_automation_result.json') !== -1; }),
            'stale output cleanup still runs after a failed checkout');
        assert.equal(bugFetches.length, 1, 'linked bugs still fetched after a failed checkout');
    });

    test('a failing stale-output cleanup is non-fatal — linked bugs still fetched', function() {
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            cli_execute_command: function(opts) {
                if (opts.command.indexOf('rm -f outputs/') !== -1) throw new Error('rm refused');
                return '';
            },
            fetchLinkedBugsModule: { action: function() { bugFetches.push(true); } }
        });

        mod.action({ inputFolderPath: 'input/TS-12' });

        assert.equal(bugFetches.length, 1, 'linked bugs still fetched after cleanup failure');
    });

    test('a failing linked-bugs fetch is non-fatal — action completes', function() {
        var moves = [];

        var mod = loadTestAutomationSetup({
            jira_move_to_status: function(opts) { moves.push(opts); },
            fetchLinkedBugsModule: { action: function() { throw new Error('bug fetch exploded'); } }
        });

        mod.action({ inputFolderPath: 'input/TS-13' });

        assert.deepEqual(moves, [{ key: 'TS-13', statusName: 'In Development' }],
            'the action still ran to completion for the ticket');
    });

    test('jobParams-only params (no top-level inputFolderPath) are resolved', function() {
        var moves = [];
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            jira_move_to_status: function(opts) { moves.push(opts); },
            cli_execute_command: function() { return ''; },
            fetchLinkedBugsModule: { action: function(params) { bugFetches.push(params); } }
        });

        mod.action({ jobParams: { inputFolderPath: 'input/TS-14', customParams: {} } });

        assert.deepEqual(moves, [{ key: 'TS-14', statusName: 'In Development' }],
            'ticket key must resolve from jobParams.inputFolderPath');
        assert.equal(bugFetches[0].inputFolderPath, 'input/TS-14',
            'bug fetch receives the resolved actual params');
    });

});
