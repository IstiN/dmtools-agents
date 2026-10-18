/**
 * Unit tests: sm GitHub state source (js/sm/sources/githubSource.js) —
 * the issue/PR query vocabulary behind source:'github' sm rules.
 */
/* global loadModule, assert, test, suite, makeRequire */

// gh-1059: the head-repo resolver is the REAL smProvider export — the
// createSmProvider mocks below stay stubbed, but the resolver must never
// be forked into a mock copy (that would move the CRAP-gate duplication
// into the tests).
var smProviderReal = function () {
    if (!smProviderReal.mod) {
        smProviderReal.mod = loadModule('js/common/smProvider.js', makeRequire({
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({}), {})
        }), {});
    }
    return smProviderReal.mod;
};

suite('sm github source', function () {

    var src;


    var providerStub = {
        findPr: function (n) { return providerStub._prs[n] || null; },
        prStatus: function (n) { return providerStub._status[n] || null; },
        lastReview: function (n) { return providerStub._reviews[n] || null; },
        reviewThreads: function (n) { return providerStub._threads[n] || null; },
        // gh-807 verdict records: keyed by PR number, but the contract is
        // per (pr, head) — a missing head sha resolves to null exactly like
        // the real provider (pins the needsStatus wiring: a rule carrying a
        // verdict guard must fetch prStatus, or the guard never resolves a
        // head and can never match).
        latestVerdictRecord: function (n, headSha) {
            if (!headSha || !providerStub._verdictRecords) return null;
            return providerStub._verdictRecords[n] || null;
        },
        _prs: {},
        _status: {},
        _reviews: {},
        _threads: {},
        _verdictRecords: {}
    };

    function load(tools, prs, statuses, reviews, threads) {
        providerStub._prs = prs || {};
        providerStub._status = statuses || {};
        providerStub._reviews = reviews || {};
        providerStub._threads = threads || {};
        // The real smAsync module: the fallback path direct-evals the
        // worker sources in ITS scope, so the forge-tool mocks (and the
        // smProvider stub for the worker-side require) are injected here.
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': {
                createSmProvider: function () { return providerStub; }
            }
        }), tools || {});
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return providerStub; },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': smAsyncMod,
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
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

    test('deployed rework-on-red-ci: issue armed + PR also armed → no match (gh-715 one-wins)', function () {
        // fa gh-1226 2026-10-04 18:47: the review post-action armed
        // agent:rework on the ISSUE and rework-unresolved-threads armed
        // the same label on the PR — one SM tick fired BOTH rework
        // dispatch rules 2s apart on the same head SHA (runs
        // 37225765526/37225768365). The deployed issue-carrier query must
        // defer to the PR-carrier rule (rework-on-label — self-consuming,
        // PR-anchored) whenever the PR is armed, so exactly one leg wins.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
        var query = null;
        rules.forEach(function (r) { if (r.id === 'rework-on-red-ci') query = r.query; });
        assert.ok(query, 'deployed rework-on-red-ci query found');

        var mk = function (prLabels) {
            return load({
                github_search_issues: function () {
                    return { items: [{ number: 1226, labels: [{ name: 'agent:rework' }] }] };
                }
            }, {
                1226: { number: 1227, state: 'OPEN' }
            }, {
                1227: { number: 1227, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED',
                       mergeable: null, author: 'ai-teammate', branch: 'ai/gh-1226',
                       labels: prLabels }
            });
        };
        var ctx = { repoInfo: { owner: 'epam', repo: 'dmtools-dart' }, machineAuthor: 'ai-teammate' };

        var both = mk(['agent:rework']).query({ source: 'github', query: query }, ctx);
        assert.equal(both.length, 0, 'PR also armed — the PR-carrier rule owns the dispatch');

        var onlyIssue = mk([]).query({ source: 'github', query: query }, ctx);
        assert.equal(onlyIssue.length, 1, 'issue-only arm still dispatches');
        assert.equal(onlyIssue[0].key, 'gh-1226');
    });

    test('blocked label: the SM ignores the item on every rule (fa #939)', function () {
        // 'blocked' is owner-controlled parking: label matches the rule,
        // yet the item must not surface from ANY query.
        var srcMod = load({
            github_search_issues: function () {
                return { items: [{ number: 7, labels: [{ name: 'ai_developed' }, { name: 'blocked' }] }] };
            }
        }, {}, {});
        var items = srcMod.query({
            query: { type: 'issue', labels: ['ai_developed'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0);
    });

    test('blocked label: PR rules skip owner-parked PRs even when green (fa #939)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 61, labels: [{ name: 'pr_approved' }, { name: 'blocked' }], head: { ref: 'feat/blocked' }, draft: false },
                    { number: 60, labels: [{ name: 'pr_approved' }], head: { ref: 'feat/ok' }, draft: false }
                ];
            }
        }, {}, {
            60: { number: 60, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true },
            61: { number: 61, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'], checks: 'green', mergeable: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1);
        assert.equal(items[0].key, 'pr-60');
    });

    test('blocked label: a frozen mutex holder does not serialize the queue (freeze is total)', function () {
        // The freeze must be invisible-EVERYWHERE, not just invisible-to-
        // matches: a blocked PR holding a stale ai_validating arm must not
        // defer the unblocked queue behind it (live: 15 PRs labeled blocked
        // and the machine kept processing / queueing behind them).
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 70, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }, { name: 'blocked' }],
                      head: { ref: 'ai/gh-70' }, draft: false },
                    { number: 71, labels: [{ name: 'pr_approved' }],
                      head: { ref: 'ai/gh-71' }, draft: false }
                ];
            }
        }, {}, {
            70: { number: 70, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            71: { number: 71, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                     mutex: 'ai_validating' }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1, 'blocked holder is transparent — the queue flows');
        assert.equal(items[0].key, 'pr-71');

        // exclude-self recovery form: the blocked armed PR is neither a
        // candidate nor a holder — the unblocked armed candidate fires.
        var srcMod2 = load({
            github_list_prs: function () {
                return [
                    { number: 70, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }, { name: 'blocked' }],
                      head: { ref: 'ai/gh-70' }, draft: false },
                    { number: 71, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-71' }, draft: false }
                ];
            }
        }, {}, {
            70: { number: 70, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            71: { number: 71, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true }
        });
        var rec = srcMod2.query({
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'],
                     checks: ['none'], notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                     mutex: 'ai_validating', mutexAmong: ['pr_approved'],
                     mutexExcludeSelf: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(rec.length, 1, 'blocked holder is transparent — the armed candidate fires');
        assert.equal(rec[0].key, 'pr-71');
    });

    test('blocked label: an issue whose linked PR is blocked is invisible too (issue-carrier)', function () {
        // review-after-dev shape: the issue itself carries no blocked
        // label, but a human parked its PR — the machine must not dispatch
        // review/rework/validation against a frozen PR.
        function mkSrc(prLabels) {
            var statuses = {};
            statuses[30] = { number: 30, state: 'OPEN', checks: 'green', mergeState: 'CLEAN',
                             mergeable: true, labels: prLabels };
            return load({
                github_search_issues: function () {
                    return { items: [{ number: 3, labels: [{ name: 'ai_developed' }] }] };
                }
            }, {
                3: { number: 30, state: 'OPEN' }
            }, statuses);
        }
        var q = { type: 'issue', labels: ['ai_developed'], notLabels: ['agent:rework'],
                  notPrLabels: ['ai_pr_reviewed', 'pr_approved'], prLabels: ['ai_validated'] };

        var parked = mkSrc(['ai_validated', 'blocked']);
        var frozen = parked.query({ query: q }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(frozen.length, 0, 'blocked linked PR freezes the issue-carrier item');

        var live = mkSrc(['ai_validated']);
        var flowing = live.query({ query: q }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(flowing.length, 1, 'removing the label re-exposes the item unchanged');
        assert.equal(flowing[0].key, 'gh-3');
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

    test('pr rules: mutexAmong — dev-lane arms do not block the merge window', function () {
        // Live priority inversion (owner report, fa 2026-09-22): #801
        // (pr_approved + ai_validated, FIFO head) starved because dev-lane
        // validations (#831/#832/#834) held ai_validating and validate-armed
        // deferred entirely every tick. mutexAmong scopes the mutex to
        // holders that also carry the given labels: dev arms don't block
        // the approved merge window, approved arms still serialize it.
        function mk(devArmed, approvedArmed) {
            return function () {
                var prs = [
                    { number: 10, labels: [{ name: 'pr_approved' }, { name: 'ai_validated' }],
                      head: { ref: 'ai/gh-10' }, draft: false }
                ];
                if (devArmed) {
                    prs.push({ number: 12, labels: [{ name: 'ai_validating' }],
                               head: { ref: 'ai/gh-12' }, draft: false });
                    prs.push({ number: 13, labels: [{ name: 'ai_validating' }],
                               head: { ref: 'ai/gh-13' }, draft: false });
                }
                if (approvedArmed) {
                    prs.push({ number: 14, labels: [{ name: 'ai_validating' }, { name: 'pr_approved' }],
                               head: { ref: 'ai/gh-14' }, draft: false });
                }
                return prs;
            };
        }
        var q = { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                  mutex: 'ai_validating', mutexAmong: ['pr_approved'] };
        var src = load({ github_list_prs: mk(true, false) }, {}, {});
        // Dev arms only → mutex NOT held for the merge window → pr-10 flows
        var items = src.query({ query: q }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1);
        assert.equal(items[0].key, 'pr-10');

        var srcHeld = load({ github_list_prs: mk(true, true) }, {}, {});
        // An approved PR holds the arm → merge window still serializes
        items = srcHeld.query({ query: q }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0);
    });
    test('pr rules: mutexExcludeSelf — recovery rule fires when the ONLY approved arm is the candidate', function () {
        // Multi-arm leak fix (fa 2026-09-26): revalidate-armed /
        // revalidate-armed-green target ALREADY-armed approved PRs, so the
        // global mutex self-blocks them 100% of the time. Exclude-self drops
        // the candidate's own arm from the holder scan: exactly one armed
        // approved PR = the candidate itself = the rule fires.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 20, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-20' }, draft: false },
                    { number: 21, labels: [{ name: 'pr_approved' }],
                      head: { ref: 'ai/gh-21' }, draft: false },
                    { number: 22, labels: [{ name: 'ai_validating' }],
                      head: { ref: 'ai/gh-22' }, draft: false }
                ];
            }
        }, {}, {
            20: { number: 20, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            21: { number: 21, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true },
            22: { number: 22, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'],
                     checks: ['none'], notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                     mutex: 'ai_validating', mutexAmong: ['pr_approved'],
                     mutexExcludeSelf: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1, 'the lone armed approved PR is the candidate — fires');
        assert.equal(items[0].key, 'pr-20');
        // 22 is a DEV-lane arm (no pr_approved): mutexAmong scopes it out of holders.
    });

    test('pr rules: mutexExcludeSelf — a leaked double-arm stack DRAINS oldest-first (#577 deadlock fix)', function () {
        // The old form asserted every candidate defers while ANOTHER
        // approved PR is armed. Live fa #1068+#1088 (2026-09-30) broke that
        // assumption: both heads were green-with-missing-CI + BLOCKED, so
        // the drain rules (merge-validated wants CLEAN, fail-validation
        // wants red, unarm-stale wants BEHIND) matched NOTHING and the
        // all-defer recovery forms deadlocked the whole queue ~40 min until
        // a manual unarm. New semantics: the candidate itself holding the
        // mutex IS the holder (its own serialization slot) — recovery
        // candidates always self-hold (their query carries the arm label),
        // so the stack drains. The old test's checks guard (31 green vs
        // checks:'none') stays: only 30 passes THIS rule's query.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 30, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-30' }, draft: false },
                    { number: 31, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-31' }, draft: false }
                ];
            }
        }, {}, {
            30: { number: 30, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            31: { number: 31, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'],
                     checks: ['none'], notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                     mutex: 'ai_validating', mutexAmong: ['pr_approved'],
                     mutexExcludeSelf: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1, 'self-holding candidate 30 fires despite another approved arm (#577)');
        assert.equal(items[0].key, 'pr-30');
    });

    test('pr rules: mutexExcludeSelf — dead-zone double-arm shape: BOTH self-holders drain in FIFO order (#577)', function () {
        // The exact live deadlock (fa 2026-09-30): two approved armed PRs,
        // both heads green-with-missing-CI + BLOCKED — the dead-zone query.
        // Old engine: both defer on each other, queue frozen. New engine:
        // both self-hold → both returned, FIFO order, limit 1 dispatches
        // the oldest per tick and the stack drains.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 30, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-30' }, draft: false },
                    { number: 31, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-31' }, draft: false }
                ];
            }
        }, {}, {
            30: { number: 30, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: true },
            31: { number: 31, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'],
                     checks: ['green'], notMergeState: ['BEHIND', 'DIRTY', 'CLEAN'], draft: false,
                     mutex: 'ai_validating', mutexAmong: ['pr_approved'],
                     mutexExcludeSelf: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 2, 'no cross-blocking: both self-holders survive the mutex');
        assert.equal(items[0].key, 'pr-30', 'oldest first');
        assert.equal(items[1].key, 'pr-31');
    });

    test('pr rules: mutexExcludeSelf — a NON-holder candidate still defers while another PR holds (no new arms)', function () {
        // The arming-protection half of #577: exclude-self relaxes the mutex
        // ONLY for candidates that hold it themselves. A candidate without
        // the arm label (would-be NEW arm) must keep deferring while any
        // other approved PR holds — the leak protection stays with the
        // global form AND the self-hold form.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 30, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-30' }, draft: false },
                    { number: 40, labels: [{ name: 'pr_approved' }],
                      head: { ref: 'ai/gh-40' }, draft: false }
                ];
            }
        }, {}, {
            30: { number: 30, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            40: { number: 40, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'],
                     checks: ['none'], notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                     mutex: 'ai_validating', mutexAmong: ['pr_approved'],
                     mutexExcludeSelf: true }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1, 'holder 30 fires; non-holder 40 defers (no second arm)');
        assert.equal(items[0].key, 'pr-30');
    });

    test('validate-armed keeps the GLOBAL mutex — exclude-self form does not leak into it', function () {
        // Behavior for validate-armed must stay byte-identical: its candidate
        // is NOT yet armed (notLabels: ai_validating), so self never appears
        // in the scan and the global defer-all form is correct there.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        var r = rules.filter(function (x) { return x.id === 'validate-armed'; })[0];
        assert.ok(r, 'validate-armed present');
        assert.equal(r.query.mutex, 'ai_validating');
        assert.deepEqual(r.query.mutexAmong, ['pr_approved']);
        assert.equal(r.query.mutexExcludeSelf, undefined,
            'global form — the candidate is not yet armed, self never appears');
        assert.deepEqual((r.query.notLabels || []),
            ['ai_validating', 'validation_failed', 'rework-loop-escalated'],
            'un-armed + not validation_failed + not rework-loop-escalated — parked guests (owner 2026-09-27,' +
            ' fa#923) and gh-957 human-handoff PRs (gh-990: an armed human-owned PR would hold the mutex' +
            ' hostage behind a label only a human clears) stay out of the arm queue');
    });

    // ── gh-837: mutexMax — parallel validations in the merge window ──
    test('pr rules: mutexMax (gh-837) — global form admits a second arm below the cap', function () {
        // The merge-cadence knob relaxes the single-flight ai_validating
        // mutex: with mutexMax 2, validate-armed still matches while
        // EXACTLY ONE approved arm is in flight; at two holders it defers.
        function mk(holderLabels) {
            return function () {
                var prs = [
                    { number: 40, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-40' }, draft: false },
                    { number: 41, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-41' }, draft: false }
                ];
                holderLabels.forEach(function (labels, i) {
                    prs.push({ number: 50 + i, labels: labels, head: { ref: 'ai/gh-' + (50 + i) }, draft: false });
                });
                return prs;
            };
        }
        var q = { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                  mutex: 'ai_validating', mutexAmong: ['pr_approved'], mutexMax: 2 };
        var armed = [{ name: 'ai_validating' }, { name: 'pr_approved' }];

        var one = load({ github_list_prs: mk([armed]) }, {}, {});
        var items = one.query({ query: q }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-40', 'pr-41'],
            'one holder < cap 2 — the rule does NOT defer; FIFO order kept (limit:1 arms pr-40)');

        var two = load({ github_list_prs: mk([armed, armed]) }, {}, {});
        items = two.query({ query: q }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0, 'two holders = cap 2 — no third arm leaks');

        // mutexMax 1 (or absent) = today's strictly serial behavior.
        var serial = load({ github_list_prs: mk([armed]) }, {}, {});
        items = serial.query({
            query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                     mutex: 'ai_validating', mutexAmong: ['pr_approved'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0, 'no mutexMax — a single holder still serializes everything');
    });

    test('pr rules: mutexMax (gh-837) — dev-lane arms never count toward the cap', function () {
        // mutexAmong parity under relaxation: only pr_approved holders
        // occupy merge-window slots; a dev-lane arm (ai_validating without
        // pr_approved) neither fills a slot nor blocks anything.
        var src = load({
            github_list_prs: function () {
                return [
                    { number: 40, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-40' }, draft: false },
                    { number: 60, labels: [{ name: 'ai_validating' }], head: { ref: 'ai/gh-60' }, draft: false },
                    { number: 61, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-61' }, draft: false }
                ];
            }
        }, {}, {});
        var items = src.query({
            query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                     mutex: 'ai_validating', mutexAmong: ['pr_approved'], mutexMax: 2 }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1, 'dev arm ignored, one approved holder < cap 2 — pr-40 arms');
        assert.equal(items[0].key, 'pr-40');
    });

    test('pr rules: mutexMax (gh-837) — exclude-self: self-holders still drain, non-holders defer at the cap', function () {
        // Recovery-rule parity (#577) under relaxation: a self-holding
        // revalidate candidate NEVER blocks itself (the leaked stack drains
        // oldest-first regardless of the cap), while a non-holder defers
        // only once OTHER approved arms reach mutexMax.
        var selfArm = [{ name: 'pr_approved' }, { name: 'ai_validating' }];
        var src = load({
            github_list_prs: function () {
                return [
                    { number: 70, labels: selfArm, head: { ref: 'ai/gh-70' }, draft: false },
                    { number: 71, labels: selfArm, head: { ref: 'ai/gh-71' }, draft: false },
                    { number: 72, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-72' }, draft: false }
                ];
            }
        }, {}, {
            70: { number: 70, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            71: { number: 71, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            72: { number: 72, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true }
        });
        var q = { type: 'pr', labels: ['pr_approved', 'ai_validating'], checks: ['none'],
                  notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                  mutex: 'ai_validating', mutexAmong: ['pr_approved'],
                  mutexExcludeSelf: true, mutexMax: 2 };
        // Both self-holders drain (2 items), and the unarmed pr-72 sees 2
        // OTHER holders = cap → defers. No cross-contamination.
        var items = src.query({ query: q }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-70', 'pr-71'],
            'self-holders drain oldest-first; the non-holder is refused a third arm');

        // Below the cap the stack still drains; and even ABOVE the cap a
        // pure self-holder stack keeps draining — the cap binds NEW arms
        // (validate-armed's global form), never the recovery rules' drain
        // (#577: self-holders never block themselves). A stack wider than
        // the cap can only be pre-existing residue (leaked while the knob
        // was off / manual arms) — it drains oldest-first, it cannot grow.
        var srcThree = load({
            github_list_prs: function () {
                return [70, 71, 72].map(function (n) {
                    return { number: n, labels: selfArm, head: { ref: 'ai/gh-' + n }, draft: false };
                });
            }
        }, {}, {
            70: { number: 70, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            71: { number: 71, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true },
            72: { number: 72, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true }
        });
        items = srcThree.query({ query: q }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-70', 'pr-71', 'pr-72'],
            'a wider-than-cap leaked stack still drains oldest-first — the cap never wedges recovery');
    });

    test('pr rules: mutexMax (gh-837) — a blocked holder is invisible under the cap', function () {
        // gh-766/fa #939 freeze semantics preserved: a 'blocked' holder was
        // filtered before the mutex scan, so it neither fills a slot nor
        // defers candidates — even with mutexMax > 1.
        var src = load({
            github_list_prs: function () {
                return [
                    { number: 80, labels: [{ name: 'blocked' }, { name: 'pr_approved' }, { name: 'ai_validating' }],
                      head: { ref: 'ai/gh-80' }, draft: false },
                    { number: 81, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-81' }, draft: false }
                ];
            }
        }, {}, {});
        var items = src.query({
            query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                     mutex: 'ai_validating', mutexAmong: ['pr_approved'], mutexMax: 3 }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1, 'frozen holder invisible — pr-81 arms despite cap 3');
        assert.equal(items[0].key, 'pr-81');
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

    test('pr rules: threadsResolved:false — unresolved threads on machine PRs match regardless of verdict staleness (gh-683)', function () {
        // Live shape (fa #1194/#1211/#1212 + dart #340, 2026-10-04): all
        // green+reviewed+validated with OPEN review threads — the exact
        // complement of review-threads-resolved matched NOTHING and the
        // 04:30 fa tick processed 0 of them. The false direction must
        // match unresolved threads whether the verdict is stale or fresh:
        //   91 unresolved + STALE verdict → match (staleVerdict would only
        //      narrow back into the re-review rules' blind spot);
        //   92 unresolved + verdict on the CURRENT head (fresh) → match
        //      (a fresh verdict with open threads equally needs rework);
        //   93 all threads resolved → no (review-threads-resolved owns it);
        //   94 no threads at all → no (nothing to rework);
        //   95 unresolved but guest-authored → no (auto-rework is
        //      machine-only, fail-closed);
        //   96 unresolved but ai_validating armed → no (merge window);
        //   97 unresolved + pr_approved (APPROVE verdict posted new
        //      threads — live fa #1211, gh-710) → MATCH: the sticky
        //      approval label must NOT exclude the rework arm; merge is
        //      BLOCKED by the conversation gate until the threads resolve.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 91, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'ai/gh-91' }, draft: false,
                      author: { login: 'ai-teammate' } },
                    { number: 92, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'ai/gh-92' }, draft: false,
                      author: { login: 'ai-teammate' } },
                    { number: 93, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'ai/gh-93' }, draft: false,
                      author: { login: 'ai-teammate' } },
                    { number: 94, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'ai/gh-94' }, draft: false,
                      author: { login: 'ai-teammate' } },
                    { number: 95, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'feat/guest' }, draft: false,
                      author: { login: 'human-contributor' } },
                    { number: 96, labels: [{ name: 'ai_pr_reviewed' }, { name: 'ai_validating' }], head: { ref: 'ai/gh-96' }, draft: false,
                      author: { login: 'ai-teammate' } },
                    { number: 97, labels: [{ name: 'ai_pr_reviewed' }, { name: 'pr_approved' }], head: { ref: 'ai/gh-97' }, draft: false,
                      author: { login: 'ai-teammate' } }
                ];
            }
        }, {}, {}, {}, {
            91: { total: 2, resolved: 1, unresolved: 1 },
            92: { total: 3, resolved: 1, unresolved: 2 },
            93: { total: 2, resolved: 2, unresolved: 0 },
            94: { total: 0, resolved: 0, unresolved: 0 },
            97: { total: 5, resolved: 0, unresolved: 5 }
            // 95/96 never reach the thread guard (author/label filters)
        });
        var items = srcMod.query({
            query: {
                type: 'pr',
                labels: ['ai_pr_reviewed'],
                // gh-710: pr_approved deliberately NOT excluded — an
                // APPROVE verdict with unresolved threads deadlocks merge
                // (BLOCKED conversation gate) without the rework arm.
                notLabels: ['agent:rework', 'agent:review', 'ai_validating', 'validation_failed'],
                prMachineAuthor: true,
                threadsResolved: false,
                draft: false
            }
        }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'ai-teammate' });
        assert.equal(items.map(function (i) { return i.key; }).join(','), 'pr-91,pr-92,pr-97',
            'unresolved threads match stale AND fresh verdicts AND sticky-approved PRs; resolved/threadless/guest/validating do not');
    });

    test('pr rules: review-stale-verdict-unchecked — validated+reviewed head with NO checks re-reviews (no green needed)', function () {
        // Live shape (flutter_agent_harness pr-1076/pr-1075, 2026-09-29): a
        // push (silent-update / rework) moved the head AFTER the review, so
        // the rollup reads 'none' (BLOCKED, required checks pending) and
        // every green-gated review path skipped — the machine-authored PR
        // stalled until a human label. Owner rule: after ai_validated + a
        // review, a moved head re-runs the REVIEW first; the single
        // pre-merge validation stays in validate-armed (post-approve,
        // final head). 'none' only — 'pending' is the in-flight dispatch
        // bridge and must not double-dispatch.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 71, labels: [{ name: 'ai_validated' }, { name: 'ai_pr_reviewed' }], head: { ref: 'feat/a' }, draft: false },
                    { number: 72, labels: [{ name: 'ai_validated' }, { name: 'ai_pr_reviewed' }], head: { ref: 'feat/b' }, draft: false },
                    { number: 73, labels: [{ name: 'ai_validated' }, { name: 'ai_pr_reviewed' }], head: { ref: 'feat/c' }, draft: false },
                    { number: 74, labels: [{ name: 'ai_validated' }, { name: 'ai_pr_reviewed' }, { name: 'pr_approved' }], head: { ref: 'feat/d' }, draft: false },
                    { number: 75, labels: [{ name: 'ai_validated' }, { name: 'ai_pr_reviewed' }], head: { ref: 'feat/e' }, draft: false },
                    { number: 76, labels: [{ name: 'ai_pr_reviewed' }], head: { ref: 'feat/f' }, draft: false }
                ];
            }
        }, {}, {
            71: { state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true, headSha: 'head71' },
            72: { state: 'OPEN', checks: 'pending', mergeState: 'BLOCKED', mergeable: true, headSha: 'head72' },
            73: { state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true, headSha: 'head73' },
            74: { state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true, headSha: 'head74' },
            75: { state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true, headSha: 'head75' },
            76: { state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: true, headSha: 'head76' }
        }, {
            71: { state: 'COMMENTED', commitId: 'old71' },
            72: { state: 'CHANGES_REQUESTED', commitId: 'old72' },
            73: { state: 'COMMENTED', commitId: 'old73' },
            74: { state: 'COMMENTED', commitId: 'old74' },
            75: { state: 'COMMENTED', commitId: 'head75' }
            // 76: never reviewed
        }, {
            71: { total: 2, resolved: 2, unresolved: 0 },
            72: { total: 2, resolved: 2, unresolved: 0 },
            73: { total: 2, resolved: 1, unresolved: 1 },
            74: { total: 1, resolved: 1, unresolved: 0 },
            75: { total: 2, resolved: 2, unresolved: 0 },
            76: { total: 1, resolved: 1, unresolved: 0 }
        });
        var items = srcMod.query({
            query: {
                type: 'pr',
                labels: ['ai_validated', 'ai_pr_reviewed'],
                notLabels: ['agent:review', 'ai_validating', 'pr_approved'],
                checks: 'none', draft: false,
                staleVerdict: true, threadsResolved: true
            }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        // 71 validated+reviewed+resolved+stale+none → match (the stall fix);
        // 72 checks pending (dispatch bridge in flight) → no;
        // 73 an unresolved thread (mid-rework window) → no;
        // 74 approved (pr_approved sticky — re-validates, never re-reviews) → no;
        // 75 the verdict is already on the current head (converged) → no;
        // 76 never reviewed (no ai_validated — out of the rule's scope) → no.
        assert.equal(items.length, 1, 'only pr-71 matches: ' +
            items.map(function (i) { return i.key; }).join(','));
        assert.equal(items[0].key, 'pr-71');
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

    test('gh-755 deployed rerun rules: author-disjoint twins route each PR to exactly one rerun rule', function () {
        // The deployed sm_github.json split: rerun-cancelled-checks keeps
        // the named branch-protection contexts for GUEST heads
        // (notMachine); rerun-any-cancelled-checks reruns ANY cancelled
        // context on MACHINE heads (prMachineAuthor, fails closed). The
        // disjointness is what makes the rerun single-shot — one rule per
        // PR, no double rerun, no marker interference.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var byId = {};
        cfg.params.jobParams.rules.forEach(function (r) { byId[r.id] = r; });
        var named = byId['rerun-cancelled-checks'];
        var sib = byId['rerun-any-cancelled-checks'];
        assert.ok(named && sib, 'both deployed rerun rules exist');

        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 752, labels: [{ name: 'ai_validating' }], draft: false,
                      author: { login: 'ai-teammate' } },
                    { number: 753, labels: [{ name: 'ai_validating' }], draft: false,
                      author: { login: 'vendor-guest' } }
                ];
            }
        }, {}, {
            752: { state: 'OPEN', checks: 'pending', mergeState: 'BLOCKED', mergeable: true },
            753: { state: 'OPEN', checks: 'pending', mergeState: 'BLOCKED', mergeable: true }
        });
        var ctx = { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'ai-teammate' };

        var namedItems = srcMod.query(named, ctx);
        assert.equal(namedItems.map(function (i) { return i.key; }).join(','), 'pr-753',
            'the named rule keeps GUEST heads only');

        var sibItems = srcMod.query(sib, ctx);
        assert.equal(sibItems.map(function (i) { return i.key; }).join(','), 'pr-752',
            'the ANY-cancelled sibling claims MACHINE heads only');

        var noKnob = srcMod.query(sib, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(noKnob.length, 0,
            'no machineAuthor configured — the sibling fails closed; the named rule (notMachine inert) covers everyone');
        var everyone = srcMod.query(named, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(everyone.map(function (i) { return i.key; }).join(','), 'pr-752,pr-753',
            'degraded deployment: the named rule covers machine AND guest heads again');
    });

    test('pr rules: release-bump PRs from the repo owner count as machine-authored (#1104)', function () {
        // Owner rule 2026-09-30: auto_release.sh (fa #1093) creates
        // chore/release-v* | chore(release): bump PRs through the owner's
        // RELEASE_PAT, so GitHub records the OWNER as the author — the
        // machine login never matches. The authorship gate must treat the
        // bump shape from the repo owner as machine (review-machine-
        // unlinked fires), everything else fails closed.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 83, draft: false, author: { login: 'IstiN' },
                      head: { ref: 'chore/release-v1.0.494' },
                      title: 'chore(release): v1.0.494' },
                    { number: 84, draft: false, author: { login: 'guest-dev' },
                      head: { ref: 'chore/release-v1.0.495' },
                      title: 'chore(release): v1.0.495' },
                    { number: 85, draft: false, author: { login: 'IstiN' },
                      head: { ref: 'ai/gh-999' }, title: 'fix(#1): regular owner PR' },
                    { number: 86, draft: false, author: { login: 'istin' },
                      head: { ref: 'manual/bump' }, title: 'chore(release): v1.0.496' }
                ];
            }
        }, {}, {
            83: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true },
            84: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true },
            85: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true },
            86: { state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
        });

        // review-machine-unlinked shape (#576): bump PRs from the owner
        // (branch OR title form, author matched case-insensitively) get
        // the auto review leg; a foreigner's bump and the owner's regular
        // PR stay out.
        var machineRule = srcMod.query({
            query: { type: 'pr', notLabels: ['ai_pr_reviewed', 'pr_approved'],
                     checks: ['green', 'none'], prMachineAuthor: true, draft: false }
        }, { repoInfo: { owner: 'IstiN', repo: 'r' }, machineAuthor: 'ai-teammate' });
        assert.equal(machineRule.map(function (i) { return i.key; }).join(','), 'pr-83,pr-86',
            'release bumps from the owner = machine (branch form and title form)');

        // review-external-once shape: notMachine now excludes the bump
        // PRs too — the external rules must not claim what the machine
        // rules own.
        var extRule = srcMod.query({
            query: { type: 'pr', notLabels: ['ai_pr_reviewed'],
                     checks: 'green', draft: false, notMachine: true }
        }, { repoInfo: { owner: 'IstiN', repo: 'r' }, machineAuthor: 'ai-teammate' });
        assert.equal(extRule.map(function (i) { return i.key; }).join(','), 'pr-84,pr-85',
            'foreign bump + owner regular PR remain external-reviewable');

        // Fail-closed: no owner resolvable (repoInfo without owner) → the
        // bump shape alone proves nothing.
        var noOwner = srcMod.query({
            query: { type: 'pr', checks: ['green', 'none'], prMachineAuthor: true, draft: false }
        }, { repoInfo: { repo: 'r' }, machineAuthor: 'ai-teammate' });
        assert.equal(noOwner.length, 0, 'no owner — release-bump gate fails closed');
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
        assert.equal(byPr[93], null, 'no reference → null (dispatch falls back to PR-anchored, #544)');
    });

    test('pr rules: linked issue — cross-repo qualified #N refs resolve to null (#544)', function () {
        // Live incident (dmtools-dart PR #266, 2026-09-27): the body
        // 'Dart port of dm.ai #601' scraped #601 as a LOCAL anchor →
        // 'gh issue view 601' 404 → guard exit 1 → the whole SM cycle red
        // every 15 min. A '#N' preceded by a repo qualifier ('dm.ai #601',
        // 'org/repo#N', 'org/repo #N') is a CROSS-repo reference and must
        // never resolve against the current repo. Existence of a remaining
        // bare ref is verified at dispatch time (smAgent localIssueExists).
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 201, labels: [{ name: 'agent:rework' }], draft: false,
                      body: 'Dart port of dm.ai #601' },
                    { number: 202, labels: [{ name: 'agent:rework' }], draft: false,
                      body: 'Ports org/repo#602 to this codebase' },
                    { number: 203, labels: [{ name: 'agent:rework' }], draft: false,
                      body: 'Upstream org/repo #603 changed the API' },
                    { number: 204, labels: [{ name: 'agent:rework' }], draft: false,
                      body: 'Follow-up of (#604) — parenthesized local ref stays local' },
                    { number: 205, labels: [{ name: 'agent:rework' }], draft: false,
                      body: 'Bumps dep after dm.ai #605; fixes #78' }
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:rework'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        var byPr = {};
        items.forEach(function (i) { byPr[i.prNumber] = i.issueNumber; });
        assert.equal(byPr[201], null, "'dm.ai #601' — repo-qualified ref is not a local anchor");
        assert.equal(byPr[202], null, "'org/repo#602' — qualified ref without space is not local");
        assert.equal(byPr[203], null, "'org/repo #603' — qualified ref with space is not local");
        assert.equal(byPr[204], 604, "'(#604)' — parenthesized bare ref stays a local anchor");
        assert.equal(byPr[205], 78, 'cross-repo mention stripped, local closing keyword still wins');
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
        assert.deepEqual(r.query.checks, ['none', 'pending'], 'no checks OR a cancelled-only rollup (dmtools-agents#632: pending with nothing in flight is the lost-run state too; validate_pr\'s duplicate-dispatch probe guards live runs)');
        // Live multi-arm leak (fa 2026-09-26 — 7 approved PRs armed at once,
        // +1/tick): a plain mutex self-blocks this rule (its own target carries
        // ai_validating), so it shipped mutex-less on a false "structural
        // singleton" assumption. The exclude-self mutex restores serialization:
        // defer only while ANOTHER approved PR holds the arm.
        assert.equal(r.query.mutex, 'ai_validating', 'serializes on the arm label');
        assert.deepEqual(r.query.mutexAmong, ['pr_approved'],
            'scoped to approved holders (dev-lane arms do not block)');
        assert.equal(r.query.mutexExcludeSelf, true,
            'exclude-self: the candidate’s own arm must not self-block the rule');
        assert.equal(r.localAction, 'validate_pr', 're-dispatches CI on the head');
    });

    test('rule order: merge-validated precedes sweep-stale-validating (#637 aftermath)', function () {
        // Live fa pr-1174 (2026-10-03): with the sweep FIRST, every arm older
        // than staleMinutes (15) was swept before the merge rule could act —
        // at night tick cadence (~20 min, kicker cron slippage) that looped
        // arm→sweep→arm forever on a green merge-ready head. Array order IS
        // execution order (smAgent's rules loop).
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        var ids = rules.map(function (x) { return x.id; });
        assert.ok(ids.indexOf('merge-validated') < ids.indexOf('sweep-stale-validating'),
            'merge-validated must consume a green armed head before the staleness sweep eats the arm');
    });

    test('revalidate-armed-green rule exists in sm_github.json (armed, green rollup, CI verdict missing)', function () {
        // Live dead zone (fa pr-922, 2026-09-26): armed head whose dispatched CI
        // run was lost (racing dispatch concurrency-canceled / CLI dispatch
        // failed silently). Every existing check green, required CI check ABSENT
        // → rollup 'green' + REST BLOCKED. None of none/red/CLEAN/BEHIND matched
        // any rule — frozen for hours. This rule re-dispatches CI on the head.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        var r = rules.filter(function (x) { return x.id === 'revalidate-armed-green'; })[0];
        assert.ok(r, 'revalidate-armed-green present');
        assert.deepEqual(r.query.labels.sort(), ['ai_validating', 'pr_approved'].sort(),
            'matches ARMED approved PRs');
        assert.deepEqual(r.query.checks, ['green'], 'fires exactly on the green-rollup dead zone');
        assert.deepEqual((r.query.notMergeState || []).slice().sort(), ['BEHIND', 'CLEAN', 'DIRTY'],
            'CLEAN excluded (merge-validated owns it), BEHIND/DIRTY excluded like the siblings');
        assert.equal(r.query.mutex, 'ai_validating', 'serializes on the arm label');
        assert.deepEqual(r.query.mutexAmong, ['pr_approved'],
            'scoped to approved holders (dev-lane arms do not block)');
        assert.equal(r.query.mutexExcludeSelf, true,
            'exclude-self: the candidate’s own arm must not self-block the rule');
        assert.equal(r.skipIfGreenCi, true,
            'green-cover guard: a completed green CI run on the head stops the re-dispatch loop');
        assert.equal(r.localAction, 'validate_pr', 're-dispatches CI on the head');
    });

    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function verdictFor(prNumber, verdict) {
        return verdict ? { record: { head: HEAD, verdict: verdict, blocking: 0,
            important: 0, suggestions: 0, at: '2026-10-09T05:47:40.000Z',
            source: 'pr_review.json' }, conflict: null } : null;
    }

    function prList(numbers, labels) {
        var ls = (labels || []).map(function (l) { return { name: l }; });
        return numbers.map(function (n) {
            return { number: n, labels: ls, head: { ref: 'feat/' + n }, draft: false };
        });
    }

    function statusFor(numbers) {
        var out = {};
        numbers.forEach(function (n) {
            out[n] = { number: n, state: 'OPEN', checks: 'green', mergeState: 'CLEAN',
                       mergeable: true, headSha: HEAD };
        });
        return out;
    }

    test('notLatestVerdict: a newest REQUEST_CHANGES on the head blocks the pr_approved lane', function () {
        // The #1428 shape: the approval was stamped, then a second leg
        // rendered REQUEST_CHANGES on the SAME head — merge-validated and
        // validate-armed must not act until re-review.
        providerStub._verdictRecords = {
            71: verdictFor(71, 'REQUEST_CHANGES'),
            72: verdictFor(72, 'APPROVE'),
            73: null // no records — pre-gh-807 PR
        };
        var srcMod = load({
            github_list_prs: function () { return prList([71, 72, 73], ['pr_approved']); }
        }, {}, statusFor([71, 72, 73]));
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'],
                     notLatestVerdict: ['REQUEST_CHANGES', 'BLOCK'], draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        var keys = items.map(function (i) { return i.key; }).sort();
        assert.deepEqual(keys, ['pr-72', 'pr-73'],
            'APPROVE and record-less PRs flow; the changes-requested head is blocked');
    });

    test('latestVerdict: the reconcile rule matches exactly the heads with a recorded verdict', function () {
        providerStub._verdictRecords = {
            81: verdictFor(81, 'APPROVE'),
            82: verdictFor(82, 'REQUEST_CHANGES'),
            83: null
        };
        var srcMod = load({
            github_list_prs: function () { return prList([81, 82, 83], ['pr_approved']); }
        }, {}, statusFor([81, 82, 83]));
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved', 'agent:rework'],
                     latestVerdict: ['APPROVE', 'REQUEST_CHANGES', 'BLOCK'], draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        var keys = items.map(function (i) { return i.key; }).sort();
        assert.deepEqual(keys, ['pr-81', 'pr-82'],
            'the record-less PR never enters reconciliation (fail-open)');
        assert.ok(items.every(function (i) { return i.pr && i.pr.headSha === HEAD; }),
            'a verdict-guard rule fetches prStatus — the guard needs the head sha (gh-807 wiring)');
    });

    test('latestVerdict on ISSUE-carrier items: the issue-rework reconcile shape matches the stale arm only', function () {
        // gh-807 review (rule-query narrowing): review CHANGES_REQUESTED /
        // red-CI / conflict-rework arms land on the LINKED ISSUE, which
        // pr-type label queries cannot see — the issue-carrier reconcile
        // rule matches an issue whose linked PR's CURRENT head carries an
        // APPROVE record while the issue still holds agent:rework. The
        // verdict guard must resolve the head through the issue
        // enrichment's prStatus (headSha).
        providerStub._verdictRecords = {
            130: verdictFor(130, 'APPROVE'),
            131: verdictFor(131, 'REQUEST_CHANGES'),
            132: null // pre-gh-807 PR — no records, fail open
        };
        var srcMod = load({
            github_search_issues: function (args) {
                if (args.query.indexOf('agent:rework') !== -1) {
                    return { items: [
                        { number: 130, labels: [{ name: 'agent:rework' }] },
                        { number: 131, labels: [{ name: 'agent:rework' }] },
                        { number: 132, labels: [{ name: 'agent:rework' }] }
                    ] };
                }
                return { items: [] };
            }
        }, {
            130: { number: 130, state: 'OPEN' },
            131: { number: 131, state: 'OPEN' },
            132: { number: 132, state: 'OPEN' }
        }, statusFor([130, 131, 132]));
        var items = srcMod.query({
            source: 'github',
            query: { type: 'issue', labels: ['agent:rework'], prState: 'OPEN',
                     latestVerdict: ['APPROVE'] }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        var keys = items.map(function (i) { return i.key; }).sort();
        assert.deepEqual(keys, ['gh-130'],
            'only the stale arm next to an APPROVE verdict matches — RC verdicts and record-less PRs never do');
        assert.ok(items[0].prNumber === 130 && items[0].issueNumber === 130,
            'the action gets both anchors: reconcile probes the PR and strips the issue');
    });

    test('BLOCK verdict blocks the approval lane too', function () {
        providerStub._verdictRecords = { 91: verdictFor(91, 'BLOCK') };
        var srcMod = load({
            github_list_prs: function () { return prList([91], ['pr_approved']); }
        }, {}, statusFor([91]));
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'],
                     notLatestVerdict: ['REQUEST_CHANGES', 'BLOCK'], draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0, 'a BLOCK verdict on the head blocks merge');
    });

    test('verdict guards pass the machine-author allowlist to the provider (gh-828 review round 2)', function () {
        // The marker format is public — the query guards must pin the
        // gh-728 machine logins onto the record read so a forged marker
        // from any comment-capable identity is invisible.
        var seenOpts = null;
        var saved = providerStub.latestVerdictRecord;
        providerStub.latestVerdictRecord = function (n, headSha, opts) {
            seenOpts = opts;
            return saved.call(providerStub, n, headSha);
        };
        try {
            providerStub._verdictRecords = { 96: verdictFor(96, 'APPROVE') };
            var srcMod = load({
                github_list_prs: function () { return prList([96], ['pr_approved']); }
            }, {}, statusFor([96]));
            srcMod.query({
                query: { type: 'pr', labels: ['pr_approved'],
                         notLatestVerdict: ['REQUEST_CHANGES', 'BLOCK'], draft: false }
            }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'ai-teammate' });
            assert.ok(seenOpts && Array.isArray(seenOpts.authorLogins),
                'latestVerdictRecord receives the authorLogins option');
            assert.deepEqual(seenOpts.authorLogins, ['ai-teammate']);
        } finally {
            providerStub.latestVerdictRecord = saved;
        }
    });

    test('guards are inert without the provider probe or a head sha (fail-open)', function () {
        providerStub._verdictRecords = {};
        var savedProbe = providerStub.latestVerdictRecord;
        delete providerStub.latestVerdictRecord;
        try {
            var srcMod = load({
                github_list_prs: function () { return prList([92, 93]); }
            }, {}, {
                92: { number: 92, state: 'OPEN', checks: 'green', mergeState: 'CLEAN',
                      mergeable: true, headSha: HEAD },
                93: { number: 93, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
            });
            var items = srcMod.query({
                query: { type: 'pr', labels: ['pr_approved'],
                         notLatestVerdict: ['REQUEST_CHANGES', 'BLOCK'],
                         latestVerdict: ['APPROVE'], draft: false }
            }, { repoInfo: { owner: 'a', repo: 'b' } });
            var keys = items.map(function (i) { return i.key; }).sort();
            assert.deepEqual(keys, [],
                'no probe: notLatestVerdict passes everything (legacy behavior) but ' +
                'latestVerdict can never confirm a verdict — the combined query matches nothing');
        } finally {
            providerStub.latestVerdictRecord = savedProbe; // restore for later tests
        }
    });
});
suite('sm github source — runAsync batching', function () {

    // Sequential-comparison stub (the shared `load()` helper above is
    // scoped to the first suite — this is its twin, wired to seqStub).
    var seqStub = {
        findPr: function (n) { return seqStub._prs[n] || null; },
        prStatus: function (n) { return seqStub._status[n] || null; },
        _prs: {},
        _status: {}
    };
    function loadSeq(tools) {
        seqStub._prs = {};
        seqStub._status = {};
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': {
                createSmProvider: function () { return seqStub; }
            }
        }), tools || {});
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return seqStub; },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': smAsyncMod,
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), tools);
    }

    // Sync fake of the Dart runAsync (same trick as test_smAsync): the
    // worker source is eval'd in THIS scope, so `require` and the forge
    // tools are provided here deliberately. The batch path wires the
    // worker-side require to batchStub; the sequential comparison run
    // goes through the shared `load()` helper whose worker-side require
    // resolves to providerStub — each side gets its own stub state.
    var batchCalls = [];
    var batchStub = {
        findPr: function (n) { return batchStub._prs[n] || null; },
        prStatus: function (n) { return batchStub._status[n] || null; },
        snapshotCalls: 0,
        snapshot: function () {
            batchStub.snapshotCalls++;
            return { openPrs: [], mergedPrs: [], branchHeads: { main: 'basesha' } };
        },
        _prs: {},
        _status: {}
    };
    // The fake's eval'd worker must see require + the forge tools in its
    // LEXICAL scope — build it through an eval-wrapped factory that
    // injects them as vars (exactly how loadModule mocks globals and how
    // the real worker engine wires its tool wrappers).
    function makeFakeRunAsync(tools, requireFn) {
        var decl = 'var require = _r_;\n';
        Object.keys(tools).forEach(function (k) {
            decl += 'var ' + k + ' = _t_["' + k + '"];\n';
        });
        var factory = eval(
            '(function(_t_, _r_) {\n' + decl +
            '    var fake = function (fn, args) {\n' +
            '        return { wait: function () { return fn(args); } };\n' +
            '    };\n' +
            "    fake.all = function (jobs) {\n" +
            '        return { wait: function () { return jobs.map(function (j) { return j.wait(); }); } };\n' +
            '    };\n' +
            '    return fake;\n' +
            '})'
        );
        return factory(tools, requireFn);
    }
    var batchRequire = makeRequire({
        './common/smProvider.js': {
            createSmProvider: function () { return batchStub; }
        }
    });

    function loadBatch(tools) {
        batchCalls = [];
        batchStub.snapshotCalls = 0;
        batchStub._prs = {};
        batchStub._status = {};
        var fakeRunAsync = makeFakeRunAsync(tools || {}, batchRequire);
        var recordingFake = function (src, args) {
            batchCalls.push({ src: src, args: args });
            return fakeRunAsync(src, args);
        };
        recordingFake.all = fakeRunAsync.all;
        var merged = Object.assign({ runAsync: recordingFake }, tools || {});
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': {
                createSmProvider: function () { return batchStub; }
            }
        }), merged);
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return batchStub; },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': smAsyncMod,
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), merged);
    }

    var STATUSES = {
        10: { number: 10, state: 'OPEN', checkConclusion: 'green', mergeState: 'CLEAN' },
        20: { number: 20, state: 'OPEN', checkConclusion: 'red', mergeState: 'BLOCKED' },
        30: { number: 30, state: 'OPEN', checkConclusion: 'none', mergeState: 'UNKNOWN' }
    };

    test('pr rules: batch enrichment (mocked runAsync) matches the sequential path shapes/order', function () {
        var prs = [
            { number: 30, labels: [], body: '', head: { ref: 'ai/gh-30' } },
            { number: 10, labels: [], body: '', head: { ref: 'ai/gh-10' } },
            { number: 20, labels: [], body: '', head: { ref: 'ai/gh-20' } }
        ];
        var tools = { github_list_prs: function () { return prs; } };
        var rule = { query: { type: 'pr', checks: ['green', 'none'] } };
        var ctx = { repoInfo: { owner: 'a', repo: 'b' } };

        // Sequential fallback (no runAsync anywhere). Stub state is set
        // AFTER the load — the loaders reset it (mirroring `load()`).
        var seqMod = loadSeq(tools);
        seqStub._status = STATUSES;
        var seqItems = seqMod.query(rule, ctx);

        // Batched path (mocked runAsync in both scopes).
        var batchMod = loadBatch(tools);
        batchStub._status = STATUSES;
        var batchItems = batchMod.query(rule, ctx);

        assert.deepEqual(batchItems, seqItems, 'identical items through the runAsync batch');
        assert.deepEqual(batchItems.map(function (i) { return i.prNumber; }), [10, 30],
            'guard filtering unchanged (FIFO order, checks guard)');
        assert.equal(batchStub.snapshotCalls, 1, 'ONE snapshot fetch for the whole batch');
        assert.equal(batchCalls.length, 3, 'one worker dispatch per PR');
        assert.ok(batchCalls.every(function (c) { return !!c.args.preseed; }),
            'every worker received the preseed snapshot');
        assert.equal(batchCalls[0].args.preseed, batchCalls[2].args.preseed,
            'the SAME snapshot object shipped to every worker');
    });

    test('issue rules: batched search preserves dedupe and descriptor order', function () {
        var tools = {
            github_search_issues: function (args) {
                if (args.query.indexOf('label:"agent:dev"') !== -1) {
                    // newest-first API order + an overlap with the second label
                    return { items: [
                        { number: 9, labels: [{ name: 'agent:dev' }] },
                        { number: 5, labels: [{ name: 'agent:dev' }, { name: 'x' }] }
                    ] };
                }
                if (args.query.indexOf('label:"agent:rework"') !== -1) {
                    return { items: [{ number: 5, labels: [{ name: 'agent:rework' }] }] };
                }
                return { items: [{ number: 7, labels: [] }] }; // assignee scan
            }
        };
        var rule = { query: { type: 'issue', labels: ['agent:dev', 'agent:rework'], assignee: 'ai-teammate' } };
        var ctx = { repoInfo: { owner: 'a', repo: 'b' } };

        var seqItems = loadSeq(tools).query(rule, ctx);

        var batchItems = loadBatch(tools).query(rule, ctx);

        assert.deepEqual(batchItems, seqItems, 'identical items through the batched search merge');
        assert.deepEqual(batchItems.map(function (i) { return i.issueNumber; }), [5, 7, 9],
            'deduped by number (overlap across label scans kept once); final order is the FIFO sort, identical on both paths');
        var searchDispatches = batchCalls.filter(function (c) { return !!c.args.descriptor; });
        assert.equal(searchDispatches.length, 3, 'one worker dispatch per search descriptor');
        assert.equal(searchDispatches[0].args.descriptor.kind, 'label');
        assert.equal(searchDispatches[2].args.descriptor.kind, 'assignee');
    });

    test('issue rules: batched enrichment preserves OPEN/MERGED shapes', function () {
        var tools = {
            github_search_issues: function () {
                return { items: [
                    { number: 3, labels: [{ name: 'agent:dev' }] },
                    { number: 1, labels: [{ name: 'agent:dev' }] }
                ] };
            }
        };
        var PRS = {
            3: { number: 40, state: 'OPEN' },
            1: { number: 10, state: 'MERGED' }
        };
        var STATUS = {
            40: { number: 40, state: 'OPEN', checkConclusion: 'green',
                  mergeState: 'CLEAN', branch: 'ai/gh-3' }
        };
        var rule = { query: { type: 'issue', labels: ['agent:dev'] } };
        var ctx = { repoInfo: { owner: 'a', repo: 'b' } };

        var seqMod = loadSeq(tools);
        seqStub._prs = PRS;
        seqStub._status = STATUS;
        var seqItems = seqMod.query(rule, ctx);

        var batchMod = loadBatch(tools);
        batchStub._prs = PRS;
        batchStub._status = STATUS;
        var batchItems = batchMod.query(rule, ctx);

        assert.deepEqual(batchItems, seqItems, 'identical enrichment shapes');
        var open = batchItems.filter(function (i) { return i.issueNumber === 3; })[0];
        var merged = batchItems.filter(function (i) { return i.issueNumber === 1; })[0];
        assert.equal(open.prNumber, 40);
        assert.equal(open.branch, 'ai/gh-3', 'OPEN ref: branch from prStatus');
        assert.deepEqual(merged.pr, { number: 10, state: 'MERGED', checks: 'none',
            mergeState: 'UNKNOWN', mergeable: null }, 'MERGED ref: placeholder shape');
        assert.equal(batchCalls.length, 2, 'one worker dispatch per issue');
    });

});

// Shared harness for the masked-green dead-zone suites (gh-759 / gh-829 —
// hoisted to module scope so the next gh-7xx follow-up edits ONE copy of
// the wiring instead of two). Both suites share the provider stub, the
// loadModule wiring and the pr() factory; they differ only in the
// issue-label fixtures, passed per load() call (omitted → every linked
// issue resolves label-less — the pre-gh-829 wave shape).
function maskedGreenHarness() {
    var providerStub = {
        findPr: function (n) { return providerStub._prs[n] || null; },
        prStatus: function (n) { return providerStub._status[n] || null; },
        lastReview: function () { return null; },
        reviewThreads: function () { return { total: 0, unresolved: 0 }; },
        _prs: {}, _status: {}, _reviews: {}, _threads: {}
    };

    // tools: dmtools-global overrides (github_list_prs,
    // github_search_issues, github_get_issue, …) — merged OVER the
    // default issue resolver, so a suite can pin contracts with a
    // throwing stub. issueLabels / issueErrors: per-issue fixture maps
    // for the gh-829 latch resolver.
    function load(tools, prs, statuses, issueLabels, issueErrors) {
        providerStub._prs = prs || {};
        providerStub._status = statuses || {};
        var mergedTools = {
            github_get_issue: function (args) {
                var n = args && args.issueNumber;
                if (issueErrors && issueErrors[n]) return { message: 'Not Found' };
                var ls = (issueLabels && issueLabels[n]) || [];
                return { number: n, labels: ls.map(function (l) { return { name: l }; }) };
            }
        };
        Object.keys(tools || {}).forEach(function (k) { mergedTools[k] = tools[k]; });
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': { createSmProvider: function () { return providerStub; } }
        }), mergedTools);
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': { createSmProvider: function () { return providerStub; },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify },
            '../../common/smAsync.js': smAsyncMod,
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), mergedTools);
    }

    function pr(n, labels, mergeState, author) {
        return {
            number: n, labels: (labels || []).map(function (l) { return { name: l }; }),
            draft: false, user: { login: author || 'ai-teammate' },
            head: { ref: 'ai/gh-' + (n - 1) }, body: 'Closes #' + (n - 1)
        };
    }

    return { load: load, providerStub: providerStub, pr: pr };
}

suite('sm github source: validate-fresh-masked-green (gh-759 dead zone)', function () {

    var h = maskedGreenHarness();
    var load = h.load;
    var pr = h.pr;

    // gh-759 live fa wave (PRs #1305/#1306/#1309/#1311/#1312): dev leg
    // done, PR zero-label, rollup GREEN from the repo's kicker/CodeQL
    // checks while the dispatch-only validation CI has no run on the
    // head, mergeState BLOCKED. validate-fresh (checks [none, pending])
    // cannot see these; the masked-green rule is the only matcher.

    // Deployed query (post gh-829 — CLEAN moved from notMergeState to the
    // mergeStateLatch below; this wave's issues carry no ai_developed, so
    // the CLEAN head stays excluded exactly as pre-gh-829).
    var RULE = {
        source: 'github',
        query: {
            type: 'pr',
            checks: 'green',
            notLabels: ['ai_validating', 'pr_approved', 'ai_validated', 'chore:pin', 'validation_failed'],
            notMergeState: ['BEHIND', 'DIRTY'],
            mergeStateLatch: { CLEAN: ['ai_developed'] },
            draft: false
        },
        localAction: 'validate_pr',
        limit: 1,
        id: 'validate-fresh-masked-green'
    };

    test('matches exactly the un-armed, un-approved, BLOCKED masked-green PRs (multi-item wave)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    pr(1305),                                        // the dead zone
                    pr(1306, ['ai_validating']),                     // armed — sweep/fail own it
                    pr(1307, ['ai_validated']),                      // latched — review-after-dev owns it
                    pr(1308, ['pr_approved']),                       // merge window
                    pr(1309, ['validation_failed']),                 // parked
                    pr(1310, ['chore:pin']),                         // factory pin
                    pr(1311, [], 'CLEAN'),                           // green+CLEAN — merge-validated shape
                    pr(1312, [], 'BEHIND'),                          // silent-update refreshes first
                    pr(1313, [], 'DIRTY'),                           // conflict-rework owns it
                    pr(1314, [], 'BLOCKED', 'vendor-guest'),         // guest — validation is author-agnostic
                    { number: 1315, labels: [], draft: true,         // draft
                      user: { login: 'ai-teammate' }, head: { ref: 'wip' }, body: '' },
                    { number: 1316, labels: [], draft: false,        // checks 'none' — validate-fresh's shape
                      user: { login: 'ai-teammate' }, head: { ref: 'ai/gh-1315' }, body: 'Closes #1315' }
                ];
            }
        }, {}, {
            1305: { number: 1305, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            1306: { number: 1306, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            1307: { number: 1307, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            1308: { number: 1308, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            1309: { number: 1309, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            1310: { number: 1310, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            1311: { number: 1311, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true },
            1312: { number: 1312, state: 'OPEN', checks: 'green', mergeState: 'BEHIND', mergeable: null },
            1313: { number: 1313, state: 'OPEN', checks: 'green', mergeState: 'DIRTY', mergeable: null },
            1314: { number: 1314, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            1316: { number: 1316, state: 'OPEN', checks: 'none', mergeState: 'BLOCKED', mergeable: false }
        });

        var items = srcMod.query(RULE, { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });

        assert.equal(items[0].key, 'pr-1305',
            'limit 1 paces the wave — the OLDEST masked-green head first (validate-fresh pacing)');
        assert.deepEqual(items.slice(1).map(function (i) { return i.key; }), ['pr-1314'],
            'the tail is the gh-922 fallthrough reserve — reachable only when the head candidate yields');

        var wave = srcMod.query(Object.assign({}, RULE, { limit: 10 }),
            { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });
        assert.deepEqual(wave.map(function (i) { return i.key; }), ['pr-1305', 'pr-1314'],
            'only the zero-label BLOCKED masked-green heads match — machine AND guest (validation is author-agnostic)');
    });

    test('validate-fresh finds nothing on the same wave — the gap this rule closes', function () {
        // Same live state, the deployed validate-fresh query: checks
        // [none, pending] never sees a kicker-masked green rollup.
        var srcMod = load({
            github_list_prs: function () {
                return [pr(1305), pr(1314, [], 'BLOCKED', 'vendor-guest')];
            }
        }, {}, {
            1305: { number: 1305, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            1314: { number: 1314, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false }
        });
        var fresh = srcMod.query({
            source: 'github',
            query: {
                type: 'pr',
                checks: ['none', 'pending'],
                notLabels: ['ai_validating', 'pr_approved', 'chore:pin', 'ai_validated'],
                notMergeState: 'BEHIND',
                draft: false
            },
            limit: 1,
            id: 'validate-fresh'
        }, { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });
        assert.equal(fresh.length, 0,
            'validate-fresh is blind to the masked-green head — this IS the gh-759 dead zone');
    });
});

suite('sm github source: validate-fresh-masked-green CLEAN arm (gh-829)', function () {

    // gh-829 live instance (2026-10-10, PR #826): dev leg done (issue gh-825
    // latch ai_developed), head all-green from the ambient workflows, merge
    // state CLEAN, ZERO labels for hours — no ai_validating, no review. The
    // gh-759 rule excluded CLEAN ('merge-validated owns CLEAN'), but
    // merge-validated needs pr_approved, which a zero-label PR can never
    // reach without first being validated. The CLEAN exclusion narrows to a
    // mergeStateLatch: green + CLEAN + zero lifecycle labels + the linked
    // issue's ai_developed latch → arm; without the latch the exclusion
    // stands. Same shared harness as the gh-759 suite (maskedGreenHarness).

    var h = maskedGreenHarness();
    var load = h.load;
    var pr = h.pr;

    // The deployed post-gh-829 rule shape: CLEAN left notMergeState, gated
    // by the issue latch instead.
    var RULE = {
        source: 'github',
        query: {
            type: 'pr',
            checks: 'green',
            notLabels: ['ai_validating', 'pr_approved', 'ai_validated', 'chore:pin', 'validation_failed'],
            notMergeState: ['BEHIND', 'DIRTY'],
            mergeStateLatch: { CLEAN: ['ai_developed'] },
            draft: false
        },
        localAction: 'validate_pr',
        skipIfGreenCi: true,
        limit: 1,
        id: 'validate-fresh-masked-green'
    };

    // Issue label map: pr(n) links issue n-1. Latched issues: 825 (pr-826),
    // 835 (pr-836), 837 (pr-838), 839 (pr-840), 841 (pr-842). Everything
    // else resolves to a label-less issue; 827 simulates a fetch failure.
    var ISSUE_LABELS = { 825: ['ai_developed'], 835: ['ai_developed'],
                         837: ['ai_developed'], 839: ['ai_developed'], 841: ['ai_developed'] };

    function wave() {
        return {
            github_list_prs: function () {
                return [
                    pr(826),                                   // CLEAN + latch — THE dead zone (AC1)
                    pr(827, [], 'CLEAN', 'vendor-guest'),      // guest, no latch — stays unarmed (AC3)
                    pr(828),                                   // CLEAN + latch issue fetch FAILS — fail closed
                    { number: 829, labels: [], draft: false,  // CLEAN + latch, UNLINKED (no #N in body)
                      user: { login: 'ai-teammate' }, head: { ref: 'ai/gh-x' }, body: 'no anchor here' },
                    pr(830, ['ai_validating']),                // armed — sweep/fail own it (AC2)
                    pr(831, ['pr_approved']),                  // merge window (AC2)
                    pr(832, ['ai_validated']),                 // latched — review-after-dev (AC2)
                    pr(833, ['chore:pin']),                    // factory pin (AC2)
                    pr(834, ['validation_failed']),            // parked (AC2)
                    pr(835, [], 'BLOCKED'),                    // gh-759 branch, NO latch — author-agnostic
                    pr(836, [], 'BLOCKED'),                    // gh-759 branch + latch — matches too
                    pr(837, [], 'BEHIND'),                     // silent-update refreshes first
                    pr(838, [], 'DIRTY'),                      // conflict-rework owns it
                    { number: 840, labels: [], draft: true,   // draft
                      user: { login: 'ai-teammate' }, head: { ref: 'wip' }, body: 'Closes #839' },
                    { number: 842, labels: [], draft: false,  // checks 'none' — validate-fresh's lane
                      user: { login: 'ai-teammate' }, head: { ref: 'ai/gh-841' }, body: 'Closes #841' }
                ];
            }
        };
    }

    function statuses() {
        var s = {};
        [826, 827, 828, 829, 830, 831, 832, 833, 834, 835, 836, 837, 838, 840, 842]
            .forEach(function (n) {
                s[n] = { number: n, state: 'OPEN', checks: 'green',
                         mergeState: 'CLEAN', mergeable: true };
            });
        s[835].mergeState = 'BLOCKED'; s[835].mergeable = false;
        s[836].mergeState = 'BLOCKED'; s[836].mergeable = false;
        s[837].mergeState = 'BEHIND';  s[837].mergeable = null;
        s[838].mergeState = 'DIRTY';   s[838].mergeable = null;
        s[842].checks = 'none';
        return s;
    }

    test('CLEAN + green + zero labels + ai_developed latch arms; the full matrix holds (AC1/AC2/AC3)', function () {
        var srcMod = load(wave(), {}, statuses(), ISSUE_LABELS, { 828: true });

        var full = srcMod.query(Object.assign({}, RULE, { limit: 50 }),
            { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });
        assert.deepEqual(full.map(function (i) { return i.key; }), ['pr-826', 'pr-835', 'pr-836'],
            'CLEAN+latch arms (AC1), the unlatched guest/failed-fetch/unlinked CLEAN heads stay ' +
            'unarmed (AC3), every lifecycle label stays untouched (AC2), BEHIND/DIRTY/draft/' +
            "checks-none stay in their owners' lanes, and the BLOCKED branch keeps matching " +
            'with and without the latch (gh-759 author-agnostic contract)');

        var one = srcMod.query(RULE, { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });
        assert.equal(one[0].key, 'pr-826',
            'limit 1 paces the wave — the oldest dead-zone head first, same dev-lane pacing');
        assert.deepEqual(one.slice(1).map(function (i) { return i.key; }), ['pr-835', 'pr-836'],
            'the tail is the gh-922 fallthrough reserve — the engine still dispatches only the head');
    });

    test('the pre-gh-829 deployed query could not arm pr-826 — the bug this fixes', function () {
        var srcMod = load(wave(), {}, statuses(), ISSUE_LABELS, { 828: true });
        var old = srcMod.query({
            source: 'github',
            query: {
                type: 'pr',
                checks: 'green',
                notLabels: ['ai_validating', 'pr_approved', 'ai_validated', 'chore:pin', 'validation_failed'],
                notMergeState: ['BEHIND', 'DIRTY', 'CLEAN'],
                draft: false
            },
            localAction: 'validate_pr',
            skipIfGreenCi: true,
            limit: 50,
            id: 'validate-fresh-masked-green'
        }, { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });
        assert.equal(old.map(function (i) { return i.key; }).indexOf('pr-826'), -1,
            'CLEAN excluded, no latch guard → pr-826 invisible to every arming rule — the exact live dead zone');
    });

    test('string-form latch value arms exactly like the array form (config normalization)', function () {
        // gh-829 review: latchWant was iterated as an array, but unlike
        // notMergeState/mergeState/checks a string-form config value was
        // never normalized — latchWant[li] indexed CHARACTERS and every
        // lookup missed, silently disabling the CLEAN arm (zero signal).
        // The established string | string[] normalization must hold here
        // too, or a future config edit resurrects the #826 dead zone.
        var srcMod = load({
            github_list_prs: function () { return [pr(826)]; }
        }, {}, {
            826: { number: 826, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
        }, { 825: ['ai_developed'] });

        var items = srcMod.query({
            source: 'github',
            query: {
                type: 'pr',
                checks: 'green',
                notLabels: ['ai_validating', 'pr_approved', 'ai_validated', 'chore:pin', 'validation_failed'],
                notMergeState: ['BEHIND', 'DIRTY'],
                mergeStateLatch: { CLEAN: 'ai_developed' },   // STRING form, not an array
                draft: false
            },
            localAction: 'validate_pr',
            skipIfGreenCi: true,
            limit: 5,
            id: 'validate-fresh-masked-green'
        }, { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });

        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-826'],
            'the string form normalizes to a one-element array — the CLEAN arm fires exactly as the array form');
    });

    test('latch guard fails closed on pr-less items — issue carrier without a linked PR', function () {
        // gh-829 review: with item.pr absent, latchState is null →
        // latchWant is null → the guard body was skipped and the item
        // PASSED the latch check, contradicting the documented 'fails
        // CLOSED' contract. An item whose merge state is UNKNOWN must not
        // match a latch over CLEAN. Issue gh-100 has a linked CLEAN PR +
        // the latch label; gh-101 carries the label but NO linked PR.
        var srcMod = load({
            github_search_issues: function () {
                return [
                    { number: 100, labels: [{ name: 'ai_developed' }] },
                    { number: 101, labels: [{ name: 'ai_developed' }] }
                ];
            }
        }, {
            100: { number: 200, state: 'OPEN' }   // findPr(100) → open pr-200
        }, {
            200: { number: 200, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', mergeable: true }
        }, { 100: ['ai_developed'], 101: ['ai_developed'] });

        var items = srcMod.query({
            source: 'github',
            query: {
                type: 'issue',
                labels: ['ai_developed'],
                mergeStateLatch: { CLEAN: ['ai_developed'] }
            },
            localAction: 'validate_pr',
            limit: 10,
            id: 'latch-fail-closed-prless'
        }, { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });

        assert.deepEqual(items.map(function (i) { return i.key; }), ['gh-100'],
            'the pr-less issue is EXCLUDED — an unknown merge state never satisfies a latch over CLEAN');
    });

    test('latch guard fails closed on pr-less items — pr carrier whose status never resolved', function () {
        // Same contract on the pr-carrier path: a latch-only query has no
        // checks/mergeState/notMergeState guard, so queryPrs never fetches
        // prStatus and item.pr stays null — the item must not sail through
        // the latch. The linked issue carries the latch label; the pr-less
        // head still stays unarmed.
        var srcMod = load({
            github_list_prs: function () {
                return [pr(950)];   // 'Closes #949', issue 949 latched
            }
        }, {}, {}, { 949: ['ai_developed'] });

        var items = srcMod.query({
            source: 'github',
            query: {
                type: 'pr',
                mergeStateLatch: { CLEAN: ['ai_developed'] },
                draft: false
            },
            localAction: 'validate_pr',
            limit: 5,
            id: 'latch-fail-closed-prcarrier'
        }, { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });

        assert.equal(items.length, 0,
            'a pr-less head is excluded even with the latch label on its issue — fail closed');
    });

    test('BLOCKED branch needs no latch and no issue fetch (guest-friendly, gh-759 contract)', function () {
        // Only the BLOCKED PRs on the list. gh-829 review: load() always
        // injects a label-less RETURNING stub, which would happily answer
        // a regression that consults the issue on the BLOCKED path — so
        // override it with a THROWING stub and pin the no-fetch half of
        // the gh-757 contract for real (load()'s tools merge lets a caller
        // override the default stub).
        var srcMod = load({
            github_list_prs: function () {
                return [pr(900, [], 'BLOCKED', 'vendor-guest'), pr(901, [], 'BLOCKED')];
            },
            github_get_issue: function () {
                throw new Error('latch must not fetch the issue on the BLOCKED path');
            }
        }, {}, {
            900: { number: 900, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false },
            901: { number: 901, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', mergeable: false }
        });
        var items = srcMod.query(Object.assign({}, RULE, { limit: 10 }),
            { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });
        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-900', 'pr-901'],
            'the mergeStateLatch is inert on BLOCKED — guests keep the validation dispatch');
    });

    test('review-on-issue-label rule exists in sm_github.json (issue-carried review arm)', function () {
        // Live dead loop (dart gh-377, 2026-10-15): agent:review sat on the
        // ISSUE while every review arm in the catalog is PR-carried — the PR
        // carried no labels, the tick processed 0 for hours, the whole
        // dart pipeline serialized behind one unreachable review. Mirrors
        // rework's dual-carrier design (rework-on-red-ci is issue-carried,
        // rework-on-label is PR-carried): review gets the same issue arm.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        var r = rules.filter(function (x) { return x.id === 'review-on-issue-label'; })[0];
        assert.ok(r, 'review-on-issue-label present');
        assert.equal(r.query.type, 'issue', 'matches the ISSUE carrier');
        assert.deepEqual(r.query.labels, ['agent:review'],
            'arms on the issue label only');
        assert.equal(r.workflowFile, 'ai-teammate.yml', 'dispatches the review leg');
        assert.equal(r.inputs.leg, 'review', 'leg=review');
        assert.equal(r.inputs.issue, '{issueNumber}',
            'issue-carried: the engine resolves the linked PR from the issue');
        assert.equal(r.workflowRef, '{branch}', 'the leg runs on the PR head');
        assert.deepEqual(r.query.notPrLabels, ['agent:review', 'pr_approved'],
            'defers to the PR-carrier rule and skips concluded reviews');
        assert.deepEqual(r.query.notLabels, ['agent:rework'],
            'a PR sent to rework must not simultaneously arm a re-review (#683)');
        // Catalog order: the PR-carrier arm must stay ahead of the issue one
        // (RULE ORDER discipline — the closer anchor wins the tick).
        var ids = rules.map(function (x) { return x.id; });
        assert.ok(ids.indexOf('review-on-label') < ids.indexOf('review-on-issue-label'),
            'review-on-label (PR carrier) precedes review-on-issue-label');
    });

    test('sm_github.json carries validationConcurrency=3 (parallel validations on the widened runner pool)', function () {
        // Live stall (2026-10-15 sweep): the guest FIFO queued 6+ approved
        // PRs while the pool sat 3-wide idle — the serial mutex (default 1)
        // was the governor, not runner capacity. The knob (gh-837, clamped
        // ≤5, watermark-gated) engages only at queue depth ≥ watermark(3),
        // so thin queues keep the legacy serial window.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var p = (cfg.params && cfg.params.jobParams) || {};
        assert.equal(p.validationConcurrency, 3, '3-wide validation window');
        assert.ok(p.validationConcurrency >= 1 && p.validationConcurrency <= 5,
            'inside the gh-837 clamp');
    });

    test('rework-on-red-gate-unlatched rule exists (red gate arms rework, latch or no latch)', function () {
        // Owner directive (2026-10-15): a red pre-merge gate MUST arm a
        // rework leg — always. Live hole (dart 408, head 01a95d5, 18:11Z):
        // a red CRAP-ratchet wave dispatched outside the ai_validating arm
        // armed NOTHING (fail-validation is latch-gated), the follow-up
        // green wave papered it over, and the PR sat blocked instead of
        // entering rework round N+1. This rule is the unlatched twin:
        // machine-authored PR + a concluded red required-gate run on the
        // current head -> arm_rework (the PR-carrier rework-on-label then
        // dispatches the leg). The latched case stays with fail-validation.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        var r = rules.filter(function (x) { return x.id === 'rework-on-red-gate-unlatched'; })[0];
        assert.ok(r, 'rework-on-red-gate-unlatched present');
        assert.equal(r.query.type, 'pr', 'PR-carried');
        assert.deepEqual(r.query.checks, ['red'], 'fires on a concluded red gate');
        assert.ok(r.query.notLabels.indexOf('ai_validating') !== -1,
            'the latched case belongs to fail-validation');
        assert.ok(r.query.notLabels.indexOf('validation_failed') !== -1,
            'no re-arm while the failure latch is fresh');
        assert.ok(r.query.notLabels.indexOf('agent:rework') !== -1,
            'no double-arm while a rework is already armed');
        assert.equal(r.query.prMachineAuthor, true,
            'auto-rework is machine-only (owner rule)');
        assert.deepEqual(r.query.notMergeState, ['BEHIND', 'DIRTY'],
            'stale waves on old heads are the silent-update\'s business');
        assert.equal(r.localAction, 'arm_rework', 'arms via the shared arm path');
        // Catalog order: directly after fail-validation (latched first, then
        // the unlatched twin — RULE ORDER discipline).
        var ids = rules.map(function (x) { return x.id; });
        assert.ok(ids.indexOf('fail-validation') < ids.indexOf('rework-on-red-gate-unlatched'),
            'fail-validation precedes its unlatched twin');
    });

    test('rework-on-validation-failed rule exists (parked machine PRs reach rework)', function () {
        // Owner directive (2026-10-15): red pre-merge gate MUST raise a
        // rework leg — for machine-authored PRs the validation_failed PARK
        // (guest semantics: wait for a human push) must never become a
        // dead end. Live hole (dart 410, 2026-10-15 19:53Z; the #390
        // validation_failed retry loop family): fail_validation stamped
        // the latch, no rule arms rework from it, the machine PR sits
        // parked while the gate stays red. The leg's push is a newer head
        // event, so the park-clear path re-opens validation on the fix.
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        var r = rules.filter(function (x) { return x.id === 'rework-on-validation-failed'; })[0];
        assert.ok(r, 'rework-on-validation-failed present');
        assert.equal(r.query.type, 'pr', 'PR-carried');
        assert.ok(r.query.labels.indexOf('validation_failed') !== -1,
            'fires from the failure latch');
        assert.ok(r.query.notLabels.indexOf('agent:rework') !== -1,
            'no double-arm while a rework is already armed');
        assert.ok(r.query.notLabels.indexOf('ai_validating') !== -1,
            'an armed validation still owns the verdict');
        assert.equal(r.query.prMachineAuthor, true,
            'guest parked PRs keep the human-push semantics (owner rule)');
        assert.deepEqual(r.query.checks, ['red'],
            'the failure stands — not a mid-revalidate wave');
        assert.equal(r.localAction, 'arm_rework', 'arms via the shared arm path');
        var ids = rules.map(function (x) { return x.id; });
        assert.ok(ids.indexOf('rework-on-red-gate-unlatched') < ids.indexOf('rework-on-validation-failed'),
            'the unlatched twin precedes the latched-park twin');
    });
});

suite('sm github source: rework-on-red-gate-unlatched covers the FIRST validation (gh-917)', function () {

    // gh-917 live evidence (epam/dmtools-dart, 2026-10-16 11:06Z tick): two
    // fresh dev PRs (#413 quality 09:46Z — method_size 82/72-line test
    // helpers; #414 quality 10:19Z — complexity CC=12 + method_size 94-line
    // main) sat with RED first validations while the SM concluded
    // `processed: 0, skipped: 0`. The 2026-10-15 red-gate rule required the
    // post-review latch (ai_pr_reviewed) — a fresh dev PR carries ZERO PR
    // labels (ai_developed lives on the linked issue, ai_validating is only
    // stamped by validate-fresh, which never dispatches on an already-red
    // head) — so the red first validation matched NO rule and the trunk
    // stalled until a human intervened (hand-fixed 11:19Z). The deployed
    // rule must match ANY machine-authored red head: first validation
    // included, review or no review.

    var h = maskedGreenHarness();
    var load = h.load;
    var pr = h.pr;

    function deployedRule() {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        return rules.filter(function (x) { return x.id === 'rework-on-red-gate-unlatched'; })[0];
    }

    test('a ZERO-label machine dev PR with a red first validation matches (the gh-917 dead zone)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    pr(413),                                     // fresh dev PR, red quality wave — THE dead zone
                    pr(408, ['ai_pr_reviewed'])                  // the original dart-408 reviewed case
                ];
            }
        }, {}, {
            413: { number: 413, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false },
            408: { number: 408, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false }
        });

        var rule = deployedRule();
        assert.ok(rule, 'deployed rule present');
        var items = srcMod.query(Object.assign({}, rule, { limit: 10 }),
            { repoInfo: { owner: 'epam', repo: 'dmtools-dart' }, machineAuthor: 'ai-teammate' });

        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-408', 'pr-413'],
            'both the reviewed red head AND the first-validation red head arm rework (gh-917)');
    });

    test('the lanes stay disjoint: armed, parked, pinned, guest, stale heads never match', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    pr(420, ['ai_validating']),                  // armed — fail-validation owns the verdict
                    pr(421, ['validation_failed']),              // parked — the latched-park twin owns it
                    pr(422, ['agent:rework']),                   // already armed — no double arm
                    pr(423, ['chore:pin']),                      // factory lockstep bump — factory-gated
                    pr(424, [], 'BLOCKED', 'vendor-guest'),      // guest — auto-rework is machine-only
                    pr(425, [], 'BEHIND'),                       // silent-update refreshes first
                    pr(426, [], 'DIRTY'),                        // conflict-rework owns it
                    pr(427, [], 'CLEAN')                         // matches — red is red in every merge state but BEHIND/DIRTY
                ];
            }
        }, {}, {
            420: { number: 420, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false },
            421: { number: 421, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false },
            422: { number: 422, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false },
            423: { number: 423, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false },
            424: { number: 424, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false },
            425: { number: 425, state: 'OPEN', checks: 'red', mergeState: 'BEHIND', mergeable: null },
            426: { number: 426, state: 'OPEN', checks: 'red', mergeState: 'DIRTY', mergeable: null },
            427: { number: 427, state: 'OPEN', checks: 'red', mergeState: 'CLEAN', mergeable: true }
        });

        var rule = deployedRule();
        var items = srcMod.query(Object.assign({}, rule, { limit: 10 }),
            { repoInfo: { owner: 'epam', repo: 'dmtools-dart' }, machineAuthor: 'ai-teammate' });

        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-427'],
            'only the unprotected red machine head matches — every labeled lane keeps its owner');
    });

    test('fail-closed without a machine author: the rule matches nothing (no auto legs at all)', function () {
        var srcMod = load({
            github_list_prs: function () { return [pr(430)]; }
        }, {}, {
            430: { number: 430, state: 'OPEN', checks: 'red', mergeState: 'BLOCKED', mergeable: false }
        });

        var rule = deployedRule();
        var items = srcMod.query(rule,
            { repoInfo: { owner: 'epam', repo: 'dmtools-dart' } });

        assert.equal(items.length, 0,
            'no machineAuthor configured → prMachineAuthor fails closed (owner rule)');
    });

    test('the rule carries the red-head max-attempt gate (redHeadGated)', function () {
        // gh-917 ask: "the same latch/anti-loop protections (max attempts,
        // no infinite retry on unfixable-without-toolchain violations)".
        var rule = deployedRule();
        assert.equal(rule.redHeadGated, true,
            'the arming is bounded per head — the shared 🔴 red-head marker budget');
    });
});

suite('sm github source: trigger fail-open overfetch (gh-922)', function () {
    // gh-922 (live fa pr-1615 2026-10-16): a candidate whose workflow
    // trigger 422s (deleted head ref) must not consume the dispatch slot.
    // The SM engine loop already gives failed candidates no slot credit —
    // the starvation came from queryPrs slicing the candidate list to
    // `limit` BEFORE any dispatch: a limit:1 rule returned ONLY the dead
    // head and the loop had nothing to fall through to. The source now
    // over-fetches `limit + TRIGGER_FALLTHROUGH_RESERVE` tier-sorted
    // candidates; the engine's processedKeys cap still bounds successful
    // dispatches at `limit`. The 🥇 preemption marker stays keyed on the
    // `limit` boundary (the slot count), not the overfetch boundary.

    var load = function (tools, prs, statuses) {
        var localProvider = {
            prStatus: function (n) { return (statuses || {})[n] || null; }
        };
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': {
                createSmProvider: function () { return localProvider; }
            }
        }), tools || {});
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return localProvider; },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': smAsyncMod,
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), tools);
    };

    function listPr(n, labels, ref, headFull) {
        return { number: n, state: 'open', draft: false, body: '',
                 head: { sha: 'ovsha' + n, ref: ref || ('feat/ov-' + n),
                         repo: headFull ? { full_name: headFull } : null },
                 labels: (labels || []).map(function (l) { return { name: l }; }),
                 user: { login: 'ai-teammate' } };
    }

    test('queryPrs returns limit + fallthrough-reserve candidates (the FIFO survives a dead head)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(306, ['agent:review']),
                    listPr(305, ['agent:review']),
                    listPr(304, ['agent:review']),
                    listPr(303, ['agent:review']),
                    listPr(302, ['agent:review', 'priority_blocker']),
                    listPr(301, ['agent:review'])
                ];
            }
        });

        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 1
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate' });

        assert.equal(items.length, 4,
            'limit 1 must still return the reserve candidates (limit + 3) for the same-tick fallthrough');
        assert.equal(items[0].prNumber, 302,
            'the blocker still leads the tier sort');
        assert.deepEqual(items.slice(1).map(function (i) { return i.prNumber; }),
            [301, 303, 304],
            'the rest is plain FIFO — oldest mediums first');
    });

    test('a parked (validation_failed) blocker does NOT preempt — its tier is voided to medium', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(302, ['agent:review', 'priority_blocker', 'validation_failed']),
                    listPr(301, ['agent:review'])
                ];
            }
        });

        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 1
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate' });

        assert.equal(items[0].prNumber, 301,
            'the parked blocker waits in plain FIFO order — a park can never preempt');
    });

    test('the 🥇 preemption marker still fires at the limit boundary (not the overfetch boundary)', function () {
        var logs = [];
        var srcMod = load({
            console: { log: function () { logs.push(Array.prototype.map.call(arguments, String).join(' ')); },
                       warn: function () {}, error: function () {} },
            github_list_prs: function () {
                return [
                    listPr(302, ['agent:review', 'priority_blocker']),
                    listPr(301, ['agent:review'])
                ];
            }
        });

        srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 1
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate' });

        assert.ok(logs.some(function (l) {
            return l.indexOf('\uD83E\uDD47') !== -1 && l.indexOf('pr-302') !== -1;
        }), 'the blocker taking the limit:1 slot over a cut medium still logs the preemption line');
    });

    test('gh-1057: a FORK dead-head park whose branch lives on the fork (404 in base) is NOT benched', function () {
        // Live fa pr-1591: the gh-922 oracle probed the head branch in the
        // BASE repo, where a fork branch is always 404 — a restored fork
        // stayed parked forever. The bench must consult the PR's head
        // repository (head.repo.full_name) instead.
        var calls = [];
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(302, ['agent:review', 'validation_failed'], 'fix/fork-branch', 'forko/forkr'),
                    listPr(301, ['agent:review'], 'feat/alive')
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 5
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate',
             provider: { branchExists: function (name, headFull) {
                 calls.push(name + '@' + headFull);
                 // base repo never holds a fork branch; the fork does
                 if (!headFull || headFull === 'o/r') return false;
                 return name !== 'gone/everywhere';
             } } });

        assert.deepEqual(items.map(function (i) { return i.prNumber; }), [301, 302],
            'the restored fork head re-enters the queue — parked label + LIVE fork branch stays a candidate');
        assert.equal(calls.indexOf('fix/fork-branch@forko/forkr') !== -1, true,
            'the oracle was asked against the FORK repo, not the base');
        assert.equal(items[1].headRepo, 'forko/forkr',
            'the item carries the head repo for the bench oracle');
    });

    test('gh-1057: a fork PR whose branch is gone from BOTH repos stays benched', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(302, ['agent:review', 'validation_failed'], 'gone/everywhere', 'forko/forkr'),
                    listPr(301, ['agent:review'], 'feat/alive')
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 5
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate',
             provider: { branchExists: function (name, headFull) {
                 if (!headFull || headFull === 'o/r') return false;
                 return name !== 'gone/everywhere';
             } } });

        assert.deepEqual(items.map(function (i) { return i.prNumber; }), [301],
            'a fork branch deleted everywhere is still a dead head — the bench verdict holds');
    });

    test('gh-1057: fail-open preserved — a fork probe error keeps the parked item', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(302, ['agent:review', 'validation_failed'], 'fix/fork-branch', 'forko/forkr')
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 5
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate',
             provider: { branchExists: function () { throw new Error('fork probe denied'); } } });

        assert.equal(items.length, 1,
            'a throwing fork probe never strands the candidate (fail-open, today\'s contract)');
    });

    test('gh-1059: STRING and GraphQL head.repo spellings ride the item via the shared resolver', function () {
        // gh-1059 rework: githubSource consumes the ONE smProvider
        // resolver — a string head.repo and the GraphQL nameWithOwner
        // dialect must flow to the item and the bench oracle exactly like
        // the REST full_name shape (the deleted duplicate _prListHeadRepo
        // accepted strings but never nameWithOwner).
        var calls = [];
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 303, state: 'open', draft: false, body: '',
                      head: { sha: 's3', ref: 'fix/str', repo: 'forko/forkr' },
                      labels: [{ name: 'agent:review' }, { name: 'validation_failed' }],
                      user: { login: 'ai-teammate' } },
                    { number: 302, state: 'open', draft: false, body: '',
                      head: { sha: 's2', ref: 'fix/gql',
                              repo: { nameWithOwner: 'gqlowner/gqlrepo' } },
                      labels: [{ name: 'agent:review' }, { name: 'validation_failed' }],
                      user: { login: 'ai-teammate' } },
                    { number: 301, state: 'open', draft: false, body: '',
                      head: { sha: 's1', ref: 'feat/alive', repo: null },
                      labels: [{ name: 'agent:review' }],
                      user: { login: 'ai-teammate' } }
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 5
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate',
             provider: { branchExists: function (name, headFull) {
                 calls.push(name + '@' + headFull);
                 return true; // every probed head is alive
             } } });

        assert.equal(items.length, 3,
            'all three dialects resolve a live head repo — nothing is benched');
        var byNum = {};
        items.forEach(function (i) { byNum[i.prNumber] = i; });
        assert.equal(byNum[303].headRepo, 'forko/forkr',
            'the STRING head.repo spelling resolves through the shared resolver');
        assert.equal(byNum[302].headRepo, 'gqlowner/gqlrepo',
            'the GraphQL nameWithOwner dialect resolves through the shared resolver');
        assert.equal(calls.indexOf('fix/str@forko/forkr') !== -1, true,
            'the oracle was asked against the fork named by the string spec');
        assert.equal(calls.indexOf('fix/gql@gqlowner/gqlrepo') !== -1, true,
            'the oracle was asked against the fork named by nameWithOwner');
    });

    test('a dead-head park (validation_failed + gone head ref) is benched from the candidate list', function () {
        // PRRT_kwDORYAuYs6tR-Jq: parked heads are never removed from
        // candidacy — 4+ simultaneously dead heads burned the whole
        // limit+3 slice every tick and re-starved the FIFO. The source
        // benches validation_failed candidates whose head ref the
        // provider cannot see; the reserve stays free for live failures.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(302, ['agent:review', 'validation_failed'], 'gone/deleted-branch'),
                    listPr(301, ['agent:review'], 'feat/alive')
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 1
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate',
             provider: { branchExists: function (name) { return name !== 'gone/deleted-branch'; } } });

        assert.deepEqual(items.map(function (i) { return i.prNumber; }), [301],
            'the dead-head park never reaches the dispatch loop — no burned attempts, no reserve slots');
    });

    test('a LIVE parked PR (red park, head ref present) stays a candidate — park-reset keeps its lane', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(303, ['validation_failed'], 'gone/really-deleted'),
                    listPr(302, ['validation_failed'], 'feat/red-but-alive')
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['validation_failed'], draft: false }, limit: 5
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate',
             provider: { branchExists: function (name) { return name !== 'gone/really-deleted'; } } });

        assert.deepEqual(items.map(function (i) { return i.prNumber; }), [302],
            'only DEAD heads are benched — the park-reset rule must still find red-parked PRs');
    });

    test('non-parked candidates are never benched (the bench keys on the park label)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(302, ['agent:review'], 'gone/deleted-branch'),
                    listPr(301, ['agent:review'], 'feat/alive')
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 1
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate',
             provider: { branchExists: function () { return false; } } });

        assert.equal(items.length, 2,
            'an UNPARKED dead head keeps its candidacy — the marker/park ladder owns it (fail-open dispatch)');
    });

    test('fail-open: a provider without branchExists benches nothing (pre-fix behavior)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    listPr(302, ['agent:review', 'validation_failed'], 'gone/deleted-branch'),
                    listPr(301, ['agent:review'], 'feat/alive')
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:review'], draft: false }, limit: 1
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate' });

        assert.equal(items.length, 2,
            'no branch-existence oracle → no benching (a blind tick never strands a candidate)');
    });
});

suite('sm github source: dev-on-assignment re-derive (gh-944)', function () {
    // gh-944 (night operation 2026-10-17): six issues assigned in one burst
    // → six `issues`-event factory runs, all derived run=false within a
    // minute — and the SM rule pack had NO dev re-derive rule, so the items
    // starved for 3.5 h until an operator explicit-dispatched leg=dev
    // (00:52Z tick: processed: 0). The derive itself lives in the factory
    // gate (awf repo); the engine-side safety net is an SM rule that
    // re-derives dev legs for assigned-but-never-started issues (ticket
    // acceptance (b): "documented one-per-tick draining with SM re-derive").
    // The machine login is a deployment knob, never a pack constant: the
    // rule carries the {machineAuthor} placeholder and the source resolves
    // it against the same resolveMachineAuthor knob every other
    // machine-keyed guard uses.

    var devStub = {
        findPr: function (n) { return devStub._prs[n] || null; },
        prStatus: function (n) { return devStub._status[n] || null; },
        _prs: {},
        _status: {}
    };

    function devLoad(tools, prs, statuses) {
        devStub._prs = prs || {};
        devStub._status = statuses || {};
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': {
                createSmProvider: function () { return devStub; }
            }
        }), tools || {});
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return devStub; },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': smAsyncMod,
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), tools);
    }

    test('{machineAuthor} placeholder in query.assignee resolves to the deployment knob', function () {
        var queries = [];
        var srcMod = devLoad({
            github_search_issues: function (args) {
                queries.push(args.query);
                if (args.query.indexOf('assignee:ai-teammate') !== -1) {
                    return { items: [{ number: 925, labels: [] }] };
                }
                return { items: [] };
            }
        });
        var items = srcMod.query({
            query: { type: 'issue', assignee: '{machineAuthor}' }
        }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'ai-teammate' });

        assert.equal(queries.length, 1, 'one assignee search descriptor');
        assert.equal(queries[0].indexOf('assignee:ai-teammate') !== -1, true,
            'the placeholder expanded to the resolved machine login, not the literal {machineAuthor}');
        assert.deepEqual(items.map(function (i) { return i.key; }), ['gh-925']);
    });

    test('a comma-separated machineAuthor list searches its FIRST login', function () {
        var queries = [];
        var srcMod = devLoad({
            github_search_issues: function (args) {
                queries.push(args.query);
                return { items: [] };
            }
        });
        srcMod.query({
            query: { type: 'issue', assignee: '{machineAuthor}' }
        }, { repoInfo: { owner: 'a', repo: 'b' },
             machineAuthor: 'ai-teammate,github-actions[bot]' });

        assert.equal(queries[0].indexOf('assignee:ai-teammate') !== -1, true,
            'the primary (harness) login drives the search — the CI-bot twin never receives assignments');
    });

    test('fail-closed: no machineAuthor configured → the assignee scan never runs', function () {
        var queries = [];
        var srcMod = devLoad({
            github_search_issues: function (args) {
                queries.push(args.query);
                return { items: [{ number: 925, labels: [] }] };
            }
        });
        var items = srcMod.query({
            query: { type: 'issue', assignee: '{machineAuthor}' }
        }, { repoInfo: { owner: 'a', repo: 'b' } });

        assert.equal(queries.length, 0,
            'an unresolvable placeholder must not search for a literal "{machineAuthor}" assignee');
        assert.equal(items.length, 0, 'the rule matches nothing (fail-closed, like prMachineAuthor)');
    });

    test('fail-closed: a machineAuthor that IS the literal placeholder never searches for it', function () {
        // Edge of the resolution contract (pr-945 rework): a misconfigured
        // knob ('{machineAuthor}' as the literal login) must survive the
        // expansion WITHOUT re-introducing the placeholder — the descriptor
        // is dropped, the search never runs for a literal '{machineAuthor}'.
        var queries = [];
        var srcMod = devLoad({
            github_search_issues: function (args) {
                queries.push(args.query);
                return { items: [] };
            }
        });
        srcMod.query({
            query: { type: 'issue', assignee: '{machineAuthor}' }
        }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: '{machineAuthor}' });

        assert.equal(queries.length, 0,
            'a placeholder-valued knob must not produce an assignee search descriptor');
    });

    test('noOpenPr guard: an issue with an OPEN linked PR is post-dev and never re-derived (2+ PR states)', function () {
        // A dev leg already produced PRs for these issues: OPEN must exclude
        // (the loop owns the item via the PR lifecycle rules), while MERGED
        // (issue reopened) and no-PR stay eligible — a merged-PR issue that
        // a human reopened is exactly a fresh dev handoff.
        var srcMod = devLoad({
            github_search_issues: function () {
                return { items: [
                    { number: 401, labels: [] },
                    { number: 402, labels: [] },
                    { number: 403, labels: [] }
                ] };
            }
        }, {
            401: { number: 500, state: 'OPEN' },
            402: { number: 501, state: 'MERGED' }
        }, {
            500: { number: 500, state: 'OPEN', checks: 'green', mergeState: 'CLEAN' }
        });
        var items = srcMod.query({
            query: { type: 'issue', assignee: 'ai-teammate', noOpenPr: true }
        }, { repoInfo: { owner: 'a', repo: 'b' }, machineAuthor: 'ai-teammate' });

        assert.deepEqual(items.map(function (i) { return i.key; }), ['gh-402', 'gh-403'],
            'OPEN linked PR excluded; MERGED-PR and PR-less issues stay eligible');
    });

    test('dev-on-assignment rule exists in sm_github.json (the SM safety net)', function () {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var rules = (cfg.rules || (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules)) || [];
        var r = rules.filter(function (x) { return x.id === 'dev-on-assignment'; })[0];
        assert.ok(r, 'dev-on-assignment present');
        assert.equal(r.source, 'github', 'github carrier');
        assert.equal(r.query.type, 'issue', 'issue-carrier query');
        assert.equal(r.query.assignee, '{machineAuthor}',
            'the machine login is a deployment knob (resolved by the source), never a pack constant');
        assert.equal(r.query.noOpenPr, true,
            'issues the dev leg already produced a PR for stay with the PR lifecycle rules');
        ['ai_developed', 'ai_pr_reviewed', 'pr_approved', 'agent:rework', 'agent:review', 'agent:skip']
            .forEach(function (label) {
                assert.ok((r.query.notLabels || []).indexOf(label) !== -1,
                    'notLabels must exclude the loop marker "' + label + '" — a live loop item is never re-derived');
            });
        assert.equal(r.inputs.issue, '{issueNumber}', 'issue-anchored dispatch');
        assert.equal(r.inputs.leg, 'dev', 'the re-derived leg is dev');
        assert.equal(r.workflowFile, 'ai-teammate.yml', 'dispatches the factory workflow');
        assert.ok(r.limit >= 1 && r.limit <= 5,
            'bounded per tick — a burst drains over consecutive ticks (workflow budget caps concurrency)');
    });
});

suite('sm github source — gh-1009 CRAP characterization (paths touched by the query split)', function () {

    var providerStub = {
        listOpenPrs: null, // set per-test; absence → direct github_list_prs fetch
        branchExists: function () { return true; },
        prStatus: function (n) { return providerStub._status[n] || null; },
        _status: {}
    };

    function load(tools, statuses) {
        providerStub._status = statuses || {};
        providerStub.listOpenPrs = null;
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return providerStub; },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {}),
            '../../common/smAsync.js': loadModule('js/common/smAsync.js', makeRequire({
                './common/smProvider.js': { createSmProvider: function () { return providerStub; } }
            }), tools || {})
        }), tools || {});
    }

    test('mergeStateLatch: EVERY listed latch label must sit on the issue (array form, characterization)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 301, labels: [], body: '', draft: false,
                      head: { ref: 'ai/gh-301' }, user: { login: 'bot' } },
                    { number: 302, labels: [], body: '', draft: false,
                      head: { ref: 'ai/gh-302' }, user: { login: 'bot' } },
                    { number: 303, labels: [], body: '', draft: false,
                      head: { ref: 'ai/gh-303' }, user: { login: 'bot' } }
                ];
            },
            github_get_issue: function (args) {
                if (args.issueNumber === 301) return { labels: [{ name: 'ai_developed' }, { name: 'ai_validated' }] };
                if (args.issueNumber === 302) return { labels: [{ name: 'ai_developed' }] };
                return { labels: [] };
            }
        }, {
            301: { number: 301, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', headSha: 's301' },
            302: { number: 302, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', headSha: 's302' },
            303: { number: 303, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', headSha: 's303' }
        });
        // linkedIssueNumber: no body refs → issueNumber null for all; give
        // latch via PR-side only… the latch reads ISSUE labels, so link the
        // PRs to issues via bodies instead:
        var linked = srcMod.query({
            query: {
                type: 'pr', labels: [],
                mergeStateLatch: { BLOCKED: ['ai_developed', 'ai_validated'] },
                checks: 'green'
            },
            limit: 50
        }, { repoInfo: { owner: 'o', repo: 'r' } });
        // pr-301 links no issue (empty body) → latch fails closed (no issue labels)
        assert.equal(linked.some(function (i) { return i.prNumber === 301; }), false);
        assert.equal(linked.length, 0);
    });

    test('mergeStateLatch: multi-label array — issue carrying ALL listed labels matches', function () {
        var prs = [
            { number: 401, labels: [{ name: 'review-me' }], body: 'Closes #51', draft: false, head: { ref: 'ai/gh-401' }, user: { login: 'bot' } },
            { number: 402, labels: [{ name: 'review-me' }], body: 'Closes #52', draft: false, head: { ref: 'ai/gh-402' }, user: { login: 'bot' } }
        ];
        var srcMod = load({
            github_list_prs: function () { return prs; },
            github_get_issue: function (args) {
                if (args.issueNumber === 51) return { labels: [{ name: 'ai_developed' }, { name: 'ai_validated' }] };
                if (args.issueNumber === 52) return { labels: [{ name: 'ai_developed' }] };
                return { labels: [] };
            }
        }, {
            401: { number: 401, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', headSha: 's401' },
            402: { number: 402, state: 'OPEN', checks: 'green', mergeState: 'BLOCKED', headSha: 's402' }
        });
        var matched = srcMod.query({
            query: {
                type: 'pr', labels: ['review-me'],
                mergeStateLatch: { BLOCKED: ['ai_developed', 'ai_validated'] },
                checks: 'green'
            },
            limit: 50
        }, { repoInfo: { owner: 'o', repo: 'r' } });
        assert.deepEqual(matched.map(function (i) { return i.prNumber; }), [401]);
    });

    test('pr rules: item mapping fallbacks — headRefName, author.name, empty title/branch (characterization)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 501, headRefName: 'feature/x', author: { name: 'Named Author' },
                      labels: ['x'], body: '', draft: false },
                    { number: 502, labels: ['x'] } // no head/headRefName/author/title at all
                ];
            }
        }, {});
        var matched = srcMod.query({
            query: { type: 'pr', labels: ['x'] }, limit: 50
        }, { repoInfo: { owner: 'o', repo: 'r' } });
        assert.equal(matched.length, 2);
        assert.equal(matched[0].branch, 'feature/x');
        assert.equal(matched[0].author, 'Named Author');
        assert.equal(matched[0].title, '');
        assert.equal(matched[1].branch, '');
        assert.equal(matched[1].author, '');
        assert.equal(matched[1].title, '');
    });

    test('pr rules: authors allowlist — only listed authors match (characterization)', function () {
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 601, head: { ref: 'a' }, user: { login: 'ann' }, labels: ['x'], body: '' },
                    { number: 602, head: { ref: 'b' }, user: { login: 'bob' }, labels: ['x'], body: '' }
                ];
            }
        }, {});
        var matched = srcMod.query({
            query: { type: 'pr', labels: ['x'], authors: ['ann'] }, limit: 50
        }, { repoInfo: { owner: 'o', repo: 'r' } });
        assert.deepEqual(matched.map(function (i) { return i.prNumber; }), [601]);
    });
});

suite('sm github source: gh-1000 phantom-heal helpers', function () {
    function loadBare() {
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': { createSmProvider: function () { return null; },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify },
            '../../common/smAsync.js': {},
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), {});
    }
    function pr(n, labels) { return { number: n, labels: labels }; }

    test('mutexHoldersOf: mutex-label holders, blocked exempt, mutexAmong scopes', function () {
        var mod = loadBare();
        var items = [pr(1, ['ai_validating']), pr(2, ['ai_validating', 'blocked']), pr(3, ['other'])];
        assert.deepEqual(mod.mutexHoldersOf(items, { mutex: 'ai_validating' }), [1],
            'blocked holder is invisible');
        var scoped = [pr(4, ['ai_validating', 'agent']), pr(5, ['ai_validating'])];
        assert.deepEqual(mod.mutexHoldersOf(scoped, { mutex: 'ai_validating', mutexAmong: ['agent'] }), [4],
            'mutexAmong scopes WHO counts');
    });

    test('logPhantomHeal: full branch coverage (CRAP ratchet)', function () {
        // The rework-added log helper resolves its holder lists through
        // || / && chains (CC 9) — partially covered by the IT suites it
        // redlined the released CRAP ratchet as a NEW > 8 function. These
        // direct calls pin every operand branch so its CRAP stays at 0
        // under any future coverage variance.
        var mod = loadBare();
        var logged = [];
        var realLog = console.log;
        console.log = function (msg) { logged.push(String(msg)); };
        try {
            mod.logPhantomHeal(
                { title: 'phantom_mutex_holder', detail: 'diverged',
                  holders: { cached: [1, 2], live: [3] } }, null, null);
            mod.logPhantomHeal(
                { title: 'phantom_mutex_holder', detail: 'diverged',
                  holders: null }, [7], [8]);
            mod.logPhantomHeal(
                { title: 'phantom_mutex_holder', detail: 'diverged',
                  holders: {} }, null, null);
            mod.logPhantomHeal(
                { title: 'phantom_mutex_holder', detail: 'diverged',
                  holders: { cached: null, live: [] } }, [9], []);
        } finally {
            console.log = realLog;
        }
        assert.equal(logged.length, 4);
        assert.ok(logged[0].indexOf('[1, 2]') !== -1 && logged[0].indexOf('[3]') !== -1,
            'alarm holders win when present');
        assert.ok(logged[1].indexOf('[7]') !== -1 && logged[1].indexOf('[8]') !== -1,
            'argument fallbacks used when the alarm carries no holders');
        assert.ok(logged[2].indexOf('[]') !== -1,
            'empty holders + null args degrade to empty lists, never throws');
        assert.ok(logged[3].indexOf('[9]') !== -1,
            'a null cached list falls back to the cachedHolders argument');
    });

    test('rederiveHoldersLive: no listOpenPrsLive hook → cached holders kept (fail-closed, E4)', function () {
        var mod = loadBare();
        var out = mod.rederiveHoldersLive([97], [pr(97, ['ai_validating'])], {}, { owner: 'o', repo: 'r' },
            { mutex: 'ai_validating' });
        assert.deepEqual(out, [97]);
        assert.equal(mod.takeMutexTickSnapshot(), null, 'no probe → no tick event');
    });

    test('rederiveHoldersLive: probe throw → cached holders kept (fail-closed, E4)', function () {
        var mod = loadBare();
        var provider = { listOpenPrsLive: function () { throw new Error('boom'); } };
        var out = mod.rederiveHoldersLive([97], [pr(97, ['ai_validating'])], provider,
            { owner: 'o', repo: 'r' }, { mutex: 'ai_validating' });
        assert.deepEqual(out, [97]);
    });

    test('rederiveHoldersLive: divergent live label layer self-heals and records the tick event', function () {
        var mod = loadBare();
        var provider = { listOpenPrsLive: function () { return { items: [pr(97, [])] }; } };
        var out = mod.rederiveHoldersLive([97], [pr(97, ['ai_validating'])], provider,
            { owner: 'o', repo: 'r' }, { mutex: 'ai_validating' });
        assert.deepEqual(out, [], 'live layer shows no arm → phantom holder dropped');
        var snap = mod.takeMutexTickSnapshot();
        assert.equal(snap.mutexSelfHeals, 1);
        assert.equal(snap.phantomHolderTicks, 1);
        assert.equal(snap.consecutivePhantomTicks, 1, 'streak key rides the tick event');
        assert.equal(snap.alarms.length, 1);
        assert.equal(snap.alarms[0].type, 'phantom_mutex_holder');
        assert.equal(snap.alarms[0].title, 'phantom_mutex_holder', 'alarm carries a title');
        assert.equal(typeof snap.alarms[0].detail, 'string', 'alarm carries a detail');
        assert.equal(mod.takeMutexTickSnapshot(), null, 'snapshot drains');
    });

    test('rederiveHoldersLive: live layer agrees → holders kept, no event', function () {
        var mod = loadBare();
        var provider = { listOpenPrsLive: function () { return { items: [pr(97, ['ai_validating'])] }; } };
        var out = mod.rederiveHoldersLive([97], [pr(97, ['ai_validating'])], provider,
            { owner: 'o', repo: 'r' }, { mutex: 'ai_validating' });
        assert.deepEqual(out, [97]);
        assert.equal(mod.takeMutexTickSnapshot(), null, 'no divergence → no self-heal event');
    });
});

suite('sm github source: gh-1000 phantom-heal probe edges', function () {
    function loadBare2(dropSpy) {
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return null; },
                ioCacheDrop: dropSpy,
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': {},
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), {});
    }
    function pr2(n, labels) { return { number: n, labels: labels }; }

    test('non-array probe payload → cached holders kept (fail-closed)', function () {
        var mod = loadBare2(null);
        var provider = { listOpenPrsLive: function () { return { items: 'junk' }; } };
        var out = mod.rederiveHoldersLive([97], [pr2(97, ['ai_validating'])], provider,
            { owner: 'o', repo: 'r' }, { mutex: 'ai_validating' });
        assert.deepEqual(out, [97]);
        assert.equal(mod.takeMutexTickSnapshot(), null);
    });

    test('divergence drops the openPrs cache entry via smProvider.ioCacheDrop', function () {
        var dropped = [];
        var mod = loadBare2(function (owner, repo, key, sub) { dropped.push([owner, repo, key, sub]); });
        var provider = { listOpenPrsLive: function () { return { items: [pr2(97, [])] }; } };
        var out = mod.rederiveHoldersLive([97], [pr2(97, ['ai_validating'])], provider,
            { owner: 'o', repo: 'r' }, { mutex: 'ai_validating' });
        assert.deepEqual(out, []);
        assert.deepEqual(dropped, [['o', 'r', 'openPrs', null]], 'ioCache self-healed');
    });
});

suite('sm github source: gh-1000 IT-1 phantom self-heal through queryPrs (AC2)', function () {
    // The rework review thread pinned the BLOCKING defect: the production
    // guard named a provider.githubApi method that never existed on the
    // smProvider facade, so the self-heal was dead code in production and
    // only pure-module tests passed. These tests drive the FULL-SLOT DEFER
    // path through queryPrs with a facade shaped like the real
    // createSmProvider return (listOpenPrs + listOpenPrsLive) — the guard
    // cannot rot again without one of these failing.
    function loadSrc(ioCacheDrop) {
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () { return null; },
                ioCacheDrop: ioCacheDrop,
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': {},
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), {});
    }

    function cachedPrs() {
        // The stale per-tick view: PR 11 holds ai_validating, PR 10 is the
        // queued approved candidate. Live 19:08Z shape.
        return [
            { number: 10, labels: [{ name: 'pr_approved' }], head: { ref: 'ai/gh-10' }, draft: false },
            { number: 11, labels: [{ name: 'ai_validating' }, { name: 'pr_approved' }],
              head: { ref: 'ai/gh-11' }, draft: false }
        ];
    }

    function rule() {
        return {
            query: { type: 'pr', labels: ['pr_approved'], notLabels: ['ai_validating'],
                     mutex: 'ai_validating' }
        };
    }

    test('full-slot defer + live layer clean → self-heal, candidate arms in the SAME tick (AC2)', function () {
        var dropped = [];
        var mod = loadSrc(function (owner, repo, key, sub) { dropped.push([owner, repo, key, sub]); });
        var liveCalls = 0;
        var provider = {
            // facade shape the real createSmProvider exposes
            listOpenPrs: cachedPrs,
            listOpenPrsLive: function () {
                liveCalls++;
                // LIVE layer: the arm is gone — 11's ai_validating vanished
                return cachedPrs().map(function (p) {
                    return p.number === 11
                        ? { number: 11, labels: [{ name: 'pr_approved' }], head: p.head, draft: false }
                        : p;
                });
            }
        };
        var items = mod.query(rule(), {
            repoInfo: { owner: 'a', repo: 'b' },
            provider: provider
        });
        assert.equal(liveCalls, 1, 'the LIVE re-read fired on the full-slot decision');
        assert.equal(items.length, 1, 'queued candidate arms in the same tick');
        assert.equal(items[0].key, 'pr-10');
        assert.deepEqual(dropped, [['a', 'b', 'openPrs', null]], 'ioCache self-healed');
        var snap = mod.takeMutexTickSnapshot();
        assert.ok(snap, 'tick event recorded');
        assert.equal(snap.mutexSelfHeals, 1);
        assert.equal(snap.consecutivePhantomTicks, 1, 'streak key rides the event');
        assert.equal(snap.alarms.length, 1);
        assert.equal(snap.alarms[0].title, 'phantom_mutex_holder');
    });

    test('full-slot defer + live probe agrees → defer stands, no event', function () {
        var mod = loadSrc(null);
        var provider = {
            listOpenPrs: cachedPrs,
            listOpenPrsLive: cachedPrs // live layer confirms the holder
        };
        var items = mod.query(rule(), {
            repoInfo: { owner: 'a', repo: 'b' },
            provider: provider
        });
        assert.equal(items.length, 0, 'a REAL holder still defers the queue');
        assert.equal(mod.takeMutexTickSnapshot(), null, 'no divergence → no self-heal event');
    });

    test('full-slot defer + live probe throws → fail-closed, cached decision kept one more tick (E4)', function () {
        var mod = loadSrc(null);
        var provider = {
            listOpenPrs: cachedPrs,
            listOpenPrsLive: function () { throw new Error('api down'); }
        };
        var items = mod.query(rule(), {
            repoInfo: { owner: 'a', repo: 'b' },
            provider: provider
        });
        assert.equal(items.length, 0, 'probe failure keeps the cached defer (fail-closed)');
        assert.equal(mod.takeMutexTickSnapshot(), null, 'no event on a failed probe');
    });

    test('facade WITHOUT listOpenPrsLive (legacy stub) → defer stands, no crash, no event', function () {
        var mod = loadSrc(null);
        var provider = { listOpenPrs: cachedPrs }; // pre-gh-1000 stub shape
        var items = mod.query(rule(), {
            repoInfo: { owner: 'a', repo: 'b' },
            provider: provider
        });
        assert.equal(items.length, 0, 'no live hook → cached decision stands (E4)');
        assert.equal(mod.takeMutexTickSnapshot(), null);
    });
});

suite('sm github source: gh-807 latestVerdict receiver binding (fa tick crash 2026-10-18)', function () {
    // Live: FAH SM ticks died with TypeError "not a function" the moment an
    // agent:rework PR reached the verdict probe — _latestVerdictRec extracted
    // provider.latestVerdictRecord into a bare variable and the unbound call
    // lost `this` (the method body rides this.verdictRecords). This test
    // drives the guard through the REAL createSmProvider: an unbound
    // extraction crashes here.
    test('latestVerdict guard evaluates through the real provider without crashing', function () {
        var commentsPayload = JSON.stringify([
            { body: '<!-- dmtools:review-verdict {"verdict":"APPROVE","headSha":"abc","at":"2026-10-18T12:00:00Z"} -->\napproved',
              author: { login: 'ai-teammate' }, created_at: '2026-10-18T12:00:00Z' }
        ]);
        var tools = {
            github_list_prs: function () {
                return [{ number: 1687, labels: [{ name: 'agent:rework' }],
                          head: { ref: 'x', sha: 'abc' }, draft: false }];
            },
            github_get_pr_comments: function () { return commentsPayload; },
            github_get_pr: function () { return { number: 1687, head: { sha: 'abc' } }; },
            github_get_commit_check_runs: function () { return []; },
            github_get_pr_review_threads: function () {
                return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
            }
        };
        var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
        var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
            makeRequire({ './machineAuthor.js': machineAuthor }), tools);
        var provider = loadModule('js/common/smProvider.js', makeRequire({
            './machineAuthor.js': machineAuthor,
            './reviewVerdicts.js': reviewVerdicts
        }), tools);
        var srcMod = loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': machineAuthor,
            '../../common/smAsync.js': {},
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), tools),
            '../../common/smProvider.js': provider
        }), tools);
        var items = srcMod.query({
            query: { type: 'pr', labels: ['agent:rework'], latestVerdict: ['APPROVE'], draft: false }
        }, { repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' } });
        assert.ok(Array.isArray(items),
            'the verdict probe ran through the bound provider method (pre-fix: TypeError "not a function" killed the tick)');
    });
});

suite('githubSource — gh-1070 maintainer-edits probe on the PR item', function () {

    function load(tools) {
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': {
                createSmProvider: function () {
                    return { branchExists: function () { return true; } };
                },
                ghPrHeadRepoFull: smProviderReal().ghPrHeadRepoFull,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify,
                ghPrMaintainerCanModify: smProviderReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': loadModule('js/common/smAsync.js', makeRequire({
                './common/smProvider.js': { createSmProvider: function () {
                    return { branchExists: function () { return true; } };
                } }
            }), tools || {}),
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), tools || {});
    }

    test('the PR item carries maintainerCanModify resolved from every payload dialect', function () {
        // gh-1070: update_branch probes "Allow edits from maintainers"
        // BEFORE any silent-update attempt on a fork head. The probe value
        // rides the PR item (like headRepo, gh-1057) so the reconcile lane
        // reads one shared resolver (gh-1059) over the raw /pulls payload.
        var srcMod = load({
            github_list_prs: function () {
                return [
                    { number: 304, state: 'open', draft: false, body: '',
                      head: { sha: 's4', ref: 'feat/rest',
                              repo: { full_name: 'forko/forkr' } },
                      maintainer_can_modify: true,
                      labels: [{ name: 'pr_approved' }],
                      user: { login: 'guest' } },
                    { number: 303, state: 'open', draft: false, body: '',
                      head: { sha: 's3', ref: 'feat/gql',
                              repo: { full_name: 'forko/forkr' } },
                      maintainerCanModify: false,
                      labels: [{ name: 'pr_approved' }],
                      user: { login: 'guest' } },
                    { number: 302, state: 'open', draft: false, body: '',
                      head: { sha: 's2', ref: 'feat/absent',
                              repo: { full_name: 'forko/forkr' } },
                      labels: [{ name: 'pr_approved' }],
                      user: { login: 'guest' } }
                ];
            }
        });
        var items = srcMod.query({
            query: { type: 'pr', labels: ['pr_approved'], draft: false }, limit: 5
        }, { repoInfo: { owner: 'o', repo: 'r' }, machineAuthor: 'ai-teammate',
             provider: { branchExists: function () { return true; } } });

        var byNum = {};
        items.forEach(function (i) { byNum[i.prNumber] = i; });
        assert.equal(byNum[304].maintainerCanModify, true, 'REST maintainer_can_modify dialect rides the item');
        assert.equal(byNum[303].maintainerCanModify, false, 'GraphQL maintainerCanModify dialect rides the item');
        assert.equal(byNum[302].maintainerCanModify, null,
            'a payload without the field resolves to null — the lane re-probes fresh (fail closed)');
    });
});
