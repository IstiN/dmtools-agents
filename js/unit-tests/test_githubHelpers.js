/**
 * Unit tests for agents/js/common/githubHelpers.js
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
        'agents/js/common/githubHelpers.js',
        makeRequire({ '../config.js': configModule, 'config': configModule }),
        mocks || {}
    );
}

function loadScm(mocks) {
    return loadModule(
        'agents/js/common/scm.js',
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
