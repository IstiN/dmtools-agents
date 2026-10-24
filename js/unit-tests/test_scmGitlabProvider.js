/**
 * Unit tests: scm.js GitLab provider — characterization (gh-981).
 *
 * Pins the current behaviour of the _createGitLabProvider methods being
 * split into module-level helpers (same extraction pattern as gh-925 for
 * ADO), against a mocked gitlab_* surface. submitReview mapping itself is
 * pinned separately by test_scmGitlabReview.js.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('scm gitlab provider', function () {

    function loadGitlabMod(mocks) {
        return scmReal(mocks || {});
    }

    function makeGitlab(mocks) {
        return loadGitlabMod(mocks).createScm({ scm: { provider: 'gitlab' }, repository: { owner: 'mygroup', repo: 'my-repo' } });
    }

    var DIFF = 'diff --git a/x.js b/x.js\nindex 111..222 100644\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n';

    // ── listPrs / getPr / getPrComments ────────────────────────────────────

    test('listPrs normalizes state and maps MRs to the PR shape', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_list_mrs: function (args) {
                calls.push(args);
                return [{
                    id: 7, iid: 7, source_branch: 'feat/x', target_branch: 'main',
                    state: 'opened', web_url: 'http://gl/mr/7', labels: [],
                    has_conflicts: false, sha: 'abc'
                }];
            }
        });
        var prs = scm.listPrs('open');
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo', state: 'opened' }]);
        assert.equal(prs.length, 1);
        assert.equal(prs[0].number, 7);
        assert.equal(prs[0].head.ref, 'feat/x');
        assert.equal(prs[0].base.ref, 'main');
        assert.equal(prs[0].html_url, 'http://gl/mr/7');
        assert.equal(prs[0].mergeable, true);
    });

    test('listPrs closed keeps only closed or merged MRs', function () {
        var scm = makeGitlab({
            gitlab_list_mrs: function () { return { value: [
                { id: 1, state: 'closed' },
                { id: 2, state: 'opened', merged_at: '2026-01-01T00:00:00Z' },
                { id: 3, state: 'opened' }
            ] }; }
        });
        var prs = scm.listPrs('closed');
        assert.deepEqual(prs.map(function (p) { return p.number; }), [1, 2]);
    });

    test('getPr parses and normalizes the MR payload', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_get_mr: function (args) { calls.push(args); return '{"iid":9,"source_branch":"b1"}'; }
        });
        var mr = scm.getPr(9);
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo', pullRequestId: '9' }]);
        assert.equal(mr.number, 9);
        assert.equal(mr.head.ref, 'b1');
    });

    test('getPrComments unwraps envelopes', function () {
        var scm = makeGitlab({
            gitlab_get_mr_comments: function () { return '{"value":[{"id":"c1"}]}'; }
        });
        assert.deepEqual(scm.getPrComments(5), [{ id: 'c1' }]);
    });

    // ── getDiffText / addComment ──────────────────────────────────────────

    test('getDiffText returns the tool result on success, null on failure', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_get_mr_diff_text: function (args) { calls.push(args); return DIFF; }
        });
        assert.equal(scm.getDiffText(5), DIFF);
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo', pullRequestId: '5' }]);
        var scm2 = makeGitlab({
            gitlab_get_mr_diff_text: function () { throw new Error('down'); }
        });
        assert.equal(scm2.getDiffText(5), null);
    });

    test('addComment passes the stringified MR id and text', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_add_mr_comment: function (args) { calls.push(args); return 'ok'; }
        });
        scm.addComment(9, 'hello');
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo', pullRequestId: '9', text: 'hello' }]);
    });

    // ── replyToThread / resolveThread ─────────────────────────────────────

    test('replyToThread prefers threadId, then rootCommentId, then discussionId', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_reply_to_mr_thread: function (args) { calls.push(args); return 'replied'; },
            gitlab_add_mr_comment: function () { throw new Error('must not fall back'); }
        });
        scm.replyToThread(5, { threadId: 't1', rootCommentId: 'r1', discussionId: 'd1' }, 'txt');
        scm.replyToThread(5, { rootCommentId: 'r1' }, 'txt');
        scm.replyToThread(5, { discussionId: 'd1' }, 'txt');
        assert.deepEqual(calls, [
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '5', discussionId: 't1', text: 'txt' },
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '5', discussionId: 'r1', text: 'txt' },
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '5', discussionId: 'd1', text: 'txt' }
        ]);
    });

    test('replyToThread falls back to a plain MR comment with no thread id', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_reply_to_mr_thread: function () { throw new Error('must not reply'); },
            gitlab_add_mr_comment: function (args) { calls.push(args); return 'commented'; }
        });
        scm.replyToThread(5, {}, 'txt');
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo', pullRequestId: '5', text: 'txt' }]);
    });

    test('resolveThread resolves by threadId or discussionId, warns otherwise', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_resolve_mr_thread: function (args) { calls.push(args); return 'resolved'; }
        });
        scm.resolveThread(5, { threadId: 't1' });
        scm.resolveThread(5, { discussionId: 'd1' });
        assert.deepEqual(calls, [
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '5', discussionId: 't1' },
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '5', discussionId: 'd1' }
        ]);
        assert.equal(scm.resolveThread(5, {}), undefined);
    });

    // ── addInlineComment ──────────────────────────────────────────────────

    test('addInlineComment requires MR diff_refs and passes them to the tool', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_get_mr: function () {
                return { diff_refs: { base_sha: 'b1', head_sha: 'h1', start_sha: 's1' } };
            },
            gitlab_add_inline_mr_comment: function (args) { calls.push(args); return 'inline'; }
        });
        var out = scm.addInlineComment(5, 'f.js', 3, 'txt');
        assert.equal(out, 'inline');
        assert.deepEqual(calls, [{
            workspace: 'mygroup', repository: 'my-repo',
            pullRequestId: '5', filePath: 'f.js',
            line: '3', text: 'txt',
            baseSha: 'b1', headSha: 'h1', startSha: 's1'
        }]);
    });

    test('addInlineComment throws the pinned error when diff_refs are missing', function () {
        var scm = makeGitlab({
            gitlab_get_mr: function () { return {}; },
            gitlab_add_inline_mr_comment: function () { throw new Error('must not comment'); }
        });
        var err = null;
        try { scm.addInlineComment(5, 'f.js', 3, 'txt'); } catch (e) { err = e; }
        assert.ok(err, 'must throw');
        assert.equal(err.message, 'GitLab inline comments require MR diff_refs; gitlab_get_mr did not return them');
    });

    // ── mergePr / labels ──────────────────────────────────────────────────

    test('mergePr passes the MR id and the commit message fallback chain', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_merge_mr: function (args) { calls.push(args); return 'merged'; }
        });
        scm.mergePr(9, null, 'title', 'message');
        scm.mergePr(9, null, 'title', '');
        scm.mergePr(9, null, '', '');
        assert.deepEqual(calls, [
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '9', mergeCommitMessage: 'message' },
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '9', mergeCommitMessage: 'title' },
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '9', mergeCommitMessage: '' }
        ]);
    });

    test('addLabel / removeLabel pass the label through', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_add_mr_label: function (args) { calls.push({ tool: 'add', args: args }); },
            gitlab_remove_mr_label: function (args) { calls.push({ tool: 'remove', args: args }); }
        });
        scm.addLabel(3, 'wip');
        scm.removeLabel(3, 'wip', 'x');
        assert.deepEqual(calls, [
            { tool: 'add', args: { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '3', label: 'wip' } },
            { tool: 'remove', args: { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '3', label: 'wip' } }
        ]);
    });

    // ── getPrDiff ──────────────────────────────────────────────────────────

    test('getPrDiff returns the primary diff-text tool result when usable', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_get_mr_diff_text: function (args) { calls.push(args); return DIFF; },
            gitlab_get_mr_diff: function () { throw new Error('legacy must not run'); },
            gitlab_get_mr: function () { throw new Error('local fallback must not run'); },
            cli_execute_command: function () { throw new Error('local fallback must not run'); }
        });
        assert.equal(scm.getPrDiff(5), DIFF);
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo', pullRequestId: '5' }]);
    });

    test('getPrDiff falls back to the legacy tool and unwraps a JSON envelope', function () {
        var scm = makeGitlab({
            gitlab_get_mr_diff_text: function () { return ''; },
            gitlab_get_mr_diff: function () { return JSON.stringify({ result: DIFF }); },
            gitlab_get_mr: function () { throw new Error('local fallback must not run'); },
            cli_execute_command: function () { throw new Error('local fallback must not run'); }
        });
        assert.equal(scm.getPrDiff(5), DIFF);
    });

    test('getPrDiff falls back to a local git diff from diff_refs base/head shas', function () {
        var cliCalls = [];
        var scm = makeGitlab({
            gitlab_get_mr_diff_text: function () { throw new Error('down'); },
            gitlab_get_mr_diff: function () { return 'GitLab$4@abc123'; },
            gitlab_get_mr: function () {
                return { diff_refs: { base_sha: 'b1', head_sha: 'h1', start_sha: 's1' } };
            },
            cli_execute_command: function (args) { cliCalls.push(args); return DIFF; }
        });
        assert.equal(scm.getPrDiff(5), DIFF.trim());
        assert.deepEqual(cliCalls, [{ command: 'git diff b1...h1' }]);
    });

    test('getPrDiff returns the raw legacy output when every tier fails', function () {
        var scm = makeGitlab({
            gitlab_get_mr_diff_text: function () { return null; },
            gitlab_get_mr_diff: function () { return '{"stats":true}'; },
            gitlab_get_mr: function () { return {}; },
            cli_execute_command: function () { return ''; }
        });
        assert.equal(scm.getPrDiff(5), '{"stats":true}');
    });

    // ── getCommitCheckRuns ────────────────────────────────────────────────

    test('getCommitCheckRuns maps commit statuses to the check-run shape', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_get_commit_statuses: function (args) {
                calls.push(args);
                return '{"value":[' +
                    '{"name":"build","status":"failed","target_url":"http://ci/1"},' +
                    '{"name":"deploy","status":"canceled"},' +
                    '{"name":"lint","status":"running"}' +
                ']}';
            }
        });
        var runs = scm.getCommitCheckRuns('abc');
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo', commitSha: 'abc' }]);
        assert.deepEqual(runs, [
            { name: 'build', conclusion: 'failure', details_url: 'http://ci/1' },
            { name: 'deploy', conclusion: 'cancelled', details_url: null },
            { name: 'lint', conclusion: 'running', details_url: null }
        ]);
    });

    test('getCommitCheckRuns returns null on empty statuses, missing sha or tool failure', function () {
        var scm = makeGitlab({
            gitlab_get_commit_statuses: function () { return '[]'; }
        });
        assert.equal(scm.getCommitCheckRuns('abc'), null);
        var scm2 = makeGitlab({
            gitlab_get_commit_statuses: function () { throw new Error('down'); }
        });
        assert.equal(scm2.getCommitCheckRuns('abc'), null);
        var scm3 = makeGitlab({});
        assert.equal(scm3.getCommitCheckRuns(''), null);
    });

    // ── getJobLogs / listWorkflowRuns / triggerWorkflow ───────────────────

    test('getJobLogs stringifies the job id', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_get_job_logs: function (args) { calls.push(args); return 'logs'; }
        });
        scm.getJobLogs(99);
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo', jobId: '99' }]);
    });

    test('listWorkflowRuns maps pipeline runs to the workflow-runs JSON shape', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_list_pipeline_runs: function (args) { calls.push(args); return [
                { id: 11, name: 'ci', status: 'running' },
                { id: 12, ref: 'dev' }
            ]; }
        });
        var out = scm.listWorkflowRuns('in_progress', null, 25, 'other-owner', 'other-repo');
        assert.deepEqual(calls, [{
            workspace: 'other-owner', repository: 'other-repo',
            status: 'running', ref: null, limit: '25'
        }]);
        var parsed = JSON.parse(out);
        assert.equal(parsed.workflow_runs.length, 2);
        assert.equal(parsed.workflow_runs[0].name, 'ci');
        assert.equal(parsed.workflow_runs[0].display_title, 'ci');
        assert.equal(parsed.workflow_runs[0].status, 'in_progress');
        assert.equal(parsed.workflow_runs[0].run_number, 11);
        assert.equal(parsed.workflow_runs[1].name, 'dev');
        assert.equal(parsed.workflow_runs[1].run_number, 12);
    });

    test('listWorkflowRuns defaults limit to 50 and workspace to the configured one', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_list_pipeline_runs: function (args) { calls.push(args); return '[]'; }
        });
        scm.listWorkflowRuns(null);
        assert.deepEqual(calls, [{
            workspace: 'mygroup', repository: 'my-repo',
            status: null, ref: null, limit: '50'
        }]);
    });

    test('triggerWorkflow builds variablesJson from the payload plus workflow_file', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_trigger_pipeline: function (args) { calls.push(args); return 'triggered'; }
        });
        scm.triggerWorkflow('o', 'r', 'wf.yml', '{"a":1,"b":"x"}', 'dev');
        scm.triggerWorkflow(null, null, 'wf.yml', 'not-json', null);
        assert.deepEqual(calls, [
            {
                workspace: 'o', repository: 'r', ref: 'dev',
                variablesJson: JSON.stringify({ a: 1, b: 'x', workflow_file: 'wf.yml' })
            },
            {
                workspace: 'mygroup', repository: 'my-repo', ref: 'main',
                variablesJson: JSON.stringify({ workflow_file: 'wf.yml' })
            }
        ]);
    });

    // ── createPr / updateBranch / getRemoteRepoInfo ───────────────────────

    test('createPr normalizes the created MR and returns the pinned result shape', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_create_mr: function (args) { calls.push(args); return '{"iid":31,"web_url":"http://gl/mr/31"}'; }
        });
        var out = scm.createPr({ branchName: 'feat/x', baseBranch: 'dev', title: 'T', body: 'B', removeSourceBranch: false });
        assert.deepEqual(calls, [{
            workspace: 'mygroup', repository: 'my-repo',
            sourceBranch: 'feat/x', targetBranch: 'dev',
            title: 'T', description: 'B', removeSourceBranch: 'false'
        }]);
        assert.deepEqual(out, {
            success: true,
            prUrl: 'http://gl/mr/31',
            number: 31,
            output: '{"iid":31,"web_url":"http://gl/mr/31"}'
        });
    });

    test('createPr defaults baseBranch to main and removeSourceBranch to true', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_create_mr: function (args) { calls.push(args); return null; }
        });
        var out = scm.createPr({ branchName: 'b', title: 't' });
        assert.deepEqual(calls, [{
            workspace: 'mygroup', repository: 'my-repo',
            sourceBranch: 'b', targetBranch: 'main',
            title: 't', description: '', removeSourceBranch: 'true'
        }]);
        assert.deepEqual(out, { success: true, prUrl: null, number: null, output: null });
    });

    test('updateBranch rebases the MR on the configured or given workspace', function () {
        var calls = [];
        var scm = makeGitlab({
            gitlab_rebase_mr: function (args) { calls.push(args); return 'rebased'; }
        });
        scm.updateBranch(9);
        scm.updateBranch(9, 'other-owner', 'other-repo');
        assert.deepEqual(calls, [
            { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '9' },
            { workspace: 'other-owner', repository: 'other-repo', pullRequestId: '9' }
        ]);
    });

    test('getRemoteRepoInfo parses a gitlab.com remote URL', function () {
        var scm = makeGitlab({
            cli_execute_command: function (args) {
                assert.equal(args.command, 'git config --get remote.origin.url');
                return 'git@gitlab.com:grp/proj.git\n';
            }
        });
        assert.deepEqual(scm.getRemoteRepoInfo(), { owner: 'grp', repo: 'proj' });
    });
});
