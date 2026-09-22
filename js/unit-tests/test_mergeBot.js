/* Unit tests for js/sm/mergeBot.js — the event-driven merge fast path. */
/* global loadModule, assert, test, suite, makeRequire */

function fixture(opts) {
    opts = opts || {};
    var calls = { merges: [], adds: [], removes: [], comments: [] };
    var checkRuns = opts.checkRuns || [
        { status: 'COMPLETED', conclusion: 'SUCCESS' }
    ];
    var mergeResponses = opts.mergeResponses || [
        JSON.stringify({ merged: true })
    ];
    var pr = {
        number: opts.number || 42,
        state: 'OPEN',
        draft: opts.draft === true,
        mergeable: opts.mergeable !== undefined ? opts.mergeable : true,
        mergeable_state: opts.mergeableState || 'clean',
        head: { sha: opts.headSha || 'deadbeef' },
        statusCheckRollup: opts.statusCheckRollup || undefined,
        labels: (opts.labels || ['ai_validating']).map(function (n) {
            return { name: n };
        })
    };
    var wfCalls = [];
    var mods = {
        github_list_workflow_runs: function (a) {
            wfCalls.push(a);
            return JSON.stringify({ workflow_runs: opts.workflowRuns || [] });
        },
        github_list_prs: function () { return JSON.stringify([{ number: pr.number }]); },
        github_get_pr: function () { return JSON.stringify(pr); },
        github_get_commit_check_runs: function () {
            return JSON.stringify({ check_runs: checkRuns });
        },
        github_merge_pr: function (m) {
            calls.merges.push(m);
            return mergeResponses[Math.min(calls.merges.length - 1, mergeResponses.length - 1)];
        },
        github_add_labels: function (a) { calls.adds.push(a); return '{}'; },
        github_remove_label: function (r) { calls.removes.push(r); return '{}'; }
    };
    var bot = loadModule('js/sm/mergeBot.js', makeRequire({}), mods);
    return { bot: bot, calls: calls, mods: mods, wfCalls: wfCalls };
}

suite('mergeBot', function () {
    test('approved + validating + green + CLEAN -> squash-merge', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validating', 'ai_pr_reviewed'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.success, true);
        assert.equal(fx.calls.merges.length, 1, 'exactly one merge call');
        assert.equal(fx.calls.merges[0].mergeMethod, 'squash');
        assert.equal(fx.calls.merges[0].number, 42);
        assert.equal(result.acted, 1);
    });

    test('validating + green + CLEAN + NOT approved -> latch ai_validated, unarm', function () {
        var fx = fixture({ labels: ['ai_validating'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 0, 'no merge without approval');
        assert.deepEqual(fx.calls.adds.map(function (a) { return a.labels; }), [['ai_validated']]);
        assert.ok(fx.calls.removes.some(function (r) { return r.label === 'ai_validating'; }));
    });

    test('approved + green + BEHIND (stale head) -> unarm only, no merge', function () {
        var fx = fixture({
            labels: ['pr_approved', 'ai_validating'],
            mergeableState: 'behind'
        });
        fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 0, 'a stale head must not merge');
        assert.ok(fx.calls.removes.some(function (r) { return r.label === 'ai_validating'; }),
            'unarm so the SM refreshes + re-validates the fresh head');
        assert.equal(fx.calls.adds.length, 0);
    });

    test('checks pending/red/none -> no-op (SM owns conclusions)', function () {
        [['pending', [{ status: 'IN_PROGRESS', conclusion: null }]],
         ['red', [{ status: 'COMPLETED', conclusion: 'FAILURE' }]],
         ['none', []]].forEach(function (pair) {
            var fx = fixture({ checkRuns: pair[1] });
            var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
            assert.equal(result.acted, 0, pair[0] + ' checks must leave the PR untouched');
            assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0);
        });
    });

    test('silent-updated head: empty check runs, green rollup -> merge (fa #762)', function () {
        // API branch refresh fires no pull_request event — no waiter check
        // run on the new head. The PR-level statusCheckRollup (suites) is
        // the evidence; 'none' there would starve a green CLEAN approved
        // head forever (live: fa #762, 30 min green+CLEAN, no merge).
        var fx = fixture({
            labels: ['pr_approved', 'ai_validating', 'ai_pr_reviewed'],
            checkRuns: [],
            statusCheckRollup: [
                { status: 'COMPLETED', conclusion: 'SUCCESS' },
                { status: 'COMPLETED', conclusion: 'SUCCESS' }
            ]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.success, true);
        assert.equal(fx.calls.merges.length, 1, 'rollup green must merge');
    });

    test('API-refreshed head: no check runs anywhere, green CI run on sha -> merge (#762)', function () {
        // REST PR body carries no statusCheckRollup and silent-updated heads
        // carry no check runs — the dispatched CI workflow run on the head
        // sha is the only evidence. Green run => merge.
        var fx = fixture({
            labels: ['pr_approved', 'ai_validating', 'ai_pr_reviewed'],
            checkRuns: [],
            workflowRuns: [
                { head_sha: 'deadbeef', conclusion: 'SUCCESS', status: 'completed' }
            ]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b', ciWorkflow: 'ci.yml' } });
        assert.equal(result.success, true);
        assert.equal(fx.calls.merges.length, 1, 'CI-run green on the sha must merge');
        assert.equal(fx.wfCalls.length, 1, 'exactly one workflow-run lookup');
        var q = fx.wfCalls[0];
        assert.equal(q.workspace, 'a', 'fallback must scope the lookup to the repo');
        assert.equal(q.repository, 'b', 'fallback must scope the lookup to the repo');
    });

    test('API-refreshed head: CI run on sha RED -> no merge, SM owns rework', function () {
        var fx = fixture({
            labels: ['pr_approved', 'ai_validating'],
            checkRuns: [],
            workflowRuns: [
                { head_sha: 'deadbeef', conclusion: 'FAILURE', status: 'completed' }
            ]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b', ciWorkflow: 'ci.yml' } });
        assert.equal(result.success, true);
        assert.equal(fx.calls.merges.length, 0, 'red CI on the sha must not merge');
    });

    test('transient merge refusal (404) is retried once and then succeeds', function () {
        var fx = fixture({
            labels: ['pr_approved', 'ai_validating'],
            mergeResponses: [
                JSON.stringify({ message: 'Not Found', status: 404 }),
                JSON.stringify({ merged: true })
            ]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 2, 'exactly one retry');
        assert.equal(result.acted, 1);
    });

    test('deterministic refusal surfaces the verbatim error, no crash', function () {
        var fx = fixture({
            labels: ['pr_approved', 'ai_validating'],
            mergeResponses: [
                JSON.stringify({ message: 'Not Found', status: 404 }),
                JSON.stringify({ message: 'Not Found', status: 404 })
            ]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.success, true, 'a refused merge is reported, not thrown');
        assert.equal(result.acted, 0);
        assert.ok(result.log.some(function (l) { return l.indexOf('Not Found') !== -1; }),
            'the GitHub error is surfaced verbatim');
    });

    test('agent:review on the PR -> skipped entirely (SM mid-review)', function () {
        var fx = fixture({ labels: ['ai_validating', 'agent:review'] });
        fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0);
    });

    test('conflicts (mergeable false) -> skipped (conflict-rework owns it)', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validating'], mergeable: false });
        fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 0);
    });

    test('no ai_validating -> not the bot\u2019s stage (validation dispatch is SM-owned)', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validated'] });
        fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0);
    });

    test('draft PRs are invisible to the bot', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validating'], draft: true });
        fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0);
    });
});
