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
            }
        }),
        mocks || {}
    );
}

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

// ── Suite: resolved status from GraphQL ──────────────────────────────────────

suite('github repo remote parsing', function() {

    [
        {
            name: 'https URL with dotted repo',
            remote: 'https://github.com/epam/dm.ai',
            expected: { owner: 'epam', repo: 'dm.ai' }
        },
        {
            name: 'https URL with dotted repo and .git suffix',
            remote: 'https://github.com/epam/dm.ai.git',
            expected: { owner: 'epam', repo: 'dm.ai' }
        },
        {
            name: 'ssh URL with dotted repo and .git suffix',
            remote: 'git@github.com:epam/dm.ai.git',
            expected: { owner: 'epam', repo: 'dm.ai' }
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
                return 'git@github.com:epam/dm.ai.git\nCOMMAND_EXIT_CODE=0';
            },
            github_list_prs: function(args) {
                calls.push(args);
                return [];
            }
        });

        var scm = scmModule.createScm({});
        scm.listPrs('open');

        assert.deepEqual(calls[0], {
            workspace: 'epam',
            repository: 'dm.ai',
            state: 'open'
        });
    });
});

suite('githubHelpers.checkoutPRBranch', function() {
    test('falls back to existing local branch when fetch creates it before failing', function() {
        var commands = [];
        var branchExists = false;
        var gh = loadGithubHelpers({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git branch --list "ai/TS-1268"') {
                    return branchExists ? '  ai/TS-1268\nCOMMAND_EXIT_CODE=0' : '\nCOMMAND_EXIT_CODE=0';
                }
                if (args.command === 'git ls-remote --heads origin ai/TS-1268') {
                    return 'abc123\trefs/heads/ai/TS-1268\nCOMMAND_EXIT_CODE=0';
                }
                if (args.command === 'git -c fetch.recurseSubmodules=no fetch origin ai/TS-1268:ai/TS-1268') {
                    branchExists = true;
                    throw new Error('fatal: refusing to fetch into branch checked out');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        gh.checkoutPRBranch('ai/TS-1268');

        assert.ok(commands.indexOf('git checkout ai/TS-1268') !== -1, 'existing local branch should be checked out');
        assert.equal(commands.indexOf('git checkout -b ai/TS-1268 origin/ai/TS-1268'), -1, 'must not recreate an existing branch');
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
                return 'git@git.epam.com:mobile/dmtools-epamsample.git\nCOMMAND_EXIT_CODE=0';
            },
            gitlab_list_mrs: function(args) {
                calls.push(args);
                return [];
            }
        });

        var scm = scmModule.createScm({ scm: { provider: 'gitlab' } });
        scm.listPrs('open');

        assert.deepEqual(calls[0], {
            workspace: 'mobile',
            repository: 'dmtools-epamsample',
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

        var provider = scmModule._createGitLabProvider('mobile', 'dmtools-epamsample');
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
                    web_url: 'https://git.epam.com/mobile/dmtools-epamsample/-/merge_requests/42',
                    source_branch: 'feature/ABC-1',
                    target_branch: 'main'
                });
            }
        });

        var provider = scmModule._createGitLabProvider('mobile', 'dmtools-epamsample');
        var result = provider.createPr({
            title: 'ABC-1: change',
            branchName: 'feature/ABC-1',
            baseBranch: 'main',
            body: 'Description',
            removeSourceBranch: true
        });

        assert.deepEqual(call, {
            workspace: 'mobile',
            repository: 'dmtools-epamsample',
            sourceBranch: 'feature/ABC-1',
            targetBranch: 'main',
            title: 'ABC-1: change',
            description: 'Description',
            removeSourceBranch: 'true'
        });
        assert.equal(result.success, true);
        assert.equal(result.number, 42);
        assert.equal(result.prUrl, 'https://git.epam.com/mobile/dmtools-epamsample/-/merge_requests/42');
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
        var provider = scmModule._createGitLabProvider('mobile', 'dmtools-epamsample');
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

        var provider = scmModule._createGitLabProvider('mobile', 'dmtools-epamsample');
        provider.updateBranch(55, 'mobile', 'dmtools-epamsample');

        assert.deepEqual(call, {
            workspace: 'mobile',
            repository: 'dmtools-epamsample',
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
});
