/* Unit tests for js/sm/mergeBot.js — the event-driven merge fast path. */
/* global loadModule, assert, test, suite, makeRequire */

function fixture(opts) {
    opts = opts || {};
    var calls = { merges: [], adds: [], removes: [], comments: [], cli: [] };
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
    var crCalls = [];
    var mods = {
        github_list_workflow_runs: function (a) {
            wfCalls.push(a);
            return JSON.stringify({ workflow_runs: opts.workflowRuns || [] });
        },
        github_list_prs: function () { return JSON.stringify([{ number: pr.number }]); },
        github_get_pr: function () { return JSON.stringify(pr); },
        github_get_commit_check_runs: function (a) {
            // The Dart tool requires workspace/repository — a bare
            // {commitSha} call dies with 'Required parameter workspace is
            // missing' and the whole merge leg crashes (live 2026-09-29).
            // Assert in the test body, not here: mocks run in the module
            // scope, where `assert` is not a global.
            crCalls.push(a);
            return JSON.stringify({ check_runs: checkRuns });
        },
        github_merge_pr: function (m) {
            calls.merges.push(m);
            return mergeResponses[Math.min(calls.merges.length - 1, mergeResponses.length - 1)];
        },
        github_add_labels: function (a) { calls.adds.push(a); return '{}'; },
        github_remove_label: function (r) { calls.removes.push(r); return '{}'; },
        // Self-tick (owner rule 2026-10-04): capture every cli dispatch;
        // opts.cliThrows simulates a dead gh CLI for the failure path.
        cli_execute_command: function (c) {
            calls.cli.push(c);
            if (opts.cliThrows) throw new Error(opts.cliThrows);
            return '';
        }
    };
    var bot = loadModule('js/sm/mergeBot.js', makeRequire({}), mods);
    return { bot: bot, calls: calls, mods: mods, wfCalls: wfCalls, crCalls: crCalls };
}

suite('mergeBot', function () {
    test('approved + validating + green + CLEAN -> squash-merge', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validating', 'ai_pr_reviewed'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.success, true);
        assert.equal(fx.calls.merges.length, 1, 'exactly one merge call');
        assert.equal(fx.calls.merges[0].mergeMethod, 'squash');
        assert.equal(fx.calls.merges[0].pullRequestId, 42, 'Java-parity param — number broke on dmtools v0.1.18+ (pulls/null/merge → 404)');
        assert.equal(result.acted, 1);
        assert.equal(fx.crCalls.length, 1, 'check runs fetched exactly once');
        assert.equal(fx.crCalls[0].workspace, 'a', 'workspace is required by the Dart tool (merge leg crashed live 2026-09-29 without it)');
        assert.equal(fx.crCalls[0].repository, 'b', 'repository is required by the Dart tool');
        assert.equal(fx.crCalls[0].commitSha, 'deadbeef');
    });

    test('blocked label: bot ignores the PR even when approved + green (fa #939)', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validating', 'blocked'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.success, true);
        assert.equal(fx.calls.merges.length, 0, 'owner-parked PR must not merge');
        assert.equal(result.acted, 0);
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

    test('workflow_run race: green rollup + BLOCKED (checks settling) -> wait, never unarm', function () {
        var fx = fixture({
            labels: ['ai_validating', 'pr_approved'],
            checkRuns: [{ name: 'c1', status: 'completed', conclusion: 'success' }],
            mergeableState: 'blocked'
        });
        fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 0, 'must not merge on BLOCKED');
        assert.equal(fx.calls.removes.filter(function (l) { return r.label === 'ai_validating'; }).length, 0,
            'BLOCKED is checks-settling, not staleness — the arm must survive');
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

    test('approved without arm -> FIFO-queued line is logged, no actions', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validated'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0);
        assert.ok(result.log.some(function (l) {
            return l.indexOf('FIFO-queued') !== -1 && l.indexOf('pr-42') !== -1;
        }), 'the operator sees the PR is queued, not stuck: ' + JSON.stringify(result.log));
        // Self-heal (owner rule 2026-10-04; live agents#696 + dart#342: the
        // bot logged this defer line, exited acted:0, and the repo went
        // event-quiet until a human fired machine-sm.yml). acted==0 + a
        // deferred approved = nothing will produce the validate-armed turn
        // → exactly ONE SM tick must be dispatched.
        assert.equal(result.acted, 0);
        assert.equal(fx.calls.cli.length, 1, 'exactly one self-tick dispatch');
        assert.equal(fx.calls.cli[0].command,
            'gh workflow run machine-sm.yml -F dryRun=false --repo a/b',
            'the full machine-sm tick command line, verbatim — --repo scopes the ' +
            'dispatch to the PR\u2019s repo (gh resolves the CWD\u2019s repo, wrong in multi-repo runners; review #701)');
        // Review #701: the probe that guards the dispatch must be scoped to
        // THIS repo's machine-sm.yml (not the CWD's).
        assert.equal(fx.wfCalls[0].workflowId, 'machine-sm.yml', 'active-SM probe lists machine-sm.yml');
        assert.equal(fx.wfCalls[0].workspace, 'a', 'active-SM probe is repo-scoped');
        assert.equal(fx.wfCalls[0].repository, 'b', 'active-SM probe is repo-scoped');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('🔁 deferred approved → SM tick dispatched (self-heal)') !== -1;
        }), 'the dispatch is logged: ' + JSON.stringify(result.log));
    });

    test('self-tick: SM already active (machine-sm.yml in_progress/queued) -> NO dispatch', function () {
        // Review #701 (tick-storm fix): during healthy waves every deferring
        // bot run fired a fresh machine-sm.yml even while one was already
        // draining the queue — the bot's own defer lines amplified into tick
        // storms. An active run means the SM will consume the turn itself.
        [['in_progress', 'in_progress'], ['queued', 'queued']].forEach(function (pair) {
            var fx = fixture({
                labels: ['pr_approved', 'ai_validated'],
                workflowRuns: [{ id: 9, status: pair[0],
                                 updated_at: new Date(Date.now() - 60 * 1000).toISOString() }]
            });
            var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
            assert.ok(result.log.some(function (l) {
                return l.indexOf('FIFO-queued') !== -1;
            }), pair[1] + ': the defer line still logs');
            assert.equal(fx.calls.cli.length, 0, pair[1] + ' SM run active — no tick dispatched');
            assert.ok(result.log.some(function (l) {
                return l.indexOf('⏭️ self-tick skipped (SM already active)') !== -1;
            }), pair[1] + ': the skip is logged: ' + JSON.stringify(result.log));
        });
    });

    test('self-tick: zombie queued SM run (>6h stale) -> probe ignores it, dispatch fires', function () {
        // smAgent parity (isStaleNonRunningWorkflowRun): a queued run older
        // than 6h is a zombie superseded by its concurrency group — treating
        // it as active would silently disable the self-heal forever.
        var fx = fixture({
            labels: ['pr_approved', 'ai_validated'],
            workflowRuns: [{ id: 9, status: 'queued',
                             updated_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() }]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.cli.length, 1, 'stale queued run does not block the tick');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('SM tick dispatched') !== -1;
        }));
    });

    test('self-tick: acted>0 (merge consumed the turn) -> NO dispatch', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validating', 'ai_pr_reviewed'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.acted, 1, 'the merge consumed the turn');
        assert.equal(fx.calls.merges.length, 1);
        assert.equal(fx.calls.cli.length, 0, 'a merge is motion — its events carry the conveyor, no tick');
    });

    test('self-tick: acted==0 but no deferred-approved -> NO dispatch', function () {
        // Unapproved, unarmed, green-latch-less: nothing waits on a
        // validate-armed turn, so there is nothing to self-heal.
        var fx = fixture({ labels: ['ai_validated'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.acted, 0);
        assert.ok(!result.log.some(function (l) { return l.indexOf('FIFO-queued') !== -1; }));
        assert.equal(fx.calls.cli.length, 0, 'no deferred approved was seen — no tick');
    });

    test('self-tick: checks pending on an armed PR (acted==0, no defer) -> NO dispatch', function () {
        var fx = fixture({ labels: ['ai_validating'], checkRuns: [{ status: 'IN_PROGRESS', conclusion: null }] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.acted, 0);
        assert.equal(fx.calls.cli.length, 0, 'pending CI is in-flight motion — no tick');
    });

    test('self-tick: jobParams.selfTick=false disables the dispatch', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validated'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b', selfTick: false } });
        assert.ok(result.log.some(function (l) { return l.indexOf('FIFO-queued') !== -1; }),
            'the defer line still logs — only the dispatch is disabled');
        assert.equal(fx.calls.cli.length, 0, 'selfTick=false → no SM tick');
        assert.ok(!result.log.some(function (l) { return l.indexOf('SM tick dispatched') !== -1; }));
    });

    test('self-tick: dead gh CLI -> failure logged, run still succeeds', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validated'], cliThrows: 'gh: command not found' });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.cli.length, 1, 'the dispatch was attempted');
        assert.equal(result.success, true, 'a failed self-tick never fails the bot run');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('self-tick dispatch failed') !== -1 &&
                   l.indexOf('gh: command not found') !== -1;
        }), 'the failure is surfaced verbatim: ' + JSON.stringify(result.log));
    });

    test('unapproved without arm -> still silent (pre-review, SM owns it)', function () {
        var fx = fixture({ labels: ['ai_validated'] });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0);
        assert.ok(!result.log.some(function (l) { return l.indexOf('FIFO-queued') !== -1; }),
            'non-approved PRs are the review flow\u2019s business, not FIFO noise');
    });

    test('draft PRs are invisible to the bot', function () {
        var fx = fixture({ labels: ['pr_approved', 'ai_validating'], draft: true });
        fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0);
    });
});

suite('mergeBot: red-holder diagnostic (owner directive 2026-10-04: red yields the slot)', function () {
    // When an approved PR is deferred as FIFO-queued AND the ai_validating
    // holder (approved scope) has a CONCLUDED-RED validation, the bot logs
    // '🚨 pr-N holds slot with concluded-red validation — fail path should
    // free it' — diagnostic ONLY, never an action. Live fa 11:0x: #1194
    // held a concluded-red arm while #1215..#1223 queued 40+ min.

    function multiPrFixture(prs) {
        prs = prs || [];
        var calls = { merges: [], adds: [], removes: [] };
        var byNumber = {};
        prs.forEach(function (p) { byNumber[p.number] = p; });
        var byHead = {};
        prs.forEach(function (p) { byHead[p.headSha] = p; });
        var labelObjs = function (p) {
            return (p.labels || []).map(function (n) { return { name: n }; });
        };
        var mods = {
            github_list_workflow_runs: function () {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_list_prs: function () {
                return JSON.stringify(prs.map(function (p) {
                    return { number: p.number, labels: labelObjs(p), head: { sha: p.headSha } };
                }));
            },
            github_get_pr: function (a) {
                var p = byNumber[a.pullRequestId] || prs[0];
                return JSON.stringify({
                    number: p.number, state: 'OPEN', draft: false, mergeable: true,
                    mergeable_state: p.mergeableState || 'clean',
                    head: { sha: p.headSha }, labels: labelObjs(p)
                });
            },
            github_get_commit_check_runs: function (a) {
                var p = byHead[a.commitSha] || {};
                return JSON.stringify({ check_runs: p.checkRuns || [] });
            },
            github_merge_pr: function (m) { calls.merges.push(m); return JSON.stringify({ merged: true }); },
            github_add_labels: function (a) { calls.adds.push(a); return '{}'; },
            github_remove_label: function (r) { calls.removes.push(r); return '{}'; }
        };
        var bot = loadModule('js/sm/mergeBot.js', makeRequire({}), mods);
        return { bot: bot, calls: calls };
    }

    var RED = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
    var PENDING = [{ status: 'IN_PROGRESS', conclusion: null }];

    test('FIFO-queued deferral + concluded-red holder → 🚨 line, diagnostic only', function () {
        var fx = multiPrFixture([
            { number: 1194, labels: ['pr_approved', 'ai_validating', 'ai_pr_reviewed'],
              headSha: 'sha1194', checkRuns: RED },
            { number: 1215, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1215' },
            { number: 1216, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1216' }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });

        var alarms = result.log.filter(function (l) {
            return l.indexOf('holds slot with concluded-red validation') !== -1;
        });
        assert.equal(alarms.length, 1,
            'exactly one alarm per run even with several queued PRs: ' + JSON.stringify(result.log));
        assert.ok(alarms[0].indexOf('pr-1194') !== -1, 'the alarm names the HOLDER');
        assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0,
            'diagnostic only — the bot never unarms/dispatches (SM owns the fail path)');
        assert.equal(result.acted, 0);
        assert.equal(result.log.filter(function (l) { return l.indexOf('FIFO-queued') !== -1; }).length, 2,
            'both queued PRs still get their operator line');
    });

    test('holder validation IN FLIGHT (pending) → no alarm', function () {
        var fx = multiPrFixture([
            { number: 1194, labels: ['pr_approved', 'ai_validating'],
              headSha: 'sha1194', checkRuns: PENDING },
            { number: 1215, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1215' }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.ok(!result.log.some(function (l) {
            return l.indexOf('concluded-red') !== -1;
        }), 'an in-flight validation is not a concluded red — silence');
    });

    test('unapproved (dev-lane) holder → no alarm (mutexAmong parity)', function () {
        var fx = multiPrFixture([
            { number: 900, labels: ['ai_validating', 'ai_developed'],
              headSha: 'sha900', checkRuns: RED },
            { number: 1215, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1215' }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.ok(!result.log.some(function (l) {
            return l.indexOf('concluded-red') !== -1;
        }), 'a dev-lane arm does not hold the merge-window slot (owner rule 2026-09-22, fa #801)');
    });
});
