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
        _prs: {},
        _status: {}
    };

    function load(tools, prs, statuses) {
        providerStub._prs = prs || {};
        providerStub._status = statuses || {};
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
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
});
