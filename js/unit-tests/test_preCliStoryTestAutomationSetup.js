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

    var githubHelpers = {
        detectMergeConflicts: function() { return []; },
        getPRDiff: function() { return ''; },
        trimLargeTextForInput: function(text) { return text || ''; }
    };

    return loadModule(
        'js/preCliStoryTestAutomationSetup.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/pullRequest.js': prHelper,
            './common/githubHelpers.js': githubHelpers,
            './common/scm.js': { createScm: function() { return {}; } }
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

    test('recreates test branch from main when it is already merged', function() {
        var commands = [];
        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function() { return []; },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git branch --list "test/TS-211"') return '  test/TS-211';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-211') === 0) return 'abc refs/heads/test/TS-211';
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return '';
                return '';
            },
            file_write: function() {}
        });

        module.action({
            inputFolderPath: 'input/TS-211',
            jobParams: { customParams: {} }
        });

        assert.ok(commands.some(function(c) { return c === 'git checkout main'; }), 'switched to main');
        assert.ok(commands.some(function(c) { return c === 'git branch -D test/TS-211'; }), 'deleted local branch');
        assert.ok(commands.some(function(c) { return c === 'git push origin --delete test/TS-211'; }), 'deleted remote branch');
        assert.ok(commands.some(function(c) { return c === 'git checkout -b test/TS-211'; }), 'recreated branch');
    });

    test('merges main into unmerged test branch cleanly', function() {
        var conflicts = [];
        var mergeCalled = false;
        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function() { return []; },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --list "test/TS-212"') return '  test/TS-212';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-212') === 0) return 'abc refs/heads/test/TS-212';
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return 'somecommit';
                return '';
            },
            file_write: function() {}
        });

        // Inject a mock githubHelpers that reports no conflicts
        var githubHelpers = {
            detectMergeConflicts: function(baseBranch, inputFolder, workingDir) {
                mergeCalled = true;
                assert.equal(baseBranch, 'main');
                return conflicts;
            },
            getPRDiff: function() { return ''; },
            trimLargeTextForInput: function(text) { return text || ''; }
        };

        module = loadModule(
            'js/preCliStoryTestAutomationSetup.js',
            makeRequire({
                './config.js': configModule,
                './configLoader.js': loadModule(
                    'js/configLoader.js',
                    makeRequire({
                        './config.js': configModule,
                        './common/scm.js': { createScm: function() { return {}; } }
                    }),
                    { file_read: function() { return null; } }
                ),
                './common/pullRequest.js': loadModule(
                    'js/common/pullRequest.js',
                    makeRequire({ './config.js': configModule }),
                    { jira_search_by_jql: function() { return []; }, cli_execute_command: function() { return ''; }, file_write: function() {} }
                ),
                './common/githubHelpers.js': githubHelpers,
                './common/scm.js': { createScm: function() { return {}; } }
            }),
            { jira_search_by_jql: function() { return []; }, cli_execute_command: function(opts) {
                if (opts.command === 'git branch --list "test/TS-212"') return '  test/TS-212';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-212') === 0) return 'abc refs/heads/test/TS-212';
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return 'somecommit';
                return '';
            }, file_write: function() {} }
        );

        module.action({
            inputFolderPath: 'input/TS-212',
            jobParams: { customParams: {} }
        });

        assert.ok(mergeCalled, 'merge conflicts check was called');
    });

    test('writes conflict files when merging main into test branch produces conflicts', function() {
        var written = {};
        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function() { return []; },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --list "test/TS-213"') return '  test/TS-213';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-213') === 0) return 'abc refs/heads/test/TS-213';
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return 'somecommit';
                return '';
            },
            file_write: function(args) { written[args.path] = args.content; }
        });

        var githubHelpers = {
            detectMergeConflicts: function() { return ['testing/tests/TS-213/test_ts_213.py']; },
            getPRDiff: function() { return 'diff --git a/testing/tests/TS-213/test_ts_213.py'; },
            trimLargeTextForInput: function(text) { return text || ''; }
        };

        module = loadModule(
            'js/preCliStoryTestAutomationSetup.js',
            makeRequire({
                './config.js': configModule,
                './configLoader.js': loadModule(
                    'js/configLoader.js',
                    makeRequire({
                        './config.js': configModule,
                        './common/scm.js': { createScm: function() { return {}; } }
                    }),
                    { file_read: function() { return null; } }
                ),
                './common/pullRequest.js': loadModule(
                    'js/common/pullRequest.js',
                    makeRequire({ './config.js': configModule }),
                    { jira_search_by_jql: function() { return []; }, cli_execute_command: function() { return ''; }, file_write: function() {} }
                ),
                './common/githubHelpers.js': githubHelpers,
                './common/scm.js': { createScm: function() { return {}; } }
            }),
            { jira_search_by_jql: function() { return []; }, cli_execute_command: function(opts) {
                if (opts.command === 'git branch --list "test/TS-213"') return '  test/TS-213';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-213') === 0) return 'abc refs/heads/test/TS-213';
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return 'somecommit';
                return '';
            }, file_write: function(args) { written[args.path] = args.content; } }
        );

        module.action({
            inputFolderPath: 'input/TS-213',
            jobParams: { customParams: {} }
        });

        assert.ok(written['input/TS-213/merge_conflicts.md'], 'merge_conflicts.md written');
        assert.ok(written['input/TS-213/pr_diff.txt'], 'pr_diff.txt written');
        assert.contains(written['input/TS-213/merge_conflicts.md'], 'testing/tests/TS-213/test_ts_213.py');
    });

});
