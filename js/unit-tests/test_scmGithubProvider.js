/**
 * Unit tests: scm.js GitHub provider — characterization + pure helpers (gh-981).
 *
 * Pins the current behaviour of every _createGithubProvider method against a
 * mocked github_* surface (happy path + error/empty paths), so the provider
 * closure can be split into module-level pure helpers without behaviour drift
 * (same extraction pattern as gh-925 applied to the ADO provider).
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('scm github provider', function () {

    function loadGithubMod(mocks) {
        return loadModule('js/common/scm.js',
            makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js'),
            './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js', makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') })) }),
            mocks || {});
    }

    function makeGithub(mocks) {
        return loadGithubMod(mocks)._createGithubProvider('my-owner', 'my-repo');
    }

    var DIFF = 'diff --git a/x.js b/x.js\nindex 111..222 100644\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n';

    // ── trivial pass-throughs ──────────────────────────────────────────────

    test('listPrs passes workspace, repository and state through', function () {
        var calls = [];
        var scm = makeGithub({
            github_list_prs: function (args) { calls.push(args); return [{ id: 1 }]; }
        });
        var prs = scm.listPrs('open');
        assert.deepEqual(calls, [{ workspace: 'my-owner', repository: 'my-repo', state: 'open' }]);
        assert.deepEqual(prs, [{ id: 1 }]);
    });

    test('getPr stringifies the PR id', function () {
        var calls = [];
        var scm = makeGithub({
            github_get_pr: function (args) { calls.push(args); return { number: 42 }; }
        });
        scm.getPr(42);
        assert.deepEqual(calls, [{ workspace: 'my-owner', repository: 'my-repo', pullRequestId: '42' }]);
    });

    test('getPrComments passes the stringified PR id through', function () {
        var calls = [];
        var scm = makeGithub({
            github_get_pr_comments: function (args) { calls.push(args); return []; }
        });
        scm.getPrComments(7);
        assert.deepEqual(calls, [{ workspace: 'my-owner', repository: 'my-repo', pullRequestId: '7' }]);
    });

    test('addComment passes the stringified PR id and text', function () {
        var calls = [];
        var scm = makeGithub({
            github_add_pr_comment: function (args) { calls.push(args); return 'ok'; }
        });
        assert.equal(scm.addComment(9, 'hello'), 'ok');
        assert.deepEqual(calls, [{ workspace: 'my-owner', repository: 'my-repo', pullRequestId: '9', text: 'hello' }]);
    });

    test('mergePr passes every field through', function () {
        var calls = [];
        var scm = makeGithub({
            github_merge_pr: function (args) { calls.push(args); return 'merged'; }
        });
        scm.mergePr(9, 'squash', 'title', 'message');
        assert.deepEqual(calls, [{
            workspace: 'my-owner', repository: 'my-repo',
            pullRequestId: '9', mergeMethod: 'squash',
            commitTitle: 'title', commitMessage: 'message'
        }]);
    });

    test('addLabel / removeLabel pass the label through (labelId ignored on remove)', function () {
        var calls = [];
        var scm = makeGithub({
            github_add_pr_label: function (args) { calls.push({ tool: 'add', args: args }); },
            github_remove_pr_label: function (args) { calls.push({ tool: 'remove', args: args }); }
        });
        scm.addLabel(3, 'wip');
        scm.removeLabel(3, 'wip', 'LA_123');
        assert.deepEqual(calls, [
            { tool: 'add', args: { workspace: 'my-owner', repository: 'my-repo', pullRequestId: '3', label: 'wip' } },
            { tool: 'remove', args: { workspace: 'my-owner', repository: 'my-repo', pullRequestId: '3', label: 'wip' } }
        ]);
    });

    test('submitReview defaults a missing body to an empty string', function () {
        var calls = [];
        var scm = makeGithub({
            github_submit_pr_review: function (args) { calls.push(args); return 'reviewed'; }
        });
        scm.submitReview(5, 'APPROVE');
        scm.submitReview(5, 'COMMENT', 'note');
        assert.deepEqual(calls, [
            { workspace: 'my-owner', repository: 'my-repo', pullRequestId: '5', event: 'APPROVE', body: '' },
            { workspace: 'my-owner', repository: 'my-repo', pullRequestId: '5', event: 'COMMENT', body: 'note' }
        ]);
    });

    test('listReviews unwraps JSON-string, envelope and array shapes', function () {
        var scm = makeGithub({
            github_list_pr_reviews: function () { return '[{"id":1}]'; }
        });
        assert.deepEqual(scm.listReviews(5), [{ id: 1 }]);
        var scm2 = makeGithub({
            github_list_pr_reviews: function () { return { value: [{ id: 2 }] }; }
        });
        assert.deepEqual(scm2.listReviews(5), [{ id: 2 }]);
        var scm3 = makeGithub({
            github_list_pr_reviews: function () { return { id: 3 }; }
        });
        assert.deepEqual(scm3.listReviews(5), [{ id: 3 }]);
    });

    test('dismissReview stringifies the review id', function () {
        var calls = [];
        var scm = makeGithub({
            github_dismiss_pr_review: function (args) { calls.push(args); return 'dismissed'; }
        });
        scm.dismissReview(5, 77, 'outdated');
        assert.deepEqual(calls, [{
            workspace: 'my-owner', repository: 'my-repo',
            pullRequestId: '5', reviewId: '77', message: 'outdated'
        }]);
    });

    test('getJobLogs stringifies the job id', function () {
        var calls = [];
        var scm = makeGithub({
            github_get_job_logs: function (args) { calls.push(args); return 'logs'; }
        });
        scm.getJobLogs(1234);
        assert.deepEqual(calls, [{ workspace: 'my-owner', repository: 'my-repo', jobId: '1234' }]);
    });

    test('listWorkflowRuns delegates with named args object and default owner/repo/limit (UT-scm-1)', function () {
        var calls = [];
        var scm = makeGithub({
            github_list_workflow_runs: function (args) {
                calls.push(args);
                return 'runs';
            }
        });
        assert.equal(scm.listWorkflowRuns('completed', 'ci.yml'), 'runs');
        assert.equal(scm.listWorkflowRuns('in_progress', 'ai-teammate.yml', 50, 'O', 'R'), 'runs');
        assert.equal(scm.listWorkflowRuns(null, null, 10, 'other-owner', 'other-repo'), 'runs');
        assert.deepEqual(calls, [
            { workspace: 'my-owner', repository: 'my-repo', perPage: 50, status: 'completed', workflowId: 'ci.yml' },
            { workspace: 'O', repository: 'R', perPage: 50, status: 'in_progress', workflowId: 'ai-teammate.yml' },
            { workspace: 'other-owner', repository: 'other-repo', perPage: 10 }
        ]);
    });

    test('triggerWorkflow delegates with named args object and stringifies object payloads (UT-scm-2)', function () {
        var calls = [];
        var scm = makeGithub({
            github_trigger_workflow: function (args) {
                calls.push(args);
                return 'triggered';
            }
        });
        scm.triggerWorkflow('o', 'r', 'wf.yml', '{"a":1}', 'dev');
        scm.triggerWorkflow('O', 'R', 'ai-teammate.yml', { issue: '1' }, 'feat/branch');
        scm.triggerWorkflow(null, null, 'wf.yml', null, '');
        assert.deepEqual(calls, [
            { workspace: 'o', repository: 'r', workflowId: 'wf.yml', inputs: '{"a":1}', ref: 'dev' },
            { workspace: 'O', repository: 'R', workflowId: 'ai-teammate.yml', inputs: '{"issue":"1"}', ref: 'feat/branch' },
            { workspace: 'my-owner', repository: 'my-repo', workflowId: 'wf.yml', inputs: '{}' }
        ]);
    });

    test('updateBranch shells out via gh api update-branch (prId NOT stringified)', function () {
        var calls = [];
        var scm = makeGithub({
            cli_execute_command: function (args) { calls.push(args); return ''; }
        });
        scm.updateBranch(9);
        scm.updateBranch(9, 'other-owner', 'other-repo');
        assert.deepEqual(calls, [
            { command: 'gh api repos/my-owner/my-repo/pulls/9/update-branch -X PUT' },
            { command: 'gh api repos/other-owner/other-repo/pulls/9/update-branch -X PUT' }
        ]);
    });

    // ── updatePrBody (gh-960) ─────────────────────────────────────────────

    test('updatePrBody PATCHes the body via gh api, staging it through a temp file', function () {
        var writes = [], deletes = [], commands = [];
        var scm = makeGithub({
            file_write: function (path, content) { writes.push([path, content]); },
            file_delete: function (args) { deletes.push(args.path || args); },
            cli_execute_command: function (args) { commands.push(args); return '{"number":9}'; }
        });
        var out = scm.updatePrBody(9, 'Closes #952\n\nbody');
        assert.equal(out, '{"number":9}');
        assert.deepEqual(writes, [['pr_body_update_tmp_9.md', 'Closes #952\n\nbody']]);
        assert.deepEqual(commands, [
            { command: 'gh api repos/my-owner/my-repo/pulls/9 -X PATCH -F body=@pr_body_update_tmp_9.md' }
        ]);
        assert.deepEqual(deletes, ['pr_body_update_tmp_9.md'], 'temp body file cleaned up');
    });

    test('updatePrBody stringifies the PR id and coerces a null body to empty string', function () {
        var writes = [], commands = [];
        var scm = makeGithub({
            file_write: function (path, content) { writes.push([path, content]); },
            file_delete: function () {},
            cli_execute_command: function (args) { commands.push(args); return 'ok'; }
        });
        scm.updatePrBody('42', null);
        assert.deepEqual(writes, [['pr_body_update_tmp_42.md', '']]);
        assert.notEqual(commands[0].command.indexOf('pulls/42 -X PATCH'), -1,
            'PR id stringified in the api path: ' + commands[0].command);
    });

    test('updatePrBody returns null and still cleans up when the api call throws', function () {
        var deletes = [];
        var scm = makeGithub({
            file_write: function () {},
            file_delete: function (args) { deletes.push(args.path || args); },
            cli_execute_command: function () { throw new Error('gh down'); }
        });
        assert.equal(scm.updatePrBody(7, 'x'), null);
        assert.deepEqual(deletes, ['pr_body_update_tmp_7.md']);
    });

    test('updatePrBody returns null when gh produces no output (PATCH failed silently)', function () {
        var scm = makeGithub({
            file_write: function () {},
            file_delete: function () {},
            cli_execute_command: function () { return ''; }
        });
        assert.equal(scm.updatePrBody(7, 'x'), null);
    });

    // ── getDiffText ────────────────────────────────────────────────────────

    test('getDiffText returns the tool result on success', function () {
        var calls = [];
        var scm = makeGithub({
            github_get_pr_diff_text: function (args) { calls.push(args); return DIFF; }
        });
        assert.equal(scm.getDiffText(5), DIFF);
        assert.deepEqual(calls, [{ workspace: 'my-owner', repository: 'my-repo', pullRequestID: '5' }]);
    });

    test('getDiffText returns null and warns when the tool throws', function () {
        var scm = makeGithub({
            github_get_pr_diff_text: function () { throw new Error('tool disabled'); }
        });
        assert.equal(scm.getDiffText(5), null);
    });

    // ── replyToThread / resolveThread ──────────────────────────────────────

    test('replyToThread replies in-thread when rootCommentId is present (stringified)', function () {
        var calls = [];
        var scm = makeGithub({
            github_reply_to_pr_thread: function (args) { calls.push({ tool: 'reply', args: args }); return 'replied'; },
            github_add_pr_comment: function () { throw new Error('must not fall back'); }
        });
        var out = scm.replyToThread(5, { rootCommentId: 77 }, 'a reply');
        assert.equal(out, 'replied');
        assert.deepEqual(calls, [{
            tool: 'reply',
            args: {
                workspace: 'my-owner', repository: 'my-repo',
                pullRequestId: '5', inReplyToId: '77', text: 'a reply'
            }
        }]);
    });

    test('replyToThread falls back to a plain comment without rootCommentId', function () {
        var calls = [];
        var scm = makeGithub({
            github_reply_to_pr_thread: function () { throw new Error('must not reply'); },
            github_add_pr_comment: function (args) { calls.push(args); return 'commented'; }
        });
        var out = scm.replyToThread(5, {}, 'a reply');
        assert.equal(out, 'commented');
        assert.deepEqual(calls, [{ workspace: 'my-owner', repository: 'my-repo', pullRequestId: '5', text: 'a reply' }]);
    });

    test('resolveThread resolves by threadId when present', function () {
        var calls = [];
        var scm = makeGithub({
            github_resolve_pr_thread: function (args) { calls.push(args); return 'resolved'; }
        });
        var out = scm.resolveThread(5, { threadId: 'PRRT_9' });
        assert.equal(out, 'resolved');
        assert.deepEqual(calls, [{
            workspace: 'my-owner', repository: 'my-repo',
            pullRequestId: '5', threadId: 'PRRT_9'
        }]);
    });

    test('resolveThread without threadId warns and returns undefined', function () {
        var scm = makeGithub({
            github_resolve_pr_thread: function () { throw new Error('must not resolve'); }
        });
        assert.equal(scm.resolveThread(5, {}), undefined);
    });

    // ── addInlineComment ───────────────────────────────────────────────────

    test('addInlineComment builds opts with optional startLine/side', function () {
        var calls = [];
        var scm = makeGithub({
            github_add_inline_comment: function (args) { calls.push(args); return 'inline'; }
        });
        scm.addInlineComment(5, 'f.js', 3, 'txt');
        scm.addInlineComment(5, 'f.js', 3, 'txt', 1, 'RIGHT');
        assert.deepEqual(calls, [
            {
                workspace: 'my-owner', repository: 'my-repo',
                pullRequestId: '5', path: 'f.js', line: '3', text: 'txt'
            },
            {
                workspace: 'my-owner', repository: 'my-repo',
                pullRequestId: '5', path: 'f.js', line: '3', text: 'txt',
                startLine: '1', side: 'RIGHT'
            }
        ]);
    });

    test('addInlineComment omits falsy startLine (0) and side', function () {
        var calls = [];
        var scm = makeGithub({
            github_add_inline_comment: function (args) { calls.push(args); return 'inline'; }
        });
        scm.addInlineComment(5, 'f.js', 3, 'txt', 0, '');
        assert.deepEqual(calls, [{
            workspace: 'my-owner', repository: 'my-repo',
            pullRequestId: '5', path: 'f.js', line: '3', text: 'txt'
        }]);
    });

    // ── getPrDiff ──────────────────────────────────────────────────────────

    test('getPrDiff returns the primary diff-text tool result when usable', function () {
        var calls = [];
        var scm = makeGithub({
            github_get_pr_diff_text: function (args) { calls.push(args); return DIFF; },
            github_get_pr_diff: function () { throw new Error('legacy must not run'); },
            github_get_pr: function () { throw new Error('local fallback must not run'); },
            cli_execute_command: function () { throw new Error('local fallback must not run'); }
        });
        assert.equal(scm.getPrDiff(5), DIFF);
        assert.deepEqual(calls, [{ workspace: 'my-owner', repository: 'my-repo', pullRequestID: '5' }]);
    });

    test('getPrDiff falls back to the legacy tool and unwraps a JSON envelope', function () {
        var scm = makeGithub({
            github_get_pr_diff_text: function () { return 'not a diff'; },
            github_get_pr_diff: function () { return JSON.stringify({ result: DIFF }); },
            github_get_pr: function () { throw new Error('local fallback must not run'); },
            cli_execute_command: function () { throw new Error('local fallback must not run'); }
        });
        assert.equal(scm.getPrDiff(5), DIFF);
    });

    test('getPrDiff falls back to a local git diff from the PR base/head refs', function () {
        var cliCalls = [];
        var scm = makeGithub({
            github_get_pr_diff_text: function () { throw new Error('diff text tool down'); },
            github_get_pr_diff: function () { return 'stats only'; },
            github_get_pr: function (args) {
                assert.deepEqual(args, { workspace: 'my-owner', repository: 'my-repo', pullRequestId: '5' });
                return { base: { ref: 'main' }, head: { ref: 'feat/x' } };
            },
            cli_execute_command: function (args) {
                cliCalls.push(args);
                return DIFF;
            }
        });
        assert.equal(scm.getPrDiff(5), DIFF.trim());
        assert.deepEqual(cliCalls, [{ command: 'git diff main...feat/x' }]);
    });

    test('getPrDiff returns the raw legacy output when every tier fails', function () {
        var scm = makeGithub({
            github_get_pr_diff_text: function () { return ''; },
            github_get_pr_diff: function () { return '{"stats":true}'; },
            github_get_pr: function () { throw new Error('PR fetch down'); },
            cli_execute_command: function () { return ''; }
        });
        assert.equal(scm.getPrDiff(5), '{"stats":true}');
    });

    test('getPrDiff returns an empty string when the legacy raw output is empty', function () {
        var scm = makeGithub({
            github_get_pr_diff_text: function () { return null; },
            github_get_pr_diff: function () { return ''; },
            github_get_pr: function () { return { base: { ref: 'main' }, head: { ref: 'f' } }; },
            cli_execute_command: function () { return ''; }
        });
        assert.equal(scm.getPrDiff(5), '');
    });

    // ── getCommitCheckRuns ────────────────────────────────────────────────

    test('getCommitCheckRuns returns null for a missing sha', function () {
        var scm = makeGithub({});
        assert.equal(scm.getCommitCheckRuns(''), null);
        assert.equal(scm.getCommitCheckRuns(null), null);
        assert.equal(scm.getCommitCheckRuns(undefined), null);
    });

    test('getCommitCheckRuns returns check runs unchanged when no legacy statuses exist', function () {
        var scm = makeGithub({
            github_get_commit_check_runs: function () {
                return { check_runs: [{ name: 'build', conclusion: 'success' }] };
            },
            cli_execute_command: function () { return ''; } // gh api → empty
        });
        assert.deepEqual(scm.getCommitCheckRuns('abc123'), [{ name: 'build', conclusion: 'success' }]);
    });

    test('getCommitCheckRuns merges legacy commit statuses by name (failure mapping)', function () {
        var scm = makeGithub({
            github_get_commit_check_runs: function () {
                return { check_runs: [{ name: 'build', conclusion: 'success' }] };
            },
            cli_execute_command: function (args) {
                assert.equal(args.command, 'gh api repos/my-owner/my-repo/commits/abc123/statuses --paginate');
                return JSON.stringify([
                    { context: 'jenkins', state: 'failure', target_url: 'http://ci/1' },
                    { context: 'build', state: 'failure', target_url: 'http://ci/2' }, // dup name — dropped
                    { context: 'jenkins', state: 'success', target_url: 'http://ci/3' } // older — dropped
                ]);
            }
        });
        var runs = scm.getCommitCheckRuns('abc123');
        assert.deepEqual(runs, [
            { name: 'build', conclusion: 'success' },
            { name: 'jenkins', conclusion: 'failure', details_url: 'http://ci/1' }
        ]);
    });

    test('getCommitCheckRuns keeps legacy statuses even when the check-runs tool throws', function () {
        var scm = makeGithub({
            github_get_commit_check_runs: function () { throw new Error('checks api down'); },
            cli_execute_command: function () { return JSON.stringify([{ context: 'jenkins', state: 'error' }]); }
        });
        assert.deepEqual(scm.getCommitCheckRuns('abc123'), [
            { name: 'jenkins', conclusion: 'failure', details_url: null }
        ]);
    });

    test('getCommitCheckRuns survives a legacy-status fetch failure', function () {
        var scm = makeGithub({
            github_get_commit_check_runs: function () { return { check_runs: [{ name: 'a' }] }; },
            cli_execute_command: function () { throw new Error('gh cli down'); }
        });
        assert.deepEqual(scm.getCommitCheckRuns('abc123'), [{ name: 'a' }]);
    });

    // ── fetchDiscussions ──────────────────────────────────────────────────

    function gqlNode(opts) {
        var first = { databaseId: opts.dbId };
        if (opts.body) first.body = opts.body;
        if (opts.author) first.author = { login: opts.author };
        var node = {
            id: opts.graphqlId || ('PRRT_' + opts.dbId),
            isResolved: opts.isResolved === true,
            comments: { nodes: [first] }
        };
        if (opts.path) node.path = opts.path;
        if (opts.line !== undefined) node.line = opts.line;
        return node;
    }

    function gqlEnvelope(nodes) {
        return JSON.stringify({
            data: { repository: { pullRequest: { reviewThreads: { nodes: nodes } } } }
        });
    }

    test('fetchDiscussions builds the inventory from GraphQL threads + general comments', function () {
        var scm = makeGithub({
            github_get_pr_conversations: function () { return []; },
            github_get_pr_review_threads: function () {
                return gqlEnvelope([gqlNode({ dbId: 101, body: 'Please fix this', author: 'alice', path: 'src/a.js', line: 10 })]);
            },
            github_get_pr_comments: function () {
                return [{ user: { login: 'bob' }, created_at: '2026-10-17T09:00:00Z', body: 'General note' }];
            }
        });
        var out = scm.fetchDiscussions(424);
        assert.ok(out.markdown.indexOf('# PR Discussion History') === 0);
        assert.ok(out.markdown.indexOf('Please fix this') !== -1);
        assert.ok(out.markdown.indexOf('## General PR Comments') !== -1);
        assert.ok(out.markdown.indexOf('**bob** (2026-10-17)') !== -1);
        assert.equal(out.rawThreads.threads.length, 1);
        assert.equal(out.rawThreads.threads[0].threadId, 'PRRT_101');
        assert.equal(out.rawThreads.threads[0].path, 'src/a.js');
        assert.equal(out.rawThreads.census.graphqlUnresolved, 1);
        assert.equal(out.rawThreads.census.source, 'graphql');
    });

    test('fetchDiscussions falls back to the conversations-only inventory when GraphQL fails', function () {
        var scm = makeGithub({
            github_get_pr_conversations: function () {
                return [{
                    rootComment: { id: 5, databaseId: 5, body: 'Conv body', created_at: '2026-10-17T08:00:00Z', user: { login: 'carol' } },
                    replies: [],
                    path: 'src/b.js',
                    line: 4,
                    isResolved: false
                }];
            },
            github_get_pr_review_threads: function () { throw new Error('graphql down'); },
            github_get_pr_comments: function () { return []; }
        });
        var out = scm.fetchDiscussions(424);
        assert.ok(out.markdown.indexOf('Conv body') !== -1);
        assert.equal(out.rawThreads.census.source, 'conversations');
        assert.equal(out.rawThreads.census.graphqlUnresolved, null);
    });

    test('fetchDiscussions tolerates conversations, threads and comments all failing', function () {
        var scm = makeGithub({
            github_get_pr_conversations: function () { throw new Error('down'); },
            github_get_pr_review_threads: function () { throw new Error('down'); },
            github_get_pr_comments: function () { throw new Error('down'); }
        });
        var out = scm.fetchDiscussions(424);
        assert.equal(out.markdown, null);
        assert.equal(out.rawThreads, null);
    });

    test('fetchDiscussions returns null markdown when there is no content at all', function () {
        var scm = makeGithub({
            github_get_pr_conversations: function () { return []; },
            github_get_pr_review_threads: function () { return null; },
            github_get_pr_comments: function () { return []; }
        });
        var out = scm.fetchDiscussions(424);
        assert.equal(out.markdown, null);
        assert.equal(out.rawThreads, null);
    });

    // ── getRemoteRepoInfo ─────────────────────────────────────────────────

    test('getRemoteRepoInfo parses a github.com remote URL', function () {
        var scm = makeGithub({
            cli_execute_command: function (args) {
                assert.equal(args.command, 'git config --get remote.origin.url');
                return 'git@github.com:myorg/myrepo.git\n';
            }
        });
        assert.deepEqual(scm.getRemoteRepoInfo(), { owner: 'myorg', repo: 'myrepo' });
    });

    test('getRemoteRepoInfo returns null for a non-github remote or a git failure', function () {
        var scm = makeGithub({
            cli_execute_command: function () { return 'git@gitlab.com:grp/proj.git\n'; }
        });
        assert.equal(scm.getRemoteRepoInfo(), null);
        var scm2 = makeGithub({
            cli_execute_command: function () { throw new Error('not a repo'); }
        });
        assert.equal(scm2.getRemoteRepoInfo(), null);
    });
});
