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

// ── gh-1080: characterization tests pinning current action() behaviour before
// the CRAP split. PR announcement, status moves, review triggers and the
// error paths are exercised here. ──

function loadReworkWith(autoStartModule, scmFactory, mocks, tokenUsageModule) {
    var allMocks = Object.assign({
        cli_execute_command: function () { return ''; },
        file_read: function () { return null; },
        file_write: function () {}
    }, mocks || {});
    var requireMap = {
        './configLoader.js': {
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
            createScm: scmFactory
        },
        './common/autoStart.js': autoStartModule,
        './common/pullRequest.js': loadModule('js/common/pullRequest.js',
            makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') })),
        './common/mergeState.js': loadModule('js/common/mergeState.js'),
        './config.js': { LABELS: {} },
        './common/tokenUsageComment.js': tokenUsageModule || { postTokenUsageComments: function () {} },
        './common/trackers.js': loadTrackersSr(allMocks)
    };
    return loadModule('js/storyTestAutomationRework.js', makeRequire(requireMap), allMocks);
}

function recordingAutoStart(configuredBehavior) {
    return {
        configuredCalls: [],
        smIdleCalls: [],
        triggerConfiguredWorkflowForTicket: function (opts) {
            this.configuredCalls.push(opts);
            if (configuredBehavior === 'throw') throw new Error('workflow dispatch down');
            return true;
        },
        triggerSmIfIdle: function (opts) {
            this.smIdleCalls.push(opts);
            if (configuredBehavior === 'sm-throws') throw new Error('sm down');
        }
    };
}

function reworkCliMock(commands, overrides) {
    return function(args) {
        commands.push(args.command);
        if (overrides && overrides[args.command]) return overrides[args.command](args);
        if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') throw new Error('exit 1');
        if (args.command === 'git branch --show-current') return 'test/TS-900';
        if (args.command === 'git diff --cached --stat') return ' testing/tests/TS-900/x.py | 1 +';
        if (args.command.indexOf('git ls-remote --heads origin test/TS-900') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-900';
        return '';
    };
}

function makeScm(openPrs) {
    return {
        prs: openPrs || [],
        replies: [],
        resolves: [],
        comments: [],
        labelRemovals: [],
        listPrs: function () { return this.prs; },
        replyToThread: function (prId, target, text) { this.replies.push({ prId: prId, target: target, text: text }); },
        resolveThread: function (prId, target) { this.resolves.push({ prId: prId, target: target }); },
        addComment: function (prId, body) { this.comments.push({ prId: prId, body: body }); },
        removeLabel: function (prId, label) { this.labelRemovals.push({ prId: prId, label: label }); }
    };
}

var REWORK_OPEN_PR = [{ number: 7, head: { ref: 'test/TS-900' }, html_url: 'https://example.com/repo/pull/7' }];

suite('storyTestAutomationRework: action characterization (gh-1080 CRAP split)', function() {

    // gh-1080 CRAP ratchet: the jira_* recorders live in their own helper so the
    // action-invocation plumbing stays below the new-function threshold (>8).
    function reworkJiraMocks(opts, jiraCalls) {
        return {
            jira_post_comment: function (args) { jiraCalls.comments.push(args.comment); },
            jira_remove_label: function (args) { jiraCalls.labelsRemoved.push(args.label); },
            jira_add_label: function (args) { jiraCalls.labelsAdded.push(args.label); },
            jira_move_to_status: function (args) {
                jiraCalls.moves.push(args.statusName);
                if (opts.rejectInTesting && args.statusName === 'In Testing') throw new Error('state rejected');
                return {};
            }
        };
    }

    function runReworkAction(opts) {
        opts = opts || {};
        var commands = [];
        var autoStart = opts.autoStart || recordingAutoStart();
        var scm = opts.scm !== undefined ? opts.scm : makeScm([]);
        var jiraCalls = { comments: [], labelsRemoved: [], labelsAdded: [], moves: [] };
        var mocks = Object.assign({
            cli_execute_command: reworkCliMock(commands, opts.cliOverrides),
            file_read: opts.fileRead || function () { return null; }
        }, reworkJiraMocks(opts, jiraCalls), opts.mocks || {});
        var module = loadReworkWith(autoStart, function () { return scm; }, mocks, opts.tokenUsage);
        var params = {
            ticket: { key: 'TS-900' },
            response: 'addressed flaky locator',
            initiator: 'sm',
            metadata: { contextId: 'story_test_automation_rework' },
            jobParams: { customParams: opts.customParams || {} }
        };
        var result = module.action(params);
        return { result: result, commands: commands, autoStart: autoStart, scm: scm, jira: jiraCalls };
    }

    test('an open test PR gets thread replies, an SCM comment, a Jira comment with the PR link', function() {
        var scm = makeScm(REWORK_OPEN_PR);
        var run = runReworkAction({
            scm: scm,
            fileRead: function (args) {
                if (args.path === 'outputs/review_replies.json') {
                    return JSON.stringify({ replies: [{ inReplyToId: 55, threadId: 't-9', reply: 'done' }] });
                }
                return null;
            }
        });

        assert.equal(run.result.success, true);
        assert.equal(run.result.prUrl, 'https://example.com/repo/pull/7');
        assert.deepEqual(run.scm.replies, [
            { prId: 7, target: { rootCommentId: 55, threadId: 't-9' }, text: 'done' }
        ]);
        assert.equal(run.scm.comments.length, 1);
        assert.contains(run.scm.comments[0].body, 'Story Test Rework Complete — TS-900');
        assert.contains(run.scm.comments[0].body, 'addressed flaky locator');
        assert.ok(run.jira.comments.some(function(c) { return c.indexOf('Story Test Rework Completed') !== -1; }));
        assert.ok(run.jira.comments.some(function(c) { return c.indexOf('*Pull Request*: https://example.com/repo/pull/7') !== -1; }));
        assert.equal(run.autoStart.smIdleCalls.length, 1, 'review falls back to the SM trigger');
        assert.equal(run.autoStart.configuredCalls.length, 0);
        assert.equal(run.scm.labelRemovals.length, 1, 'the rework-needed label is removed from the PR');
    });

    test('a failing SCM comment only warns — the rework still succeeds', function() {
        var scm = makeScm(REWORK_OPEN_PR);
        scm.addComment = function () { throw new Error('scm comment denied'); };
        var run = runReworkAction({ scm: scm });

        assert.equal(run.result.success, true);
        assert.ok(run.jira.comments.some(function(c) { return c.indexOf('Story Test Rework Completed') !== -1; }),
            'the Jira comment is still posted');
    });

    test('In Testing move success logs the move; a rejected none-mode move is caught', function() {
        var run = runReworkAction({});
        assert.equal(run.result.success, true);
        assert.deepEqual(run.jira.moves, ['In Testing']);

        var rejected = runReworkAction({ rejectInTesting: true });
        assert.equal(rejected.result.success, true, 'a rejected story move must not fail the rework');
        assert.deepEqual(rejected.jira.moves, ['In Testing']);
    });

    test('autoStartReview routes to the configured workflow and skips the SM fallback', function() {
        var run = runReworkAction({
            customParams: {
                autoStartReview: true,
                autoStartReviewConfigFile: 'agents/pr_story_test_automation_review.json',
                removeLabel: 'sm_story_test_rework_triggered'
            }
        });

        assert.equal(run.result.success, true);
        assert.equal(run.autoStart.configuredCalls.length, 1);
        assert.equal(run.autoStart.configuredCalls[0].ticketKey, 'TS-900');
        assert.equal(run.autoStart.configuredCalls[0].configFile, 'agents/pr_story_test_automation_review.json');
        assert.equal(run.autoStart.configuredCalls[0].label, 'pr_story_test_automation_review');
        assert.deepEqual(run.autoStart.configuredCalls[0].stripKeys, ['removeLabel', 'autoStartReview', 'autoStartReviewConfigFile']);
        assert.equal(run.autoStart.smIdleCalls.length, 0);
        assert.ok(run.jira.labelsRemoved.indexOf('sm_story_test_rework_triggered') !== -1,
            'the custom SM trigger label is removed');
    });

    test('a failing workflow dispatch falls back to the SM trigger', function() {
        var run = runReworkAction({
            customParams: { autoStartReview: true, autoStartReviewConfigFile: 'agents/pr_story_test_automation_review.json' },
            autoStart: recordingAutoStart('throw')
        });

        assert.equal(run.result.success, true);
        assert.equal(run.autoStart.smIdleCalls.length, 1, 'SM fallback ran after the dispatch failure');
    });

    test('a failing token usage comment does not fail the rework', function() {
        var run = runReworkAction({
            tokenUsage: { postTokenUsageComments: function () { throw new Error('ledger down'); } }
        });

        assert.equal(run.result.success, true);
    });

    test('a failing SM fallback fails the run through the outer error path and releases the lock', function() {
        var run = runReworkAction({ autoStart: recordingAutoStart('sm-throws') });

        assert.equal(run.result.success, false);
        assert.contains(run.result.error, 'sm down');
        assert.ok(run.jira.labelsRemoved.indexOf('sm_story_test_rework_triggered') !== -1,
            'the SM trigger label is released by the error path');
        assert.ok(run.jira.labelsRemoved.indexOf('story_test_automation_rework_wip') !== -1,
            'the WIP lock is released by the error path');
    });
});

// ── gh-1229 characterization: commitAndPush contract pinned before helper
//    extraction (direct calls; cli_execute_command fully scripted). ──
suite('storyTestAutomationRework: commitAndPush characterization (gh-1229)', function() {

    function scriptedRework(handler) {
        var commands = [];
        var m = loadRework({
            cli_execute_command: function(args) {
                commands.push(args.command);
                return handler(args.command) || '';
            }
        });
        return { mod: m, commands: commands };
    }

    function lsRemoteLine(branch) {
        return '9a7e2ae1234567' + String.fromCharCode(9) + 'refs/heads/' + branch;
    }

    function happyHandler(branch, staged) {
        return function(command) {
            if (command === 'git branch --show-current') return branch;
            if (command === 'git diff --cached --stat') return staged || '';
            if (command === 'git ls-remote --heads origin ' + branch) return lsRemoteLine(branch);
            if (command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                throw new Error('Command execution failed (exit code 1)'); // no merge in progress
            }
            return '';
        };
    }

    test('refuses to commit on main/master before any other git call', function() {
        var x = scriptedRework(function(command) {
            if (command === 'git branch --show-current') return 'main';
            return '';
        });

        var threw = null;
        try { x.mod.commitAndPush('PROJ-1', TEST_CONFIG); } catch (e) { threw = e; }

        assert.ok(threw, 'main must be refused');
        assert.contains(threw.toString(), 'Refusing to commit rework directly');
        assert.ok(x.commands.every(function(c) { return c !== 'git merge origin/main --no-edit'; }),
            'nothing may run before the refusal');
    });

    test('an undetectable current branch fails loudly', function() {
        var x = scriptedRework(function() { return ''; });

        var threw = null;
        try { x.mod.commitAndPush('PROJ-1', TEST_CONFIG); } catch (e) { threw = e; }

        assert.ok(threw, 'missing branch must be refused');
        assert.contains(threw.toString(), 'Could not determine current git branch');
    });

    test('staged testing/ changes are committed with the rework template, then pushed', function() {
        var x = scriptedRework(happyHandler('test/PROJ-1', '3 files changed, 9 insertions(+)'));
        var config = Object.assign({}, TEST_CONFIG, {
            formats: { commitMessage: { testRework: '[{ticketKey}] address review comments' } }
        });

        var branch = x.mod.commitAndPush('PROJ-1', config);

        assert.equal(branch, 'test/PROJ-1');
        assert.ok(x.commands.indexOf('git add testing/') !== -1);
        assert.ok(x.commands.some(function(c) { return c.indexOf('git commit -m') === 0 && c.indexOf('PROJ-1') !== -1; }),
            'commit message carries the ticket key');
        assert.ok(x.commands.indexOf('git push -u origin test/PROJ-1') !== -1);
        assert.ok(x.commands.indexOf('git ls-remote --heads origin test/PROJ-1') !== -1,
            'push verified via ls-remote (gh-912)');
    });

    test('a clean staging area skips the commit and pushes existing commits only', function() {
        var x = scriptedRework(happyHandler('test/PROJ-2', ''));

        var branch = x.mod.commitAndPush('PROJ-2', TEST_CONFIG);

        assert.equal(branch, 'test/PROJ-2');
        assert.equal(x.commands.filter(function(c) { return c.indexOf('git commit') === 0; }).length, 0,
            'no commit command on a clean staging area');
        assert.ok(x.commands.indexOf('git push -u origin test/PROJ-2') !== -1);
    });

    test('a rejected normal push falls back to force-pushing the rework branch', function() {
        var x = scriptedRework(function(command) {
            if (command === 'git branch --show-current') return 'test/PROJ-3';
            if (command === 'git ls-remote --heads origin test/PROJ-3') return lsRemoteLine('test/PROJ-3');
            if (command === 'git push -u origin test/PROJ-3') throw new Error('non-fast-forward');
            if (command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                throw new Error('Command execution failed (exit code 1)');
            }
            return '';
        });

        var branch = x.mod.commitAndPush('PROJ-3', TEST_CONFIG);

        assert.equal(branch, 'test/PROJ-3');
        assert.ok(x.commands.indexOf('git push -u origin test/PROJ-3 --force') !== -1, 'force fallback ran');
    });

    test('a push that leaves no remote branch fails the guard', function() {
        var x = scriptedRework(function(command) {
            if (command === 'git branch --show-current') return 'test/PROJ-4';
            if (command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                throw new Error('Command execution failed (exit code 1)');
            }
            return '';
        });

        var threw = null;
        try { x.mod.commitAndPush('PROJ-4', TEST_CONFIG); } catch (e) { threw = e; }

        assert.ok(threw, 'missing remote branch must fail');
        assert.contains(threw.toString(), 'Branch not found on remote after push');
    });
});
