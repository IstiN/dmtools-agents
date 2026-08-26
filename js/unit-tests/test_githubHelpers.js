/**
 * Unit tests for js/common/githubHelpers.js
 *
 * Focuses on fetchDiscussionsAndRawData — specifically that resolved threads
 * are correctly identified using GraphQL isResolved (since the REST conversations
 * API does not expose this field).
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function loadGithubHelpers(mocks) {
    return loadModule(
        'js/common/githubHelpers.js',
        makeRequire({
            '../config.js': configModule,
            'config': configModule,
            './pullRequest.js': {
                buildOriginFetchCommand: function(refSpec) {
                    return 'git -c fetch.recurseSubmodules=no fetch origin' + (refSpec ? ' ' + refSpec : '');
                }
            },
            './gitOps.js': gitOpsStub
        }),
        mocks || {}
    );
}

// Sentinel stub used to verify githubHelpers.js correctly re-exports these
// functions from gitOps.js (real behavior for each is covered in
// test_gitOps.js — this file only checks the delegation wiring).
var gitOpsStub = {
    checkoutPRBranch: function() { return 'checkoutPRBranch-from-gitOps'; },
    getPRDiff: function() { return 'getPRDiff-from-gitOps'; },
    detectMergeConflicts: function() { return 'detectMergeConflicts-from-gitOps'; },
    trimLargeTextForInput: function() { return 'trimLargeTextForInput-from-gitOps'; },
    writePRContext: function() { return 'writePRContext-from-gitOps'; }
};

function loadScm(mocks) {
    return loadModule(
        'js/common/scm.js',
        null,
        mocks || {}
    );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConversation(opts) {
    return {
        rootComment: {
            id: opts.id,
            databaseId: opts.id,
            body: opts.body || 'reviewer comment',
            user: { login: 'reviewer' },
            created_at: '2026-03-26T10:00:00Z'
        },
        replies: opts.replies || [],
        path: opts.path || 'src/foo.ts',
        line: opts.line || 10,
        resolved: opts.resolved !== undefined ? opts.resolved : undefined,
        isResolved: opts.isResolved !== undefined ? opts.isResolved : undefined
    };
}

function makeGraphQLThread(opts) {
    return {
        id: opts.graphqlId || ('PRRT_' + opts.dbId),
        isResolved: opts.isResolved === true,
        comments: {
            nodes: [{ databaseId: opts.dbId }]
        }
    };
}

function makeGraphQLResponse(nodes) {
    return JSON.stringify({
        data: {
            repository: {
                pullRequest: {
                    reviewThreads: { nodes: nodes }
                }
            }
        }
    });
}

// ── Suite: findPRForTicket scoring/ranking ──────────────────────────────────

function scmWithOpenPrs(prs) {
    return {
        listPrs: function(state) {
            assert.equal(state, 'open', 'findPRForTicket must request open PRs');
            return prs;
        }
    };
}

suite('githubHelpers.findPRForTicket', function() {

    test('returns null when no open PR matches', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 1, title: 'OTHER-1: unrelated', head: { ref: 'feature/other-1' }, changed_files: 2 }
        ]);

        var result = gh.findPRForTicket(scm, 'PROJ-42');

        assert.ok(!result, 'no matching PR should return null/falsy');
    });

    test('matches ticket key case-insensitively in title', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 1, title: 'proj-42: fix', head: { ref: 'feature/x' }, changed_files: 1 }
        ]);

        var result = gh.findPRForTicket(scm, 'PROJ-42');

        assert.ok(result, 'should match lowercase title against uppercase ticket key');
        assert.equal(result.number, 1);
    });

    test('matches ticket key case-insensitively in head branch', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 2, title: 'Unrelated title', head: { ref: 'feature/proj-42-fix' }, changed_files: 1 }
        ]);

        var result = gh.findPRForTicket(scm, 'PROJ-42');

        assert.ok(result, 'should match lowercase branch against uppercase ticket key');
        assert.equal(result.number, 2);
    });

    test('falls back to bounded numeric part when full key is absent', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 3, title: 'lions: update 420 navigation', head: { ref: 'feature/ft_lions_420_update' }, changed_files: 1 }
        ]);

        var result = gh.findPRForTicket(scm, 'PROJ-420');

        assert.ok(result, 'should find PR by bounded ticket number when full key missing');
        assert.equal(result.number, 3);
    });

    test('numeric fallback ignores unbounded digit substrings', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 4, title: 'fix for 14200 range', head: { ref: 'feature/x' }, changed_files: 1 }
        ]);

        var result = gh.findPRForTicket(scm, 'PROJ-420');

        assert.ok(!result, 'number 420 embedded inside 14200 must not match');
    });

    test('prefers feature/bug prefix over release/ prefix', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 5, title: 'release: proj-42', head: { ref: 'release/rc_proj_42' }, changed_files: 250 },
            { number: 6, title: 'proj-42 fix', head: { ref: 'feature/ft_proj_42' }, changed_files: 3 }
        ]);

        var result = gh.findPRForTicket(scm, 'PROJ-42');

        assert.ok(result, 'should select a PR');
        assert.equal(result.number, 6, 'feature branch PR should win over release/rc PR');
    });

    test('deprioritizes bot-authored PRs', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 7, title: 'proj-42 release', head: { ref: 'release/rc_proj_42' }, changed_files: 250, user: { login: 'release-bot', is_bot: true } },
            { number: 8, title: 'proj-42 fix', head: { ref: 'feature/ft_proj_42' }, changed_files: 3, user: { login: 'dev' } }
        ]);

        var result = gh.findPRForTicket(scm, 'PROJ-42');

        assert.equal(result.number, 8, 'human-authored feature PR should win over bot release PR');
    });

    test('uses changed_files as tie-breaker when scores are equal', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 9, title: 'PROJ-42 fix a', head: { ref: 'feature/ft_proj_42_a' }, changed_files: 10 },
            { number: 10, title: 'PROJ-42 fix b', head: { ref: 'feature/ft_proj_42_b' }, changed_files: 2 }
        ]);

        var result = gh.findPRForTicket(scm, 'PROJ-42');

        assert.equal(result.number, 10, 'smaller PR should win when scores are tied');
    });

    test('project prSearchFn hook can override selection', function() {
        var gh = loadGithubHelpers({});
        var scm = scmWithOpenPrs([
            { number: 11, title: 'PROJ-42 first', head: { ref: 'feature/ft_proj_42_first' }, changed_files: 1 },
            { number: 12, title: 'PROJ-42 second', head: { ref: 'feature/ft_proj_42_second' }, changed_files: 1 }
        ]);
        var hookCalled = false;
        var options = {
            prSearchFn: function(candidates, key, opts) {
                hookCalled = true;
                assert.equal(key, 'PROJ-42');
                assert.equal(candidates.length, 2);
                return candidates[1];
            }
        };

        var result = gh.findPRForTicket(scm, 'PROJ-42', options);

        assert.ok(hookCalled, 'prSearchFn hook should be called');
        assert.equal(result.number, 12, 'hook should decide which PR to use');
    });

    test('returns null and does not throw when scm.listPrs throws', function() {
        var gh = loadGithubHelpers({});
        var scm = {
            listPrs: function() { throw new Error('network down'); }
        };

        var result = gh.findPRForTicket(scm, 'PROJ-42');

        assert.ok(!result, 'errors should be swallowed and null returned');
    });
});

// ── Suite: resolved status from GraphQL ──────────────────────────────────────

suite('github repo remote parsing', function() {

    [
        {
            name: 'https URL with dotted repo',
            remote: 'https://github.com/example-org/example.repo',
            expected: { owner: 'example-org', repo: 'example.repo' }
        },
        {
            name: 'https URL with dotted repo and .git suffix',
            remote: 'https://github.com/example-org/example.repo.git',
            expected: { owner: 'example-org', repo: 'example.repo' }
        },
        {
            name: 'ssh URL with dotted repo and .git suffix',
            remote: 'git@github.com:example-org/example.repo.git',
            expected: { owner: 'example-org', repo: 'example.repo' }
        }
    ].forEach(function(tc) {
        test('githubHelpers.getGitHubRepoInfo parses ' + tc.name, function() {
            var gh = loadGithubHelpers({
                cli_execute_command: function() {
                    return tc.remote + '\nCOMMAND_EXIT_CODE=0';
                }
            });

            assert.deepEqual(gh.getGitHubRepoInfo(), tc.expected);
        });
    });

    test('scm createScm auto-detects dotted GitHub repository names', function() {
        var calls = [];
        var scmModule = loadScm({
            cli_execute_command: function() {
                return 'git@github.com:example-org/example.repo.git\nCOMMAND_EXIT_CODE=0';
            },
            github_list_prs: function(args) {
                calls.push(args);
                return [];
            }
        });

        var scm = scmModule.createScm({});
        scm.listPrs('open');

        assert.deepEqual(calls[0], {
            workspace: 'example-org',
            repository: 'example.repo',
            state: 'open'
        });
    });
});

suite('githubHelpers → gitOps re-export delegation', function() {
    test('re-exports the SCM-agnostic git operations from gitOps.js unchanged', function() {
        var gh = loadGithubHelpers();

        assert.equal(gh.checkoutPRBranch, gitOpsStub.checkoutPRBranch,
            'checkoutPRBranch must be the exact function from gitOps.js, not a reimplementation');
        assert.equal(gh.getPRDiff, gitOpsStub.getPRDiff);
        assert.equal(gh.detectMergeConflicts, gitOpsStub.detectMergeConflicts);
        assert.equal(gh.trimLargeTextForInput, gitOpsStub.trimLargeTextForInput);
        assert.equal(gh.writePRContext, gitOpsStub.writePRContext);
    });
});

suite('githubHelpers.fetchDiscussionsAndRawData — resolved thread detection', function() {

    test('thread resolved=true via GraphQL isResolved is excluded from markdown', function() {
        var conversations = [
            makeConversation({ id: 101, body: 'open issue' }),
            makeConversation({ id: 102, body: 'already fixed — resolved' })
        ];
        var graphqlNodes = [
            makeGraphQLThread({ dbId: 101, graphqlId: 'PRRT_open', isResolved: false }),
            makeGraphQLThread({ dbId: 102, graphqlId: 'PRRT_resolved', isResolved: true })
        ];

        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return conversations; },
            github_get_pr_review_threads: function() { return makeGraphQLResponse(graphqlNodes); },
            github_get_pr_comments: function() { return []; },
            file_write: function() {}
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '42');

        assert.contains(result.markdown, 'open issue', 'open thread must appear in markdown');
        assert.notContains(result.markdown, 'already fixed — resolved', 'resolved thread must be excluded from markdown');
    });

    test('resolved thread is marked resolved in rawThreads', function() {
        var conversations = [
            makeConversation({ id: 201, body: 'needs fix' }),
            makeConversation({ id: 202, body: 'done' })
        ];
        var graphqlNodes = [
            makeGraphQLThread({ dbId: 201, graphqlId: 'PRRT_A', isResolved: false }),
            makeGraphQLThread({ dbId: 202, graphqlId: 'PRRT_B', isResolved: true })
        ];

        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return conversations; },
            github_get_pr_review_threads: function() { return makeGraphQLResponse(graphqlNodes); },
            github_get_pr_comments: function() { return []; },
            file_write: function() {}
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '42');

        var t201 = result.rawThreads.threads.filter(function(t) { return t.rootCommentId === 201; })[0];
        var t202 = result.rawThreads.threads.filter(function(t) { return t.rootCommentId === 202; })[0];
        assert.ok(t201, 'thread 201 should be in rawThreads');
        assert.ok(t202, 'thread 202 should be in rawThreads');
        assert.equal(t201.resolved, false, 'thread 201 should not be resolved');
        assert.equal(t202.resolved, true, 'thread 202 should be resolved via GraphQL isResolved');
    });

    test('REST resolved=true still works when GraphQL not available', function() {
        var conversations = [
            makeConversation({ id: 301, body: 'fixed', resolved: true })
        ];

        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return conversations; },
            github_get_pr_review_threads: function() { throw new Error('GraphQL unavailable'); },
            github_get_pr_comments: function() { return []; },
            file_write: function() {}
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '42');

        var t = result.rawThreads.threads[0];
        assert.equal(t.resolved, true, 'REST resolved=true should still be respected');
        assert.notContains(result.markdown, 'fixed', 'REST-resolved thread must be excluded from markdown');
    });

    test('REST isResolved=true still works when GraphQL not available', function() {
        var conversations = [
            makeConversation({ id: 401, body: 'addressed', isResolved: true })
        ];

        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return conversations; },
            github_get_pr_review_threads: function() { throw new Error('GraphQL unavailable'); },
            github_get_pr_comments: function() { return []; },
            file_write: function() {}
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '42');

        var t = result.rawThreads.threads[0];
        assert.equal(t.resolved, true, 'REST isResolved=true should still be respected');
        assert.notContains(result.markdown, 'addressed', 'REST-isResolved thread must be excluded from markdown');
    });

    test('all threads open when neither REST nor GraphQL marks any resolved', function() {
        var conversations = [
            makeConversation({ id: 501, body: 'first open' }),
            makeConversation({ id: 502, body: 'second open' })
        ];
        var graphqlNodes = [
            makeGraphQLThread({ dbId: 501, isResolved: false }),
            makeGraphQLThread({ dbId: 502, isResolved: false })
        ];

        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return conversations; },
            github_get_pr_review_threads: function() { return makeGraphQLResponse(graphqlNodes); },
            github_get_pr_comments: function() { return []; },
            file_write: function() {}
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '42');

        assert.equal(result.rawThreads.threads.length, 2, 'both threads should be present');
        assert.equal(result.rawThreads.threads.filter(function(t) { return t.resolved; }).length, 0, 'no threads resolved');
        assert.contains(result.markdown, 'first open');
        assert.contains(result.markdown, 'second open');
    });

    test('summary note is prepended when resolved threads exist', function() {
        var conversations = [
            makeConversation({ id: 601, body: 'open' }),
            makeConversation({ id: 602, body: 'closed' })
        ];
        var graphqlNodes = [
            makeGraphQLThread({ dbId: 601, isResolved: false }),
            makeGraphQLThread({ dbId: 602, isResolved: true })
        ];

        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return conversations; },
            github_get_pr_review_threads: function() { return makeGraphQLResponse(graphqlNodes); },
            github_get_pr_comments: function() { return []; },
            file_write: function() {}
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '42');

        assert.contains(result.markdown, '1 resolved thread(s) excluded', 'summary note should mention resolved count');
    });

    test('GraphQL threadId is correctly set on open thread', function() {
        var conversations = [
            makeConversation({ id: 701, body: 'needs attention' })
        ];
        var graphqlNodes = [
            makeGraphQLThread({ dbId: 701, graphqlId: 'PRRT_XYZ', isResolved: false })
        ];

        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return conversations; },
            github_get_pr_review_threads: function() { return makeGraphQLResponse(graphqlNodes); },
            github_get_pr_comments: function() { return []; },
            file_write: function() {}
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '42');

        var t = result.rawThreads.threads[0];
        assert.equal(t.threadId, 'PRRT_XYZ', 'GraphQL node ID should be set for open thread');
        assert.equal(t.resolved, false);
    });
});

suite('scm GitLab provider', function() {

    test('createScm auto-detects nested GitLab repository names', function() {
        var calls = [];
        var scmModule = loadScm({
            cli_execute_command: function() {
                return 'git@gitlab.example.com:example-group/example-project.git\nCOMMAND_EXIT_CODE=0';
            },
            gitlab_list_mrs: function(args) {
                calls.push(args);
                return [];
            }
        });

        var scm = scmModule.createScm({ scm: { provider: 'gitlab' } });
        scm.listPrs('open');

        assert.deepEqual(calls[0], {
            workspace: 'example-group',
            repository: 'example-project',
            state: 'opened'
        });
    });

    test('listPrs closed returns only closed/merged merge requests', function() {
        var scmModule = loadScm({
            gitlab_list_mrs: function() {
                return JSON.stringify([
                    { iid: 1, state: 'opened', source_branch: 'f1', target_branch: 'main' },
                    { iid: 2, state: 'closed', source_branch: 'f2', target_branch: 'main' },
                    { iid: 3, state: 'merged', merged_at: '2026-06-01T00:00:00Z', source_branch: 'f3', target_branch: 'main' }
                ]);
            }
        });

        var provider = scmModule._createGitLabProvider('example-group', 'example-project');
        var closed = provider.listPrs('closed');

        assert.equal(closed.length, 2);
        assert.equal(closed[0].state, 'closed');
        assert.equal(closed[1].state, 'merged');
    });

    test('createPr delegates to gitlab_create_mr and returns normalized result', function() {
        var call = null;
        var scmModule = loadScm({
            gitlab_create_mr: function(args) {
                call = args;
                return JSON.stringify({
                    iid: 42,
                    web_url: 'https://gitlab.example.com/example-group/example-project/-/merge_requests/42',
                    source_branch: 'feature/ABC-1',
                    target_branch: 'main'
                });
            }
        });

        var provider = scmModule._createGitLabProvider('example-group', 'example-project');
        var result = provider.createPr({
            title: 'ABC-1: change',
            branchName: 'feature/ABC-1',
            baseBranch: 'main',
            body: 'Description',
            removeSourceBranch: true
        });

        assert.deepEqual(call, {
            workspace: 'example-group',
            repository: 'example-project',
            sourceBranch: 'feature/ABC-1',
            targetBranch: 'main',
            title: 'ABC-1: change',
            description: 'Description',
            removeSourceBranch: 'true'
        });
        assert.equal(result.success, true);
        assert.equal(result.number, 42);
        assert.equal(result.prUrl, 'https://gitlab.example.com/example-group/example-project/-/merge_requests/42');
    });

    test('_normalizeGitLabCommitStatus maps GitLab commit statuses into check-run shape', function() {
        var scmModule = loadScm({});

        var failed = scmModule._normalizeGitLabCommitStatus({
            name: 'sonar-tests/Merge requests check',
            status: 'failed',
            target_url: 'https://jenkins.ci.example.com/job/sonar-tests/job/Merge%20requests%20check/23681/'
        });
        assert.equal(failed.name, 'sonar-tests/Merge requests check');
        assert.equal(failed.conclusion, 'failure');
        assert.equal(failed.details_url, 'https://jenkins.ci.example.com/job/sonar-tests/job/Merge%20requests%20check/23681/');

        var succeeded = scmModule._normalizeGitLabCommitStatus({ name: 'ai-teammate', status: 'success' });
        assert.equal(succeeded.conclusion, 'success');

        var pending = scmModule._normalizeGitLabCommitStatus({ name: 'ai-teammate-pending', status: 'pending' });
        assert.equal(pending.conclusion, 'pending');

        var cancelled = scmModule._normalizeGitLabCommitStatus({ name: 'x', status: 'canceled' });
        assert.equal(cancelled.conclusion, 'cancelled');
    });

    test('getCommitCheckRuns calls gitlab_get_commit_statuses for the right project/sha and normalizes the response', function() {
        var calledArgs = null;
        var scmModule = loadScm({
            gitlab_get_commit_statuses: function(args) {
                calledArgs = args;
                return JSON.stringify([
                    { name: 'sonar-tests/Merge requests check', status: 'failed', target_url: 'https://jenkins.ci.example.com/job/sonar-tests/job/Merge%20requests%20check/23681/' },
                    { name: 'ai-teammate', status: 'success', target_url: 'https://gitlab.example.com/acme-org/ai-teammate/-/pipelines/1' }
                ]);
            }
        });

        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        var runs = provider.getCommitCheckRuns('7b74c0eb5f0fdfa3d18472d3c55e91235a0924aa');

        assert.equal(calledArgs.workspace, 'acme-org/develop');
        assert.equal(calledArgs.repository, 'service-api');
        assert.equal(calledArgs.commitSha, '7b74c0eb5f0fdfa3d18472d3c55e91235a0924aa');
        assert.equal(runs.length, 2);
        assert.equal(runs[0].conclusion, 'failure');
        assert.equal(runs[1].conclusion, 'success');
    });

    test('getCommitCheckRuns returns null when there are no statuses for the commit', function() {
        var scmModule = loadScm({
            gitlab_get_commit_statuses: function() { return '[]'; }
        });
        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        assert.equal(provider.getCommitCheckRuns('deadbeef'), null);
    });

    test('getCommitCheckRuns returns null and does not throw when the tool call fails', function() {
        var scmModule = loadScm({
            gitlab_get_commit_statuses: function() { throw new Error('boom'); }
        });
        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        assert.equal(provider.getCommitCheckRuns('deadbeef'), null);
    });

    test('listWorkflowRuns maps GitLab run statuses to workflow_runs payload', function() {
        var call = null;
        var scmModule = loadScm({
            gitlab_list_pipeline_runs: function(args) {
                call = args;
                return JSON.stringify([
                    { id: 1001, status: 'running', ref: 'main', name: 'CI' },
                    { id: 1002, status: 'failed', ref: 'main', name: 'CI' }
                ]);
            }
        });
        var provider = scmModule._createGitLabProvider('example-group', 'example-project');
        var raw = provider.listWorkflowRuns('in_progress', null, 20);
        var parsed = JSON.parse(raw);

        assert.equal(call.status, 'running');
        assert.equal(call.limit, '20');
        assert.equal(parsed.workflow_runs.length, 2);
        assert.equal(parsed.workflow_runs[0].status, 'in_progress');
        assert.equal(parsed.workflow_runs[0].run_number, 1001);
    });

    test('updateBranch delegates to gitlab_rebase_mr', function() {
        var call = null;
        var scmModule = loadScm({
            gitlab_rebase_mr: function(args) {
                call = args;
                return '{"rebase_in_progress":true}';
            }
        });

        var provider = scmModule._createGitLabProvider('example-group', 'example-project');
        provider.updateBranch(55, 'example-group', 'example-project');

        assert.deepEqual(call, {
            workspace: 'example-group',
            repository: 'example-project',
            pullRequestId: '55'
        });
    });
});

suite('scm GitHub provider getPrDiff fallback', function() {

    test('uses github_get_pr_diff directly when it returns a usable diff', function() {
        var prCalls = [];
        var gitCalls = [];
        var scmModule = loadScm({
            github_get_pr_diff: function(args) {
                return 'diff --git a/file.txt b/file.txt\n+change\n';
            },
            github_get_pr: function(args) { prCalls.push(args); return {}; },
            cli_execute_command: function(args) { gitCalls.push(args.command); return ''; }
        });

        var provider = scmModule._createGithubProvider('IstiN', 'trackstate');
        var diff = provider.getPrDiff('1789');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should return usable diff');
        assert.equal(prCalls.length, 0, 'must not fetch PR details when MCP diff is usable');
        assert.equal(gitCalls.length, 0, 'must not run git diff when MCP diff is usable');
    });

    test('falls back to local git diff when github_get_pr_diff returns a Java object string', function() {
        var prDiffCalls = [];
        var prCalls = [];
        var gitCalls = [];
        var scmModule = loadScm({
            github_get_pr_diff_text: function() { return ''; },
            github_get_pr_diff: function(args) {
                prDiffCalls.push(args);
                return 'com.github.istin.dmtools.github.GitHub$1@61edc883';
            },
            github_get_pr: function(args) {
                prCalls.push(args);
                return { base: { ref: 'main' }, head: { ref: 'ai/TS-577' } };
            },
            cli_execute_command: function(args) {
                gitCalls.push(args.command);
                if (args.command === 'git diff main...ai/TS-577') {
                    return 'diff --git a/file.txt b/file.txt\n+change\nCOMMAND_EXIT_CODE=0';
                }
                return 'COMMAND_EXIT_CODE=128';
            }
        });

        var provider = scmModule._createGithubProvider('IstiN', 'trackstate');
        var diff = provider.getPrDiff('1789');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should return usable local diff');
        assert.equal(prDiffCalls.length, 1);
        assert.equal(prDiffCalls[0].pullRequestID, '1789');
        assert.equal(prCalls.length, 1);
        assert.equal(prCalls[0].pullRequestId, '1789');
        assert.ok(gitCalls.indexOf('git diff main...ai/TS-577') !== -1, 'should try three-dot local diff');
    });

    test('falls back to origin-prefixed git diff when bare refs are not available', function() {
        var gitCalls = [];
        var scmModule = loadScm({
            github_get_pr_diff_text: function() { return ''; },
            github_get_pr_diff: function() { return ''; },
            github_get_pr: function() { return { base: { ref: 'main' }, head: { ref: 'ai/TS-577' } }; },
            cli_execute_command: function(args) {
                gitCalls.push(args.command);
                if (args.command === 'git diff origin/main...ai/TS-577') {
                    return 'diff --git a/file.txt b/file.txt\n+change\nCOMMAND_EXIT_CODE=0';
                }
                return 'COMMAND_EXIT_CODE=128';
            }
        });

        var provider = scmModule._createGithubProvider('IstiN', 'trackstate');
        var diff = provider.getPrDiff('1789');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should return usable origin-prefixed diff');
        assert.ok(gitCalls.indexOf('git diff main...ai/TS-577') !== -1, 'should try bare refs first');
        assert.ok(gitCalls.indexOf('git diff origin/main...ai/TS-577') !== -1, 'should fall back to origin/ prefix');
    });

    test('prefers github_get_pr_diff_text when available', function() {
        var calls = [];
        var scmModule = loadScm({
            github_get_pr_diff_text: function(args) {
                calls.push(args);
                return 'diff --git a/file.txt b/file.txt\n+change\n';
            },
            github_get_pr_diff: function() { throw new Error('legacy tool should not be called'); },
            github_get_pr: function() { throw new Error('github_get_pr should not be called'); },
            cli_execute_command: function() { throw new Error('git diff should not be called'); }
        });

        var provider = scmModule._createGithubProvider('IstiN', 'trackstate');
        var diff = provider.getPrDiff('1789');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should return diff from new tool');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].pullRequestID, '1789');
    });

    test('extracts diff from JSON result wrapper', function() {
        var scmModule = loadScm({
            github_get_pr_diff_text: function() {
                return JSON.stringify({ result: 'diff --git a/file.txt b/file.txt\n+change\n' });
            },
            github_get_pr_diff: function() { throw new Error('legacy tool should not be called'); },
            github_get_pr: function() { throw new Error('github_get_pr should not be called'); },
            cli_execute_command: function() { throw new Error('git diff should not be called'); }
        });

        var provider = scmModule._createGithubProvider('IstiN', 'trackstate');
        var diff = provider.getPrDiff('1789');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should unwrap JSON result');
        assert.ok(diff.indexOf('diff --git') === 0, 'should return raw diff, not JSON envelope');
    });

    test('extracts diff from IBody arg$1 wrapper', function() {
        var scmModule = loadScm({
            github_get_pr_diff_text: function() {
                return JSON.stringify({ 'arg$1': 'diff --git a/file.txt b/file.txt\n+change\n' });
            },
            github_get_pr_diff: function() { throw new Error('legacy tool should not be called'); },
            github_get_pr: function() { throw new Error('github_get_pr should not be called'); },
            cli_execute_command: function() { throw new Error('git diff should not be called'); }
        });

        var provider = scmModule._createGithubProvider('IstiN', 'trackstate');
        var diff = provider.getPrDiff('1789');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should unwrap arg$1 field');
        assert.ok(diff.indexOf('diff --git') === 0, 'should return raw diff, not JSON envelope');
    });
});

suite('scm GitHub provider getCommitCheckRuns', function() {

    test('returns native check runs as-is when the Checks API already reports them', function() {
        var checkRunArgs = null;
        var cliCalls = [];
        var scmModule = loadScm({
            github_get_commit_check_runs: function(args) {
                checkRunArgs = args;
                return { check_runs: [{ name: 'build', conclusion: 'failure' }] };
            },
            cli_execute_command: function(args) { cliCalls.push(args.command); return '[]'; }
        });

        var provider = scmModule._createGithubProvider('IstiN', 'trackstate');
        var runs = provider.getCommitCheckRuns('abc123');

        assert.equal(checkRunArgs.workspace, 'IstiN');
        assert.equal(checkRunArgs.repository, 'trackstate');
        assert.equal(checkRunArgs.commitSha, 'abc123');
        assert.equal(runs.length, 1);
        assert.equal(runs[0].name, 'build');
        assert.equal(runs[0].conclusion, 'failure');
    });

    test('merges legacy commit statuses (e.g. an external Jenkins) when the Checks API has none', function() {
        var cliCommand = null;
        var scmModule = loadScm({
            github_get_commit_check_runs: function() { return { check_runs: [] }; },
            cli_execute_command: function(args) {
                cliCommand = args.command;
                return JSON.stringify([
                    { context: 'continuous-integration/jenkins/pr-merge', state: 'error', target_url: 'https://jenkins.example.com/job/x/job/PR-1/5/display/redirect' },
                    { context: 'continuous-integration/jenkins/pr-merge', state: 'pending', target_url: 'https://jenkins.example.com/job/x/job/PR-1/5/display/redirect' },
                    { context: 'other-check', state: 'success', target_url: 'https://ci.example.com/1' }
                ]);
            }
        });

        var provider = scmModule._createGithubProvider('acme', 'widgets');
        var runs = provider.getCommitCheckRuns('deadbeef');

        assert.ok(cliCommand.indexOf('repos/acme/widgets/commits/deadbeef/statuses') !== -1, 'should call gh api for the right repo/sha');
        assert.equal(runs.length, 2, 'should dedupe to the most recent status per context');
        assert.equal(runs[0].name, 'continuous-integration/jenkins/pr-merge');
        assert.equal(runs[0].conclusion, 'failure', 'most recent report (error) wins over the older pending one');
        assert.equal(runs[0].details_url, 'https://jenkins.example.com/job/x/job/PR-1/5/display/redirect');
        assert.equal(runs[1].name, 'other-check');
        assert.equal(runs[1].conclusion, 'success');
    });

    test('does not duplicate a check that is already reported by the Checks API', function() {
        var scmModule = loadScm({
            github_get_commit_check_runs: function() { return { check_runs: [{ name: 'shared-check', conclusion: 'success' }] }; },
            cli_execute_command: function() {
                return JSON.stringify([{ context: 'shared-check', state: 'failure', target_url: 'https://x/1' }]);
            }
        });

        var provider = scmModule._createGithubProvider('acme', 'widgets');
        var runs = provider.getCommitCheckRuns('deadbeef');

        assert.equal(runs.length, 1, 'Checks API entry should win, not be duplicated by the legacy status');
        assert.equal(runs[0].conclusion, 'success');
    });

    test('returns only check runs when there are no legacy statuses', function() {
        var scmModule = loadScm({
            github_get_commit_check_runs: function() { return { check_runs: [{ name: 'build', conclusion: 'success' }] }; },
            cli_execute_command: function() { return '[]'; }
        });

        var provider = scmModule._createGithubProvider('acme', 'widgets');
        var runs = provider.getCommitCheckRuns('deadbeef');

        assert.equal(runs.length, 1);
        assert.equal(runs[0].name, 'build');
    });

    test('does not throw when the legacy status CLI call fails', function() {
        var scmModule = loadScm({
            github_get_commit_check_runs: function() { return { check_runs: [{ name: 'build', conclusion: 'failure' }] }; },
            cli_execute_command: function() { throw new Error('gh not authenticated'); }
        });

        var provider = scmModule._createGithubProvider('acme', 'widgets');
        var runs = provider.getCommitCheckRuns('deadbeef');

        assert.equal(runs.length, 1, 'should still return the native check runs it already had');
        assert.equal(runs[0].name, 'build');
    });

    test('does not throw when the Checks API call fails, and still surfaces legacy statuses', function() {
        var scmModule = loadScm({
            github_get_commit_check_runs: function() { throw new Error('boom'); },
            cli_execute_command: function() {
                return JSON.stringify([{ context: 'continuous-integration/jenkins/pr-merge', state: 'error', target_url: 'https://x/1' }]);
            }
        });

        var provider = scmModule._createGithubProvider('acme', 'widgets');
        var runs = provider.getCommitCheckRuns('deadbeef');

        assert.equal(runs.length, 1);
        assert.equal(runs[0].name, 'continuous-integration/jenkins/pr-merge');
        assert.equal(runs[0].conclusion, 'failure');
    });

    test('returns null without calling any tool when sha is missing', function() {
        var calls = [];
        var scmModule = loadScm({
            github_get_commit_check_runs: function() { calls.push('checks'); return { check_runs: [] }; },
            cli_execute_command: function() { calls.push('cli'); return '[]'; }
        });

        var provider = scmModule._createGithubProvider('acme', 'widgets');
        assert.equal(provider.getCommitCheckRuns(null), null);
        assert.equal(calls.length, 0);
    });
});

suite('scm GitLab provider getPrDiff fallback', function() {

    test('prefers gitlab_get_mr_diff_text when available', function() {
        var calls = [];
        var scmModule = loadScm({
            gitlab_get_mr_diff_text: function(args) {
                calls.push(args);
                return 'diff --git a/file.txt b/file.txt\n+change\n';
            },
            gitlab_get_mr_diff: function() { throw new Error('legacy tool should not be called'); },
            gitlab_get_mr: function() { throw new Error('gitlab_get_mr should not be called'); },
            cli_execute_command: function() { throw new Error('git diff should not be called'); }
        });

        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        var diff = provider.getPrDiff('7860');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should return diff from new tool');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].pullRequestId, '7860');
    });

    test('falls back to legacy gitlab_get_mr_diff when gitlab_get_mr_diff_text is unavailable or unusable', function() {
        var legacyCalls = [];
        var scmModule = loadScm({
            gitlab_get_mr_diff_text: function() { return 'com.github.istin.dmtools.gitlab.GitLab$5@abc123'; },
            gitlab_get_mr_diff: function(args) {
                legacyCalls.push(args);
                return 'diff --git a/file.txt b/file.txt\n+change\n';
            }
        });

        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        var diff = provider.getPrDiff('7860');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should fall back to legacy tool result');
        assert.equal(legacyCalls.length, 1, 'should call legacy gitlab_get_mr_diff as fallback');
    });

    test('uses gitlab_get_mr_diff directly when it returns a usable diff', function() {
        var mrCalls = [];
        var gitCalls = [];
        var scmModule = loadScm({
            gitlab_get_mr_diff_text: function() { return ''; },
            gitlab_get_mr_diff: function() {
                return 'diff --git a/file.txt b/file.txt\n+change\n';
            },
            gitlab_get_mr: function(args) { mrCalls.push(args); return '{}'; },
            cli_execute_command: function(args) { gitCalls.push(args.command); return ''; }
        });

        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        var diff = provider.getPrDiff('7860');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should return usable diff');
        assert.equal(mrCalls.length, 0, 'must not fetch MR details when MCP diff is usable');
        assert.equal(gitCalls.length, 0, 'must not run git diff when MCP diff is usable');
    });

    test('falls back to local git diff (using base/head SHAs) when gitlab_get_mr_diff returns a Java object string', function() {
        var mrDiffCalls = [];
        var mrCalls = [];
        var gitCalls = [];
        var scmModule = loadScm({
            gitlab_get_mr_diff_text: function() { return ''; },
            gitlab_get_mr_diff: function(args) {
                mrDiffCalls.push(args);
                return 'com.github.istin.dmtools.gitlab.GitLab$4@b2c4a8b';
            },
            gitlab_get_mr: function(args) {
                mrCalls.push(args);
                return JSON.stringify({
                    diff_refs: { base_sha: 'abc111', head_sha: 'def222', start_sha: 'abc111' }
                });
            },
            cli_execute_command: function(args) {
                gitCalls.push(args.command);
                if (args.command === 'git diff abc111...def222') {
                    return 'diff --git a/file.txt b/file.txt\n+change\nCOMMAND_EXIT_CODE=0';
                }
                return 'COMMAND_EXIT_CODE=128';
            }
        });

        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        var diff = provider.getPrDiff('7860', './dependencies/service-api');

        assert.ok(diff.indexOf('diff --git') !== -1, 'should return usable local diff');
        assert.equal(mrDiffCalls.length, 1);
        assert.equal(mrDiffCalls[0].pullRequestId, '7860');
        assert.equal(mrCalls.length, 1, 'should fetch MR to get diff_refs');
        assert.ok(gitCalls.indexOf('git diff abc111...def222') !== -1, 'should diff using base/head SHAs');
    });

    test('passes workingDir through to cli_execute_command for local diff fallback', function() {
        var gitOpts = [];
        var scmModule = loadScm({
            gitlab_get_mr_diff_text: function() { return ''; },
            gitlab_get_mr_diff: function() { return ''; },
            gitlab_get_mr: function() {
                return JSON.stringify({ diff_refs: { base_sha: 'abc111', head_sha: 'def222', start_sha: 'abc111' } });
            },
            cli_execute_command: function(args) {
                gitOpts.push(args);
                return 'diff --git a/file.txt b/file.txt\n+change\nCOMMAND_EXIT_CODE=0';
            }
        });

        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        provider.getPrDiff('7860', './dependencies/service-api');

        assert.equal(gitOpts[0].workingDirectory, './dependencies/service-api', 'should run git diff in the checked-out repo dir');
    });

    test('returns raw (unusable) value when both MCP diff and local git diff fail', function() {
        var scmModule = loadScm({
            gitlab_get_mr_diff_text: function() { return ''; },
            gitlab_get_mr_diff: function() { return 'com.github.istin.dmtools.gitlab.GitLab$4@b2c4a8b'; },
            gitlab_get_mr: function() { return JSON.stringify({ diff_refs: {} }); },
            cli_execute_command: function() { throw new Error('should not be called without diff_refs'); }
        });

        var provider = scmModule._createGitLabProvider('acme-org/develop', 'service-api');
        var diff = provider.getPrDiff('7860', './dependencies/service-api');

        assert.equal(diff, 'com.github.istin.dmtools.gitlab.GitLab$4@b2c4a8b', 'should fall back to raw value, not throw');
    });
});

suite('githubHelpers.detectFailedChecks — Jenkins failed checks', function() {

    function makeGh(mocks) {
        return loadGithubHelpers(mocks || {});
    }

    function findWrite(writes, path) {
        for (var i = 0; i < writes.length; i++) {
            if (writes[i].path === path) return writes[i];
        }
        return null;
    }

    test('fetches Jenkins console log for a failed check with Jenkins details_url', function() {
        var writes = [];
        var jenkinsInfoCalls = [];
        var jenkinsLogCalls = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'Jenkins PR Build',
                        conclusion: 'failure',
                        details_url: 'https://jenkins.example.com/job/example-org/job/example.repo/job/PR-123/45/'
                    }]
                };
            },
            jenkins_get_job_info: function(args) {
                jenkinsInfoCalls.push(args);
                return { result: { number: 45, result: 'FAILURE' } };
            },
            jenkins_get_build_log: function(args) {
                jenkinsLogCalls.push(args);
                return 'line 1\nline 2\nfailure reason';
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks(
            'example-org', 'example.repo', 'abc123def', '/tmp/input',
            'https://jenkins.example.com/'
        );

        assert.equal(failed.length, 1, 'one failed check should be reported');
        assert.equal(failed[0].name, 'Jenkins PR Build');
        assert.equal(jenkinsInfoCalls.length, 1, 'jenkins_get_job_info should be called once');
        assert.equal(jenkinsInfoCalls[0].jobPath, 'job/example-org/job/example.repo/job/PR-123');
        assert.equal(jenkinsInfoCalls[0].buildNumber, 45);
        assert.equal(jenkinsLogCalls.length, 1, 'jenkins_get_build_log should be called once');
        assert.equal(jenkinsLogCalls[0].jobPath, 'job/example-org/job/example.repo/job/PR-123');
        assert.equal(jenkinsLogCalls[0].buildNumber, 45);

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');

        assert.ok(mdWrite, 'ci_failures.md should be written');
        assert.contains(mdWrite.content, 'Jenkins PR Build');
        assert.contains(mdWrite.content, 'Jenkins error log');
        assert.contains(mdWrite.content, 'failure reason');
        assert.contains(mdWrite.content, 'last 500 lines', 'ci_failures.md should mention last 500 lines');
        assert.contains(mdWrite.content, 'ci_failures_full.log', 'ci_failures.md should reference ci_failures_full.log');

        assert.ok(fullLogWrite, 'ci_failures_full.log should be written');
        assert.contains(fullLogWrite.content, '=== Jenkins error log for: Jenkins PR Build ===');
        assert.contains(fullLogWrite.content, 'line 1');
        assert.contains(fullLogWrite.content, 'line 2');
        assert.contains(fullLogWrite.content, 'failure reason');
    });

    test('ignores Jenkins details_url when jenkinsBasePath is not configured', function() {
        var writes = [];
        var jenkinsLogCalls = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'Jenkins PR Build',
                        conclusion: 'failure',
                        details_url: 'https://jenkins.example.com/job/example-org/job/example.repo/job/PR-123/45/'
                    }]
                };
            },
            jenkins_get_build_log: function(args) {
                jenkinsLogCalls.push(args);
                return 'log';
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks('example-org', 'example.repo', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1);
        assert.equal(jenkinsLogCalls.length, 0, 'jenkins log should not be fetched without base path');

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'file should still be written for the failed check');
        assert.notContains(mdWrite.content, 'Jenkins error log');

        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(!fullLogWrite, 'ci_failures_full.log should not be written when no logs were fetched');
    });

    test('ignores failed checks whose details_url points to a different Jenkins host', function() {
        var jenkinsLogCalls = [];
        var writes = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'Other Jenkins Build',
                        conclusion: 'failure',
                        details_url: 'https://other-jenkins.example.com/job/x/1/'
                    }]
                };
            },
            jenkins_get_build_log: function(args) {
                jenkinsLogCalls.push(args);
                return 'log';
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        gh.detectFailedChecks('example-org', 'example.repo', 'abc123def', '/tmp/input', 'https://jenkins.example.com/');

        assert.equal(jenkinsLogCalls.length, 0, 'different host should be ignored');
        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(mdWrite, 'ci_failures.md should still be written for the failed check');
        assert.notContains(mdWrite.content, 'Jenkins error log');
        assert.ok(!fullLogWrite, 'ci_failures_full.log should not be written when no logs were fetched');
    });
});

suite('githubHelpers.findMergedPRForTicket', function() {

    function scmWithClosedPrs(prs) {
        return {
            listPrs: function(state) {
                assert.equal(state, 'closed', 'findMergedPRForTicket must request closed PRs');
                return prs;
            }
        };
    }

    test('returns null when no closed PR matches the ticket key', function() {
        var gh = loadGithubHelpers();
        var scm = scmWithClosedPrs([
            { number: 1, title: 'OTHER-1: unrelated', merged_at: '2026-01-01T00:00:00Z' }
        ]);

        var result = gh.findMergedPRForTicket(scm, 'ABC-123');

        assert.ok(!result, 'no matching PR should return null/falsy');
    });

    test('ignores closed-but-not-merged PRs even when the title matches', function() {
        var gh = loadGithubHelpers();
        var scm = scmWithClosedPrs([
            { number: 1, title: 'ABC-123: fix', merged_at: null }
        ]);

        var result = gh.findMergedPRForTicket(scm, 'ABC-123');

        assert.ok(!result, 'closed-without-merge PR must not be returned');
    });

    test('matches by ticket key in the head branch ref when title has no match', function() {
        var gh = loadGithubHelpers();
        var scm = scmWithClosedPrs([
            { number: 7, title: 'Unrelated title', head: { ref: 'feature/ABC-123-fix' }, merged_at: '2026-02-01T00:00:00Z' }
        ]);

        var result = gh.findMergedPRForTicket(scm, 'ABC-123');

        assert.ok(result, 'should match via head.ref');
        assert.equal(result.number, 7);
    });

    test('when several merged PRs match, returns the most recently merged one', function() {
        var gh = loadGithubHelpers();
        var scm = scmWithClosedPrs([
            { number: 1, title: 'ABC-123: first attempt', merged_at: '2026-01-01T00:00:00Z' },
            { number: 2, title: 'ABC-123: second attempt', merged_at: '2026-03-01T00:00:00Z' },
            { number: 3, title: 'ABC-123: third attempt (older)', merged_at: '2026-02-01T00:00:00Z' }
        ]);

        var result = gh.findMergedPRForTicket(scm, 'ABC-123');

        assert.equal(result.number, 2, 'the PR with the latest merged_at should win');
    });

    test('returns null and does not throw when scm.listPrs throws', function() {
        var gh = loadGithubHelpers();
        var scm = {
            listPrs: function() { throw new Error('boom'); }
        };

        var result = gh.findMergedPRForTicket(scm, 'ABC-123');

        assert.ok(!result, 'errors should be swallowed and null returned');
    });
});

suite('scm.getDiffText', function() {

    test('GitHub provider calls github_get_pr_diff_text with workspace/repository/pullRequestID', function() {
        var call = null;
        var scmModule = loadScm({
            github_get_pr_diff_text: function(args) {
                call = args;
                return 'diff --git a/x b/x';
            }
        });

        var provider = scmModule._createGithubProvider('example-org', 'example.repo');
        var diff = provider.getDiffText(42);

        assert.deepEqual(call, { workspace: 'example-org', repository: 'example.repo', pullRequestID: '42' });
        assert.equal(diff, 'diff --git a/x b/x');
    });

    test('GitHub provider returns null instead of throwing when the diff-text tool fails', function() {
        var scmModule = loadScm({
            github_get_pr_diff_text: function() { throw new Error('IS_READ_PULL_REQUEST_DIFF disabled'); }
        });

        var provider = scmModule._createGithubProvider('example-org', 'example.repo');
        var diff = provider.getDiffText(42);

        assert.ok(diff === null, 'must gracefully return null on failure');
    });

    test('GitLab provider calls gitlab_get_mr_diff_text with workspace/repository/pullRequestId', function() {
        var call = null;
        var scmModule = loadScm({
            gitlab_get_mr_diff_text: function(args) {
                call = args;
                return 'diff --git a/x b/x';
            }
        });

        var provider = scmModule._createGitLabProvider('example-group', 'example-project');
        var diff = provider.getDiffText(7);

        assert.deepEqual(call, { workspace: 'example-group', repository: 'example-project', pullRequestId: '7' });
        assert.equal(diff, 'diff --git a/x b/x');
    });

    test('GitLab provider returns null instead of throwing when the diff-text tool fails', function() {
        var scmModule = loadScm({
            gitlab_get_mr_diff_text: function() { throw new Error('boom'); }
        });

        var provider = scmModule._createGitLabProvider('example-group', 'example-project');
        var diff = provider.getDiffText(7);

        assert.ok(diff === null, 'must gracefully return null on failure');
    });

    test('ADO provider always returns null (no raw diff-text API available)', function() {
        var scmModule = loadScm({});
        var provider = scmModule._createAdoProvider('example-project');

        assert.ok(provider.getDiffText(7) === null);
    });
});
