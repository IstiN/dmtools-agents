/**
 * Unit tests: sm GitHub state source (js/sm/sources/githubSource.js) —
 * the issue/PR query vocabulary behind source:'github' sm rules.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('sm github source', function () {

    var src;


    var providerStub = {
        findPr: function (n) { return providerStub._prs[n] || null; },
        prStatus: function (n) { return providerStub._status[n] || null; },
        lastReview: function (n) { return providerStub._reviews[n] || null; },
        reviewThreads: function (n) { return providerStub._threads[n] || null; },
        _prs: {},
        _status: {},
        _reviews: {},
        _threads: {}
    };

    function load(tools, prs, statuses, reviews, threads) {
        providerStub._prs = prs || {};
        providerStub._status = statuses || {};
        providerStub._reviews = reviews || {};
        providerStub._threads = threads || {};
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return providerStub; }
            }
        }), tools);
    }

    test('issue rules: per-label OR search, linked-PR enrichment, guards', function () {
        var queries = [];
        var srcMod = load({
            github_search_issues: function (args) {
                queries.push(args.query);
                if (args.query.indexOf('agent:rework') !== -1) {
                    return { items: [{ number: 125, labels: [{ name: 'agent:rework' }] }] };
                }
                return { items: [] };
            }
        }, {
            125: { number: 127, state: 'OPEN' }
        }, {
            127: { number: 127, state: 'OPEN', checks: 'red',
                   mergeState: 'BLOCKED', mergeable: false }
        });

        var items = srcMod.query({
            source: 'github',
            query: { type: 'issue', labels: ['agent:rework', 'agent:dev'], prChecks: 'red' }
        }, { repoInfo: { owner: 'epam', repo: 'dmtools-dart' } });

        assert.equal(items.length, 1);
        assert.equal(items[0].key, 'gh-125');
        assert.equal(items[0].prNumber, 127);
        assert.equal(items[0].pr.checks, 'red');
        // per-label OR queries were issued
        assert.equal(queries.length, 2);
        assert.equal(queries.some(function (q) { return q.indexOf('label:"agent:rework"') !== -1; }), true);
    });

    test('issue rules: FIFO — oldest issue first, limit slices from the head', function () {
        // Live starvation (owner report): github_search_issues returns
        // newest-first and limit:1 rules took the head — the oldest
        // machine-loop issue rotted at the bottom of the queue while
        // newer ones were worked. Mirrors the PR-carrier FIFO fix.
        var srcMod = load({
            github_search_issues: function () {
                return { items: [
                    { number: 9, labels: [{ name: 'agent:dev' }] },
                    { number: 5, labels: [{ name: 'agent:dev' }] },
                    { number: 3, labels: [{ name: 'agent:dev' }] }
                ] };
            }
        });
        var items = srcMod.query({
            query: { type: 'issue', labels: ['agent:dev'] }, limit: 2
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.map(function (i) { return i.key; }).join(','), 'gh-3,gh-5',
            'oldest first, limit slices from the head');

        var one = srcMod.query({
            query: { type: 'issue', labels: ['agent:dev'] }, limit: 1
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(one.length, 1);
        assert.equal(one[0].key, 'gh-3', 'limit:1 picks the OLDEST issue, not the newest');
    });

    test('issue rules: green guard drops red-PR items', function () {
        var srcMod = load({
            github_search_issues: function () {
                return { items: [{ number: 1, labels: [{ name: 'ai_developed' }] }] };
            }
        }, {
            1: { number: 10, state: 'OPEN' }
        }, {
            10: { number: 10, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false }
        });
        var items = srcMod.query({
            query: { type: 'issue', labels: ['ai_developed'], prChecks: 'green' }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0);
    });

    test('issue rules: prLabels/notPrLabels read the linked PR labels (#687 machine loop)', function () {
        // The machine loop pins ai_pr_reviewed on the PR, never on the
        // issue — review-after-dev must gate on the PR-side label or it
        // re-dispatches a review every tick.
        var srcMod = load({
            github_search_issues: function () {
                return { items: [{ number: 2, labels: [{ name: 'ai_developed' }] }] };
            }
        }, {
            2: { number: 20, state: 'OPEN' }
        }, {
            20: { number: 20, state: 'OPEN', checks: 'green', mergeState: 'CLEAN',
                  mergeable: true, labels: ['ai_pr_reviewed'] }
        });
        var filtered = srcMod.query({
            query: { type: 'issue', labels: ['ai_developed'], notPrLabels: ['ai_pr_reviewed'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(filtered.length, 0, 'PR already reviewed — rule must not match');

        var statuses = {};
        statuses[20] = { number: 20, state: 'OPEN', checks: 'green', mergeState: 'CLEAN',
                         mergeable: true, labels: [] };
        var srcMod2 = load({
            github_search_issues: function () {
                return { items: [{ number: 2, labels: [{ name: 'ai_developed' }] }] };
            }
        }, { 2: { number: 20, state: 'OPEN' } }, statuses);
        var fresh = srcMod2.query({
            query: { type: 'issue', labels: ['ai_developed'], notPrLabels: ['ai_pr_reviewed'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(fresh.length, 1, 'unreviewed PR matches');
    });

    test('issue rules: notLabels filters', function () {
        var srcMod = load({
            github_search_issues: function () {
                return { items: [{ number: 2, labels: [{ name: 'ai_developed' }, { name: 'ai_pr_reviewed' }] }] };
            }
        }, {}, {});
        var items = srcMod.query({
            query: { type: 'issue', labels: ['ai_developed'], notLabels: ['ai_pr_reviewed'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0);
    });

    test('pr rules: label guards + checks + mergeable, PRs without issues', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 41, labels: [{ name: 'pr_approved' }], head: { ref: 'feat/x' }, draft: false },
                    { number: 42, labels: [{ name: 'pr_approved' }], head: { ref: 'feat/y' }, draft: false },
                    { number: 43, labels: [], head: { ref: 'feat/z' }, draft: false }
                ];
            }
        }, {}, {
            41: { number: 41, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true },
            42: { number: 42, state: 'OPEN', checks: 'green', mergeState: 'BEHIND', mergeable: true },
            43: null
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'], checks: 'green', mergeable: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        // 41 CLEAN + 42 BEHIND are both green+mergeable; 43 has no label
        assert.equal(items.length, 2);
        assert.equal(items[0].key, 'pr-41');
        assert.equal(items[1].key, 'pr-42');
    });

    test('pr rules: FIFO — API newest-first list drains oldest mergeable first', function () {
        // GitHub list_prs returns newest-first (API default). The queue must
        // still drain oldest-to-newest: under limit:1 a newest-first order
        // would starve older approved PRs. Blocked candidates (conflict,
        // red) are guard-filtered, so the head is the oldest MERGEABLE PR.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 57, labels: [{ name: 'pr_approved' }], head: { ref: 'feat/new' }, draft: false },
                    { number: 56, labels: [{ name: 'pr_approved' }], head: { ref: 'feat/mid' }, draft: false },
                    { number: 55, labels: [{ name: 'pr_approved' }], head: { ref: 'feat/old' }, draft: false }
                ];
            }
        }, {}, {
            55: { number: 55, state: 'OPEN', checks: 'green', mergeState: 'CONFLICTING', mergeable: false },
            56: { number: 56, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true },
            57: { number: 57, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'], checks: 'green', mergeable: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        // 55 is conflicted → guard-skipped; 56 (older) heads the queue
        // ahead of 57 despite the API listing 57 first.
        assert.equal(items.length, 2);
        assert.equal(items[0].key, 'pr-56');
        assert.equal(items[1].key, 'pr-57');
    });

    test('pr rules: notMergeState array — oldest DIRTY/BEHIND skipped, next approved flows (owner FIFO)', function () {
        // Owner rule: the oldest approved PR leads to merge; advance past
        // it only while it is conflicted (rework) or behind (refreshing).
        // Array notMergeState must exclude BOTH from one rule.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 10, labels: [{ name: 'pr_approved' }], head: { ref: 'a' }, draft: false },
                    { number: 11, labels: [{ name: 'pr_approved' }], head: { ref: 'b' }, draft: false },
                    { number: 12, labels: [{ name: 'pr_approved' }], head: { ref: 'c' }, draft: false }
                ];
            }
        }, {}, {
            10: { number: 10, state: 'OPEN', checks: 'green', mergeState: 'DIRTY', mergeable: false },
            11: { number: 11, state: 'OPEN', checks: 'green', mergeState: 'BEHIND', mergeable: true },
            12: { number: 12, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'], notMergeState: ['BEHIND', 'DIRTY'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1);
        assert.equal(items[0].key, 'pr-12', 'conflicted 10 and behind 11 skipped; fresh 12 flows');
    });

    test('pr rules: mutex — rule defers while another PR holds the label', function () {
        // Live FIFO violation (owner report, fa 2026-09-22): #778/#779 both
        // ai_validating while older #762 waited — parallel validations
        // re-churn on every merge. With mutex, validate-armed returns
        // nothing while ANY PR holds ai_validating: one dispatch at a time.
        var listCalls = 0;
        function mk(holdsLabel) {
            return function () {
                listCalls++;
                return [
                    { number: 10, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-10' }, draft: false },
                    { number: 11, labels: holdsLabel
                        ? [{ name: 'ai_validating' }, { name: 'pr_approved' }]
                        : [{ name: 'other' }], head: { ref: 'ai/gh-11' }, draft: false }
                ];
            };
        }
        var held = load({ github_list_prs: mk(true) }, {}, {});
        var items = held.query({
            query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                     mutex: 'ai_validating' }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0);

        var free = load({ github_list_prs: mk(false) }, {}, {});
        items = free.query({
            query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                     mutex: 'ai_validating' }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        // No holder → oldest approved candidate flows through
        assert.equal(items.length, 1);
        assert.equal(items[0].key, 'pr-10');
    });
    test('pr rules: branchPrefix and draft filters', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 51, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-9' }, draft: false },
                    { number: 52, labels: [{ name: 'pr_approved' }], head: { ref: 'manual/branch' }, draft: false },
                    { number: 53, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-10' }, draft: true }
                ];
            }
        }, {}, {});
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'], branchPrefix: 'ai/gh-', draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1);
        assert.equal(items[0].key, 'pr-51');
    });

    test('pr rules: #687 lifecycle guards — notAuthors, notMergeState, live checkConclusion', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 61, labels: [{ name: 'pr_approved' }], draft: false,
                      author: { login: 'vabhzw17eg2qu4m9-bit' } },
                    { number: 62, labels: [{ name: 'pr_approved' }], draft: false,
                      author: { login: 'human-contributor' } },
                    { number: 63, labels: [{ name: 'pr_approved' }], draft: false,
                      author: { login: 'human-contributor' } },
                    { number: 64, labels: [{ name: 'ai_validating' }], draft: false,
                      author: { login: 'human-contributor' } }
                ];
            }
        }, {}, {
            // Live provider shape: checkConclusion (not the stub's `checks`).
            61: { state: 'OPEN', checkConclusion: 'green', mergeState: 'BEHIND', mergeable: true },
            62: { state: 'OPEN', checkConclusion: 'green', mergeState: 'BLOCKED', mergeable: true },
            63: { state: 'OPEN', checkConclusion: 'green', mergeState: 'CLEAN', mergeable: true },
            64: { state: 'OPEN', checkConclusion: 'red', mergeState: 'BLOCKED', mergeable: true }
        });

        // review-external-once: machine author excluded via the deployment
        // knob (ctx.machineAuthor; no login in the agents repo), drafts
        // excluded, ai_pr_reviewed not yet set, green checks required.
        var ext = srcMod.query({
            query: { type: 'pr', notMachine: true,
                     notLabels: ['ai_pr_reviewed'], checks: 'green', draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'vabhzw17eg2qu4m9-bit' });
        assert.equal(ext.map(function (i) { return i.key; }).join(','), 'pr-62,pr-63');

        // Same query without a configured machineAuthor: guard inert —
        // machine PRs are reviewable too (deployment must set the knob).
        var noKnob = srcMod.query({
            query: { type: 'pr', notMachine: true, checks: 'green' }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(noKnob.map(function (i) { return i.key; }).join(','), 'pr-61,pr-62,pr-63');

        // Generic notAuthors still works for explicit lists.
        var listed = srcMod.query({
            query: { type: 'pr', notAuthors: ['human-contributor'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(listed.map(function (i) { return i.key; }).join(','), 'pr-61');

        // silent-update-behind rule shape lives in its own test below
        // (broader fixture).

        // validate-armed: armed, not validating, not BEHIND (fresh enough).
        var fresh = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                     notMergeState: 'BEHIND', draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(fresh.map(function (i) { return i.key; }).join(','), 'pr-62,pr-63');

        // fail-validation: labels are OR-matched, so the rule keys on
        // ai_validating alone (it only ever lands on armed PRs).
        var failed = srcMod.query({
            query: { type: 'pr', labels: ['ai_validating'], checks: 'red' }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(failed.map(function (i) { return i.key; }).join(','), 'pr-64');
    });

    test('pr rules: silent-update-behind — free freshness for every behind PR', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    // armed + behind (the old silent-update-armed case)
                    { number: 61, labels: [{ name: 'pr_approved' }], draft: false,
                      author: { login: 'vabhzw17eg2qu4m9-bit' } },
                    // bare behind PR, no labels at all — still freshened
                    { number: 65, labels: [], draft: false,
                      author: { login: 'human-contributor' } },
                    // behind but validating: head must not move mid-run
                    { number: 66, labels: [{ name: 'ai_validating' }], draft: false,
                      author: { login: 'vabhzw17eg2qu4m9-bit' } },
                    // behind but draft: skipped
                    { number: 67, labels: [], draft: true,
                      author: { login: 'human-contributor' } },
                    // fresh PR: not behind
                    { number: 68, labels: [], draft: false,
                      author: { login: 'human-contributor' } }
                ];
            }
        }, {}, {
            61: { state: 'OPEN', checkConclusion: 'green', mergeState: 'BEHIND', mergeable: true },
            65: { state: 'OPEN', checkConclusion: 'none', mergeState: 'BEHIND', mergeable: true },
            66: { state: 'OPEN', checkConclusion: 'none', mergeState: 'BEHIND', mergeable: true },
            67: { state: 'OPEN', checkConclusion: 'none', mergeState: 'BEHIND', mergeable: true },
            68: { state: 'OPEN', checkConclusion: 'none', mergeState: 'CLEAN', mergeable: true }
        });

        var behind = srcMod.query({
            query: { type: 'pr', notLabels: ['ai_validating'],
                     mergeState: 'BEHIND', draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(behind.map(function (i) { return i.key; }).join(','), 'pr-61,pr-65');

        // Array mergeState: BEHIND or BLOCKED (REST flip-flops under
        // branch protection; update-branch no-ops when fresh).
        var anyBehind = srcMod.query({
            query: { type: 'pr', mergeState: ['BEHIND', 'BLOCKED'], draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(anyBehind.map(function (i) { return i.key; }).join(','),
                     'pr-61,pr-65,pr-66');
    });

    test('pr rules: REST list shape — creator rides `user`, not `author`', function () {
        // Live REST /pulls has NO author key; the creator is `user`.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 71, labels: [], draft: false,
                      user: { login: 'vabhzw17eg2qu4m9-bit' } },
                    { number: 72, labels: [], draft: false,
                      user: { login: 'human-contributor' } }
                ];
            }
        }, {}, {
            71: { state: 'OPEN', checkConclusion: 'green', mergeState: 'CLEAN', mergeable: true },
            72: { state: 'OPEN', checkConclusion: 'green', mergeState: 'CLEAN', mergeable: true }
        });
        var machine = srcMod.query({
            query: { type: 'pr', notMachine: true, checks: 'green' }
        }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'vabhzw17eg2qu4m9-bit' });
        assert.equal(machine.map(function (i) { return i.key; }).join(','), 'pr-72');
    });

    test('pr rules: reviewStale — CHANGES_REQUESTED on an older head re-matches after fixes', function () {
        // Live shape (flutter_agent_harness PR #690): the verdict
        // (CHANGES_REQUESTED) was rendered on commit 'old123' while fixes
        // moved the head to 'new456' and checks went green — a re-review
        // is owed. Fresh verdicts (commit == head), stale APPROVED
        // verdicts, and never-reviewed PRs must NOT match.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 41, labels: [], head: { ref: 'feat/a' }, draft: false },
                    { number: 42, labels: [], head: { ref: 'feat/b' }, draft: false },
                    { number: 43, labels: [], head: { ref: 'feat/c' }, draft: false },
                    { number: 44, labels: [], head: { ref: 'feat/d' }, draft: false }
                ];
            }
        }, {}, {
            41: { number: 41, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'new456' },
            42: { number: 42, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'new456' },
            43: { number: 43, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'new456' },
            44: { number: 44, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'new456' }
        }, {
            41: { state: 'CHANGES_REQUESTED', commitId: 'old123' },
            42: { state: 'CHANGES_REQUESTED', commitId: 'new456' },
            43: { state: 'APPROVED', commitId: 'old123' }
            // 44: never reviewed
        });
        var items = srcMod.query({
            query: { type: 'pr', checks: 'green', draft: false, reviewStale: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        // 41 stale CHANGES → match; 42 verdict on the current head → no;
        // 43 stale but APPROVED → no; 44 no reviews → no.
        assert.equal(items.length, 1);
        assert.equal(items[0].key, 'pr-41');
    });

    test('pr rules: threadsResolved + staleVerdict — resolved threads after fixes re-review once per head', function () {
        // Live shape (flutter_agent_harness PR #676): the rework resolved
        // every review thread, so the CHANGES_REQUESTED verdict dissolved
        // into COMMENTED — verdict-staleness alone misses it. The rule
        // matches only while BOTH hold: all threads resolved AND the last
        // verdict predates the head. After the re-review the verdict lands
        // on the current head → never re-arms (no loop).
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 61, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'feat/a' }, draft: false },
                    { number: 62, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'feat/b' }, draft: false },
                    { number: 63, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'feat/c' }, draft: false },
                    { number: 64, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'feat/d' }, draft: false },
                    { number: 65, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'feat/e' }, draft: false }
                ];
            }
        }, {}, {
            61: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'head61' },
            62: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'head62' },
            63: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'head63' },
            64: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'head64' },
            65: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true, headSha: 'head65' }
        }, {
            61: { state: 'COMMENTED', commitId: 'old61' },
            62: { state: 'COMMENTED', commitId: 'old62' },
            63: { state: 'COMMENTED', commitId: 'old63' },
            64: { state: 'COMMENTED', commitId: 'head64' }
            // 65: never reviewed
        }, {
            61: { total: 3, resolved: 3, unresolved: 0 },
            62: { total: 3, resolved: 2, unresolved: 1 },
            63: { total: 0, resolved: 0, unresolved: 0 },
            64: { total: 2, resolved: 2, unresolved: 0 }
            // 65: no threads entry
        });
        var items = srcMod.query({
            query: {
                type: 'pr', labels: ['ai_pr_reviewed'],
                notLabels: ['agent:review'], checks: 'green', draft: false,
                threadsResolved: true, staleVerdict: true
            }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        // 61 resolved+stale → match; 62 has an unresolved thread → no;
        // 63 no threads → no; 64 resolved but the verdict is on the
        // current head (fresh re-review already happened) → no;
        // 65 never reviewed → no.
        assert.equal(items.length, 1);
        assert.equal(items[0].key, 'pr-61');
    });

    test('pr rules: prMachineAuthor — auto legs fire only on machine-authored PRs', function () {
        // Owner rule: rework-style auto legs must never fire on a
        // human-authored PR, and with no machineAuthor configured the gate
        // fails CLOSED (no auto legs at all — unlike notMachine, which is
        // inert without the knob).
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 81, labels: [{ name: 'pr_changes_requested' }], draft: false,
                      author: { login: 'vabhzw17eg2qu4m9-bit' } },
                    { number: 82, labels: [{ name: 'pr_changes_requested' }], draft: false,
                      author: { login: 'human-contributor' } }
                ];
            }
        });

        var mine = srcMod.query({
            query: { type: 'pr', labels: ['pr_changes_requested'], prMachineAuthor: true }
        }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'vabhzw17eg2qu4m9-bit' });
        assert.equal(mine.map(function (i) { return i.key; }).join(','), 'pr-81');

        var noKnob = srcMod.query({
            query: { type: 'pr', labels: ['pr_changes_requested'], prMachineAuthor: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(noKnob.length, 0, 'no machineAuthor configured — gate fails closed');
    });

    test('pr rules: linked issue resolves from the PR body (closing keyword, bare #N, none)', function () {
        // The manual rework rule (rework-on-label) dispatches an
        // issue-anchored leg for a PR-carrier match — the {issueNumber}
        // input needs this link.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 91, labels: [{ name: 'agent:rework' }], draft: false,
                      body: 'Closes #123\n\nSome description' },
                    { number: 92, labels: [{ name: 'agent:rework' }], draft: false,
                      body: 'Related to #45, no closing keyword' },
                    { number: 93, labels: [{ name: 'agent:rework' }], draft: false,
                      body: 'no reference at all' }
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:rework'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        var byPr = {};
        items.forEach(function (i) { byPr[i.prNumber] = i.issueNumber; });
        assert.equal(byPr[91], 123, 'closing keyword resolves');
        assert.equal(byPr[92], 45, 'bare #N mention resolves (findPr convention)');
        assert.equal(byPr[93], null, 'no reference → null (dispatch skips loudly)');
    });

    test('issue rules: prMachineAuthor reads the linked PR author (prStatus)', function () {
        // Issue-anchored rework rules carry the state on the issue but the
        // author fact lives on the enriched PR — the gate reads it from
        // provider.prStatus (item.author is an issue-side field there).
        var srcMod = load({
            github_search_issues: function () {
                return { items: [
                    { number: 3, labels: [{ name: 'agent:rework' }] },
                    { number: 4, labels: [{ name: 'agent:rework' }] }
                ] };
            }
        }, {
            3: { number: 30, state: 'OPEN' },
            4: { number: 40, state: 'OPEN' }
        }, {
            30: { number: 30, state: 'OPEN', checks: 'green', mergeState: 'CLEAN',
                  mergeable: true, author: 'vabhzw17eg2qu4m9-bit' },
            40: { number: 40, state: 'OPEN', checks: 'green', mergeState: 'CLEAN',
                  mergeable: true, author: 'human-contributor' }
        });

        var items = srcMod.query({
            query: { type: 'issue', labels: ['agent:rework'], prMachineAuthor: true }
        }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'vabhzw17eg2qu4m9-bit' });
        assert.equal(items.map(function (i) { return i.key; }).join(','), 'gh-3');

        var noKnob = srcMod.query({
            query: { type: 'issue', labels: ['agent:rework'], prMachineAuthor: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(noKnob.length, 0, 'no machineAuthor configured — gate fails closed');
    });

    test('pr rules: checks accepts an array (dispatch-CI bridge reports pending on fresh heads)', function () {
        // With dispatch-only CI, a pull_request-triggered bridge workflow
        // holds PENDING check runs on every fresh head while it waits for
        // the SM's dispatched run — "no validation yet" is 'none' OR
        // 'pending'. validate-fresh matches both; scalar form unchanged.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 61, labels: [], head: { ref: 'a/x' }, draft: false },
                    { number: 62, labels: [], head: { ref: 'a/y' }, draft: false },
                    { number: 63, labels: [], head: { ref: 'a/z' }, draft: false }
                ];
            }
        }, {}, {
            61: { number: 61, state: 'OPEN', checks: 'none', mergeState: 'CLEAN', mergeable: true },
            62: { number: 62, state: 'OPEN', checks: 'pending', mergeState: 'CLEAN', mergeable: true },
            63: { number: 63, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', checks: ['none', 'pending'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.map(function (i) { return i.key; }).join(','), 'pr-61,pr-62');

        var scalar = srcMod.query({
            query: { type: 'pr', checks: 'green' }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(scalar.map(function (i) { return i.key; }).join(','), 'pr-63');
    });    test('revalidate-armed rule exists in sm_github.json (armed head moved mid-validation)', function () {
        // Live hole (dart pr-194, 2026-09-22 15:06): double silent-update moved
        // the head past the green run; ai_validating stayed, checks read 'none',
        // and NO rule matched — the tick processed 0 until a manual disarm.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        var r = rules.filter(function (x) { return x.id === 'revalidate-armed'; })[0];
        assert.ok(r, 'revalidate-armed present');
        assert.deepEqual(r.query.labels.sort(), ['ai_validating', 'pr_approved'].sort(),
            'matches ARMED approved PRs');
        assert.deepEqual(r.query.checks, ['none'], 'only when the head carries no checks');
        assert.equal(r.query.mutex, 'ai_validating', 'one validation at a time');
        assert.equal(r.localAction, 'validate_pr', 're-dispatches CI on the head');
    });

});