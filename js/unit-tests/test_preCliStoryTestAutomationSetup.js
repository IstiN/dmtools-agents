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

suite('preCliStoryTestAutomationSetup.removeIrrelevantTestCode (gh-1192)', function() {

    test('removes tracked test code for every irrelevant TC, in order', function() {
        var commands = [];
        var module = loadPreCliStoryTestAutomationSetup({
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git ls-files -- testing/tests/TS-1') return 'testing/tests/TS-1/test.ts';
                if (opts.command === 'git ls-files -- testing/tests/TS-2') return 'testing/tests/TS-2/a.ts\ntesting/tests/TS-2/b.ts';
                return '';
            }
        });
        var removed = module.removeIrrelevantTestCode([
            { key: 'TS-1', fields: { status: { name: 'Irrelevant' } } },
            { key: 'TS-2', fields: { status: { name: 'Irrelevant' } } }
        ], null, 'testing/', 'Irrelevant');
        assert.deepEqual(removed, ['TS-1', 'TS-2']);
        assert.ok(commands.indexOf('git rm -r --ignore-unmatch -- testing/tests/TS-1') !== -1);
        assert.ok(commands.indexOf('git rm -r --ignore-unmatch -- testing/tests/TS-2') !== -1);
    });

    test('skips TCs whose status is not the irrelevant one', function() {
        var commands = [];
        var module = loadPreCliStoryTestAutomationSetup({
            cli_execute_command: function(opts) { commands.push(opts.command); return ''; }
        });
        var removed = module.removeIrrelevantTestCode([
            { key: 'TS-3', fields: { status: { name: 'Ready For Development' } } },
            { key: 'TS-4', fields: { status: { name: 'In Testing' } } }
        ], null, 'testing/', 'Irrelevant');
        assert.deepEqual(removed, []);
        assert.equal(commands.length, 0, 'no git probes for relevant TCs');
    });

    test('TCs with no tracked test code are left alone', function() {
        var commands = [];
        var module = loadPreCliStoryTestAutomationSetup({
            cli_execute_command: function(opts) { commands.push(opts.command); return ''; }
        });
        var removed = module.removeIrrelevantTestCode([
            { key: 'TS-5', fields: { status: { name: 'Irrelevant' } } }
        ], null, 'testing/', 'Irrelevant');
        assert.deepEqual(removed, []);
        assert.ok(commands.indexOf('git ls-files -- testing/tests/TS-5') !== -1);
        assert.equal(commands.filter(function(c) { return c.indexOf('git rm') === 0; }).length, 0);
    });

    test('a failing rm warns and does not abort the remaining TCs', function() {
        var commands = [];
        var module = loadPreCliStoryTestAutomationSetup({
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git rm -r --ignore-unmatch -- testing/tests/TS-6') throw new Error('rm boom');
                if (opts.command.indexOf('git ls-files') === 0) return 'testing/x.ts';
                return '';
            }
        });
        var removed = module.removeIrrelevantTestCode([
            { key: 'TS-6', fields: { status: { name: 'Irrelevant' } } },
            { key: 'TS-7', fields: { status: { name: 'Irrelevant' } } }
        ], null, 'testing/', 'Irrelevant');
        assert.deepEqual(removed, ['TS-7']);
    });

    test('a failing ls-files probe warns and skips that TC', function() {
        var module = loadPreCliStoryTestAutomationSetup({
            cli_execute_command: function(opts) {
                if (opts.command.indexOf('git ls-files') === 0) throw new Error('ls boom');
                return '';
            }
        });
        var removed = module.removeIrrelevantTestCode([
            { key: 'TS-8', fields: { status: { name: 'Irrelevant' } } }
        ], null, 'testing/', 'Irrelevant');
        assert.deepEqual(removed, []);
    });

    test('getTestCaseDirectory joins testFilesPath, tests and the TC key', function() {
        var module = loadPreCliStoryTestAutomationSetup({});
        assert.equal(module.getTestCaseDirectory('TC-9', 'testing/'), 'testing/tests/TC-9');
        assert.equal(module.getTestCaseDirectory('TC-9', 'testing'), 'testing/tests/TC-9');
    });

    test('testCaseTypeOf honors the configured issue type, defaulting to "Test Case"', function() {
        var module = loadPreCliStoryTestAutomationSetup({});
        assert.equal(module.testCaseTypeOf({ jira: { issueTypes: { TEST_CASE: 'TC Custom' } } }), 'TC Custom');
        assert.equal(module.testCaseTypeOf({ jira: {} }), 'Test Case');
        assert.equal(module.testCaseTypeOf({}), 'Test Case');
    });

    test('action removes irrelevant TC code, reports it and still succeeds', function() {
        var commands = [];
        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function() {
                return [{ key: 'TS-201', fields: { summary: 'S', status: { name: 'Irrelevant' } } }];
            },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git ls-files -- testing/tests/TS-201') return 'testing/tests/TS-201/test.ts';
                if (opts.command === 'git branch --list "test/TS-200"') return '';
                if (opts.command.indexOf('git ls-remote') === 0) return '';
                return '';
            },
            file_write: function() {}
        });
        var result = module.action({ inputFolderPath: 'input/TS-200', jobParams: { customParams: {} } });
        assert.equal(result.success, true);
        assert.ok(commands.indexOf('git rm -r --ignore-unmatch -- testing/tests/TS-201') !== -1);
    });

    test('non-fatal step failures: a blowing-up branch checkout still ends in success', function() {
        var module = loadPreCliStoryTestAutomationSetup({
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --list "test/TS-211"') throw new Error('git boom');
                return '';
            }
        });
        var result = module.action({ inputFolderPath: 'input/TS-211', jobParams: { customParams: {} } });
        assert.equal(result.success, true);
    });

    test('a top-level failure (no input folder) fails the action', function() {
        var module = loadPreCliStoryTestAutomationSetup({});
        var result = module.action({ jobParams: { customParams: {} } });
        assert.equal(result.success, false);
    });
});

// ── Suite: gh-1223 characterization: alignBranchWithBase gaps ───────────────
// Pins the remote-only checkout path and the failure-tolerance of the
// recreate/conflict branches ahead of the gh-1223 helper extraction. These
// tests must keep passing unchanged through the refactor.

suite('preCliStoryTestAutomationSetup — gh-1223 characterization: alignBranchWithBase gaps', function() {

    // Mirrors the inline loadModule pattern used by the conflict suites above,
    // allowing the githubHelpers (conflict probe) to be overridden per test.
    function loadStoryWithConflicts(githubHelpers, cliMock) {
        return loadModule(
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
                    { jira_search_by_jql: function() { return []; }, cli_execute_command: cliMock, file_write: function() {} }
                ),
                './common/githubHelpers.js': githubHelpers,
                './common/scm.js': { createScm: function() { return {}; } }
            }),
            { jira_search_by_jql: function() { return []; }, cli_execute_command: cliMock, file_write: function() {} }
        );
    }

    var NO_CONFLICTS_HELPERS = {
        detectMergeConflicts: function() { return []; },
        getPRDiff: function() { return ''; },
        trimLargeTextForInput: function(text) { return text || ''; }
    };

    test('remote-only branch is checked out with -b from origin', function() {
        var commands = [];

        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function() { return []; },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git branch --list "test/TS-220"') return '';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-220') === 0) {
                    return 'abc1234567890abcdef1234567890abcdef1234\trefs/heads/test/TS-220\n';
                }
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return 'somecommit';
                return '';
            },
            file_write: function() {}
        });

        module.action({
            inputFolderPath: 'input/TS-220',
            jobParams: { customParams: {} }
        });

        assert.ok(commands.some(function(c) { return c === 'git checkout -b test/TS-220 origin/test/TS-220'; }),
            'remote-only branch must be checked out tracking origin');
        assert.equal(commands.filter(function(c) { return c === 'git checkout -b test/TS-220'; }).length, 0,
            'must not create a fresh branch when origin already has one');
    });

    test('recreate path tolerates local branch deletion failure', function() {
        var commands = [];

        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function() { return []; },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git branch --list "test/TS-221"') return '  test/TS-221';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-221') === 0) {
                    return 'abc1234567890abcdef1234567890abcdef1234\trefs/heads/test/TS-221\n';
                }
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return '';
                if (opts.command.indexOf('git branch -D ') === 0) throw new Error('local delete refused');
                return '';
            },
            file_write: function() {}
        });

        module.action({
            inputFolderPath: 'input/TS-221',
            jobParams: { customParams: {} }
        });

        assert.ok(commands.some(function(c) { return c === 'git push origin --delete test/TS-221'; }),
            'remote deletion must still be attempted after a local delete failure');
        assert.ok(commands.some(function(c) { return c === 'git checkout -b test/TS-221'; }),
            'branch must still be recreated from fresh main');
    });

    test('recreate path tolerates remote branch deletion failure', function() {
        var commands = [];

        var module = loadPreCliStoryTestAutomationSetup({
            jira_search_by_jql: function() { return []; },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git branch --list "test/TS-222"') return '  test/TS-222';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-222') === 0) {
                    return 'abc1234567890abcdef1234567890abcdef1234\trefs/heads/test/TS-222\n';
                }
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return '';
                if (opts.command.indexOf('git push origin --delete ') === 0) throw new Error('remote delete refused');
                return '';
            },
            file_write: function() {}
        });

        module.action({
            inputFolderPath: 'input/TS-222',
            jobParams: { customParams: {} }
        });

        assert.ok(commands.some(function(c) { return c === 'git checkout -b test/TS-222'; }),
            'branch must still be recreated when the remote deletion fails');
    });

    test('conflict guidance still written when the PR diff is empty', function() {
        var written = {};
        var githubHelpers = {
            detectMergeConflicts: function() { return ['testing/tests/TS-223/test_ts_223.py']; },
            getPRDiff: function() { return ''; },
            trimLargeTextForInput: function(text) { return text || ''; }
        };

        var cliMock = function(opts) {
            if (opts.command === 'git branch --list "test/TS-223"') return '  test/TS-223';
            if (opts.command.indexOf('git ls-remote --heads origin test/TS-223') === 0) {
                return 'abc1234567890abcdef1234567890abcdef1234\trefs/heads/test/TS-223\n';
            }
            if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return 'somecommit';
            return '';
        };

        var module = loadStoryWithConflicts(githubHelpers, cliMock);
        // Re-load with a capturing file_write on the top-level globals.
        module = loadModule(
            'js/preCliStoryTestAutomationSetup.js',
            makeRequire({
                './config.js': configModule,
                './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), { jira_search_by_jql: function() { return []; } }),
                './configLoader.js': loadModule('js/configLoader.js', makeRequire({ './config.js': configModule, './common/scm.js': { createScm: function() { return {}; } } }), { file_read: function() { return null; } }),
                './common/pullRequest.js': loadModule('js/common/pullRequest.js', makeRequire({ './config.js': configModule, './mergeState.js': loadModule('js/common/mergeState.js'), './common/mergeState.js': loadModule('js/common/mergeState.js') }), { jira_search_by_jql: function() { return []; }, cli_execute_command: cliMock, file_write: function() {} }),
                './common/githubHelpers.js': githubHelpers,
                './common/scm.js': { createScm: function() { return {}; } }
            }),
            { jira_search_by_jql: function() { return []; }, cli_execute_command: cliMock, file_write: function(args) { written[args.path] = args.content; } }
        );

        module.action({
            inputFolderPath: 'input/TS-223',
            jobParams: { customParams: {} }
        });

        assert.ok(written.hasOwnProperty('input/TS-223/merge_conflicts.md'),
            'conflict guidance must be written even without a PR diff');
        assert.ok(!written.hasOwnProperty('input/TS-223/pr_diff.txt'),
            'no pr_diff.txt when the diff probe returns nothing');
    });

    test('conflict guidance still written when the PR diff probe throws', function() {
        var written = {};
        var githubHelpers = {
            detectMergeConflicts: function() { return ['testing/tests/TS-224/test_ts_224.py']; },
            getPRDiff: function() { throw new Error('diff probe failed'); },
            trimLargeTextForInput: function(text) { return text || ''; }
        };

        var cliMock = function(opts) {
            if (opts.command === 'git branch --list "test/TS-224"') return '  test/TS-224';
            if (opts.command.indexOf('git ls-remote --heads origin test/TS-224') === 0) {
                return 'abc1234567890abcdef1234567890abcdef1234\trefs/heads/test/TS-224\n';
            }
            if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') === 0) return 'somecommit';
            return '';
        };

        var module = loadModule(
            'js/preCliStoryTestAutomationSetup.js',
            makeRequire({
                './config.js': configModule,
                './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), { jira_search_by_jql: function() { return []; } }),
                './configLoader.js': loadModule('js/configLoader.js', makeRequire({ './config.js': configModule, './common/scm.js': { createScm: function() { return {}; } } }), { file_read: function() { return null; } }),
                './common/pullRequest.js': loadModule('js/common/pullRequest.js', makeRequire({ './config.js': configModule, './mergeState.js': loadModule('js/common/mergeState.js'), './common/mergeState.js': loadModule('js/common/mergeState.js') }), { jira_search_by_jql: function() { return []; }, cli_execute_command: cliMock, file_write: function() {} }),
                './common/githubHelpers.js': githubHelpers,
                './common/scm.js': { createScm: function() { return {}; } }
            }),
            { jira_search_by_jql: function() { return []; }, cli_execute_command: cliMock, file_write: function(args) { written[args.path] = args.content; } }
        );

        module.action({
            inputFolderPath: 'input/TS-224',
            jobParams: { customParams: {} }
        });

        assert.ok(written.hasOwnProperty('input/TS-224/merge_conflicts.md'),
            'conflict guidance must survive a failing PR diff probe');
        assert.ok(!written.hasOwnProperty('input/TS-224/pr_diff.txt'),
            'no pr_diff.txt when the diff probe throws');
    });

});
