/**
 * Unit tests for js/preCliStoryTestAutomationSetup.js
 */

function loadPreCliStoryTestAutomationSetup(mocks) {
    var defaults = {
        jira_search_by_jql: function() { return []; },
        cli_execute_command: function() { return ''; },
        file_write: function() {}
    };

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } }
        }),
        { file_read: function() { return null; } }
    );

    var prHelper = loadModule(
        'js/common/pullRequest.js',
        makeRequire({ './config.js': configModule }),
        defaults
    );

    return loadModule(
        'js/preCliStoryTestAutomationSetup.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/pullRequest.js': prHelper
        }),
        Object.assign({}, defaults, mocks)
    );
}

suite('preCliStoryTestAutomationSetup', function() {

    test('fetches linked Test Cases and writes context files', function() {
        var written = {};
        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-200")');
                assert.contains(args.jql, 'issuetype = "Test Case"');
                return [
                    {
                        key: 'TS-201',
                        fields: {
                            summary: 'Verify login',
                            description: 'User can log in',
                            status: { name: 'Ready For Development' },
                            priority: { name: 'High' }
                        }
                    }
                ];
            },
            file_write: function(args) { written[args.path] = args.content; },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'main';
                if (opts.command.indexOf('git ls-remote') === 0) return '';
                return '';
            }
        });

        module.action({
            inputFolderPath: 'input/TS-200',
            jobParams: { customParams: {} }
        });

        assert.ok(written['input/TS-200/linked_test_cases.json'], 'linked_test_cases.json written');
        assert.ok(written['input/TS-200/linked_test_cases.md'], 'linked_test_cases.md written');

        var json = JSON.parse(written['input/TS-200/linked_test_cases.json']);
        assert.equal(json.storyKey, 'TS-200');
        assert.equal(json.testCases.length, 1);
        assert.equal(json.testCases[0].key, 'TS-201');
        assert.contains(written['input/TS-200/linked_test_cases.md'], 'TS-201');
    });

    test('creates new test branch when none exists', function() {
        var commands = [];
        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function() { return []; },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git branch --list "test/TS-210"') return '';
                if (opts.command === 'git ls-remote --heads origin test/TS-210') return '';
                if (opts.command === 'git branch --show-current') return 'main';
                return '';
            },
            file_write: function() {}
        });

        module.action({
            inputFolderPath: 'input/TS-210',
            jobParams: { customParams: {} }
        });

        assert.ok(commands.some(function(c) { return c === 'git checkout -b test/TS-210'; }), 'created branch');
    });

});
