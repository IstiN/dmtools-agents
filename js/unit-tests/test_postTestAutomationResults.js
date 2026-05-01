/**
 * Unit tests for agents/js/postTestAutomationResults.js
 */

function loadPostTestAutomation(mocks) {
    var fileReadMock = mocks.file_read || function(opts) {
        if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
        try { return file_read(opts); } catch (e) { return null; }
    };

    var freshConfigLoader = loadModule(
        'agents/js/configLoader.js',
        makeRequire({ './config.js': configModule, './common/scm.js': {} }),
        { file_read: fileReadMock }
    );

    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_add_label: function() {},
        jira_remove_label: function() {},
        cli_execute_command: function() { return ''; },
        file_read: fileReadMock,
        file_write: function() {}
    };

    return loadModule(
        'agents/js/postTestAutomationResults.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './config.js': configModule
        }),
        Object.assign({}, defaults, mocks)
    );
}

suite('postTestAutomationResults: PR creation', function() {

    test('creates PR without calling non-whitelisted pwd command', function() {
        var commands = [];
        var writtenFiles = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'failed', summary: 'Regression captured' });
                }
                if (opts.path === 'outputs/pr_body.md') return 'PR body';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            file_write: function(path, content) {
                writtenFiles.push({ path: path, content: content });
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                commands.push(command);
                if (command === 'pwd') throw new Error('pwd must not be called');
                if (command === 'git branch --show-current') return 'test/DMC-898';
                if (command.indexOf('find testing') === 0) return 'testing/tests/DMC-898/test_dmc_898.py';
                if (command === 'git diff --cached --stat') return ' testing/tests/DMC-898/test_dmc_898.py | 1 +';
                if (command.indexOf('git ls-remote --heads origin test/DMC-898') === 0) return 'abc\trefs/heads/test/DMC-898';
                if (command.indexOf('gh pr list --head test/DMC-898') === 0) return '';
                if (command.indexOf('gh pr create') === 0) return 'https://github.com/epam/dm.ai/pull/898';
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-898', fields: { summary: 'Automate test case' } },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/epam/dm.ai/pull/898');
        assert.ok(writtenFiles.length > 0, 'PR body written to temp file');
        assert.ok(commands.some(function(command) { return command.indexOf('gh pr create') === 0; }), 'gh pr create called');
        assert.notOk(commands.some(function(command) { return command === 'pwd'; }), 'pwd command not used');
    });

});
