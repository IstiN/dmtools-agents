/**
 * Unit tests: smProvider.js — the forge-agnostic I/O layer of the machine
 * watchdog. GitHub maps to github_* tools (gh CLI only for update-branch),
 * GitLab maps to gitlab_* tools natively. Both must satisfy the same
 * contract the decision core consumes.
 */
/* global loadModule, assert, test, suite, makeRequire */

// gh-823: smProvider requires ./reviewVerdicts.js at LOAD TIME — every
// loadModule of it must provide the module in its require map.
var rvReal = function () {
    if (!rvReal.mod) rvReal.mod = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});
    return rvReal.mod;
};
// gh-1106: smProvider requires ./validationLiveness.js at LOAD TIME —
// every loadModule of it must provide the module in its require map.
var vlReal = function () {
    if (!vlReal.mod) vlReal.mod = loadModule('js/common/validationLiveness.js', makeRequire({}), {});
    return vlReal.mod;
};

suite('smProvider', function () {

    var MOD = 'js/common/smProvider.js';

    function loadProvider(provider, mocks) {
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, mocks || {}), mocks || {});
        return mod.createSmProvider({
            scm: { provider: provider },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
    }

    // ── shared contract ──────────────────────────────────────────────────────

    test('unknown provider is rejected loudly', function () {
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {});
        var threw = false;
        try {
            mod.createSmProvider({ scm: { provider: 'bitbucket' },
                repository: { owner: 'a', repo: 'b' } });
        } catch (e) { threw = true; }
        assert.equal(threw, true);
    });

    test('missing repository is rejected loudly', function () {
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {});
        var threw = false;
        try { mod.createSmProvider({ scm: { provider: 'github' } }); }
        catch (e) { threw = true; }
        assert.equal(threw, true);
    });

    // ── github provider ──────────────────────────────────────────────────────

    test('github: listMachineIssues ORs per-label searches, dedupes, adds assignee matches', function () {
        var queries = [];
        var p = loadProvider('github', {
            github_search_issues: function (args) {
                queries.push(args.query);
                if (args.query.indexOf('assignee:') !== -1) {
                    return { items: [{ number: 6, title: 'A', labels: [], assignees: [{ login: 'ai-teammate' }] }] };
                }
                if (args.query.indexOf('agent:dev') !== -1) {
                    return { items: [{ number: 5, title: 'T', labels: [{ name: 'agent:dev' }], assignees: [] }] };
                }
                return { items: [] };
            }
        });
        var issues = p.listMachineIssues(['agent:dev', 'agent:rework'], 'ai-teammate', 50);
        assert.equal(issues.length, 2);          // one per label + one assignee, no dupes
        assert.equal(issues[0].number, 5);
        assert.equal(issues[1].number, 6);
        assert.equal(issues[1].assignees[0], 'ai-teammate');
        // per-label queries (OR semantics — GitHub ANDs multi-label queries)
        assert.equal(queries.some(function (q) { return q.indexOf('label:"agent:dev"') !== -1; }), true);
        assert.equal(queries.some(function (q) { return q.indexOf('label:"agent:rework"') !== -1; }), true);
    });

    test('github: prStatus rolls up red/pending/green', function () {
        var rollup;
        var p = loadProvider('github', {
            github_get_pr: function () {
                return { state: 'OPEN', mergeable: true, mergeStateStatus: 'CLEAN',
                         statusCheckRollup: rollup };
            }
        });
        // Per-tick prStatus memo: the cache key is the PR number, so each
        // rollup variant pins a DISTINCT number (same-number repeats return
        // the memoized result — pinned by the memo test below).
        rollup = [{ conclusion: 'FAILURE' }];
        assert.equal(p.prStatus(7).checkConclusion, 'red');
        rollup = [{ status: 'IN_PROGRESS' }];
        assert.equal(p.prStatus(8).checkConclusion, 'pending');
        rollup = [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }];
        var st = p.prStatus(9);
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.mergeState, 'CLEAN');
        assert.equal(st.mergeable, true);
    });

    test('github: prStatus ignores bookkeeping checks — kicker-green born heads stay pending (#628)', function () {
        var rollup;
        var p = loadProvider('github', {
            github_get_pr: function () {
                return { state: 'OPEN', mergeable: true, mergeStateStatus: 'CLEAN',
                         statusCheckRollup: rollup };
            }
        });
        // Live shape (dart #332): timer auto-commit pushed the branch before
        // the PR existed, sm-kicker + the wake-up probe stamped green on the
        // sha — naive fold says 'green', the validation lane (none|pending)
        // never fires, and the PR dead-zones with no rule matching.
        rollup = [{ name: 'kicker / head-completeness', conclusion: 'SUCCESS' },
                  { name: 'kicker / sm-liveness', conclusion: 'SUCCESS' },
                  { name: 'Wake-up probe (bitrise-runner-dmtools-ci)', conclusion: 'SUCCESS' }];
        assert.equal(p.prStatus(21).checkConclusion, 'pending');
        // Bookkeeping must not mask a real verdict either way:
        rollup = [{ name: 'kicker / sm-liveness', conclusion: 'SUCCESS' },
                  { name: 'Quality gate', conclusion: 'FAILURE' }];
        assert.equal(p.prStatus(22).checkConclusion, 'red');
        rollup = [{ name: 'kicker / sm-liveness', conclusion: 'SUCCESS' },
                  { name: 'Quality gate', conclusion: 'SUCCESS' }];
        assert.equal(p.prStatus(23).checkConclusion, 'green');
        // StatusContext items carry `context`, not `name`:
        rollup = [{ context: 'kicker / sm-liveness', conclusion: 'SUCCESS' }];
        assert.equal(p.prStatus(24).checkConclusion, 'pending');
        // dmtools-agents#635 (live fa pr-1174): the Machine Merge Bot's OWN
        // check on the head must not shadow the verdict — queued/running
        // 'merge / merge' next to green is still GREEN (the bot waited on
        // itself and merge-validated never matched), and bookkeeping-only
        // heads stay pending.
        rollup = [{ name: 'merge / merge', status: 'QUEUED', conclusion: null },
                  { name: 'Quality gate', conclusion: 'SUCCESS' },
                  { name: 'JS engine integration (quickjs-ng)', conclusion: 'SUCCESS' },
                  { name: 'Binaries smoke gate', conclusion: 'SUCCESS' }];
        assert.equal(p.prStatus(25).checkConclusion, 'green',
            'queued merge-lane check never demotes a green validation rollup');
        rollup = [{ name: 'merge / merge', conclusion: 'SUCCESS' }];
        assert.equal(p.prStatus(26).checkConclusion, 'pending',
            'merge-lane bookkeeping alone is still no verdict');
    });

    test('github: prStatus uses pullRequestId + REST check-runs rollup (live shape)', function () {
        // Live bug: `number` hit /pulls/null (404) and statusCheckRollup is
        // GraphQL-only — guards saw UNKNOWN/none forever. The REST path is
        // github_get_pr(pullRequestId) + github_get_commit_check_runs(head.sha).
        var prBody, checkBody;
        var p = loadProvider('github', {
            github_get_pr: function (args) {
                prBody.args = args;
                return prBody;
            },
            github_get_commit_check_runs: function (args) {
                checkBody.args = args;
                return checkBody;
            }
        });
        prBody = { state: 'OPEN', mergeable: true, mergeable_state: 'behind',
                   head: { sha: 'abc123' } };
        checkBody = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] };
        var st = p.prStatus(7);
        assert.equal(prBody.args.pullRequestId, 7);
        assert.equal(prBody.args.number, undefined);
        assert.equal(checkBody.args.commitSha, 'abc123');
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.mergeState, 'BEHIND');

        // distinct numbers per variant — the prStatus memo is keyed by number
        checkBody = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'failure' }] };
        assert.equal(p.prStatus(8).checkConclusion, 'red');

        checkBody = { total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] };
        assert.equal(p.prStatus(9).checkConclusion, 'pending');

        // check-runs API shape: sha field name on head is `sha`.
        prBody = { state: 'OPEN', mergeable: true, head: { sha: 'zzz' } };
        checkBody = { total_count: 0, check_runs: [] };
        assert.equal(p.prStatus(10).checkConclusion, 'none');
    });

    test('github: prStatus normalizes REST lowercase state to OPEN', function () {
        // Live bug (flutter_agent_harness): the REST body reports
        // `state: 'open'` (lowercase) while issue-anchored guards compare
        // against 'OPEN' — develop-done evaluated its candidates, then
        // rejected every one ('open' !== 'OPEN') and printed
        // "No tickets found" for genuinely green PRs.
        var prBody = { state: 'open', mergeable: true, mergeable_state: 'clean',
                       head: { sha: 'abc123' } };
        var p = loadProvider('github', {
            github_get_pr: function () { return prBody; },
            github_get_commit_check_runs: function () {
                return { check_runs: [{ status: 'completed', conclusion: 'success' }] };
            }
        });
        var st = p.prStatus(7);
        assert.equal(st.state, 'OPEN');
        assert.equal(st.checkConclusion, 'green');
        // head sha pins the stale-verdict comparison (reviewStale guard)
        assert.equal(st.headSha, 'abc123');

        // absent state (defensive stubs) still yields the OPEN default
        prBody = { mergeable: true };
        assert.equal(p.prStatus(7).state, 'OPEN');
    });

    test('github: lastReview pins the newest verdict commit (REST shape)', function () {
        // The stale-verdict guard compares the latest review's commit_id
        // against the PR head: reviews arrive chronological, so the last
        // entry is the freshest verdict (REST spelling: commit_id).
        var calls = [];
        var p = loadProvider('github', {
            github_list_pr_reviews: function (args) {
                calls.push(args);
                return [
                    { state: 'COMMENTED', commit_id: 'aaa1', user: { login: 'ai-teammate' } },
                    { state: 'CHANGES_REQUESTED', commit_id: '7bac91fd', user: { login: 'ai-teammate' } }
                ];
            }
        });
        var lr = p.lastReview(9);
        assert.equal(calls[0].pullRequestId, '9');
        assert.equal(lr.state, 'CHANGES_REQUESTED');
        assert.equal(lr.commitId, '7bac91fd');
        assert.equal(lr.author, 'ai-teammate');
        // never-reviewed PRs → null (the guard treats them as not stale)
        var empty = loadProvider('github', {
            github_list_pr_reviews: function () { return []; }
        });
        assert.equal(empty.lastReview(9), null);
    });

    test('UT-prov-1: github lastReview ignores trailing empty-body COMMENTED inline replies so stale CHANGES_REQUESTED is preserved', function () {
        var p = loadProvider('github', {
            github_list_pr_reviews: function () {
                return [
                    { state: 'CHANGES_REQUESTED', commit_id: 'shaA', body: 'Please fix x', user: { login: 'ai-teammate' } },
                    { state: 'COMMENTED', commit_id: 'shaB', body: '', user: { login: 'ai-teammate' } },
                    { state: 'COMMENTED', commit_id: 'shaB', body: '   ', user: { login: 'human' } }
                ];
            }
        });
        assert.deepEqual(p.lastReview(1151), {
            state: 'CHANGES_REQUESTED',
            commitId: 'shaA',
            author: 'ai-teammate'
        });
    });

    test('UT-prov-2: github lastReview picks newer APPROVED verdict and falls back to last COMMENTED when all are empty-body', function () {
        var p = loadProvider('github', {
            github_list_pr_reviews: function () {
                return [
                    { state: 'CHANGES_REQUESTED', commit_id: 'shaA', body: 'Fix', user: { login: 'ai-teammate' } },
                    { state: 'APPROVED', commit_id: 'shaB', body: '', user: { login: 'ai-teammate' } },
                    { state: 'COMMENTED', commit_id: 'shaB', body: '', user: { login: 'ai-teammate' } }
                ];
            }
        });
        assert.deepEqual(p.lastReview(1151), {
            state: 'APPROVED',
            commitId: 'shaB',
            author: 'ai-teammate'
        });

        var pCommentedSummary = loadProvider('github', {
            github_list_pr_reviews: function () {
                return [
                    { state: 'COMMENTED', commit_id: 'shaA', body: '## Automated Code Review', user: { login: 'ai-teammate' } },
                    { state: 'COMMENTED', commit_id: 'shaB', body: '', user: { login: 'ai-teammate' } }
                ];
            }
        });
        assert.deepEqual(pCommentedSummary.lastReview(1151), {
            state: 'COMMENTED',
            commitId: 'shaA',
            author: 'ai-teammate'
        });

        var pAllEmpty = loadProvider('github', {
            github_list_pr_reviews: function () {
                return [
                    { state: 'COMMENTED', commit_id: 'shaA', body: '', user: { login: 'u1' } },
                    { state: 'COMMENTED', commit_id: 'shaB', body: '', user: { login: 'u2' } }
                ];
            }
        });
        assert.deepEqual(pAllEmpty.lastReview(1151), {
            state: 'COMMENTED',
            commitId: 'shaB',
            author: 'u2'
        });
    });

    test('github: reviewThreads counts resolved/unresolved (GraphQL envelope)', function () {
        // Threads are GraphQL-only; the provider must navigate
        // data.repository.pullRequest.reviewThreads.nodes and count
        // isResolved — the threadsResolved guard re-arms a re-review only
        // when at least one thread exists and none are unresolved.
        var calls = [];
        var p = loadProvider('github', {
            github_get_pr_review_threads: function (args) {
                calls.push(args);
                return { data: { repository: { pullRequest: { reviewThreads: {
                    nodes: [
                        { id: 't1', isResolved: true, path: 'a.dart' },
                        { id: 't2', isResolved: true, path: 'b.dart' },
                        { id: 't3', isResolved: false, path: 'c.dart' }
                    ]
                } } } } };
            }
        });
        var th = p.reviewThreads(6);
        assert.equal(calls[0].pullRequestId, '6');
        assert.equal(th.total, 3);
        assert.equal(th.resolved, 2);
        assert.equal(th.unresolved, 1);

        // shape variance / empty → zeroed totals, never a throw
        var bare = loadProvider('github', {
            github_get_pr_review_threads: function () { return null; }
        });
        var none = bare.reviewThreads(6);
        assert.equal(none.total, 0);
        assert.equal(none.unresolved, 0);
    });

    test('github: prStatus computes BEHIND/CLEAN from base.sha vs branch head (deterministic)', function () {
        // Live race: right after a base push, REST mergeable_state says
        // `unknown` for every PR while GitHub recomputes lazily — an SM
        // tick in that window updated nothing. base.sha vs the live
        // branch head (github_list_branches) is always current.
        var branches = [
            { name: 'main', commit: { sha: 'mainhead' } },
            { name: 'dev', commit: { sha: 'devhead' } }
        ];
        function mkProvider(pr) {
            return loadProvider('github', {
                github_get_pr: function () { return pr; },
                github_get_commit_check_runs: function () { return { check_runs: [] }; },
                github_list_branches: function () { return branches; }
            });
        }
        // stale base + mergeable true (or null mid-recompute) -> BEHIND
        assert.equal(mkProvider({
            state: 'OPEN', mergeable: true, mergeable_state: 'unknown',
            base: { ref: 'main', sha: 'oldbase' }, head: { sha: 'h' }
        }).prStatus(7).mergeState, 'BEHIND');
        assert.equal(mkProvider({
            state: 'OPEN', mergeable: null, mergeable_state: 'unknown',
            base: { ref: 'main', sha: 'oldbase' }, head: { sha: 'h' }
        }).prStatus(7).mergeState, 'BEHIND');
        // fresh base -> CLEAN (even when REST still mutters 'behind')
        assert.equal(mkProvider({
            state: 'OPEN', mergeable: true, mergeable_state: 'behind',
            base: { ref: 'main', sha: 'mainhead' }, head: { sha: 'h' }
        }).prStatus(7).mergeState, 'CLEAN');
        // conflicts beat freshness -> DIRTY
        assert.equal(mkProvider({
            state: 'OPEN', mergeable: false, mergeable_state: 'dirty',
            base: { ref: 'main', sha: 'mainhead' }, head: { sha: 'h' }
        }).prStatus(7).mergeState, 'DIRTY');
        // non-default base branch heads work too
        assert.equal(mkProvider({
            state: 'OPEN', mergeable: true, mergeable_state: 'unknown',
            base: { ref: 'dev', sha: 'devhead' }, head: { sha: 'h' }
        }).prStatus(7).mergeState, 'CLEAN');
    });

    test('github: branchHead falls back to a single-branch gh probe when page 1 misses main (#639)', function () {
        // Live fa pr-1174 (2026-10-03): github_list_branches returns page 1
        // only (30 branches — no perPage param, Java parity); on fa the
        // 'ai/gh-*' fleet pushes 'main' off the page, the override never
        // ran, mergeState stayed raw 'UNSTABLE', and merge-validated
        // (mergeState CLEAN) matched NOTHING all night.
        var probeCmds = [];
        var p = loadProvider('github', {
            github_get_pr: function () {
                return { state: 'OPEN', mergeable: true, mergeable_state: 'unstable',
                    base: { ref: 'main', sha: 'aa11' + 'bb22cc33dd44ee55ff66aa77bb88cc99dd00' },
                    head: { sha: 'h' } };
            },
            github_get_commit_check_runs: function () { return { check_runs: [] }; },
            // page 1 without 'main' — the #639 reality
            github_list_branches: function () {
                return [{ name: 'ai/gh-1', commit: { sha: 'x' } }];
            },
            cli_execute_command: function (args) {
                probeCmds.push(args.command);
                return 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
            }
        });
        assert.equal(p.prStatus(31).mergeState, 'CLEAN',
            'the gh-api probe rescues the override: fresh base stays CLEAN despite the truncated list');
        assert.ok(probeCmds.some(function (c) {
            return c.indexOf('/branches/main') !== -1; }),
            'the single-branch probe fired for main');
    });

    test('github: branchExists — page-1 hit, #639 probe hit, and genuinely gone (gh-922 bench oracle)', function () {
        // gh-922: the dead-head park bench asks the provider whether a
        // parked PR's head ref still exists. The verdict rides the same
        // caches as the deterministic base check: the branchHeads snapshot
        // first, the single-branch gh probe for the page-1 listing cutoff.
        var p = loadProvider('github', {
            github_list_branches: function () {
                return [{ name: 'main', commit: { sha: 'm' } }]; // page 1 only
            },
            cli_execute_command: function (args) {
                if (args.command.indexOf('/branches/off-page') !== -1) {
                    return 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
                }
                if (args.command.indexOf('/branches/gone') !== -1) {
                    throw new Error('404 Not Found');
                }
                return '';
            }
        });
        assert.equal(p.branchExists('main'), true,
            'a page-1 branch exists — answered from the snapshot, no probe');
        assert.equal(p.branchExists('off-page'), true,
            'the #639 single-branch probe rescues a page-1 miss — a LIVE park is never benched');
        assert.equal(p.branchExists('gone'), false,
            'a 404 probe means the ref is gone — the dead-head park is benchable');
        assert.equal(p.branchExists(''), false,
            'an empty ref fails closed (nothing to dispatch against)');
    });

    test('github: branchExists redirects the probe to the head repo for fork PRs (gh-1057)', function () {
        // gh-1057 (live fa pr-1591): a fork's branch can never exist in
        // the base repo — probing the base is a guaranteed 404 that parks
        // a restored fork forever. branchExists(name, headFull) aims the
        // same snapshot + #639 probe machinery at the fork; an absent,
        // same-repo, or malformed spec keeps the base probe (fail-safe).
        var listed = [];
        var p = loadProvider('github', {
            github_list_branches: function (args) {
                var full = args.workspace + '/' + args.repository;
                listed.push(full);
                if (args.repository === 'my-repo') {
                    return [{ name: 'main', commit: { sha: 'm' } }]; // fork branch NOT here
                }
                return [{ name: 'fix/fork-branch', commit: { sha: 'f' } }];
            },
            cli_execute_command: function (args) {
                throw new Error('404 Not Found');
            }
        });
        assert.equal(p.branchExists('fix/fork-branch', 'forko/forkr'), true,
            'fork branch present in the FORK, 404 in base — the fork snapshot answers, never the base 404');
        assert.equal(listed.indexOf('forko/forkr') !== -1, true,
            'the branch listing ran against the head repo');
        assert.equal(p.branchExists('gone/everywhere', 'forko/forkr'), false,
            'a fork probe 404 keeps the bench verdict for a really-dead head');
        assert.equal(p.branchExists('gone/everywhere'), false,
            'no head spec — the base probe, unchanged legacy behavior');
        assert.equal(p.branchExists('main', 'mygroup/my-repo'), true,
            'a same-repo head spec keeps the base snapshot answer (no redirect)');
        assert.equal(p.branchExists('main', 'not-a-repo-spec'), true,
            'a malformed head spec falls back to the base probe (fail-safe)');
    });

    test('github: prStatus carries the head repo full name for the bench oracle (gh-1057)', function () {
        function mkProvider(pr) {
            return loadProvider('github', {
                github_get_pr: function () { return pr; },
                github_get_commit_check_runs: function () { return { check_runs: [] }; },
                github_list_branches: function () {
                    return [{ name: 'main', commit: { sha: 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00' } }];
                }
            });
        }
        var forkPr = mkProvider({
            state: 'OPEN', mergeable: true, mergeable_state: 'clean',
            base: { ref: 'main', sha: 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00' },
            head: { sha: 'h', ref: 'fix/x', repo: { full_name: 'forko/forkr' } }
        });
        assert.equal(forkPr.prStatus(41).headRepo, 'forko/forkr',
            'REST head.repo.full_name rides the status the bench oracle reads');
        var ownerNamePr = mkProvider({
            state: 'OPEN', mergeable: true, mergeable_state: 'clean',
            base: { ref: 'main', sha: 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00' },
            head: { sha: 'h', ref: 'fix/x',
                    repo: { owner: { login: 'forko' }, name: 'forkr' } }
        });
        assert.equal(ownerNamePr.prStatus(42).headRepo, 'forko/forkr',
            'owner+name spelling resolves the same full name');
        var noRepoPr = mkProvider({
            state: 'OPEN', mergeable: true, mergeable_state: 'clean',
            base: { ref: 'main', sha: 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00' },
            head: { sha: 'h', ref: 'fix/y' }
        });
        assert.equal(noRepoPr.prStatus(43).headRepo, null,
            'a missing head.repo (deleted fork) resolves to null — base probe, fail-open');
    });

    test('github: the shared head-repo resolver covers every head.repo dialect (gh-1059)', function () {
        // gh-1059 rework: ONE exported resolver (smProvider) is consumed by
        // githubSource.js too — these branches are the CRAP-gate coverage
        // the near-duplicate pair used to split between two files.
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {});
        var full = mod.ghPrHeadRepoFull;
        assert.equal(typeof full, 'function',
            'the resolver is exported for the githubSource consumer');
        assert.equal(full(null), null, 'no PR at all resolves to null');
        assert.equal(full({ head: null }), null, 'a headless PR resolves to null');
        assert.equal(full({ head: { repo: null } }), null, 'a deleted fork (null repo) resolves to null');
        assert.equal(full({ head: { repo: 'forko/forkr' } }), 'forko/forkr',
            'a STRING head.repo with a slash resolves as-is');
        assert.equal(full({ head: { repo: 'noslash' } }), null,
            'a STRING head.repo without a slash is malformed → null');
        assert.equal(full({ head: { repo: { full_name: 'a/b' } } }), 'a/b',
            'REST full_name dialect');
        assert.equal(full({ head: { repo: { nameWithOwner: 'gql/o' } } }), 'gql/o',
            'GraphQL nameWithOwner dialect');
        assert.equal(full({ head: { repo: { owner: { login: 'o' }, name: 'r' } } }), 'o/r',
            'owner.login + name dialect');
        assert.equal(full({ head: { repo: { owner: { name: 'orgx' }, name: 'r' } } }), 'orgx/r',
            'owner.name (no login) dialect');
        assert.equal(full({ head: { repo: { owner: {}, name: 'r' } } }), null,
            'an owner carrying neither login nor name resolves to null');
        assert.equal(full({ head: { repo: { owner: { login: 'o' } } } }), null,
            'a repo object with no usable name resolves to null');
    });

    test('github: prStatus preserves BLOCKED on a fresh base (dart #195 deadlock)', function () {
        // Live: dart #195 sat armed (ai_validating) on a fresh head whose
        // required checks were pending — REST reported mergeable_state
        // 'blocked', but the deterministic override masked it as CLEAN, so
        // unarm-stale-validation ({mergeState:[BEHIND,BLOCKED]}) never
        // matched and the PR deadlocked for hours. BLOCKED on a fresh base
        // is a REAL verdict (branch protection unmet) and must survive;
        // 'behind'/'unknown' on a fresh base stay recompute lies -> CLEAN.
        var branches = [{ name: 'main', commit: { sha: 'mainhead' } }];
        function mkProvider(pr) {
            return loadProvider('github', {
                github_get_pr: function () { return pr; },
                github_get_commit_check_runs: function () { return { check_runs: [] }; },
                github_list_branches: function () { return branches; }
            });
        }
        // fresh head + required checks pending/red -> BLOCKED survives
        assert.equal(mkProvider({
            state: 'OPEN', mergeable: true, mergeable_state: 'blocked',
            base: { ref: 'main', sha: 'mainhead' }, head: { sha: 'h' }
        }).prStatus(7).mergeState, 'BLOCKED');
        // GraphQL spelling of the same verdict
        assert.equal(mkProvider({
            state: 'OPEN', mergeable: true, mergeStateStatus: 'BLOCKED',
            base: { ref: 'main', sha: 'mainhead' }, head: { sha: 'h' }
        }).prStatus(7).mergeState, 'BLOCKED');
        // stale REST 'behind' on a fresh base is still a lie -> CLEAN
        assert.equal(mkProvider({
            state: 'OPEN', mergeable: true, mergeable_state: 'behind',
            base: { ref: 'main', sha: 'mainhead' }, head: { sha: 'h' }
        }).prStatus(7).mergeState, 'CLEAN');
    });

    test('github: prStatus falls back to REST mergeable_state without the branches tool', function () {
        var p = loadProvider('github', {
            github_get_pr: function () {
                return { state: 'OPEN', mergeable: true, mergeable_state: 'behind' };
            },
            github_get_commit_check_runs: function () { return { check_runs: [] }; }
            // no github_list_branches stub — older runtime
        });
        assert.equal(p.prStatus(7).mergeState, 'BEHIND');
    });

    test('github: prStatus maps the REST mergeable_state (live github_get_pr shape)', function () {
        // Live bug: the REST body carries mergeable_state (lowercase), not
        // the GraphQL mergeStateStatus — the old fallback read mergeable===
        // true and reported BEHIND PRs as CLEAN, so silent-update-behind
        // never matched (live: 5 PRs sat behind, tick processed 0).
        var shape = { state: 'OPEN', mergeable: true, statusCheckRollup: [] };
        var p = loadProvider('github', {
            github_get_pr: function () {
                // mergeStateStatus deliberately ABSENT — REST shape.
                return Object.assign({}, shape, { mergeable_state: currentRest });
            }
        });
        var currentRest = 'behind';
        assert.equal(p.prStatus(7).mergeState, 'BEHIND');
        currentRest = 'dirty';
        assert.equal(p.prStatus(8).mergeState, 'DIRTY');
        currentRest = 'blocked';
        assert.equal(p.prStatus(9).mergeState, 'BLOCKED');
        currentRest = 'unknown';
        assert.equal(p.prStatus(10).mergeState, 'UNKNOWN');
        // Neither field present: coarse bool fallback stays.
        var fb = loadProvider('github', {
            github_get_pr: function () {
                return { state: 'OPEN', mergeable: true, statusCheckRollup: [] };
            }
        });
        assert.equal(fb.prStatus(7).mergeState, 'CLEAN');
    });

    test('github: activeMachineRuns parses gh-N from in-progress run titles', function () {
        var statuses = [];
        var p = loadProvider('github', {
            github_list_workflow_runs: function (args) {
                statuses.push(args.status);
                return { workflow_runs: [
                    { display_title: '🔧 rework · gh-125: Machine comments on GitHub' }
                ] };
            }
        });
        var active = p.activeMachineRuns('ai-teammate.yml');
        assert.equal(active[0], 125);
        assert.equal(statuses.indexOf('in_progress') !== -1, true);
        assert.equal(statuses.indexOf('queued') !== -1, true);
    });

    test('github: dispatchLeg posts workflow inputs; merge is squash', function () {
        var dispatched = null, merged = null;
        var p = loadProvider('github', {
            github_trigger_workflow: function (args) { dispatched = args; return {}; },
            github_merge_pr: function (args) { merged = args; return {}; }
        });
        p.dispatchLeg(42, 'rework', 'CI red', 'ai-teammate.yml');
        assert.equal(dispatched.workflowId, 'ai-teammate.yml');
        var inputs = JSON.parse(dispatched.inputs);
        assert.equal(inputs.issue, '42');
        assert.equal(inputs.leg, 'rework');
        p.merge(42);
        assert.equal(merged.mergeMethod, 'squash');
        assert.equal(merged.pullRequestId, 42);
    });

    test('github: updateBranch falls back to the gh CLI', function () {
        var cmd = null;
        var p = loadProvider('github', {
            cli_execute_command: function (args) { cmd = args.command; return ''; }
        });
        p.updateBranch(9);
        assert.equal(cmd.indexOf('gh pr update-branch 9') !== -1, true);
    });

    // ── gitlab provider ──────────────────────────────────────────────────────

    test('gitlab: listMachineIssues filters by label OR assignee client-side', function () {
        var p = loadProvider('gitlab', {
            gitlab_list_issues: function () {
                return [
                    { iid: 1, title: 'a', labels: ['agent:dev'], assignees: [] },
                    { iid: 2, title: 'b', labels: [], assignees: [{ username: 'ai-teammate' }] },
                    { iid: 3, title: 'c', labels: ['wontfix'], assignees: [] }
                ];
            }
        });
        var issues = p.listMachineIssues(['agent:dev'], 'ai-teammate', 50);
        assert.equal(issues.length, 2);
        assert.equal(issues[0].number, 1);
        assert.equal(issues[1].number, 2);
    });

    test('gitlab: findPr matches source branch or description reference', function () {
        var p = loadProvider('gitlab', {
            gitlab_list_mrs: function (args) {
                if (args.state === 'opened') {
                    return [
                        { iid: 11, source_branch: 'ai/gh-5', description: '' },
                        { iid: 12, source_branch: 'other', description: 'Closes #5 tracked' }
                    ];
                }
                return [];
            }
        });
        var pr = p.findPr(5, 'ai/gh-');
        assert.equal(pr.number, 11);
        assert.equal(pr.state, 'OPEN');
    });

    test('gitlab: prStatus maps pipeline failures and conflicts', function () {
        var p = loadProvider('gitlab', {
            gitlab_get_mr: function () { return { state: 'opened', merge_status: 'can_be_merged', has_conflicts: false }; },
            gitlab_get_mr_pipelines: function () { return [{ status: 'failed' }, { status: 'success' }]; }
        });
        assert.equal(p.prStatus(11).checkConclusion, 'red');

        var p2 = loadProvider('gitlab', {
            gitlab_get_mr: function () { return { state: 'opened', merge_status: 'cannot_be_merged', has_conflicts: true }; },
            gitlab_get_mr_pipelines: function () { return [{ status: 'success' }]; }
        });
        var st = p2.prStatus(11);
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.mergeState, 'BEHIND');   // conflicts ⇒ rebase path
        assert.equal(st.mergeable, false);
    });

    test('gitlab: prStatus — a cancelled pipeline is NOT a verdict (gh-755): cancelled-only reads pending', function () {
        // gh-755 (owner directive 2026-10-05): a CANCELLED run is not a
        // verdict — mapping it to red armed fail_validation/rework legs on
        // heads whose only red was a cancel. GitHub parity (dart gh-191):
        // cancelled folds to 'no verdict yet', validate-fresh/revalidate
        // re-dispatch, the rerun-cancelled-checks remedy re-stamps.
        var p = loadProvider('gitlab', {
            gitlab_get_mr: function () { return { state: 'opened', merge_status: 'can_be_merged', has_conflicts: false }; },
            gitlab_get_mr_pipelines: function () { return [{ status: 'canceled' }]; }
        });
        assert.equal(p.prStatus(11).checkConclusion, 'pending',
            'cancelled-only rollup is pending — never red, never green');
    });

    test('gitlab: prStatus — cancelled next to green stays pending; failed next to cancelled still reads red', function () {
        // GitHub parity: a cancel forces 'no verdict yet' EVEN next to a
        // green pipeline (a cancelled run is the missing verdict), while a
        // genuine failure anywhere keeps the rollup red.
        var mixed = loadProvider('gitlab', {
            gitlab_get_mr: function () { return { state: 'opened', merge_status: 'can_be_merged', has_conflicts: false }; },
            gitlab_get_mr_pipelines: function () { return [{ status: 'success' }, { status: 'canceled' }]; }
        });
        assert.equal(mixed.prStatus(11).checkConclusion, 'pending',
            'green + cancelled → pending (wait for the rerun)');

        var failed = loadProvider('gitlab', {
            gitlab_get_mr: function () { return { state: 'opened', merge_status: 'can_be_merged', has_conflicts: false }; },
            gitlab_get_mr_pipelines: function () { return [{ status: 'failed' }, { status: 'canceled' }]; }
        });
        assert.equal(failed.prStatus(11).checkConclusion, 'red',
            'a real failure is not laundered by a neighbouring cancel');
    });

    test('gitlab: activeMachineRuns is conservative on API pipelines', function () {
        var p = loadProvider('gitlab', {
            gitlab_list_pipeline_runs: function () {
                return [{ source: 'push' }, { source: 'api' }];
            }
        });
        assert.equal(p.activeMachineRuns()[0], 'unknown');

        var p2 = loadProvider('gitlab', {
            gitlab_list_pipeline_runs: function () { return [{ source: 'push' }]; }
        });
        assert.equal(p2.activeMachineRuns().length, 0);
    });

    test('gitlab: dispatchLeg sends issue/leg variables; updateBranch rebases', function () {
        var trig = null, rebased = null;
        var p = loadProvider('gitlab', {
            gitlab_trigger_pipeline: function (args) { trig = args; return {}; },
            gitlab_rebase_mr: function (args) { rebased = args; return {}; }
        });
        p.dispatchLeg(7, 'review', 'green', 'ai-teammate.yml');
        // Canonical tool contract (Java + Dart): workspace/repository scoping,
        // variablesJson as a JSON string, pullRequestId as the MR id.
        assert.equal(trig.workspace, 'mygroup');
        assert.equal(trig.repository, 'my-repo');
        assert.equal(trig.ref, 'main');
        var vars = JSON.parse(trig.variablesJson);
        assert.equal(vars.issue, '7');
        assert.equal(vars.leg, 'review');
        p.updateBranch(7);
        assert.equal(rebased.workspace, 'mygroup');
        assert.equal(rebased.repository, 'my-repo');
        assert.equal(rebased.pullRequestId, '7');
    });

    test('gitlab: closeIssue warns and stays non-fatal (documented gap)', function () {
        var p = loadProvider('gitlab', {
            gitlab_create_mr_note: function () { return {}; }
        });
        var res = p.closeIssue(7, 'bye');   // must not throw
        assert.equal(res, null);
    });
    test('cancelled checks are not a verdict: all-cancelled rollup reads pending, never red', function () {
        // Live bug (dmtools-dart gh-191, twice on 2026-09-22): manual
        // run cleanups cancel validation runs; the engine read the
        // CANCELLED check runs as red and dispatched rework legs on an
        // approved+validated PR.
        var p = loadProvider('github', {
            github_get_pr: function () { return { state: 'open', mergeable: true, mergeable_state: 'clean', head: { sha: 'abc123' } }; },
            github_get_commit_check_runs: function () {
                return { check_runs: [
                    { status: 'completed', conclusion: 'cancelled' },
                    { status: 'completed', conclusion: 'cancelled' }
                ] };
            }
        });
        var st = p.prStatus(7);
        assert.notEqual(st.checkConclusion, 'red', 'cancelled runs are not failures — rework must not fire');
        assert.equal(st.checkConclusion, 'pending', 'nothing conclusive left — re-run validation, do not rework');
    });

    // ── per-tick ioCache + preseed (runAsync worker re-hydration) ─────────

    var MOD = 'js/common/smProvider.js';

    test('github: preseed openPrs/mergedPrs eliminates the github_list_prs fetch', function () {
        var listCalls = 0;
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_list_prs: function () { listCalls++; return []; },
            github_list_branches: function () { return []; }
        });
        var p = mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' },
            preseed: {
                openPrs: [{ number: 9, head: { label: 'mygroup:ai/gh-9', ref: 'ai/gh-9' }, body: '' }],
                mergedPrs: []
            }
        });
        var found = p.findPr(9, 'ai/gh-');
        assert.equal(found && found.number, 9, 'findPr resolves from the preseeded list');
        assert.equal(listCalls, 0, 'preseeded lists — github_list_prs never called');
    });

    test('github: preseed branchHeads eliminates github_list_branches (deterministic base check)', function () {
        var branchCalls = 0;
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_get_pr: function () {
                return { state: 'open', mergeable: true, base: { ref: 'main', sha: 'basesha' } };
            },
            github_list_branches: function () { branchCalls++; return []; }
        });
        var p = mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' },
            preseed: { branchHeads: { main: 'basesha' } }
        });
        var st = p.prStatus(3);
        assert.equal(st.mergeState, 'CLEAN', 'base sha matches the preseeded head — deterministic CLEAN');
        assert.equal(branchCalls, 0, 'github_list_branches never called');
    });

    test('github: TTL hit across two provider instances (shared per-tick cache)', function () {
        var listCalls = 0;
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_list_prs: function (a) {
                listCalls++;
                return a.state === 'open'
                    ? [{ number: 9, head: { label: 'mygroup:ai/gh-9', ref: 'ai/gh-9' }, body: '' }]
                    : [];
            }
        });
        var p1 = mod.createSmProvider({ scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' } });
        var p2 = mod.createSmProvider({ scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' } });
        p1.findPr(9, 'ai/gh-');                       // open list fetched (match — merged not needed)
        assert.equal(listCalls, 1);
        var snap1 = p1.snapshot();                    // mergedPrs fetched here
        var snap2 = p2.snapshot();
        assert.equal(listCalls, 2, 'second provider instance hits the same TTL cache');
        assert.equal(snap2.openPrs === snap1.openPrs, true, 'snapshot shares the cached payload');
        assert.equal(p2.findPr(9, 'ai/gh-').number, 9);
        assert.equal(listCalls, 2, 'findPr on the second instance still hits');
    });

    test('github: snapshot(kinds) skips unneeded legs (merged list unused by the PR-rule batch)', function () {
        var listCalls = 0, branchCalls = 0;
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_list_prs: function (args) {
                listCalls++;
                return args && args.state === 'merged'
                    ? [{ number: 3, head: { label: 'mygroup:ai/gh-3', ref: 'ai/gh-3' } }]
                    : [];
            },
            github_list_branches: function () { branchCalls++; return []; }
        });
        var p = mod.createSmProvider({ scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' } });
        var snap = p.snapshot(['openPrs', 'branchHeads', 'prStatus']);
        assert.equal(listCalls, 1, 'only the OPEN list fetched — the merged leg is skipped');
        assert.equal(branchCalls, 1, 'branch heads materialized');
        assert.equal(snap.mergedPrs, undefined, 'omitted kinds stay out of the snapshot');
        assert.ok(snap.prStatus && typeof snap.prStatus === 'object', 'prStatus memo leg present');
    });

    test('github: cache miss after TTL expiry re-fetches', function () {
        var listCalls = 0;
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_list_prs: function () { listCalls++; return []; }
        });
        var p = mod.createSmProvider({ scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' } });
        p.findPr(1, 'ai/gh-');
        assert.equal(listCalls, 2);
        mod._cache.ttlMs = -1; // force every entry stale
        p.findPr(1, 'ai/gh-');
        assert.equal(listCalls, 4, 'stale entries are re-fetched');
        assert.equal(typeof mod._cache.entries, 'object', '_cache exposed for tests');
    });

    test('github: prStatus memo — same number fetched once per tick, per-number keys, TTL re-fetch', function () {
        var getCalls = 0, checkCalls = 0;
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_get_pr: function () {
                getCalls++;
                return { state: 'open', mergeable: true, mergeable_state: 'clean',
                         head: { sha: 'abc123' } };
            },
            github_get_commit_check_runs: function () {
                checkCalls++;
                return { check_runs: [{ status: 'completed', conclusion: 'success' }] };
            }
        });
        var p = mod.createSmProvider({ scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' } });
        var s1 = p.prStatus(7);
        var s2 = p.prStatus(7);
        assert.equal(getCalls, 1, 'github_get_pr once for two prStatus(7) calls');
        assert.equal(checkCalls, 1, 'github_get_commit_check_runs once');
        assert.equal(s2 === s1, true, 'memoized result is the same read-only reference');
        p.prStatus(8);
        assert.equal(getCalls, 2, 'per-number cache keys');
        mod._cache.ttlMs = -1;
        p.prStatus(7);
        assert.equal(getCalls, 3, 'TTL expiry re-fetches');
    });

    test('github: prStatus memo rides snapshot/preseed + memoPrStatus write-back (worker round-trip)', function () {
        var getCalls = 0;
        function makeProvider() {
            var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
                github_get_pr: function () {
                    getCalls++;
                    return { state: 'open', mergeable: true, mergeable_state: 'clean',
                             head: { sha: 'abc123' } };
                },
                github_get_commit_check_runs: function () {
                    return { check_runs: [{ status: 'completed', conclusion: 'success' }] };
                },
                github_list_prs: function () { return []; },
                github_list_branches: function () { return []; }
            });
            return mod.createSmProvider({ scm: { provider: 'github' },
                repository: { owner: 'mygroup', repo: 'my-repo' } });
        }
        // Worker side: a fresh isolate computes prStatus(7); the main
        // engine absorbs the result via memoPrStatus and snapshots.
        var workerProvider = makeProvider();
        var status = workerProvider.prStatus(7);
        workerProvider.memoPrStatus(7, status);
        var snap = workerProvider.snapshot();
        assert.ok(snap.prStatus && snap.prStatus['7'], 'snapshot carries the prStatus memo leg');

        // Next batch's worker: fresh module state, rehydrated from preseed
        // — the SAME status comes back with zero new fetches.
        var before = getCalls;
        var mainMod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_get_pr: function () { getCalls++; return { state: 'open' }; },
            github_get_commit_check_runs: function () { return { check_runs: [] }; },
            github_list_prs: function () { return []; },
            github_list_branches: function () { return []; }
        });
        var mainProvider = mainMod.createSmProvider({ scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' }, preseed: snap });
        assert.equal(mainProvider.prStatus(7) === status, true,
            'preseeded memo returns the identical read-only reference');
        assert.equal(getCalls, before, 'no re-fetch after preseed');
    });

    test('gitlab: snapshot/listOpenPrs documented gaps return null', function () {
        var p = loadProvider('gitlab', {});
        assert.equal(p.snapshot(), null);
        assert.equal(p.listOpenPrs(), null);
    });

});

suite('smProvider: ioCacheDrop (owner directive 2026-10-04 — red yields the slot)', function () {

    var MOD = 'js/common/smProvider.js';

    test('dropping openPrs forces a fresh github_list_prs on the next read', function () {
        // Same-tick slot yield: fail_validation unarms ai_validating
        // mid-tick; the arm rule re-reading the open-PR list in the SAME
        // tick must see the freed mutex — the cached entry is dropped, the
        // next listOpenPrs() re-fetches instead of serving the stale arm.
        var listCalls = 0;
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_list_prs: function () {
                listCalls++;
                return JSON.stringify([{ number: listCalls }]); // payload changes per fetch
            }
        });
        mod._cache.entries = {}; // fresh holder

        var provider = mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });

        var first = provider.listOpenPrs();
        assert.equal(listCalls, 1, 'first read fetches');
        var cached = provider.listOpenPrs();
        assert.equal(listCalls, 1, 'second read rides the per-tick cache');
        assert.equal(cached[0].number, first[0].number, 'cache serves the same payload');

        mod.ioCacheDrop('mygroup', 'my-repo', 'openPrs', null);
        var fresh = provider.listOpenPrs();
        assert.equal(listCalls, 2, 'after the drop the list re-fetches');
        assert.notEqual(fresh[0].number, first[0].number,
            'the fresh payload (post-unarm labels) is what the arm rule sees');
    });

    test('ioCacheDrop is a no-op for absent entries (never throws)', function () {
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {});
        mod._cache.entries = {};
        mod.ioCacheDrop('nobody', 'nowhere', 'openPrs', null); // must not throw
    });
});

suite('smProvider — gh-807 machine verdict records', function () {

    var MOD = 'js/common/smProvider.js';
    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function marker(verdict, at, head) {
        return '<!-- dmtools:review-verdict ' + JSON.stringify({
            head: head || HEAD, verdict: verdict, blocking: 0,
            important: 0, suggestions: 0, at: at, source: 'pr_review.json'
        }) + ' -->';
    }

    function loadWith(comments, calls) {
        var rvMod = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});
        var mod = loadModule(MOD,
            makeRequire({ './reviewVerdicts.js': rvMod, './validationLiveness.js': vlReal() }, {}),
            {
                github_get_pr_comments: function () {
                    calls.push(1);
                    return JSON.stringify(comments);
                }
            });
        return mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
    }

    test('verdictRecords parses the marker comments; free-form text is invisible (AC4)', function () {
        var calls = [];
        var p = loadWith([
            { body: 'please REQUEST_CHANGES, this is broken' },
            { body: marker('APPROVE', '2026-10-09T05:47:30.000Z') }
        ], calls);
        var records = p.verdictRecords(5);
        assert.equal(records.length, 1, 'only the marker comment is a record');
        assert.equal(records[0].verdict, 'APPROVE');
        assert.equal(calls.length, 1, 'one comment fetch');
    });

    test('verdictRecords memoizes per tick (kind prVerdicts) — guards may call per rule', function () {
        var calls = [];
        var p = loadWith([{ body: marker('APPROVE', '2026-10-09T05:47:30.000Z') }], calls);
        p.verdictRecords(5);
        p.verdictRecords(5);
        p.latestVerdictRecord(5, HEAD);
        assert.equal(calls.length, 1, 'three reads, one fetch');
    });

    test('latestVerdictRecord resolves per head; other heads\u2019 records stay out', function () {
        var p = loadWith([
            { body: marker('APPROVE', '2026-10-09T05:47:30.000Z') },
            { body: marker('REQUEST_CHANGES', '2026-10-09T05:47:40.000Z', 'ffffffffeeeeeeeedddddddd77777777') }
        ], []);
        var effective = p.latestVerdictRecord(5, HEAD);
        assert.equal(effective.record.verdict, 'APPROVE', 'the head\u2019s own record wins');
        assert.notOk(effective.conflict);
        assert.equal(p.latestVerdictRecord(5, '0'.repeat(40)), null, 'unknown head → null (fail-open)');
        assert.equal(p.latestVerdictRecord(5, null), null, 'no head → null (fail-open)');
    });

    test('the #1428 replay through the provider: newest wins, conflict rides the result', function () {
        var p = loadWith([
            { body: marker('APPROVE', '2026-10-09T05:47:30.000Z') },
            { body: marker('REQUEST_CHANGES', '2026-10-09T05:47:40.000Z') }
        ], []);
        var effective = p.latestVerdictRecord(1428, HEAD);
        assert.equal(effective.record.verdict, 'REQUEST_CHANGES', 'the 97s-later leg wins');
        assert.ok(effective.conflict, 'the contradiction surfaces to the guard/action layer');
    });

    test('probe failure fails open to [] — the guards go inert, never red', function () {
        var rvMod = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});
        var mod = loadModule(MOD,
            makeRequire({ './reviewVerdicts.js': rvMod, './validationLiveness.js': vlReal() }, {}),
            {
                github_get_pr_comments: function () { throw new Error('api down'); }
            });
        var p = mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
        assert.deepEqual(p.verdictRecords(7), [], 'broken read → empty records');
        assert.equal(p.latestVerdictRecord(7, HEAD), null, 'no head resolution → guard inert');
    });

    test('verdictRecords(pr, {authorLogins}) trusts only machine-authored markers (gh-828 review round 2)', function () {
        // The marker format is public (this repo) — a forged APPROVE from
        // any comment-capable identity must be invisible to the readers.
        var calls = [];
        var p = loadWith([
            { user: { login: 'ai-teammate' }, body: marker('APPROVE', '2026-10-09T05:47:30.000Z') },
            { user: { login: 'random-triager' }, body: marker('APPROVE', '2026-10-09T05:47:40.000Z') },
            { body: marker('REQUEST_CHANGES', '2026-10-09T05:47:50.000Z') }
        ], calls);
        var records = p.verdictRecords(5, { authorLogins: ['ai-teammate'] });
        assert.equal(records.length, 1, 'only the machine-authored marker is trusted');
        assert.equal(records[0].verdict, 'APPROVE');
        assert.equal(Date.parse(records[0].at), Date.parse('2026-10-09T05:47:30.000Z'));
        // the filtered read must not poison the unfiltered memo entry
        var all = p.verdictRecords(5);
        assert.equal(all.length, 3, 'the unfiltered read still sees every marker');
        assert.equal(calls.length, 1, 'one comment fetch serves both variants');
        // the head-resolution consumer honors the same allowlist
        var forgedOnly = loadWith([
            { user: { login: 'random-triager' }, body: marker('APPROVE', '2026-10-09T05:47:40.000Z') }
        ], []);
        assert.equal(forgedOnly.latestVerdictRecord(5, HEAD, { authorLogins: ['ai-teammate'] }),
            null, 'a forged newest marker unlocks nothing');
    });
});

suite('smProvider — gh-828 post-APPROVE thread primitives', function () {

    var MOD = 'js/common/smProvider.js';
    function loadProvider(mocks) {
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, mocks || {}), mocks || {});
        return mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
    }

    test('github: reviewThreadList maps nodes to thread/author/body/resolve ids', function () {
        var p = loadProvider({
            github_get_pr_review_threads: function () {
                return { data: { repository: { pullRequest: { reviewThreads: {
                    nodes: [
                        { id: 'RT_1', isResolved: false, path: 'a.js', line: 12,
                          comments: { nodes: [{ databaseId: 101, body: '💡 SUGGESTION: x',
                                                author: { login: 'ai-teammate' } }] } },
                        { id: 'RT_2', isResolved: true,
                          comments: { nodes: [{ databaseId: 102, body: 'done',
                                                author: { login: 'human' } }] } }
                    ]
                } } } } };
            }
        });
        var list = p.reviewThreadList(6);
        assert.equal(list.length, 2);
        assert.equal(list[0].threadId, 'RT_1');
        assert.equal(list[0].rootCommentId, 101);
        assert.equal(list[0].author, 'ai-teammate');
        assert.equal(list[0].body, '💡 SUGGESTION: x');
        assert.equal(list[0].resolved, false);
        assert.equal(list[1].resolved, true);
    });

    test('github: reviewThreadList fails open to [] on a broken read', function () {
        var p = loadProvider({
            github_get_pr_review_threads: function () { throw new Error('graphql down'); }
        });
        assert.deepEqual(p.reviewThreadList(6), []);
        var bare = loadProvider({ github_get_pr_review_threads: function () { return null; } });
        assert.deepEqual(bare.reviewThreadList(6), []);
    });

    test('github: replyToThread uses the root comment id; resolveThread uses the GraphQL thread id', function () {
        var replies = [], resolves = [];
        var p = loadProvider({
            github_reply_to_pr_thread: function (args) { replies.push(args); },
            github_resolve_pr_thread: function (args) { resolves.push(args); }
        });
        p.replyToThread(6, { rootCommentId: 101, threadId: 'RT_1' }, 'ack text');
        assert.equal(replies.length, 1);
        assert.equal(replies[0].inReplyToId, '101');
        assert.equal(replies[0].pullRequestId, '6');
        assert.contains(replies[0].text, 'ack text');
        p.resolveThread(6, { threadId: 'RT_1' });
        assert.equal(resolves.length, 1);
        assert.equal(resolves[0].threadId, 'RT_1');
        // no thread id → warn, no throw
        p.resolveThread(6, {});
        assert.equal(resolves.length, 1);
    });

    test('github: replyToThread without a root comment id falls back to a PR comment', function () {
        var comments = [];
        var p = loadProvider({
            github_add_pr_comment: function (args) { comments.push(args); }
        });
        p.replyToThread(6, { threadId: 'RT_1' }, 'ack');
        assert.equal(comments.length, 1);
        assert.equal(comments[0].pullRequestId, '6');
        assert.contains(comments[0].text, 'ack');
    });
});

suite('smProvider — gh-1009 CRAP characterization (paths touched by the provider split)', function () {

    var MOD = 'js/common/smProvider.js';

    function rvMod() {
        return loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});
    }

    function loadMod(mocks) {
        return loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvMod(), './validationLiveness.js': vlReal() }, mocks || {}), mocks || {});
    }

    function loadProvider(provider, mocks) {
        return loadMod(mocks).createSmProvider({
            scm: { provider: provider },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
    }

    function captureWarn(fn) {
        var original = console.warn;
        var warnings = [];
        console.warn = function (m) { warnings.push(String(m)); };
        try { fn(); } finally { console.warn = original; }
        return warnings;
    }

    // ── ecosystem parsing helpers ────────────────────────────────────────

    test('parseMcp: an invalid JSON string parses to null and the open list reads empty (characterization)', function () {
        var p = loadProvider('github', {
            github_list_prs: function (args) {
                if (args.state === 'open') return '{not json';
                return [];
            }
        });
        // open list unparseable → no open match, no merged match → null
        assert.equal(p.findPr(3, 'ai/gh-'), null);
    });

    test('asList: pullRequests/issues envelopes and the no-list-envelope fallback (characterization)', function () {
        var p = loadProvider('github', {
            github_list_prs: function (args) {
                if (args.state === 'open') {
                    return { pullRequests: [{ number: 3, head: { label: 'mygroup:ai/gh-3' }, body: '' }] };
                }
                return { unrelated: true }; // no list envelope → []
            }
        });
        assert.deepEqual(p.findPr(3, 'ai/gh-'), { number: 3, state: 'OPEN', branch: 'ai/gh-3' });
        assert.equal(p.findPr(4, 'ai/gh-'), null);
    });

    // ── ioCache ──────────────────────────────────────────────────────────

    test('ioCacheCollect: TTL-expired prStatus entries are dropped from snapshot() (characterization)', function () {
        var mod = loadMod({
            github_get_pr: function () { return { state: 'open' }; }
        });
        var p = mod.createSmProvider({ scm: { provider: 'github' },
            repository: { owner: 'g', repo: 'r' } });
        p.prStatus(42); // seeds the prStatus cache leg
        var key = 'g/r:prStatus:42';
        assert.ok(mod._cache.entries[key], 'precondition: memo entry exists');
        mod._cache.entries[key].at = Date.now() - 120000; // age past the 60s TTL
        var snap = p.snapshot(['prStatus']);
        assert.deepEqual(snap.prStatus, {});
    });

    test('createSmProvider: the preseed prStatus leg hydrates the memo (no refetch)', function () {
        var mod = loadMod({
            github_get_pr: function () { throw new Error('github_get_pr must not be called on a preseed hit'); }
        });
        var status = { number: 77, state: 'OPEN', checkConclusion: 'green' };
        var p = mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'g', repo: 'r' },
            preseed: { prStatus: { '77': status } }
        });
        assert.deepEqual(p.prStatus(77), status);
    });

    test('branchHead: the #639 single-branch probe result is cached (second read hits, no second gh call)', function () {
        var ghCalls = 0;
        var p = loadProvider('github', {
            github_list_branches: function () { return []; }, // page 1 misses 'main'
            cli_execute_command: function () {
                ghCalls++;
                return { output: '"' + 'a'.repeat(40) + '"' };
            }
        });
        assert.equal(p.branchExists('main'), true);
        assert.equal(p.branchExists('main'), true);
        assert.equal(ghCalls, 1, 'the probed sha is cached per tick');
    });

    // ── github provider methods ──────────────────────────────────────────

    test('github: findPr — open head-label match, body-ref fallback, merged match, null (characterization)', function () {
        var listCalls = { open: 0, merged: 0 };
        var p = loadProvider('github', {
            github_list_prs: function (args) {
                if (args.state === 'open') {
                    listCalls.open++;
                    return [
                        { number: 10, head: { label: 'mygroup:ai/gh-10', ref: 'ai/gh-10' }, body: 'plain' },
                        { number: 11, head: { label: 'other:zz', ref: 'zz' }, body: 'Fixes #11 for good' }
                    ];
                }
                listCalls.merged++;
                return [{ number: 5, head: { label: 'mygroup:ai/gh-5' } }];
            }
        });
        assert.deepEqual(p.findPr(10, 'ai/gh-'), { number: 10, state: 'OPEN', branch: 'ai/gh-10' });
        assert.deepEqual(p.findPr(11, 'ai/gh-'), { number: 11, state: 'OPEN', branch: 'zz' });
        assert.deepEqual(p.findPr(5, 'ai/gh-'), { number: 5, state: 'MERGED', branch: 'ai/gh-5' });
        assert.equal(p.findPr(999, 'ai/gh-'), null);
        assert.equal(listCalls.open, 1, 'open list rides the per-tick cache');
        assert.equal(listCalls.merged, 1, 'merged list rides the per-tick cache');
    });

    test('github: findPr — a body reference does not match a bare substring of a longer number', function () {
        var p = loadProvider('github', {
            github_list_prs: function (args) {
                if (args.state === 'open') {
                    return [{ number: 110, head: { label: 'x:y' }, body: 'refs #1100' }];
                }
                return [];
            }
        });
        assert.equal(p.findPr(110, 'ai/gh-'), null);
        // …but the same PR IS the linked PR of #1100 (its body refs #1100)
        assert.equal(p.findPr(1100, 'ai/gh-').number, 110);
    });

    test('github: listMachineIssues — the limit early-exit line never skips later label searches (characterization)', function () {
        var queries = [];
        var p = loadProvider('github', {
            github_search_issues: function (args) {
                queries.push(args.query);
                if (args.query.indexOf('label:"one"') !== -1) {
                    return { items: [
                        { number: 1, title: 'a', labels: [{ name: 'one' }], assignees: [] },
                        { number: 2, title: 'b', labels: [{ name: 'one' }], assignees: [] }
                    ] };
                }
                if (args.query.indexOf('label:"two"') !== -1) {
                    return { items: [{ number: 2, title: 'b2', labels: [{ name: 'two' }], assignees: [] }] };
                }
                if (args.query.indexOf('assignee:') !== -1) {
                    return { items: [{ number: 3, title: 'c', labels: [], assignees: [{ login: 'bot' }] }] };
                }
                return { items: [] };
            }
        });
        var issues = p.listMachineIssues(['one', 'two'], 'bot', 2);
        assert.equal(issues.length, 2);
        assert.equal(issues[0].number, 1);
        assert.equal(issues[1].number, 2);
        // the `return` inside forEach continues with the NEXT label: all three
        // searches still fire even though label "one" already filled the limit.
        assert.equal(queries.length, 3);
    });

    test('github: prStatus maps string-form PR labels and resolves the author via user/author fallbacks', function () {
        var prs = {
            31: { state: 'open', mergeable: true, mergeStateStatus: 'CLEAN',
                  labels: ['ai_pr_reviewed', { name: 'agent:review' }], author: { login: 'graphbot' } },
            32: { state: 'open', mergeable: true, mergeStateStatus: 'CLEAN',
                  labels: [], author: { name: 'Named Author' } },
            33: { state: 'open', mergeable: true, mergeStateStatus: 'CLEAN' }
        };
        var p = loadProvider('github', {
            github_get_pr: function (args) { return prs[args.pullRequestId]; }
        });
        var st31 = p.prStatus(31);
        assert.deepEqual(st31.labels, ['ai_pr_reviewed', 'agent:review']);
        assert.equal(st31.author, 'graphbot');
        assert.equal(p.prStatus(32).author, 'Named Author');
        assert.equal(p.prStatus(33).author, '');
    });

    test('github: closeIssue — comment then close; a failing comment still closes; no comment skips the note', function () {
        var calls = [];
        var p = loadProvider('github', {
            github_create_comment: function (a) { calls.push(['comment', a]); return 'ok'; },
            github_close_issue: function (a) { calls.push(['close', a]); return 'closed'; }
        });
        assert.equal(p.closeIssue(7, 'done'), 'closed');
        assert.equal(p.closeIssue(8, null), 'closed');
        assert.deepEqual(calls, [
            ['comment', { workspace: 'mygroup', repository: 'my-repo', number: 7, body: 'done' }],
            ['close', { workspace: 'mygroup', repository: 'my-repo', number: 7 }],
            ['close', { workspace: 'mygroup', repository: 'my-repo', number: 8 }]
        ]);
        var p2 = loadProvider('github', {
            github_create_comment: function () { throw new Error('boom'); },
            github_close_issue: function (a) { calls.push(['close', a]); return 'closed'; }
        });
        var warnings = captureWarn(function () {
            assert.equal(p2.closeIssue(9, 'x'), 'closed');
        });
        assert.equal(warnings.length, 1);
        assert.contains(warnings[0], 'close-issue comment failed');
        assert.deepEqual(calls[calls.length - 1],
            ['close', { workspace: 'mygroup', repository: 'my-repo', number: 9 }]);
    });

    test('github: addIssueLabel/addPrLabel ride github_add_labels with a single-label array', function () {
        var calls = [];
        var p = loadProvider('github', {
            github_add_labels: function (a) { calls.push(a); return 'ok'; }
        });
        p.addIssueLabel(4, 'agent:dev');
        p.addPrLabel(5, 'ai_pr_reviewed');
        assert.deepEqual(calls, [
            { workspace: 'mygroup', repository: 'my-repo', number: 4, labels: ['agent:dev'] },
            { workspace: 'mygroup', repository: 'my-repo', number: 5, labels: ['ai_pr_reviewed'] }
        ]);
    });

    test('github: removePrLabel — idempotent no-op on a 404 (warns, returns null)', function () {
        var calls = [];
        var p = loadProvider('github', {
            github_remove_label: function (a) { calls.push(a); throw new Error('HTTP 404'); }
        });
        var warnings = captureWarn(function () {
            assert.equal(p.removePrLabel(12, 'ai_validating'), null);
        });
        assert.equal(warnings.length, 1);
        assert.contains(warnings[0], 'remove "ai_validating" from PR #12');
        assert.deepEqual(calls, [{ workspace: 'mygroup', repository: 'my-repo',
                                   number: 12, label: 'ai_validating' }]);
        var p2 = loadProvider('github', {
            github_remove_label: function (a) { return 'removed'; }
        });
        assert.equal(p2.removePrLabel(12, 'ai_validating'), 'removed');
    });

    test('github: dispatchPrLeg posts issue:"" + pr inputs; dispatchLeg posts the issue number', function () {
        var calls = [];
        var p = loadProvider('github', {
            github_trigger_workflow: function (a) { calls.push(a); return 'fired'; }
        });
        p.dispatchPrLeg(15, 'review', 'because', 'factory.yml');
        p.dispatchLeg(16, 'dev', null, 'factory.yml');
        assert.deepEqual(calls, [
            { workflowId: 'factory.yml', ref: 'main',
              inputs: JSON.stringify({ issue: '', leg: 'review', reason: 'because', pr: '15' }) },
            { workflowId: 'factory.yml', ref: 'main',
              inputs: JSON.stringify({ issue: '16', leg: 'dev', reason: '' }) }
        ]);
    });

    test('github: silentUpdateBranch — plain, silent+restore, silent-only token shapes', function () {
        var calls = [];
        var p = loadProvider('github', {
            cli_execute_command: function (a) { calls.push(['gh', a.command]); return 'ok'; },
            set_env_variable: function (k, v) { calls.push(['env', k, v]); }
        });
        p.silentUpdateBranch(3);
        p.silentUpdateBranch(4, 'SILENT', 'RESTORE');
        p.silentUpdateBranch(5, 'SILENT2');
        assert.deepEqual(calls, [
            ['gh', 'gh pr update-branch 3 --repo mygroup/my-repo'],
            ['env', 'GH_TOKEN', 'SILENT'],
            ['gh', 'gh pr update-branch 4 --repo mygroup/my-repo'],
            ['env', 'GH_TOKEN', 'RESTORE'],
            ['env', 'GH_TOKEN', 'SILENT2'],
            ['gh', 'gh pr update-branch 5 --repo mygroup/my-repo'],
            ['env', 'GH_TOKEN', 'SILENT2']
        ]);
    });

    // ── gh-1106: the workflow-write escalation on the base-repo path ─────
    // A workflows-permission rejection is a token-capability fact — the
    // silent token can NEVER create/update workflow files — so the update
    // retries ONCE with GH_TOKEN swapped to the escalation token; a second
    // workflows-class refusal surfaces a DISTINCT error naming the missing
    // capability. Non-workflows failures keep the pre-gh-1106 surface
    // byte-identical (REG-1).
    var WF_APP_ERR = 'Tool execution failed: gh: refusing to allow a GitHub App to create or update ' +
        'workflow `.github/workflows/ci.yml` without `workflows` permission';
    var WF_OAUTH_ERR = 'gh: refusing to allow an OAuth App to create or update workflow ' +
        '`ci.yml` without `workflow` scope';

    test('UT-4/AC6: workflows rejection escalates ONCE with the escalation token, then restores', function () {
        var calls = [];
        var n = 0;
        var p = loadProvider('github', {
            cli_execute_command: function (a) {
                calls.push(['gh', a.command]);
                if (++n === 1) throw new Error(WF_APP_ERR); // silent attempt refused
                return 'updated';                            // escalated attempt succeeds
            },
            set_env_variable: function (k, v) { calls.push(['env', k, v]); }
        });
        var out = p.silentUpdateBranch(7, 'SILENT', 'RESTORE', 'ESCALATE');
        assert.equal(out, 'updated', 'the escalated update result propagates');
        assert.deepEqual(calls, [
            ['env', 'GH_TOKEN', 'SILENT'],
            ['gh', 'gh pr update-branch 7 --repo mygroup/my-repo'],   // refused (workflows class)
            ['env', 'GH_TOKEN', 'ESCALATE'],
            ['gh', 'gh pr update-branch 7 --repo mygroup/my-repo'],   // exactly ONE escalated attempt (AC1)
            ['env', 'GH_TOKEN', 'SILENT'],                            // AC7: swap undone before the outer restore
            ['env', 'GH_TOKEN', 'RESTORE']
        ]);
    });

    test('UT-4: the escalated attempt ALSO refused with the workflows class → DISTINCT error naming the capability', function () {
        var calls = [];
        var p = loadProvider('github', {
            cli_execute_command: function () { calls.push(['gh']); throw new Error(WF_OAUTH_ERR); },
            set_env_variable: function (k, v) { calls.push(['env', k, v]); }
        });
        var threw = null;
        try { p.silentUpdateBranch(8, 'SILENT', 'RESTORE', 'ESCALATE'); }
        catch (e) { threw = e; }
        assert.ok(threw, 'the failure surfaces');
        assert.ok(threw.message.indexOf('workflow-write token') !== -1 &&
                  threw.message.indexOf('gh-1106') !== -1,
            'the error names the missing token capability, not "edits revoked"');
        assert.equal(calls.filter(function (c) { return c[0] === 'gh'; }).length, 2,
            'one silent + one escalated attempt — no infinite retries (E1)');
        assert.deepEqual(calls.slice(-2), [
            ['env', 'GH_TOKEN', 'SILENT'],
            ['env', 'GH_TOKEN', 'RESTORE']
        ], 'AC7: the env is restored even on the double refusal');
    });

    test('UT-4/E1: workflows refusal with NO escalation token wired → distinct error, no second attempt', function () {
        var calls = [];
        var p = loadProvider('github', {
            cli_execute_command: function () { calls.push(['gh']); throw new Error(WF_APP_ERR); },
            set_env_variable: function (k, v) { calls.push(['env', k, v]); }
        });
        var threw = null;
        try { p.silentUpdateBranch(9, 'SILENT', 'RESTORE'); }
        catch (e) { threw = e; }
        assert.ok(threw && threw.message.indexOf('workflow-write token') !== -1,
            'the capability gap is named');
        assert.equal(calls.filter(function (c) { return c[0] === 'gh'; }).length, 1,
            'no escalation without a token to escalate with');
    });

    test('REG-1: a non-workflows rejection keeps the pre-gh-1106 surface byte-identical (no escalation, no env churn)', function () {
        var calls = [];
        var p = loadProvider('github', {
            cli_execute_command: function () {
                calls.push(['gh']);
                throw new Error(' ! [remote rejected] HEAD:main (protected branch hook declined)');
            },
            set_env_variable: function (k, v) { calls.push(['env', k, v]); }
        });
        var threw = null;
        try { p.silentUpdateBranch(10, 'SILENT', 'RESTORE', 'ESCALATE'); }
        catch (e) { threw = e; }
        assert.ok(threw && threw.message.indexOf('protected branch hook declined') !== -1,
            'the original error propagates untouched');
        assert.deepEqual(calls, [
            ['env', 'GH_TOKEN', 'SILENT'],
            ['gh'],
            ['env', 'GH_TOKEN', 'RESTORE']
        ], 'no escalated attempt, no extra swap — the classic failure shape');
    });

    test('github: reviewThreadList skips null nodes (characterization)', function () {
        var p = loadProvider('github', {
            github_get_pr_review_threads: function () {
                return { data: { repository: { pullRequest: { reviewThreads: { nodes: [
                    null,
                    { id: 't1', isResolved: true, path: 'a.js', line: 7,
                      comments: { nodes: [{ databaseId: 5, author: { login: 'ann' }, body: 'pls fix' }] } }
                ] } } } } };
            }
        });
        assert.deepEqual(p.reviewThreadList(9), [
            { threadId: 't1', rootCommentId: 5, resolved: true, author: 'ann',
              body: 'pls fix', path: 'a.js', line: 7 }
        ]);
    });

    // ── gitlab provider methods ──────────────────────────────────────────

    test('gitlab: findPr — opened by source_branch, opened by description ref, merged, null (characterization)', function () {
        var listCalls = { opened: 0, merged: 0 };
        var p = loadProvider('gitlab', {
            gitlab_list_mrs: function (args) {
                if (args.state === 'opened') {
                    listCalls.opened++;
                    return [
                        { iid: 10, source_branch: 'ai/gh-10', description: 'x' },
                        { iid: 11, source_branch: 'zz', description: 'Fixes #11 for good' }
                    ];
                }
                listCalls.merged++;
                return [{ iid: 5, source_branch: 'ai/gh-5' }];
            }
        });
        assert.deepEqual(p.findPr(10, 'ai/gh-'), { number: 10, state: 'OPEN', branch: 'ai/gh-10' });
        assert.deepEqual(p.findPr(11, 'ai/gh-'), { number: 11, state: 'OPEN', branch: 'zz' });
        assert.deepEqual(p.findPr(5, 'ai/gh-'), { number: 5, state: 'MERGED', branch: 'ai/gh-5' });
        assert.equal(p.findPr(999, 'ai/gh-'), null);
        // gitlab has no per-tick list cache: every findPr re-fetches
        assert.equal(listCalls.opened, 4);
        assert.equal(listCalls.merged, 2);
    });

    test('gitlab: listMachineIssues — an issue matching neither assignee nor labels is excluded', function () {
        var p = loadProvider('gitlab', {
            gitlab_list_issues: function () {
                return { issues: [
                    { iid: 1, title: 'mine', labels: ['agent:dev'], assignees: [] },
                    { iid: 2, title: 'other', labels: ['trivial'], assignees: [{ username: 'human' }] }
                ] };
            }
        });
        var issues = p.listMachineIssues(['agent:dev'], 'bot', 50);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].number, 1);
        assert.equal(issues[0].title, 'mine');
    });

    test('gitlab: prStatus — checking reads UNKNOWN; conflicts read BEHIND even when can_be_merged; empty pipelines read none', function () {
        var mr = { state: 'opened', merge_status: 'checking', has_conflicts: false,
                   author: { username: 'bot' } };
        var p = loadProvider('gitlab', {
            gitlab_get_mr: function () { return mr; },
            gitlab_get_mr_pipelines: function () { return { pipelines: [] }; }
        });
        var st = p.prStatus(6);
        assert.equal(st.mergeState, 'UNKNOWN');
        assert.equal(st.checkConclusion, 'none');
        assert.equal(st.author, 'bot');
        mr = { state: 'opened', merge_status: 'can_be_merged', has_conflicts: true };
        var st2 = p.prStatus(7);
        assert.equal(st2.mergeState, 'BEHIND');
        assert.equal(st2.mergeable, false);
    });

    test('gitlab: pipeline status map — running/pending/created/waiting_for_resource read pending (characterization)', function () {
        var pipelines = [{ status: 'running' }, { status: 'success' }];
        var p = loadProvider('gitlab', {
            gitlab_get_mr: function () { return { state: 'opened', merge_status: 'checking' }; },
            gitlab_get_mr_pipelines: function () { return { pipelines: pipelines }; }
        });
        assert.equal(p.prStatus(8).checkConclusion, 'pending');
        pipelines = [{ status: 'waiting_for_resource' }];
        assert.equal(p.prStatus(9).checkConclusion, 'pending');
    });

    test('gitlab: merge/updateBranch/addIssueLabel tool shapes (characterization)', function () {
        var calls = [];
        var p = loadProvider('gitlab', {
            gitlab_merge_mr: function (a) { calls.push(['merge', a]); return 'merged'; },
            gitlab_rebase_mr: function (a) { calls.push(['rebase', a]); return 'rebased'; },
            gitlab_add_mr_label: function (a) { calls.push(['label', a]); return 'ok'; }
        });
        p.merge(21);
        p.updateBranch(22);
        p.addIssueLabel(23, 'machine');
        assert.deepEqual(calls, [
            ['merge', { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '21' }],
            ['rebase', { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '22' }],
            ['label', { workspace: 'mygroup', repository: 'my-repo', pullRequestId: '23', label: 'machine' }]
        ]);
    });

    test('gitlab: closeIssue warns, posts the note when a comment is given, stays non-fatal on note failure', function () {
        var notes = [];
        var p = loadProvider('gitlab', {
            gitlab_create_mr_note: function (a) { notes.push(a); return 'ok'; }
        });
        var warnings = captureWarn(function () {
            assert.equal(p.closeIssue(4, 'bye'), null);
        });
        assert.equal(warnings.length, 1);
        assert.contains(warnings[0], 'gitlab close-issue tool not available');
        assert.deepEqual(notes, [{ workspace: 'mygroup', repository: 'my-repo',
                                  pullRequestId: '4', text: 'bye' }]);
        var p2 = loadProvider('gitlab', {
            gitlab_create_mr_note: function () { throw new Error('boom'); }
        });
        warnings = captureWarn(function () {
            assert.equal(p2.closeIssue(5, 'x'), null);
        });
        assert.equal(warnings.length, 2);
        assert.contains(warnings[1], 'close-issue comment failed');
    });
});

suite('smProvider: listOpenPrsLive — gh-1000 phantom-heal probe surface', function () {

    var MOD = 'js/common/smProvider.js';

    function loadGithub(payloads) {
        var listCalls = 0;
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {
            github_list_prs: function (args) {
                listCalls++;
                var idx = Math.min(listCalls - 1, payloads.length - 1);
                assert.equal(args.state, 'open', 'the probe reads the OPEN list');
                return JSON.stringify(payloads[idx]);
            }
        });
        mod._cache.entries = {}; // fresh holder
        var provider = mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
        return { mod: mod, provider: provider, listCalls: function () { return listCalls; } };
    }

    test('listOpenPrsLive bypasses the stale per-tick cache AND refreshes the entry', function () {
        // The phantom-holder self-heal probe must see the LIVE label layer
        // even when the per-tick ioCache holds a stale arm — and after a
        // self-heal the rest of the tick must read the corrected layer
        // without another fetch. (CI: this coverage holds githubProvider
        // inside the released CRAP baseline — do not delete.)
        var h = loadGithub([
            [{ number: 1, labels: ['ai_validating'] }],
            [{ number: 2, labels: [] }]
        ]);
        var first = h.provider.listOpenPrs();
        assert.equal(first[0].number, 1, 'first read fetches and caches');
        assert.equal(h.listCalls(), 1);

        h.provider.listOpenPrs();
        assert.equal(h.listCalls(), 1, 'the cached read rides the per-tick cache');

        var live = h.provider.listOpenPrsLive();
        assert.equal(h.listCalls(), 2, 'the LIVE re-read always fetches (cache bypass)');
        assert.equal(live[0].number, 2, 'the fresh layer wins over the stale cached arm');

        var after = h.provider.listOpenPrs();
        assert.equal(after[0].number, 2, 'the live fetch refreshed the cache entry');
        assert.equal(h.listCalls(), 2, 'no third fetch — the refreshed cache hits');
    });

    test('listOpenPrsLive is exposed on the github facade next to the cached reader', function () {
        var h = loadGithub([[]]);
        assert.equal(typeof h.provider.listOpenPrsLive, 'function',
            'the phantom-heal guard in githubSource.livePrItems names a real facade method');
        assert.equal(typeof h.provider.listOpenPrs, 'function');
    });
});

suite('smProvider — gh-1070 maintainer-edits probe resolver', function () {

    var MOD = 'js/common/smProvider.js';

    test('github: one shared resolver covers every maintainerCanModify payload dialect', function () {
        // gh-1070: update_branch probes "Allow edits from maintainers"
        // before pushing to a fork head. REST /pulls spells the field
        // maintainer_can_modify, GraphQL maintainerCanModify — ONE
        // exported resolver (gh-1059 pattern), consumed by githubSource
        // on the PR-list path and by smAgent on the fresh-probe path.
        var mod = loadModule(MOD, makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, {}), {});
        var mcm = mod.ghPrMaintainerCanModify;
        assert.equal(typeof mcm, 'function', 'the resolver is exported for consumers');
        assert.equal(mcm({ maintainer_can_modify: true }), true, 'REST dialect: editable');
        assert.equal(mcm({ maintainer_can_modify: false }), false, 'REST dialect: not editable');
        assert.equal(mcm({ maintainerCanModify: true }), true, 'GraphQL dialect: editable');
        assert.equal(mcm({ maintainerCanModify: false }), false, 'GraphQL dialect: not editable');
        assert.equal(mcm({}), null, 'a payload WITHOUT the field resolves to null (re-probe, fail closed)');
        assert.equal(mcm(null), null, 'no PR at all resolves to null');
        assert.equal(mcm({ maintainer_can_modify: 'true' }), null,
            'a non-boolean value is not a probe verdict');
    });
});

// ── gh-1221 CRAP characterization: createSmProvider config table ─────────────
// Pins the factory contract the helper split must preserve: every preseed leg
// lands in the shared per-tick cache, the provider dispatch table and the
// exact thrown errors for a malformed config.
suite('smProvider — gh-1221 createSmProvider characterization', function () {

    var GH1221_MOD = 'js/common/smProvider.js';

    function gh1221Load(mocks) {
        return loadModule(GH1221_MOD,
            makeRequire({ './reviewVerdicts.js': rvReal(), './validationLiveness.js': vlReal() }, mocks || {}),
            mocks || {});
    }

    test('preseed rehydrates all four cache legs in one factory call', function () {
        var listCalls = 0, branchCalls = 0;
        var mod = gh1221Load({
            github_list_prs: function () { listCalls++; return []; },
            github_list_branches: function () { branchCalls++; return []; }
        });
        var p = mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' },
            preseed: {
                openPrs: [{ number: 9, head: { label: 'mygroup:ai/gh-9', ref: 'ai/gh-9' }, body: '' }],
                mergedPrs: [],
                branchHeads: { main: 'basesha' },
                prStatus: { '3': { number: 3, state: 'OPEN', checks: 'success', mergeState: 'CLEAN' } }
            }
        });
        assert.equal((p.findPr(9, 'ai/gh-') || {}).number, 9, 'openPrs leg: findPr resolves preseeded');
        assert.equal(listCalls, 0, 'openPrs/mergedPrs legs: github_list_prs never called');
        var st = p.prStatus(3);
        assert.equal(st.mergeState, 'CLEAN', 'prStatus leg: memoized status rides the preseed');
        assert.equal(branchCalls, 0, 'prStatus leg: no branch fetch for a memoized status');
    });

    test('the provider dispatch table stays exact (github default, gitlab opt-in)', function () {
        var gh = gh1221Load({}).createSmProvider({
            scm: {}, repository: { owner: 'mygroup', repo: 'my-repo' }
        });
        assert.equal(gh.provider, 'github', 'no scm.provider → github');
        var gl = gh1221Load({}).createSmProvider({
            scm: { provider: 'gitlab' }, repository: { owner: 'mygroup', repo: 'my-repo' }
        });
        assert.equal(gl.provider, 'gitlab', 'explicit gitlab → gitlab');
    });

    test('malformed configs throw the exact contract errors before any provider is built', function () {
        var mod = gh1221Load({});
        var errs = [];
        try { mod.createSmProvider({ scm: { provider: 'github' } }); } catch (e) { errs.push(e.message); }
        try { mod.createSmProvider({ scm: { provider: 'github' }, repository: { owner: 'o' } }); } catch (e) { errs.push(e.message); }
        try { mod.createSmProvider({ scm: { provider: 'gopher' }, repository: { owner: 'o', repo: 'r' } }); } catch (e) { errs.push(e.message); }
        assert.deepEqual(errs, [
            'smProvider: repository.owner and repository.repo are required',
            'smProvider: repository.owner and repository.repo are required',
            'smProvider: unknown provider "gopher" (github | gitlab)'
        ], 'repository validation precedes the provider dispatch; unknown forges throw');
    });
});
