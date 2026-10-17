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
        makeRequire({
            './config.js': configModule,
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }),
        defaults
    );

    var githubHelpers = {
        detectMergeConflicts: function() { return []; },
        getPRDiff: function() { return ''; },
        trimLargeTextForInput: function(text) { return text || ''; }
    };

    var allMocks = Object.assign({}, defaults, mocks);
    return loadModule(
        'js/preCliStoryTestAutomationSetup.js',
        makeRequire({
            './config.js': configModule,
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), allMocks),
            './configLoader.js': freshConfigLoader,
            './common/pullRequest.js': prHelper,
            './common/githubHelpers.js': githubHelpers,
            './common/scm.js': { createScm: function() { return {}; } }
        }),
        allMocks
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
                './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), { jira_search_by_jql: function() { return []; } }),
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
                    makeRequire({
                        './config.js': configModule,
                        './mergeState.js': loadModule('js/common/mergeState.js'),
                        './common/mergeState.js': loadModule('js/common/mergeState.js')
                    }),
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
                './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), { jira_search_by_jql: function() { return []; } }),
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
                    makeRequire({
                        './config.js': configModule,
                        './mergeState.js': loadModule('js/common/mergeState.js'),
                        './common/mergeState.js': loadModule('js/common/mergeState.js')
                    }),
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

// ── gh-930: writePrContext fixtures ─────────────────────────────────────────
// writePrContext was 0% covered (CRAP 812). These tests drive action() with
// fixture SCMs for each PR source (GitHub / GitLab / ADO shapes) — the helper
// is source-agnostic: it only calls scm.getPrDiff / scm.fetchDiscussions.
function loadForPrContext(mocks, opts) {
    opts = opts || {};
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
        makeRequire({
            './config.js': configModule,
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }),
        defaults
    );

    var githubHelpers = {
        detectMergeConflicts: function() { return []; },
        getPRDiff: function() { return ''; },
        trimLargeTextForInput: function(text) { return text || ''; }
    };

    var allMocks = Object.assign({}, defaults, mocks);
    return loadModule(
        'js/preCliStoryTestAutomationSetup.js',
        makeRequire({
            './config.js': configModule,
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), allMocks),
            './configLoader.js': freshConfigLoader,
            './common/pullRequest.js': prHelper,
            './common/githubHelpers.js': githubHelpers,
            './common/scm.js': { createScm: function() { return opts.scm || {}; } }
        }),
        allMocks
    );
}

suite('preCliStoryTestAutomationSetup > writePrContext fixtures (gh-930)', function() {

    function runSetup(scm, mocks) {
        var written = {};
        var module = loadForPrContext(Object.assign({
            file_write: function(args) { written[args.path] = args.content; }
        }, mocks || {}), { scm: scm });
        var result = module.action({
            inputFolderPath: 'input/TS-300',
            jobParams: { customParams: {} }
        });
        return { written: written, result: result };
    }

    test('GitHub PR fixture writes pr_info.md, pr_diff.txt, discussions and open-thread replies', function() {
        var pr = {
            number: 77,
            html_url: 'https://github.com/acme/widgets/pull/77',
            title: 'Add TS-300 tests',
            state: 'open',
            user: { login: 'octocat' },
            head: { ref: 'test/TS-300' },
            base: { ref: 'main' }
        };
        var scm = {
            listPrs: function() { return [pr]; },
            getPrDiff: function(n) {
                assert.equal(n, 77);
                return 'diff --git a/testing/tests/TS-300/x.py b/testing/tests/TS-300/x.py\n+assert True\n';
            },
            fetchDiscussions: function(n) {
                assert.equal(n, 77);
                return {
                    markdown: '# PR Discussions\n',
                    rawThreads: { threads: [
                        { threadId: 't1', path: 'testing/tests/TS-300/x.py', line: 12, body: 'Fix assertion', resolved: false, id: 'c1' },
                        { threadId: 't2', path: 'testing/tests/TS-300/y.py', line: 3, body: 'Naming', resolved: false, id: 'c2' },
                        { threadId: 't3', path: 'testing/tests/TS-300/z.py', line: 8, body: 'Already handled', resolved: true, id: 'c3' }
                    ] }
                };
            }
        };

        var out = runSetup(scm);

        assert.equal(out.result.success, true);
        var info = out.written['input/TS-300/pr_info.md'];
        assert.ok(info, 'pr_info.md written');
        assert.contains(info, '# Pull Request Information');
        assert.contains(info, '- **PR #**: 77');
        assert.contains(info, '- **URL**: https://github.com/acme/widgets/pull/77');
        assert.contains(info, '- **Title**: Add TS-300 tests');
        assert.contains(info, '- **Author**: octocat');
        assert.contains(info, '- **Branch**: `test/TS-300` → `main`');
        assert.contains(info, '- **State**: open');
        assert.equal(out.written['input/TS-300/pr_diff.txt'],
            'diff --git a/testing/tests/TS-300/x.py b/testing/tests/TS-300/x.py\n+assert True\n');
        assert.equal(out.written['input/TS-300/pr_discussions.md'], '# PR Discussions\n');
        var replies = JSON.parse(out.written['outputs/review_replies.json']).replies;
        assert.equal(replies.length, 2, 'only unresolved threads become replies');
        assert.equal(replies[0].file, 'testing/tests/TS-300/x.py');
        assert.equal(replies[0].line, 12);
        assert.equal(replies[0].comment, 'Fix assertion');
        assert.equal(replies[0].severity, 'important');
        assert.equal(replies[0].threadId, 't1');
        assert.equal(replies[0].inReplyToId, 'c1');
        assert.equal(replies[1].file, 'testing/tests/TS-300/y.py');
        assert.equal(replies[1].threadId, 't2');
    });

    test('GitLab/ADO-shaped PR fixture (missing user/title/state, no diff, no discussions) degrades gracefully', function() {
        var scm = {
            listPrs: function() {
                return [{ number: 9, head: { ref: 'test/TS-300' }, base: { ref: 'main' } }];
            },
            getPrDiff: function() { return null; },
            fetchDiscussions: function() { return null; }
        };

        var out = runSetup(scm);

        assert.equal(out.result.success, true);
        var info = out.written['input/TS-300/pr_info.md'];
        assert.contains(info, '- **PR #**: 9');
        assert.contains(info, '- **Author**: \n');
        assert.contains(info, '- **Branch**: `test/TS-300` → `main`');
        assert.contains(info, '- **State**: \n');
        assert.ok(out.written['input/TS-300/pr_diff.txt'] === undefined, 'no diff → no pr_diff.txt');
        assert.ok(out.written['input/TS-300/pr_discussions.md'] === undefined, 'no discussions → no file');
        assert.ok(out.written['outputs/review_replies.json'] === undefined, 'no threads → no replies');
    });

    test('markdown and raw threads beyond 100 entries are trimmed to the last 100', function() {
        var threads = [];
        var sections = [];
        for (var i = 1; i <= 103; i++) {
            threads.push({ threadId: 't' + i, path: 'f' + i + '.py', line: i, body: 'note ' + i, resolved: false, id: 'c' + i });
            sections.push('### Thread ' + i + '\nbody ' + i);
        }
        var markdown = '# Discussions\n' + sections.join('\n') + '\n';
        var scm = {
            listPrs: function() {
                return [{ number: 77, head: { ref: 'test/TS-300' }, base: { ref: 'main' } }];
            },
            getPrDiff: function() { return 'd'; },
            fetchDiscussions: function() { return { markdown: markdown, rawThreads: { threads: threads } }; }
        };

        var out = runSetup(scm);

        var md = out.written['input/TS-300/pr_discussions.md'];
        assert.ok(md.indexOf('### Thread 103') !== -1, 'keeps the newest thread');
        assert.equal(md.indexOf('### Thread 1\n'), -1, 'drops the oldest beyond 100');
        assert.equal(md.split('### Thread ').length - 1, 100, 'exactly 100 threads kept');
        var replies = JSON.parse(out.written['outputs/review_replies.json']).replies;
        assert.equal(replies.length, 100, 'replies derive from the trimmed thread list');
        assert.equal(replies[0].threadId, 't4');
        assert.equal(replies[99].threadId, 't103');
    });

    test('scm failures while writing PR context are non-fatal — the setup action still succeeds', function() {
        var scm = {
            listPrs: function() {
                return [{ number: 5, head: { ref: 'test/TS-300' }, base: { ref: 'main' } }];
            },
            getPrDiff: function() { throw new Error('diff API down'); },
            fetchDiscussions: function() { throw new Error('discussions API down'); }
        };

        var out = runSetup(scm);

        assert.equal(out.result.success, true);
        assert.ok(out.written['input/TS-300/pr_info.md'], 'pr_info.md still written');
        assert.ok(out.written['input/TS-300/pr_diff.txt'] === undefined, 'failed diff write skipped');
        assert.ok(out.written['outputs/review_replies.json'] === undefined, 'failed discussions write skipped');
    });

    test('no open test PR → no PR context files at all', function() {
        var scm = {
            listPrs: function() { return []; },
            getPrDiff: function() { throw new Error('must not be called'); },
            fetchDiscussions: function() { throw new Error('must not be called'); }
        };

        var out = runSetup(scm);

        assert.equal(out.result.success, true);
        assert.ok(out.written['input/TS-300/pr_info.md'] === undefined);
        assert.ok(out.written['outputs/review_replies.json'] === undefined);
    });

});
