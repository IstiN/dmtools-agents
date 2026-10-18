/**
 * Unit tests for js/storyTestAutomationRework.js — mergeMain guard (gh-761)
 *
 * The rework post-action runs `git merge origin/main` after the CLI agent
 * finishes. When a merge is ALREADY in progress (MERGE_HEAD present — the
 * agent left a conflicted base-branch merge unconcluded), the old flow
 * finalized that foreign merge: `git merge` failed with "You have not
 * concluded your merge", the fallback then auto-resolved the leftover
 * unmerged paths (--ours/--theirs) and committed them — baking conflict
 * markers into a merge nobody deliberately resolved.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadTrackersSr(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

function loadRework(mocks, loaderOverride) {
    var requireMap = {
        './configLoader.js': {
            formatTemplate: function (template, values) {
                return template.replace(/\{ticketKey\}/g, values.ticketKey);
            }
        },
        './common/autoStart.js': {
            triggerConfiguredWorkflowForTicket: function () { return true; },
            triggerSmIfIdle: function () {}
        },
        './common/pullRequest.js': loadModule('js/common/pullRequest.js',
            makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') })),
        './common/mergeState.js': loadModule('js/common/mergeState.js'),
        './config.js': { LABELS: {} },
        './common/tokenUsageComment.js': {
            postTokenUsageComments: function () {}
        }
    };
    var allMocks = Object.assign({
        cli_execute_command: function () { return ''; },
        file_read: function () { return null; },
        file_write: function () {}
    }, mocks || {});
    requireMap['./common/trackers.js'] = loadTrackersSr(allMocks);
    if (loaderOverride) requireMap['./configLoader.js'] = loaderOverride;
    return loadModule(
        'js/storyTestAutomationRework.js',
        makeRequire(requireMap),
        allMocks
    );
}

var TEST_CONFIG = {
    workingDir: 'repo',
    git: { authorName: 'AI Teammate', authorEmail: 'ai@example.com' }
};

suite('storyTestAutomationRework — mergeMain mid-merge guard (gh-761)', function() {

    test('refuses to start while MERGE_HEAD exists — must not auto-resolve or finalize a foreign merge', function() {
        var commands = [];
        var m = loadRework({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                    return '9a7e2aecommitsha'; // merge in progress
                }
                return '';
            }
        });

        var threw = null;
        try {
            m.mergeMain('PROJ-123', TEST_CONFIG);
        } catch (e) {
            threw = e;
        }

        assert.ok(threw, 'mergeMain must refuse (throw) when a merge is in progress');
        assert.contains(threw.toString(), 'MERGE_HEAD');
        assert.equal(commands.length, 1, 'only the MERGE_HEAD probe may run before the refusal');
        assert.equal(commands.filter(function(c) { return c.indexOf('git merge') === 0; }).length, 0,
            'must not start a merge on top of an unconcluded one');
        assert.equal(commands.filter(function(c) { return c.indexOf('git checkout --') !== -1; }).length, 0,
            'must not auto-resolve the leftover unmerged paths');
        assert.equal(commands.filter(function(c) { return c.indexOf('git commit') === 0; }).length, 0,
            'must not finalize a merge this step did not start');
    });

    test('proceeds with the origin/main merge when no merge is in progress', function() {
        var commands = [];
        var m = loadRework({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                    throw new Error('Command execution failed (exit code 1)'); // no MERGE_HEAD
                }
                return '';
            }
        });

        m.mergeMain('PROJ-123', TEST_CONFIG);

        assert.ok(commands.some(function(c) { return c === 'git merge origin/main --no-edit'; }),
            'the origin/main merge must still run on a clean (non-merge) state');
    });

    test('refusal error names the ticket context so the job failure is actionable', function() {
        var m = loadRework({
            cli_execute_command: function(args) {
                if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                    return '9a7e2aecommitsha';
                }
                return '';
            }
        });

        var threw = null;
        try {
            m.mergeMain('PROJ-999', { workingDir: null, git: TEST_CONFIG.git });
        } catch (e) {
            threw = e;
        }

        assert.ok(threw, 'must refuse');
        assert.contains(threw.toString(), 'conclude', 'error must tell the operator what to do');
    });

    test('ado provider: push-failure comment + wip cleanup use ado_* tools, no jira_* (wave1c)', function() {
        var tools = [];
        var mocks = {
            cli_execute_command: function () { throw new Error('git boom'); },
            file_read: function () { return null; },
            file_write: function () {}
        };
        ['jira_post_comment', 'jira_remove_label', 'ado_add_work_item_comment', 'ado_remove_work_item_label'].forEach(function (n) {
            mocks[n] = function () { tools.push(n); };
        });
        var m = loadRework(mocks);
        // loadRework's configLoader stub only formats templates; patch in the pieces action() needs.
        var req = {
            './configLoader.js': {
                loadProjectConfig: function () { return Object.assign({}, TEST_CONFIG, { jira: { statuses: {} } }); },
                createScm: function () { return {}; },
                formatTemplate: function (t) { return t; }
            },
            './common/autoStart.js': { triggerSmIfIdle: function () {} },
            './common/pullRequest.js': loadModule('js/common/pullRequest.js',
            makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') })),
            './common/mergeState.js': loadModule('js/common/mergeState.js'),
            './config.js': { LABELS: {} },
            './common/tokenUsageComment.js': { postTokenUsageComments: function () {} },
            './common/trackers.js': loadTrackersSr(mocks)
        };
        var mod = loadModule('js/storyTestAutomationRework.js', makeRequire(req), mocks);
        var result = mod.action({
            ticket: { key: '88' },
            metadata: { contextId: 'story_test_automation_rework' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(result.success, false);
        assert.equal(tools.filter(function (t) { return t.indexOf('jira_') === 0; }).length, 0);
        assert.ok(tools.indexOf('ado_add_work_item_comment') !== -1);
        assert.ok(tools.indexOf('ado_remove_work_item_label') !== -1);
    });
});

// ── gh-916: stage-label fallback for the In Testing move ──

suite('storyTestAutomationRework: stage-label fallback (gh-916)', function() {
    var GH916_LOADER = {
        formatTemplate: function (template, values) {
            return template.replace(/\{ticketKey\}/g, values.ticketKey);
        },
        loadProjectConfig: function () {
            return {
                jira: makeDefaultJiraConfig(),
                workingDir: null,
                git: { authorName: 'AI Teammate', authorEmail: 'ai@example.com' },
                formats: { commitMessage: { testRework: '{ticketKey}: address review comments' } }
            };
        },
        createScm: function () {
            return { listPrs: function () { return []; } };
        }
    };

    test("'label' mode: a rejected In Testing move marks stage_in_testing, no throw", function() {
        var added = [];
        var moved = [];
        var module = loadRework({
            cli_execute_command: function(args) {
                if (args.command === 'git branch --show-current') return 'test/TS-800';
                if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') throw new Error('exit 1');
                if (args.command === 'git diff --cached --stat') return ' testing/tests/x.py | 1 +';
                if (args.command.indexOf('git ls-remote --heads origin test/TS-800') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-800';
                return '';
            },
            jira_move_to_status: function(args) {
                moved.push(args);
                throw new Error("The field 'State' contains the value 'In Testing' that is not in the list of supported values");
            },
            jira_add_label: function(args) { added.push(args); },
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        }, GH916_LOADER);

        var result = module.action({
            ticket: { key: 'TS-800' },
            response: 'fixed flaky locator',
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true);
        assert.deepEqual(moved, [{ key: 'TS-800', statusName: 'In Testing' }]);
        assert.deepEqual(added, [{ key: 'TS-800', label: 'stage_in_testing' }]);
    });
});

// ── gh-1006: characterization tests for mergeMain conflict-resolution paths ──
// Pure-refactor guard: these pin the exact git command order and error
// strings of mergeMain before the CRAP extraction (gh-1006).

function runMergeMainConflict(commands, behavior) {
    // behavior: function(command) → output string, or throw to simulate failure
    var m = loadRework({
        cli_execute_command: function (args) {
            commands.push(args.command);
            if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                throw new Error('exit 1'); // no merge in progress
            }
            return behavior(args.command);
        }
    });
    return m.mergeMain('PROJ-123', TEST_CONFIG);
}

suite('storyTestAutomationRework: mergeMain conflict auto-resolution (gh-1006)', function () {

    test('merge conflict: resolves ticket test file with --ours, others with --theirs, then commits', function () {
        var commands = [];
        runMergeMainConflict(commands, function (command) {
            if (command === 'git merge origin/main --no-edit') throw new Error('Auto-merging failed');
            if (command === 'git diff --name-only --diff-filter=U') {
                return 'testing/tests/PROJ-123/login.robot\njs/unrelated.js';
            }
            return '';
        });
        assert.deepEqual(commands, [
            'git rev-parse --quiet --verify MERGE_HEAD',
            'git config user.name "AI Teammate"',
            'git config user.email "ai@example.com"',
            'git fetch origin main',
            'git fetch --unshallow',
            'git merge origin/main --no-edit',
            'git diff --name-only --diff-filter=U',
            'git checkout --ours -- "testing/tests/PROJ-123/login.robot"',
            'git add "testing/tests/PROJ-123/login.robot"',
            'git checkout --theirs -- "js/unrelated.js"',
            'git add "js/unrelated.js"',
            'git commit -m "PROJ-123 test rework: merge origin/main and resolve test conflicts"'
        ], 'git commands must run in the exact established order');
    });

    test('merge conflict with no unmerged files throws without resolving or committing', function () {
        var commands = [];
        var threw = null;
        try {
            runMergeMainConflict(commands, function (command) {
                if (command === 'git merge origin/main --no-edit') throw new Error('boom');
                return ''; // empty conflict list
            });
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, 'must throw when the merge failed but no conflicted files are found');
        assert.contains(threw.toString(), 'no conflicted files were found');
        assert.equal(commands.some(function (c) { return c.indexOf('git checkout --') !== -1; }), false);
        assert.equal(commands.some(function (c) { return c.indexOf('git commit') === 0; }), false);
    });

    test('a failing git checkout aborts resolution with an actionable error, no commit', function () {
        var commands = [];
        var threw = null;
        try {
            runMergeMainConflict(commands, function (command) {
                if (command === 'git merge origin/main --no-edit') throw new Error('conflict');
                if (command === 'git diff --name-only --diff-filter=U') return 'testing/tests/PROJ-123/a.robot';
                if (command === 'git checkout --ours -- "testing/tests/PROJ-123/a.robot"') throw new Error('disk full');
                return '';
            });
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, 'must rethrow as a resolution failure');
        assert.contains(threw.toString(), 'Failed to resolve conflict for testing/tests/PROJ-123/a.robot');
        assert.equal(commands.some(function (c) { return c.indexOf('git commit') === 0; }), false);
    });

    test('a failing final commit throws with the commit error context', function () {
        var threw = null;
        try {
            runMergeMainConflict([], function (command) {
                if (command === 'git merge origin/main --no-edit') throw new Error('conflict');
                if (command === 'git diff --name-only --diff-filter=U') return 'js/unrelated.js';
                if (command === 'git add "js/unrelated.js"') throw new Error('index locked');
                return '';
            });
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, 'must throw');
        assert.contains(threw.toString(), 'Failed to resolve conflict for js/unrelated.js');
    });

    test('unshallow and git-config failures are non-fatal warnings; merge still runs', function () {
        var commands = [];
        runMergeMainConflict(commands, function (command) {
            if (command === 'git config user.name "AI Teammate"') throw new Error('no repo');
            if (command === 'git fetch --unshallow') throw new Error('already complete');
            return '';
        });
        assert.ok(commands.some(function (c) { return c === 'git merge origin/main --no-edit'; }),
            'merge must still run when author config and unshallow fail');
    });

    test('a failing origin/main fetch aborts before any merge attempt', function () {
        var commands = [];
        var threw = null;
        try {
            runMergeMainConflict(commands, function (command) {
                if (command === 'git fetch origin main') throw new Error('network down');
                return '';
            });
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, 'must throw');
        assert.contains(threw.toString(), 'Failed to fetch origin/main: ');
        assert.equal(commands.some(function (c) { return c.indexOf('git merge') === 0; }), false);
    });
});

// ── gh-1006: characterization tests for postThreadReplies (review-thread replies) ──

function makeReplyScm(calls, behavior) {
    return {
        replyToThread: function (pr, target, reply) {
            calls.push({ kind: 'reply', pr: pr, target: target, reply: reply });
            if (behavior && behavior.replyToThread) return behavior.replyToThread(pr, target, reply);
        },
        resolveThread: function (pr, target) {
            calls.push({ kind: 'resolve', pr: pr, target: target });
            if (behavior && behavior.resolveThread) return behavior.resolveThread(pr, target);
        }
    };
}

function loadReplyModule(fileContent) {
    return loadRework({
        file_read: function (args) {
            if (args.path === 'outputs/review_replies.json') return fileContent;
            return null;
        }
    });
}

suite('storyTestAutomationRework: postThreadReplies (gh-1006)', function () {

    test('missing review_replies.json returns 0 and never touches the SCM', function () {
        var calls = [];
        var m = loadReplyModule(null);
        assert.equal(m.postThreadReplies(makeReplyScm(calls), 42), 0);
        assert.deepEqual(calls, []);
    });

    test('unparseable review_replies.json returns 0 and never touches the SCM', function () {
        var calls = [];
        var m = loadReplyModule('{not json');
        assert.equal(m.postThreadReplies(makeReplyScm(calls), 42), 0);
        assert.deepEqual(calls, []);
    });

    test('empty replies array returns 0 and never touches the SCM', function () {
        var calls = [];
        var m = loadReplyModule('{"replies": []}');
        assert.equal(m.postThreadReplies(makeReplyScm(calls), 42), 0);
        assert.deepEqual(calls, []);
    });

    test('posts replies for two items: threadId, discussionId fallback and default reply text', function () {
        var calls = [];
        var m = loadReplyModule(JSON.stringify({
            replies: [
                { inReplyToId: 101, threadId: 't-1', reply: 'Fixed in abc123' },
                { inReplyToId: 202, discussionId: 'd-2' }
            ]
        }));
        var scm = makeReplyScm(calls);
        assert.equal(m.postThreadReplies(scm, 7), 2);
        assert.deepEqual(calls, [
            { kind: 'reply', pr: 7, target: { rootCommentId: 101, threadId: 't-1' }, reply: 'Fixed in abc123' },
            { kind: 'resolve', pr: 7, target: { threadId: 't-1' } },
            { kind: 'reply', pr: 7, target: { rootCommentId: 202, threadId: 'd-2' }, reply: '✅ Addressed.' },
            // no threadId on the second item — discussionId only feeds the reply target
        ]);
    });

    test('a failing reply is counted as not posted but does not stop the loop', function () {
        var calls = [];
        var m = loadReplyModule(JSON.stringify({
            replies: [
                { inReplyToId: 1, threadId: 't-1' },
                { inReplyToId: 2, threadId: 't-2' }
            ]
        }));
        var scm = makeReplyScm(calls, {
            replyToThread: function (pr, target) {
                if (target.rootCommentId === 1) throw new Error('thread gone');
            }
        });
        assert.equal(m.postThreadReplies(scm, 7), 1);
        assert.equal(calls.filter(function (c) { return c.kind === 'reply'; }).length, 2);
        assert.equal(calls.filter(function (c) { return c.kind === 'resolve'; }).length, 2,
            'both threads must still be resolved');
    });

    test('a failing resolve is non-fatal and does not change the posted count', function () {
        var calls = [];
        var m = loadReplyModule(JSON.stringify({
            replies: [{ inReplyToId: 1, threadId: 't-1' }]
        }));
        var scm = makeReplyScm(calls, {
            resolveThread: function () { throw new Error('cannot resolve'); }
        });
        assert.equal(m.postThreadReplies(scm, 7), 1);
    });
});
