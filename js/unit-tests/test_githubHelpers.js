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
    var machineNoticeModule = loadModule('js/common/machineNotice.js');
    var reviewThreadInventoryModule = loadModule('js/common/reviewThreadInventory.js',
        makeRequire({ './machineNotice.js': machineNoticeModule }));
    return loadModule(
        'js/common/githubHelpers.js',
        makeRequire({
            '../config.js': configModule,
            'config': configModule,
            // Real PR helper (gh-912): githubHelpers delegates cleanCommandOutput
            // to it, so the canonical implementation must be in the map.
            './pullRequest.js': PR_HELPER_REAL_GH,
            './gitOps.js': gitOpsStub,
            './machineNotice.js': machineNoticeModule,
            './reviewThreadInventory.js': reviewThreadInventoryModule,
            './ci.js': loadModule('js/common/ci.js'),
            './ciViolations.js': loadModule('js/common/ciViolations.js')
        }),
        mocks || {}
    );
}

// Real PR helper (gh-912) — shared by every githubHelpers load in this file.
var PR_HELPER_REAL_GH = loadModule('js/common/pullRequest.js',
    makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }));

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
        makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js'),
            './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js', makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') })) }),
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

// ── Suite: PR-anchored lookup for githubSource pseudo-tickets (pr-N) ─────────
// Live fa #1212 (2026-10-04, run 37200002499, job 111429622376): the rework
// ticket key was the pseudo-ticket 'pr-1212' but the PR's title/branch reference
// the ORIGINAL work item ('ai/gh-1204'), and with ~10+ open PRs the target was
// not even in the single listPrs page the pack fetched. The list-scan scored
// nothing → "No open Pull Request found for this ticket" at the start gate and
// "Could not find PR to post comment" in the post-action → empty rework laps
// and unresolved threads forever. A 'pr-N' key must resolve DIRECTLY by number.
suite('githubHelpers.findPRForTicket — PR-anchored (githubSource pr-N) lookup', function() {

    function pageOneOpenPrs() {
        // A single github_list_prs page of unrelated open PRs — none of them is
        // #1212 and none matches 'pr-1212' / bounded '1212' in title or branch.
        var prs = [];
        for (var n = 1200; n <= 1209; n++) {
            var other = n - 400; // 800..809 — original work items of OTHER PRs
            prs.push({
                number: n,
                title: 'ai/gh-' + other + ': unrelated fix',
                head: { ref: 'ai/gh-' + other },
                changed_files: 2
            });
        }
        return prs;
    }

    var anchoredPr = {
        number: 1212,
        title: 'ai/gh-1204: fix telemetry',
        head: { ref: 'ai/gh-1204' },
        state: 'open',
        changed_files: 3
    };

    test('repro (fa #1212): pr-N key resolves directly by number even when the PR is absent from the single listPrs page', function() {
        var gh = loadGithubHelpers({});
        var listCalls = [];
        var getPrCalls = [];
        var scm = {
            listPrs: function(state) { listCalls.push(state); return pageOneOpenPrs(); },
            getPr: function(id) { getPrCalls.push(id); return anchoredPr; }
        };

        var result = gh.findPRForTicket(scm, 'pr-1212');

        assert.ok(result, 'the PR-anchored key must resolve to its PR — list-scan false negatives end here');
        assert.equal(result.number, 1212);
        assert.equal(getPrCalls.length, 1, 'exactly one direct get-by-number call');
        assert.equal(String(getPrCalls[0]), '1212', 'direct get-by-number (REST pulls/{n}) is the lookup path');
        assert.equal(listCalls.length, 0, 'anchored keys must not depend on the (page-1-only) PR list at all');
    });

    test('anchored lookup failure does NOT fall back to the list-scan (deterministic)', function() {
        var gh = loadGithubHelpers({});
        var listCalls = [];
        var scm = {
            listPrs: function(state) { listCalls.push(state); return pageOneOpenPrs(); },
            getPr: function() { throw new Error('pulls/1212 not found'); }
        };

        var result = gh.findPRForTicket(scm, 'pr-1212');

        assert.ok(!result, 'failed direct fetch means no PR — null, honestly');
        assert.equal(listCalls.length, 0, 'no list-scan fallback: scanning reintroduces the false-negative race');
    });

    test('anchored lookup returns null for a closed/merged PR (open-gate semantics)', function() {
        var gh = loadGithubHelpers({});
        var scm = {
            listPrs: function() { return pageOneOpenPrs(); },
            getPr: function() { return Object.assign({}, anchoredPr, { state: 'closed' }); }
        };

        var result = gh.findPRForTicket(scm, 'pr-1212');

        assert.ok(!result, 'a closed anchored PR is not an open PR — the gate must stop');
    });

    test('anchored lookup tolerates providers that omit the state field', function() {
        var gh = loadGithubHelpers({});
        var scm = {
            listPrs: function() { return pageOneOpenPrs(); },
            getPr: function() { var p = Object.assign({}, anchoredPr); delete p.state; return p; }
        };

        var result = gh.findPRForTicket(scm, 'pr-1212');

        assert.ok(result, 'missing state must not reject a directly-fetched PR');
        assert.equal(result.number, 1212);
    });

    test('anchor is case-sensitive lowercase (a real Jira project key "PR-1212" keeps the list-scan path)', function() {
        var gh = loadGithubHelpers({});
        var listCalls = [];
        var getPrCalls = [];
        var scm = {
            listPrs: function(state) {
                listCalls.push(state);
                return [{ number: 42, title: 'PR-1212: jira ticket fix', head: { ref: 'feature/PR-1212' }, changed_files: 1 }];
            },
            getPr: function(id) { getPrCalls.push(id); return anchoredPr; }
        };

        var result = gh.findPRForTicket(scm, 'PR-1212');

        assert.ok(result, 'uppercase Jira key still matches via the unchanged scan');
        assert.equal(result.number, 42, 'must be the scanned PR, not the anchor fetch');
        assert.equal(getPrCalls.length, 0, 'no anchor fetch for uppercase keys');
        assert.deepEqual(listCalls, ['open']);
    });

    test('legacy (workspace, repository, ticketKey) form: anchored key uses github_get_pr, never github_list_prs', function() {
        var gh = loadGithubHelpers({
            github_get_pr: function(args) {
                getPrArgs.push(args);
                return anchoredPr;
            },
            github_list_prs: function(args) {
                listPrsArgs.push(args);
                return pageOneOpenPrs();
            }
        });
        var getPrArgs = [];
        var listPrsArgs = [];

        var result = gh.findPRForTicket('IstiN', 'fa', 'pr-1212');

        assert.ok(result, 'legacy calling convention must resolve the anchor too');
        assert.equal(result.number, 1212);
        assert.equal(getPrArgs.length, 1);
        assert.equal(getPrArgs[0].pullRequestId, '1212');
        assert.equal(getPrArgs[0].repository, 'fa');
        assert.equal(listPrsArgs.length, 0, 'no list call for anchored keys');
    });

    test('jira regression: real ticket keys keep the exact pre-change list-scan path', function() {
        var gh = loadGithubHelpers({});
        var listCalls = [];
        var getPrCalls = [];
        var scm = {
            listPrs: function(state) {
                listCalls.push(state);
                return [{ number: 7, title: 'PROJ-42: fix login', head: { ref: 'feature/proj-42' }, changed_files: 1 }];
            },
            getPr: function(id) { getPrCalls.push(id); return anchoredPr; }
        };

        var result = gh.findPRForTicket(scm, 'PROJ-42');

        assert.ok(result, 'jira-shaped key still found by the scan');
        assert.equal(result.number, 7);
        assert.deepEqual(listCalls, ['open'], 'same single open-state list call as before');
        assert.equal(getPrCalls.length, 0, 'jira keys never switch to get-by-number');
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
        // gh-802 AC2: tool mocked to succeed → exactly 1 call, 0 fallbacks
        // (the legacy tool / github_get_pr / git mocks above all throw).
        assert.equal(calls.length, 1);
        // gh-802 AC1: exact schema casing — the runtime tool schema declares
        // `pullRequestID` (capital D) for BOTH diff tools; dmtools v1.7.256
        // rejects `pullRequestId` ("Required parameter 'pullRequestID' is
        // missing" — reproduced live, see repo history #193/#201). The catalog
        // is asymmetric: other github_* PR tools take `pullRequestId`.
        assert.equal(calls[0].pullRequestID, '1789');
        assert.equal(calls[0].pullRequestId, undefined,
            'pullRequestId is the wrong casing — the diff-text tool schema requires pullRequestID');
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
        // gh-1045: the failure is loud — per-check diagnostics in both files.
        assert.contains(mdWrite.content, 'log fetch failed: unsupported details_url shape');

        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'gh-1045: full log written with per-check error markers');
        assert.contains(fullLogWrite.content, 'LOG FETCH FAILED for: Jenkins PR Build');
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
        // gh-1045: the failure is loud — per-check diagnostics in both files.
        assert.contains(mdWrite.content, 'log fetch failed: unsupported details_url shape');
        assert.ok(fullLogWrite, 'gh-1045: full log written with per-check error markers');
        assert.contains(fullLogWrite.content, 'LOG FETCH FAILED for: Other Jenkins Build');
    });

    test('a failed Jenkins fetch reports the Jenkins reason, not "unsupported details_url shape"', function() {
        var writes = [];

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
            jenkins_get_job_info: function() {
                return { result: { number: 45, result: 'FAILURE' } };
            },
            jenkins_get_build_log: function() {
                throw new Error('jenkins exploded');
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        gh.detectFailedChecks(
            'example-org', 'example.repo', 'abc123def', '/tmp/input',
            'https://jenkins.example.com/'
        );

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(mdWrite, 'ci_failures.md should still be written for the failed check');
        // gh-1045 review: the Jenkins-matched URL must surface the JENKINS
        // failure — the GitHub resolver's "unsupported details_url shape" is
        // misleading here because the shape IS supported.
        assert.contains(mdWrite.content, 'log fetch failed: Jenkins log fetch failed: jenkins exploded');
        assert.notContains(mdWrite.content, 'unsupported details_url shape',
            'the GitHub resolver reason must not mask the Jenkins failure');
        assert.ok(fullLogWrite, 'gh-1045: full log written with per-check error markers');
        assert.contains(fullLogWrite.content, 'Reason: Jenkins log fetch failed: jenkins exploded');
    });
});

suite('githubHelpers.detectFailedChecks — run-level details_url (/actions/runs/N)', function() {

    function makeGh(mocks) {
        return loadGithubHelpers(mocks || {});
    }

    function findWrite(writes, path) {
        for (var i = 0; i < writes.length; i++) {
            if (writes[i].path === path) return writes[i];
        }
        return null;
    }

    var RUN_JOBS = {
        total_count: 3,
        jobs: [
            { id: 111, name: 'build', conclusion: 'success', status: 'completed' },
            { id: 222, name: 'unit-tests', conclusion: 'failure', status: 'completed' },
            { id: 333, name: 'lint', conclusion: 'failure', status: 'completed' }
        ]
    };

    test('fetches run jobs and per-job logs for /runs/N-shaped details_url (owner/repo mode)', function() {
        var writes = [];
        var runJobsCalls = [];
        var jobLogCalls = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'CI',
                        conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/actions/runs/123456789'
                    }]
                };
            },
            github_get_workflow_run_jobs: function(args) {
                runJobsCalls.push(args);
                return JSON.stringify(RUN_JOBS);
            },
            github_get_job_logs: function(args) {
                jobLogCalls.push(args);
                return 'log for job ' + args.jobId;
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1, 'one failed check should be reported');
        assert.equal(runJobsCalls.length, 1, 'run jobs should be fetched once for the run-level URL');
        assert.equal(runJobsCalls[0].workspace, 'acme');
        assert.equal(runJobsCalls[0].repository, 'widgets');
        assert.equal(runJobsCalls[0].runId, '123456789');

        assert.equal(jobLogCalls.length, 2, 'logs fetched only for the 2 failed jobs');
        assert.equal(jobLogCalls[0].jobId, '222');
        assert.equal(jobLogCalls[1].jobId, '333');

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'ci_failures.md should be written');
        assert.contains(mdWrite.content, 'unit-tests');
        assert.contains(mdWrite.content, 'lint');
        assert.notContains(mdWrite.content, 'build');

        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'ci_failures_full.log should be written');
        assert.contains(fullLogWrite.content, 'log for job 222');
        assert.contains(fullLogWrite.content, 'log for job 333');
    });

    test('prefers the job id from /runs/N/job/M URLs and does not fetch run jobs', function() {
        var runJobsCalls = [];
        var jobLogCalls = [];
        var writes = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'CI',
                        conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/actions/runs/123456789/job/987654'
                    }]
                };
            },
            github_get_workflow_run_jobs: function(args) {
                runJobsCalls.push(args);
                return JSON.stringify(RUN_JOBS);
            },
            github_get_job_logs: function(args) {
                jobLogCalls.push(args);
                return 'direct job log';
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        assert.equal(runJobsCalls.length, 0, 'run jobs must not be fetched when a job id is present in the URL');
        assert.equal(jobLogCalls.length, 1, 'one direct job log fetch');
        assert.equal(jobLogCalls[0].jobId, '987654');
    });

    test('uses scm.getWorkflowRunJobs in SCM mode for run-level URLs', function() {
        var writes = [];
        var runJobsCalls = [];
        var jobLogCalls = [];

        var scm = {
            listPrs: function() { return []; },
            getCommitCheckRuns: function() {
                return {
                    check_runs: [{
                        name: 'CI',
                        conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/actions/runs/123456789'
                    }]
                };
            },
            getWorkflowRunJobs: function(runId) {
                runJobsCalls.push(runId);
                return RUN_JOBS;
            },
            getJobLogs: function(jobId) {
                jobLogCalls.push(jobId);
                return 'scm log for ' + jobId;
            }
        };

        var gh = makeGh({
            github_get_workflow_run_jobs: function() {
                throw new Error('github_get_workflow_run_jobs must not be called in SCM mode');
            },
            github_get_job_logs: function() {
                throw new Error('github_get_job_logs must not be called in SCM mode');
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks(scm, 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1);
        assert.equal(runJobsCalls.length, 1, 'scm.getWorkflowRunJobs should be called once');
        assert.equal(runJobsCalls[0], '123456789');
        assert.equal(jobLogCalls.length, 2);
        assert.equal(jobLogCalls[0], '222');
        assert.equal(jobLogCalls[1], '333');

        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'ci_failures_full.log should be written');
        assert.contains(fullLogWrite.content, 'scm log for 222');
    });

    test('skips log fetching when the run has no failed jobs', function() {
        var writes = [];
        var jobLogCalls = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'CI',
                        conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/actions/runs/123456789'
                    }]
                };
            },
            github_get_workflow_run_jobs: function() {
                return JSON.stringify({
                    total_count: 1,
                    jobs: [{ id: 111, name: 'build', conclusion: 'success', status: 'completed' }]
                });
            },
            github_get_job_logs: function(args) {
                jobLogCalls.push(args);
                return 'log';
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1, 'check is still reported as failed');
        assert.equal(jobLogCalls.length, 0, 'no job logs fetched when the run has no failed jobs');
        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'ci_failures.md should still be written');
        assert.contains(mdWrite.content, 'log fetch failed: no failed jobs resolved from workflow run 123456789',
            'gh-1045: loud per-check diagnostic for the empty run');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'gh-1045: full log written with per-check error markers');
        assert.contains(fullLogWrite.content, 'LOG FETCH FAILED for: CI');
    });

    test('supports a bare array workflow-run-jobs response', function() {
        var jobLogCalls = [];
        var writes = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'CI',
                        conclusion: 'timed_out',
                        details_url: 'https://github.com/acme/widgets/actions/runs/555'
                    }]
                };
            },
            github_get_workflow_run_jobs: function() {
                return JSON.stringify([{ id: 777, name: 'e2e', conclusion: 'timed_out' }]);
            },
            github_get_job_logs: function(args) {
                jobLogCalls.push(args);
                return 'timed-out log';
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1);
        assert.equal(failed[0].conclusion, 'timed_out');
        assert.equal(jobLogCalls.length, 1);
        assert.equal(jobLogCalls[0].jobId, '777');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'ci_failures_full.log should be written');
        assert.contains(fullLogWrite.content, 'timed-out log');
    });

    test('supports the {job_runs: [...]} envelope in a workflow-run-jobs response', function() {
        var jobLogCalls = [];
        var writes = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'CI',
                        conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/actions/runs/777'
                    }]
                };
            },
            github_get_workflow_run_jobs: function() {
                return JSON.stringify({
                    total_count: 2,
                    job_runs: [
                        { id: 888, name: 'build', conclusion: 'success', status: 'completed' },
                        { id: 999, name: 'integration', conclusion: 'failure', status: 'completed' }
                    ]
                });
            },
            github_get_job_logs: function(args) {
                jobLogCalls.push(args);
                return 'job-runs envelope log';
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1, 'check is still reported as failed');
        assert.equal(jobLogCalls.length, 1, 'logs fetched only for the failed job in the job_runs envelope');
        assert.equal(jobLogCalls[0].jobId, '999');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'ci_failures_full.log should be written');
        assert.contains(fullLogWrite.content, 'job-runs envelope log');
        assert.contains(fullLogWrite.content, 'integration');
    });

    test('treats an unparseable JSON-string run-jobs response as no jobs', function() {
        var jobLogCalls = [];
        var writes = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'CI',
                        conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/actions/runs/888'
                    }]
                };
            },
            github_get_workflow_run_jobs: function() {
                return '{not json';
            },
            github_get_job_logs: function(args) {
                jobLogCalls.push(args);
                return 'log';
            },
            file_write: function(args) {
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1, 'check is still reported as failed');
        assert.equal(jobLogCalls.length, 0, 'no job logs fetched when the run-jobs response cannot be parsed');
        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'ci_failures.md should still be written');
        assert.contains(mdWrite.content, 'log fetch failed: no failed jobs resolved from workflow run 888',
            'gh-1045: loud per-check diagnostic for the unparseable run-jobs response');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'gh-1045: full log written with per-check error markers');
        assert.contains(fullLogWrite.content, 'LOG FETCH FAILED for: CI');
    });
});

suite('scm GitHub provider getWorkflowRunJobs', function() {

    test('forwards runId to github_get_workflow_run_jobs with workspace/repository', function() {
        var calls = [];
        var scmModule = loadScm({
            github_get_workflow_run_jobs: function(args) {
                calls.push(args);
                return JSON.stringify({ total_count: 0, jobs: [] });
            }
        });

        var provider = scmModule._createGithubProvider('acme', 'widgets');
        var result = provider.getWorkflowRunJobs('123456789');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].workspace, 'acme');
        assert.equal(calls[0].repository, 'widgets');
        assert.equal(calls[0].runId, '123456789');
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

    test('GitHub provider calls github_get_pr_diff_text with workspace/repository/pullRequestID (gh-802 AC1 schema casing)', function() {
        var call = null;
        var scmModule = loadScm({
            github_get_pr_diff_text: function(args) {
                call = args;
                return 'diff --git a/x b/x';
            }
        });

        var provider = scmModule._createGithubProvider('example-org', 'example.repo');
        var diff = provider.getDiffText(42);

        // pullRequestID — the exact casing the runtime tool schema declares for
        // BOTH diff tools (dmtools v1.7.256 rejects pullRequestId — verified
        // live; repo history #193/#201). Other github_* PR tools take
        // pullRequestId — the catalog is asymmetric on purpose here.
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

suite('githubHelpers.detectFailedChecks — pure log helpers (gh-1007)', function() {

    function makeGh(mocks) {
        return loadGithubHelpers(mocks || {});
    }

    test('parseCheckRunsResult normalizes every accepted payload shape', function() {
        var gh = makeGh();
        var check = { name: 'x', conclusion: 'failure' };

        assert.deepEqual(gh.parseCheckRunsResult(null), []);
        assert.deepEqual(gh.parseCheckRunsResult('oops'), [], 'unparseable string yields no checks');
        assert.deepEqual(gh.parseCheckRunsResult({}), [], 'object without check_runs yields no checks');
        assert.deepEqual(gh.parseCheckRunsResult([check]), [check], 'array passes through');
        assert.deepEqual(gh.parseCheckRunsResult({ check_runs: [check] }), [check]);
        assert.deepEqual(gh.parseCheckRunsResult(JSON.stringify({ check_runs: [check] })), [check],
            'JSON string payload is parsed');
    });

    test('unwrapLogResult unwraps JSON {result} payloads and passes everything else through', function() {
        var gh = makeGh();
        assert.equal(gh.unwrapLogResult(JSON.stringify({ result: 'the log' })), 'the log');
        assert.equal(gh.unwrapLogResult('plain log'), 'plain log');
        assert.equal(gh.unwrapLogResult('{"other":1}'), '{"other":1}', 'JSON without result stays as-is');
        assert.equal(gh.unwrapLogResult(null), null);
        assert.deepEqual(gh.unwrapLogResult({ raw: 1 }), { raw: 1 });
    });

    test('extractJenkinsBuildTarget resolves the job path and build number', function() {
        var gh = makeGh();
        var t = gh.extractJenkinsBuildTarget(
            'https://jenkins.example.com/job/example-org/job/example.repo/job/PR-123/45/',
            'https://jenkins.example.com/');
        assert.deepEqual(t, { jobPath: 'job/example-org/job/example.repo/job/PR-123', buildNumber: 45 });
    });

    test('extractJenkinsBuildTarget rejects foreign hosts, missing numbers and empty job paths', function() {
        var gh = makeGh();
        assert.equal(gh.extractJenkinsBuildTarget('https://other.example.com/job/x/1/', 'https://jenkins.example.com/'), null);
        assert.equal(gh.extractJenkinsBuildTarget('https://jenkins.example.com/job/x/y/', 'https://jenkins.example.com/'), null,
            'no numeric build segment');
        assert.equal(gh.extractJenkinsBuildTarget('https://jenkins.example.com/45/', 'https://jenkins.example.com/'), null,
            'build number without a job path');
        assert.equal(gh.extractJenkinsBuildTarget(null, 'https://jenkins.example.com/'), null);
        assert.equal(gh.extractJenkinsBuildTarget('https://jenkins.example.com/job/x/1/', null), null);
    });

    test('buildLogSections builds the md snippet and full-log block, truncating to the last 500 lines', function() {
        var gh = makeGh();
        var lines = [];
        for (var i = 1; i <= 600; i++) lines.push('line ' + i);
        var sections = gh.buildLogSections(
            { name: 'Build', details_url: 'https://ci/job/1' }, lines.join('\n'), 'Error log');

        assert.ok(sections, 'sections should be returned for non-empty logs');
        assert.contains(sections.md, '**Error log (last 500 lines)**');
        assert.contains(sections.md, 'line 600');
        assert.notContains(sections.md, 'line 1\n', 'md snippet must only hold the last 500 lines');
        assert.contains(sections.md, 'line 101', 'the 500-line window starts at line 101');
        assert.contains(sections.full, '=== Error log for: Build ===');
        assert.contains(sections.full, 'URL: https://ci/job/1');
        assert.contains(sections.full, 'line 1');
        assert.equal(gh.buildLogSections({ name: 'B' }, '', 'Error log'), null, 'empty logs yield no sections');
        assert.equal(gh.buildLogSections({ name: 'B' }, null, 'Error log'), null);
    });

    test('buildCiFailuresHeader and resolution section shape the report', function() {
        var gh = makeGh();
        var md = gh.buildCiFailuresHeader([{ name: 'a' }, { name: 'b' }], 'abc123def');
        assert.contains(md, '# ⚠️ Failed CI Checks — Fix Before Completing Rework');
        assert.contains(md, 'ci_failures_full.log');
        assert.contains(md, '2 check(s) failed on commit `abc123de`');

        var resolution = gh.buildCiFailuresResolutionSection();
        assert.contains(resolution, '## Resolution');
        assert.contains(resolution, 'CI will re-run automatically');
    });
});

suite('githubHelpers.detectFailedChecks — scm mode and GitHub job logs (gh-1007)', function() {

    function makeGh(mocks) {
        return loadGithubHelpers(mocks || {});
    }

    function findWrite(writes, path) {
        for (var i = 0; i < writes.length; i++) {
            if (writes[i].path === path) return writes[i];
        }
        return null;
    }

    test('scm mode fetches check runs and job logs through the scm object', function() {
        var writes = [];
        var scm = {
            listPrs: function() { return []; },
            getCommitCheckRuns: function(sha) {
                return { check_runs: [{
                    name: 'PR Build', conclusion: 'failure',
                    details_url: 'https://ci.example.com/jobs/12345'
                }] };
            },
            getJobLogs: function(jobId) { return 'scm log for ' + jobId; }
        };

        var gh = makeGh({ file_write: function(args) { writes.push(args); } });
        var failed = gh.detectFailedChecks(scm, 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1);
        assert.equal(failed[0].name, 'PR Build');
        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite);
        assert.contains(mdWrite.content, '**Error log (last 500 lines)**');
        assert.contains(mdWrite.content, 'scm log for 12345');
    });

    test('scm getCommitCheckRuns returning null yields an empty result', function() {
        var scm = { listPrs: function() { return []; }, getCommitCheckRuns: function() { return null; }, getJobLogs: function() {} };
        var gh = makeGh({ file_write: function() {} });
        assert.deepEqual(gh.detectFailedChecks(scm, 'abc123def', '/tmp/input'), []);
    });

    test('github mode fetches job logs for /jobs/{id} urls and unwraps JSON-wrapped logs', function() {
        var writes = [];
        var logCalls = [];
        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return { check_runs: [{
                    name: 'Build',
                    conclusion: 'timed_out',
                    details_url: 'https://github.com/o/r/checks?check_run_id=1/jobs/777'
                }] };
            },
            github_get_job_logs: function(args) {
                logCalls.push(args);
                return JSON.stringify({ result: 'boom from json' });
            },
            file_write: function(args) { writes.push(args); }
        });

        var failed = gh.detectFailedChecks('o', 'r', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1, 'timed_out counts as failed');
        assert.equal(failed[0].conclusion, 'timed_out');
        assert.deepEqual(logCalls, [{ workspace: 'o', repository: 'r', jobId: '777' }]);
        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.contains(mdWrite.content, 'boom from json');
    });

    test('a job-log fetch failure is tolerated and the report is still written', function() {
        var writes = [];
        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return { check_runs: [{
                    name: 'Build', conclusion: 'failure', details_url: 'https://ci/jobs/1'
                }] };
            },
            github_get_job_logs: function() { throw new Error('logs down'); },
            file_write: function(args) { writes.push(args); }
        });

        var failed = gh.detectFailedChecks('o', 'r', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1);
        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'report should still be written without logs');
        assert.notContains(mdWrite.content, 'Error log (last 500 lines)');
        // gh-1045: the fetch failure is loud, not silent.
        assert.contains(mdWrite.content, 'log fetch failed: job log fetch failed: logs down');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'gh-1045: full log written with per-check error markers');
        assert.contains(fullLogWrite.content, 'LOG FETCH FAILED for: Build');
    });

    test('passing checks produce no report files', function() {
        var writes = [];
        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return { check_runs: [{ name: 'Build', conclusion: 'success' }] };
            },
            file_write: function(args) { writes.push(args); }
        });
        assert.deepEqual(gh.detectFailedChecks('o', 'r', 'abc123def', '/tmp/input'), []);
        assert.equal(writes.length, 0);
    });

    test('an empty check-run list produces no report files', function() {
        var writes = [];
        var gh = makeGh({
            github_get_commit_check_runs: function() { return { check_runs: [] }; },
            file_write: function(args) { writes.push(args); }
        });
        assert.deepEqual(gh.detectFailedChecks('o', 'r', 'abc123def', '/tmp/input'), []);
        assert.equal(writes.length, 0);
    });

    test('a missing headSha short-circuits before any fetch', function() {
        var gh = makeGh({
            github_get_commit_check_runs: function() { throw new Error('must not be called'); }
        });
        assert.deepEqual(gh.detectFailedChecks('o', 'r', null, '/tmp/input'), []);
    });

    test('a report-write failure is non-fatal and returns an empty list', function() {
        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return { check_runs: [{ name: 'Build', conclusion: 'failure' }] };
            },
            file_write: function() { throw new Error('disk full'); }
        });
        assert.doesNotThrow(function() {
            assert.deepEqual(gh.detectFailedChecks('o', 'r', 'abc123def', '/tmp/input'), []);
        });
    });

    test('a Jenkins url without a resolvable build target is ignored', function() {
        var writes = [];
        var jenkinsCalls = 0;
        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return { check_runs: [{
                    name: 'Jenkins Build', conclusion: 'failure',
                    details_url: 'https://jenkins.example.com/45/'
                }] };
            },
            jenkins_get_job_info: function() { jenkinsCalls++; },
            jenkins_get_build_log: function() { jenkinsCalls++; },
            file_write: function(args) { writes.push(args); }
        });

        var failed = gh.detectFailedChecks('o', 'r', 'abc123def', '/tmp/input', 'https://jenkins.example.com/');

        assert.equal(failed.length, 1);
        assert.equal(jenkinsCalls, 0, 'no Jenkins calls for a bare build number');
        assert.ok(findWrite(writes, '/tmp/input/ci_failures.md'));
    });
});


suite('githubHelpers.fetchGithubCheckLogs / fetchGithubRunLogs (gh-982 runs-url fallback)', function () {
    function load(tools) {
        var m = loadGithubHelpers(tools);
        return m;
    }

    test('isFailedRunJob: only failed/timed-out jobs with an id count', function () {
        var gh = load();
        assert.ok(gh.isFailedRunJob({ id: 1, conclusion: 'failure' }));
        assert.ok(gh.isFailedRunJob({ id: 1, conclusion: 'timed_out' }));
        assert.ok(!gh.isFailedRunJob({ id: 1, conclusion: 'success' }));
        assert.ok(!gh.isFailedRunJob({ conclusion: 'failure' }), 'no id');
        assert.ok(!gh.isFailedRunJob(null));
    });

    test('jobs/N details_url fetches the job log via the scm provider', function () {
        var calls = [];
        var gh = load();
        var scm = { getJobLogs: function (id) { calls.push(id); return 'LOG-' + id; } };
        var out = gh.fetchGithubCheckLogs({ details_url: 'https://x/actions/runs/1/jobs/42' }, scm, 'o', 'r');
        assert.equal(out, 'LOG-42');
        assert.deepEqual(calls, ['42']);
    });

    test('runs/N details_url falls back to the failed jobs of the run', function () {
        var gh = load();
        var scm = {
            getWorkflowRunJobs: function () {
                return { jobs: [
                    { id: 7, name: 'crap', conclusion: 'failure' },
                    { id: 8, name: 'gate', conclusion: 'success' },
                    { name: 'noid', conclusion: 'failure' }
                ] };
            },
            getJobLogs: function (id) { return 'ERR' + id; }
        };
        var out = gh.fetchGithubRunLogs({ details_url: 'https://x/actions/runs/99' }, scm, 'o', 'r');
        assert.ok(out.indexOf('=== crap ===') !== -1, 'failed job labeled');
        assert.ok(out.indexOf('ERR7') !== -1);
        assert.ok(out.indexOf('ERR8') === -1, 'successful jobs skipped');
    });

    test('runs/N fallback accumulates MULTIPLE failed jobs in order and skips log-less jobs', function () {
        var gh = load();
        var fetched = [];
        var scm = {
            getWorkflowRunJobs: function () {
                return { jobs: [
                    { id: 7, name: 'crap', conclusion: 'failure' },
                    { id: 9, name: 'lint', conclusion: 'timed_out' },
                    { id: 10, conclusion: 'failure' },
                    { id: 11, name: 'empty', conclusion: 'failure' }
                ] };
            },
            getJobLogs: function (id) { fetched.push(id); return String(id) === '11' ? null : 'ERR' + id; }
        };
        var out = gh.fetchGithubRunLogs({ details_url: 'https://x/actions/runs/99' }, scm, 'o', 'r');
        assert.deepEqual(fetched, ['7', '9', '10', '11'], 'every failed job with an id is fetched');
        assert.ok(out.indexOf('=== crap ===\nERR7') !== -1, 'first failed job first');
        assert.ok(out.indexOf('ERR7') < out.indexOf('=== lint ==='), 'order preserved');
        assert.ok(out.indexOf('=== lint ===\nERR9') !== -1, 'timed_out job included');
        assert.ok(out.indexOf('=== job 10 ===\nERR10') !== -1, 'unnamed job falls back to job <id> header');
        assert.ok(out.indexOf('empty') === -1 && out.indexOf('ERR11') === -1, 'job with null logs contributes nothing');
    });

    test('extractGithubRunId: digits after /runs/, nothing otherwise', function () {
        var gh = load();
        assert.equal(gh.extractGithubRunId({ details_url: 'https://x/actions/runs/123456' }), '123456');
        assert.equal(gh.extractGithubRunId({ details_url: 'https://x/actions/runs/555/job/77' }), '555');
        assert.equal(gh.extractGithubRunId({ details_url: 'https://x/pull/1' }), null);
        assert.equal(gh.extractGithubRunId({ details_url: null }), null);
        assert.equal(gh.extractGithubRunId({}), null);
    });

    test('fetchWorkflowRunJobs: scm provider preferred, gh tool as fallback', function () {
        var gh = load();
        var calls = [];
        var scm = { getWorkflowRunJobs: function (id) { calls.push(id); return { jobs: [] }; } };
        gh.fetchWorkflowRunJobs(scm, 'o', 'r', '42');
        assert.deepEqual(calls, ['42']);
        var tools = { github_get_workflow_run_jobs: function (p) { calls.push(p); return { jobs: [] }; } };
        var gh2 = loadGithubHelpers(tools);
        gh2.fetchWorkflowRunJobs(null, 'o', 'r', '43');
        assert.deepEqual(calls, ['42', { workspace: 'o', repository: 'r', runId: '43' }]);
        var gh3 = loadGithubHelpers({});
        assert.throws(function () { gh3.fetchWorkflowRunJobs(null, 'o', 'r', '44'); }, /github_get_workflow_run_jobs/, 'no provider at all is a loud failure');
    });

    test('formatFailedRunJobLogs: concatenates failed-job sections, null when none', function () {
        var gh = load();
        var scm = { getJobLogs: function (id) { return 'L' + id; } };
        var out = gh.formatFailedRunJobLogs(scm, 'o', 'r', { jobs: [
            { id: 1, name: 'a', conclusion: 'failure' },
            { id: 2, name: 'b', conclusion: 'failure' }
        ] });
        assert.equal(out, '=== a ===\nL1\n=== b ===\nL2\n');
        assert.equal(gh.formatFailedRunJobLogs(scm, 'o', 'r', { jobs: [{ id: 3, name: 'c', conclusion: 'success' }] }), null);
    });

    test('null paths: no url match, no failed jobs, provider throw', function () {
        var gh = load();
        assert.equal(gh.fetchGithubRunLogs({ details_url: 'https://x/pull/1' }, null, 'o', 'r'), null);
        var empty = { getWorkflowRunJobs: function () { return { jobs: [{ id: 1, conclusion: 'success' }] }; } };
        assert.equal(gh.fetchGithubRunLogs({ details_url: 'https://x/actions/runs/9' }, empty, 'o', 'r'), null);
        var boom = { getWorkflowRunJobs: function () { throw new Error('net'); } };
        assert.equal(gh.fetchGithubRunLogs({ details_url: 'https://x/actions/runs/9' }, boom, 'o', 'r'), null, 'fail-open');
        assert.equal(gh.fetchGithubCheckLogs({ details_url: null }, null, 'o', 'r'), null);
    });
});

suite('githubHelpers.detectFailedChecks — gh-1045 bare check-run URLs + loud fetch failures', function() {

    function makeGh(mocks) {
        return loadGithubHelpers(mocks || {});
    }

    function findWrite(writes, path) {
        for (var i = 0; i < writes.length; i++) {
            if (writes[i].path === path) return writes[i];
        }
        return null;
    }

    test('extractGithubCheckRunId: bare runs/N yields the check-run id, actions/runs/N does not', function() {
        var gh = makeGh();
        assert.equal(gh.extractGithubCheckRunId({ details_url: 'https://github.com/acme/widgets/runs/117677625675' }), '117677625675');
        assert.equal(gh.extractGithubCheckRunId({ details_url: 'https://github.com/acme/widgets/actions/runs/117677625675' }), null,
            'an actions-run URL must stay on the workflow-run path');
        assert.equal(gh.extractGithubCheckRunId({ details_url: 'https://github.com/acme/widgets/actions/runs/1/job/2' }), null);
        assert.equal(gh.extractGithubCheckRunId({ details_url: 'https://x/pull/1' }), null);
        assert.equal(gh.extractGithubCheckRunId({ details_url: null }), null);
        assert.equal(gh.extractGithubCheckRunId({}), null);
    });

    test('bare check-run URL resolves its log via the check-run id (scm mode, no run-jobs lookup)', function() {
        var gh = makeGh();
        var calls = [];
        var scm = {
            getJobLogs: function(id) { calls.push('logs:' + id); return 'CHECK-RUN-LOG-' + id; },
            getWorkflowRunJobs: function() { throw new Error('must not treat a check-run id as a workflow-run id'); }
        };
        var out = gh.fetchGithubCheckLogs({ name: 'gate/static', details_url: 'https://github.com/acme/widgets/runs/117677625675' }, scm, 'acme', 'widgets');
        assert.equal(out, 'CHECK-RUN-LOG-117677625675');
        assert.deepEqual(calls, ['logs:117677625675'], 'exactly one job-log fetch with the check-run id');
    });

    test('mixed URL shapes replay (#423 head): job logs fetched, bare check-runs resolved, failures marked', function() {
        var writes = [];
        var jobLogCalls = [];
        var runJobsCalls = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [
                        { name: 'test (0)', conclusion: 'failure',
                          details_url: 'https://github.com/acme/widgets/actions/runs/39127338030/job/117677126855' },
                        { name: 'gate/static', conclusion: 'failure',
                          details_url: 'https://github.com/acme/widgets/runs/117677625675' },
                        { name: 'agents-gate', conclusion: 'failure',
                          details_url: 'https://github.com/acme/widgets/runs/117677625999' }
                    ]
                };
            },
            github_get_job_logs: function(args) {
                jobLogCalls.push(args.jobId);
                if (args.jobId === '117677625999') { throw new Error('check-run gone'); }
                return 'LOG-FOR-' + args.jobId;
            },
            github_get_workflow_run_jobs: function(args) {
                runJobsCalls.push(args);
                throw new Error('check-run ids must never reach the workflow-run API');
            },
            file_write: function(args) { writes.push(args); }
        });

        var failed = gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 3, 'all failed checks are still reported');
        assert.equal(runJobsCalls.length, 0, 'no workflow-run-jobs call for bare check-run URLs');
        assert.ok(jobLogCalls.indexOf('117677126855') !== -1, 'actions job URL resolved via its job id');
        assert.ok(jobLogCalls.indexOf('117677625675') !== -1, 'bare check-run URL resolved via the check-run id');

        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'ci_failures_full.log must be written even with mixed/unresolvable shapes');
        assert.contains(fullLogWrite.content, 'LOG-FOR-117677126855', 'actions-job check log present');
        assert.contains(fullLogWrite.content, 'LOG-FOR-117677625675', 'bare check-run check log present');
        assert.contains(fullLogWrite.content, 'LOG FETCH FAILED for: agents-gate', 'per-check fetch diagnostics for the rest');
        assert.contains(fullLogWrite.content, 'Reason: orphan check-run (no job logs; mirrored verdict)'); assert.contains(fullLogWrite.content, '[check-run log fetch failed: check-run gone]');

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'ci_failures.md written');
        assert.contains(mdWrite.content, '[check-run log fetch failed: check-run gone]',
            'per-check failure is loud in ci_failures.md');
        assert.contains(mdWrite.content, 'ci_failures_full.log', 'md references the full log that WAS written');
    });

    test('fetch failure of one check does not drop the other checks\' logs', function() {
        var writes = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [
                        { name: 'broken-check', conclusion: 'failure',
                          details_url: 'https://github.com/acme/widgets/runs/1' },
                        { name: 'healthy-check', conclusion: 'failure',
                          details_url: 'https://github.com/acme/widgets/actions/runs/9/job/77' }
                    ]
                };
            },
            github_get_job_logs: function(args) {
                if (args.jobId === '1') { throw new Error('boom'); }
                return 'healthy log content';
            },
            file_write: function(args) { writes.push(args); }
        });

        gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'full log written');
        assert.contains(fullLogWrite.content, 'healthy log content', 'resolvable check log survives another check\'s failure');
        assert.contains(fullLogWrite.content, 'LOG FETCH FAILED for: broken-check');
        assert.contains(fullLogWrite.content, '[check-run log fetch failed: boom]');

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite);
        assert.contains(mdWrite.content, 'healthy log content');
        assert.contains(mdWrite.content, 'log fetch failed: orphan check-run'); assert.contains(mdWrite.content, '[check-run log fetch failed: boom]');
    });

    test('ci_failures.md never references ci_failures_full.log when the full-log write failed (AC2)', function() {
        var writes = [];
        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'Build', conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/actions/runs/9/job/77'
                    }]
                };
            },
            github_get_job_logs: function() { return 'some log'; },
            file_write: function(args) {
                if (args.path.indexOf('ci_failures_full.log') !== -1) { throw new Error('disk full'); }
                writes.push(args);
            }
        });

        var failed = gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1, 'check still reported');
        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'ci_failures.md still written');
        assert.notContains(mdWrite.content, 'ci_failures_full.log',
            'must not advertise a file that was not written');
    });

    test('scm mode resolves bare check-run URLs via scm.getJobLogs', function() {
        var writes = [];
        var calls = [];
        var scm = {
            listPrs: function() { return []; },
            getCommitCheckRuns: function() {
                return {
                    check_runs: [{
                        name: 'agents-gate', conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/runs/117677625675'
                    }]
                };
            },
            getJobLogs: function(id) { calls.push(id); return 'scm check-run log'; }
        };

        var gh = makeGh({
            github_get_job_logs: function() { throw new Error('github_get_job_logs must not be called in SCM mode'); },
            file_write: function(args) { writes.push(args); }
        });

        var failed = gh.detectFailedChecks(scm, 'abc123def', '/tmp/input');

        assert.equal(failed.length, 1);
        assert.deepEqual(calls, ['117677625675']);
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'full log written');
        assert.contains(fullLogWrite.content, 'scm check-run log');
    });

    test('an empty job log for a /jobs/{id} URL is loud, not silent', function() {
        var writes = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'empty-job', conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/actions/runs/9/job/77'
                    }]
                };
            },
            github_get_job_logs: function() { return ''; },
            file_write: function(args) { writes.push(args); }
        });

        gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite);
        assert.contains(mdWrite.content, 'log fetch failed: job log for 77 came back empty');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'full log written');
        assert.contains(fullLogWrite.content, 'Reason: job log for 77 came back empty');
    });

    test('an empty check-run log for a bare /runs/{id} URL is loud, not silent', function() {
        var writes = [];

        var gh = makeGh({
            github_get_commit_check_runs: function() {
                return {
                    check_runs: [{
                        name: 'empty-check-run', conclusion: 'failure',
                        details_url: 'https://github.com/acme/widgets/runs/4242'
                    }]
                };
            },
            github_get_job_logs: function() { return ''; },
            file_write: function(args) { writes.push(args); }
        });

        gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input');

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite);
        assert.contains(mdWrite.content, '[check-run 4242 log came back empty');
        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'full log written');
        assert.contains(fullLogWrite.content, '[check-run 4242 log came back empty');
    });

    test('empty-log branches of the resolvers return loud reasons (direct)', function() {
        var gh = makeGh({
            github_get_job_logs: function() { return ''; }
        });

        var jobResult = gh.fetchGithubCheckLogsDetailed(
            { name: 'j', details_url: 'https://github.com/acme/widgets/actions/runs/9/job/77' },
            null, 'acme', 'widgets');
        assert.deepEqual(jobResult, { reason: 'job log for 77 came back empty' },
            '/jobs/{id} empty log pins the loud contract');

        var checkRunResult = gh.fetchGithubCheckLogsDetailed(
            { name: 'c', details_url: 'https://github.com/acme/widgets/runs/4242' },
            null, 'acme', 'widgets');
        assert.deepEqual(checkRunResult,
            { reason: 'check-run 4242 log came back empty (check run is not backed by a GitHub Actions job?)' },
            'bare /runs/{id} empty log pins the loud contract');
    });
});

suite('githubHelpers.detectFailedChecks — orphan/placeholder check-runs (dart #432)', function() {

    function findWrite(writes, path) {
        return writes.filter(function(w) { return w.path === path; })[0] || null;
    }

    function orphanMocks(writes, checkRuns, extra) {
        var m = {
            github_get_commit_check_runs: function() { return { check_runs: checkRuns }; },
            github_get_job_logs: function(args) {
                if (args.jobId === '118070885373') throw new Error('HTTP 404 {"message":"Not Found"}');
                return 'REAL-LOG-' + args.jobId;
            },
            github_list_workflow_runs: function() {
                return { workflow_runs: [
                    { id: 39254074760, head_sha: 'other', html_url: 'https://x/actions/runs/39254074760' },
                    { id: 39254356497, head_sha: '0d76ffe9abc', html_url: 'https://x/actions/runs/39254356497' }
                ] };
            },
            github_get_workflow_run_jobs: function(args) {
                assert.equal(args.runId, '39254356497', 'only runs on the head are scanned');
                return { jobs: [
                    { id: 118066596584, name: 'test (1)', conclusion: 'failure' },
                    { id: 118070072955, name: 'gate', conclusion: 'failure' }
                ] };
            },
            file_write: function(args) { writes.push(args); }
        };
        Object.keys(extra || {}).forEach(function(k) { m[k] = extra[k]; });
        return m;
    }

    test('orphan 404 falls back to the same-named failed job logs of the CI run on the head', function() {
        var writes = [];
        var gh = loadGithubHelpers(orphanMocks(writes, [
            { name: 'gate', conclusion: 'failure', details_url: 'https://github.com/o/r/runs/118070885373' }
        ]));
        var failed = gh.detectFailedChecks('o', 'r', '0d76ffe9abc', '/tmp/in');
        assert.equal(failed.length, 1);
        var full = findWrite(writes, '/tmp/in/ci_failures_full.log').content;
        assert.contains(full, 'REAL-LOG-118070072955', 'real gate job logs used');
        assert.contains(full, 'orphan check-run', 'fallback provenance noted');
        assert.notContains(full, 'LOG FETCH FAILED', 'no 404 section');
    });

    test('orphan is deduped into a same-named failed check that has real logs', function() {
        var writes = [];
        var gh = loadGithubHelpers(orphanMocks(writes, [
            { name: 'gate', conclusion: 'failure', details_url: 'https://github.com/o/r/runs/118070885373' },
            { name: 'gate', conclusion: 'failure', details_url: 'https://github.com/o/r/actions/runs/39254356497/job/118070072955' }
        ], { github_get_workflow_run_jobs: function() { throw new Error('no fallback needed'); } }));
        var failed = gh.detectFailedChecks('o', 'r', '0d76ffe9abc', '/tmp/in');
        assert.equal(failed.length, 1, 'one gate entry');
        var md = findWrite(writes, '/tmp/in/ci_failures.md').content;
        assert.contains(md, '1 check(s) failed');
        assert.notContains(md, '118070885373', 'orphan section dropped');
        assert.notContains(md, 'log fetch failed');
    });

    test('orphan with no same-named job on the head gets a clear orphan reason', function() {
        var writes = [];
        var gh = loadGithubHelpers(orphanMocks(writes, [
            { name: 'agents-gate', conclusion: 'failure', details_url: 'https://github.com/o/r/runs/118070885373' }
        ]));
        gh.detectFailedChecks('o', 'r', '0d76ffe9abc', '/tmp/in');
        var md = findWrite(writes, '/tmp/in/ci_failures.md').content;
        assert.contains(md, 'orphan check-run (no job logs; mirrored verdict) — see run https://github.com/o/r/runs/118070885373');
    });
});

suite('githubHelpers.fetchDiscussionsAndRawData — dmtools: machine markers (naked-pr-rearm)', function() {
    test('naked-pr-rearm notice is not an open thread nor a general comment', function() {
        var body = '<!-- dmtools:naked-pr-rearm {"pr":432,"issue":1,"label":"x","head":"abc"} -->\n🩹 **Naked-PR reconciliation (gh-1097)**: re-armed';
        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return [{ rootComment: { id: 9, body: body, user: { login: 'ai-teammate' } }, replies: [] }]; },
            github_get_pr_review_threads: function() { return null; },
            github_get_pr_comments: function() { return [{ body: body, user: { login: 'ai-teammate' }, created_at: '2026-10-19' }]; }
        });
        var res = gh.fetchDiscussionsAndRawData('o', 'r', '432');
        var open = ((res.rawThreads && res.rawThreads.threads) || []).filter(function(t) { return !t.resolved; });
        assert.equal(open.length, 0, 'no open thread from the rearm notice');
        assert.ok(!res.markdown || res.markdown.indexOf('Naked-PR reconciliation') === -1, 'not in pr_discussions.md');
    });
});

suite('githubHelpers.runsOfPayload — payload shapes (orphan fallback)', function() {
    var h = loadGithubHelpers();
    test('array payload is returned as-is', function() {
        assert.equal(h._runsOfPayload([{ id: 1 }]).length, 1);
    });
    test('workflow_runs and workflowRuns objects', function() {
        assert.equal(h._runsOfPayload({ workflow_runs: [{ id: 1 }, { id: 2 }] }).length, 2);
        assert.equal(h._runsOfPayload({ workflowRuns: [{ id: 3 }] })[0].id, 3);
    });
    test('JSON string payloads (plain and tool-result wrapped)', function() {
        assert.equal(h._runsOfPayload(JSON.stringify({ workflow_runs: [{ id: 4 }] }))[0].id, 4);
        assert.equal(h._runsOfPayload(JSON.stringify({ result: [{ id: 5 }] }))[0].id, 5);
        assert.equal(h._runsOfPayload(JSON.stringify({ result: JSON.stringify([{ id: 6 }]) }))[0].id, 6);
    });
    test('garbage, null and runless objects yield []', function() {
        assert.equal(h._runsOfPayload('not json').length, 0);
        assert.equal(h._runsOfPayload(JSON.stringify({ result: 'nope{' })).length, 0);
        assert.equal(h._runsOfPayload(null).length, 0);
        assert.equal(h._runsOfPayload({ other: 1 }).length, 0);
    });
});

// ── gh-1119: gate-violation extraction wired into detectFailedChecks ────────

suite('githubHelpers.detectFailedChecks — owned/foreign violations block (gh-1119)', function() {

    function findWrite(writes, path) {
        for (var i = 0; i < writes.length; i++) {
            if (writes[i].path === path) return writes[i];
        }
        return null;
    }

    function make433Gh(writes) {
        var gateLog = file_read({ path: 'js/unit-tests/fixtures/ci_logs/gate_crap4dart.log' });
        var agentsGateLog = file_read({ path: 'js/unit-tests/fixtures/ci_logs/agents_gate.log' });
        return loadGithubHelpers({
            github_get_commit_check_runs: function() {
                return { check_runs: [
                    { name: 'gate', conclusion: 'failure', details_url: 'https://github.com/acme/widgets/actions/runs/1/job/111' },
                    { name: 'agents-gate', conclusion: 'failure', details_url: 'https://github.com/acme/widgets/actions/runs/1/job/222' }
                ]};
            },
            github_get_job_logs: function(args) {
                return String(args.jobId) === '111' ? gateLog : agentsGateLog;
            },
            file_write: function(args) { writes.push(args); }
        });
    }

    test('IT-1/AC7 (replay #433): the owned violation row opens ci_failures.md above the raw tails', function() {
        var writes = [];
        var gh = make433Gh(writes);
        var diff = file_read({ path: 'js/unit-tests/fixtures/ci_logs/diff_pr_433.txt' });

        var failed = gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input', null, diff);

        assert.equal(failed.length, 2, 'both failed checks reported as before');
        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'ci_failures.md written');
        var md = mdWrite.content;
        var ownedIdx = md.indexOf('Violations you must fix (1 owned)');
        var foreignIdx = md.indexOf('Foreign / infra reds (do not chase)');
        var tailsIdx = md.indexOf('## ❌ gate');
        assert.ok(ownedIdx !== -1, 'owned table present');
        assert.ok(foreignIdx > ownedIdx, 'owned table BEFORE the foreign list');
        assert.ok(tailsIdx > ownedIdx, 'raw 500-line tails stay BELOW the violations block (I1)');
        assert.contains(md, '`test/js/require_base_resolution_test.dart:13`');
        assert.contains(md, 'main has 100 lines > max 60');
        assert.contains(md, 'js/unit-tests/test_recoverDirtyReviewTestCase.js');

        var jsonWrite = findWrite(writes, '/tmp/input/ci_violations.json');
        assert.ok(jsonWrite, 'ci_violations.json written');
        var summary = JSON.parse(jsonWrite.content);
        assert.equal(summary.owned, 1);
        assert.equal(summary.foreign, 1);
        assert.equal(summary.violations.length, 2);

        var fullLogWrite = findWrite(writes, '/tmp/input/ci_failures_full.log');
        assert.ok(fullLogWrite, 'I1: the full log is still written');
        assert.contains(fullLogWrite.content, 'main has 100 lines > max 60');
    });

    test('AC5/REG-1: an unrecognized log shape keeps today\u2019s file — no table, no ci_violations.json', function() {
        var writes = [];
        var unknownLog = file_read({ path: 'js/unit-tests/fixtures/ci_logs/unknown_shape.log' });
        var gh = loadGithubHelpers({
            github_get_commit_check_runs: function() {
                return { check_runs: [
                    { name: 'gate', conclusion: 'failure', details_url: 'https://github.com/acme/widgets/actions/runs/1/job/333' }
                ]};
            },
            github_get_job_logs: function() { return unknownLog; },
            file_write: function(args) { writes.push(args); }
        });

        gh.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input', null,
            'diff --git a/src/a.dart b/src/a.dart\n');

        var mdWrite = findWrite(writes, '/tmp/input/ci_failures.md');
        assert.ok(mdWrite, 'ci_failures.md still written');
        assert.notContains(mdWrite.content, 'Violations you must fix');
        assert.notContains(mdWrite.content, 'Foreign / infra reds');
        assert.contains(mdWrite.content, '## ❌ gate', 'the raw per-check section is intact');
        assert.notOk(findWrite(writes, '/tmp/input/ci_violations.json'), 'no ci_violations.json for zero violations');
        assert.ok(findWrite(writes, '/tmp/input/ci_failures_full.log'), 'full log still written');
    });

    test('a violations json write failure is non-fatal (the md still carries the table)', function() {
        var writes = [];
        var gateLog = file_read({ path: 'js/unit-tests/fixtures/ci_logs/gate_crap4dart.log' });
        var diff = file_read({ path: 'js/unit-tests/fixtures/ci_logs/diff_pr_433.txt' });
        var ghFailing = loadGithubHelpers({
            github_get_commit_check_runs: function() {
                return { check_runs: [
                    { name: 'gate', conclusion: 'failure', details_url: 'https://github.com/acme/widgets/actions/runs/1/job/111' }
                ]};
            },
            github_get_job_logs: function() { return gateLog; },
            file_write: function(args) {
                if (args.path && args.path.indexOf('ci_violations.json') !== -1) {
                    throw new Error('disk full');
                }
                writes.push(args);
            }
        });

        var failed = ghFailing.detectFailedChecks('acme', 'widgets', 'abc123def', '/tmp/input', null, diff);
        assert.equal(failed.length, 1);
        assert.ok(findWrite(writes, '/tmp/input/ci_failures.md'), 'md written despite the json failure');
        assert.notOk(findWrite(writes, '/tmp/input/ci_violations.json'));
        assert.contains(findWrite(writes, '/tmp/input/ci_failures.md').content, 'Violations you must fix');
    });

    test('buildLogSections carries the raw logs for the extractor (additive)', function() {
        var gh = loadGithubHelpers({});
        var sections = gh.buildLogSections({ name: 'gate', details_url: 'u' }, 'a\nb\n', 'Error log');
        assert.equal(sections.logs, 'a\nb\n');
        assert.equal(gh.buildLogSections({ name: 'g' }, null, 'Error log'), null);
    });
});

// ── fetchDiscussionsAndRawData — scm delegation + general comments (gh-1086) ──

suite('githubHelpers.fetchDiscussionsAndRawData — SCM delegation', function() {
    test('SCM-object first argument delegates to provider.fetchDiscussions', function() {
        var fetched = [];
        var scm = {
            listPrs: function() { return []; },
            fetchDiscussions: function(prId) {
                fetched.push(prId);
                return { markdown: 'MD', rawThreads: { threads: [] } };
            }
        };
        var gh = loadGithubHelpers({});
        var result = gh.fetchDiscussionsAndRawData(scm, 'PR-42');
        assert.equal(fetched.length, 1);
        assert.equal(fetched[0], 'PR-42');
        assert.equal(result.markdown, 'MD');
        assert.deepEqual(result.rawThreads, { threads: [] });
    });
});

suite('githubHelpers.fetchDiscussionsAndRawData — general PR comments section', function() {

    function ghWith(comments, overrides) {
        var mocks = {
            github_get_pr_conversations: function() { return []; },
            github_get_pr_review_threads: function() { return null; },
            github_get_pr_comments: function() { return comments; }
        };
        if (overrides) {
            for (var k in overrides) mocks[k] = overrides[k];
        }
        return loadGithubHelpers(mocks);
    }

    test('no conversations, threads or comments → null markdown and null rawThreads', function() {
        var gh = ghWith([]);
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '7');
        assert.equal(result.markdown, null);
        assert.equal(result.rawThreads, null);
    });

    test('general comments render with author, date and separator', function() {
        var gh = ghWith([
            { user: { login: 'alice' }, created_at: '2026-03-26T10:00:00Z', body: 'first note' },
            { user: { login: 'bob' }, created_at: '2026-03-27T09:00:00Z', body: 'second note' }
        ]);
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '7');
        assert.ok(result.markdown, 'markdown built');
        assert.contains(result.markdown, '# PR Discussion History');
        assert.contains(result.markdown, '_Previous review discussions for PR #7._');
        assert.contains(result.markdown, '## General PR Comments');
        assert.contains(result.markdown, '**alice** (2026-03-26):');
        assert.contains(result.markdown, '**bob** (2026-03-27):');
        assert.contains(result.markdown, 'first note');
        assert.contains(result.markdown, 'second note');
        assert.contains(result.markdown, '---');
        assert.equal(result.rawThreads, null);
    });

    test('dmtools: marker comments are excluded from the general section', function() {
        var marker = '<!-- dmtools:naked-pr-rearm {"pr":7} --> rearm';
        var gh = ghWith([
            { user: { login: 'bot' }, created_at: '2026-03-26T10:00:00Z', body: marker },
            { user: { login: 'human' }, created_at: '2026-03-26T11:00:00Z', body: 'real feedback' }
        ]);
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '7');
        assert.notContains(result.markdown, 'naked-pr-rearm');
        assert.contains(result.markdown, 'real feedback');
    });

    test('missing author and created_at fall back to unknown/empty', function() {
        var gh = ghWith([{ body: 'anon note' }]);
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '7');
        assert.contains(result.markdown, '**unknown** ():');
        assert.contains(result.markdown, 'anon note');
    });

    test('comment body whitespace is trimmed', function() {
        var gh = ghWith([{ user: { login: 'a' }, created_at: '2026-01-01T00:00:00Z', body: '   padded   \n' }]);
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '7');
        assert.ok(result.markdown.indexOf('padded') !== -1);
        assert.ok(result.markdown.indexOf('   padded   ') === -1, 'raw padding must be trimmed');
    });

    test('comments fetch failure still yields no markdown when nothing else exists', function() {
        var gh = ghWith(null, {
            github_get_pr_comments: function() { throw new Error('comments down'); }
        });
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '7');
        assert.equal(result.markdown, null);
        assert.equal(result.rawThreads, null);
    });

    test('comments alone produce the markdown header wrapper', function() {
        var gh = ghWith([{ user: { login: 'a' }, created_at: '2026-01-01', body: 'x' }]);
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '99');
        assert.ok(result.markdown.indexOf('# PR Discussion History') === 0, 'header first');
        assert.ok(result.markdown.indexOf('_Previous review discussions for PR #99._') !== -1);
    });

    test('inventory with open threads but no general comments keeps raw census', function() {
        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() {
                return [makeConversation({ id: 11, body: 'open thread', isResolved: false })];
            },
            github_get_pr_review_threads: function() {
                return makeGraphQLResponse([makeGraphQLThread({ dbId: 11, graphqlId: 'PRRT_11', isResolved: false })]);
            },
            github_get_pr_comments: function() { return []; }
        });
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '11');
        assert.ok(result.markdown, 'inventory section present');
        assert.ok(result.rawThreads, 'rawThreads present');
        assert.equal(result.rawThreads.threads.length, 1);
        assert.ok(result.rawThreads.census, 'census propagated');
        assert.equal(result.rawThreads.threads[0].rootCommentId, 11);
    });

    test('conversations and GraphQL both failing yields empty result', function() {
        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { throw new Error('conversations down'); },
            github_get_pr_review_threads: function() { throw new Error('graphql down'); },
            github_get_pr_comments: function() { return []; }
        });
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '3');
        assert.equal(result.markdown, null);
        assert.equal(result.rawThreads, null);
    });
});

suite('githubHelpers.fetchDiscussionsAndRawData — inventory build failure', function() {
    test('inventory build failure falls back to no inventory section (census dropped)', function() {
        var machineNoticeModule = loadModule('js/common/machineNotice.js');
        var brokenInventory = {
            collectThreadInventory: function() { throw new Error('inventory exploded'); },
            parseGraphQLNodes: function() { return []; }
        };
        var gh = loadModule(
            'js/common/githubHelpers.js',
            makeRequire({
                '../config.js': configModule,
                'config': configModule,
                './pullRequest.js': PR_HELPER_REAL_GH,
                './gitOps.js': gitOpsStub,
                './machineNotice.js': machineNoticeModule,
                './reviewThreadInventory.js': brokenInventory,
                './ci.js': loadModule('js/common/ci.js'),
                './ciViolations.js': loadModule('js/common/ciViolations.js')
            }),
            {
                github_get_pr_conversations: function() { return [makeConversation({ id: 1, body: 'b' })]; },
                github_get_pr_review_threads: function() { return makeGraphQLResponse([]); },
                github_get_pr_comments: function() { return [{ user: { login: 'a' }, created_at: '2026-01-01', body: 'note' }]; }
            }
        );
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '5');
        // inventory section dropped, general comments still render
        assert.ok(result.markdown, 'markdown from general comments only');
        assert.notContains(result.markdown, 'PR Review Threads');
        assert.contains(result.markdown, '## General PR Comments');
        assert.equal(result.rawThreads, null, 'no inventory → no rawThreads payload');
    });

    test('fetchPrConversations passes non-array payloads through to the inventory', function() {
        var seen = [];
        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return 5; },
            github_get_pr_review_threads: function() { return null; },
            github_get_pr_comments: function() { return []; }
        });
        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '5');
        seen.push(result);
        assert.equal(result.markdown, null);
        assert.equal(result.rawThreads, null);
    });
});
