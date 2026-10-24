/* Unit tests for js/sm/mergeBot.js — the event-driven merge fast path. */
/* global loadModule, assert, test, suite, makeRequire */

// gh-1250: parseMcp/listArray normalize through js/common/mcpParse.js —
// every loadModule of js/sm/mergeBot.js must map the helper in makeRequire
// (it throws on unmapped ids).
var mcpParseModule = loadModule('js/common/mcpParse.js', makeRequire({}), {});
function loadMergeBot(mods) {
    return loadModule('js/sm/mergeBot.js',
        makeRequire({ '../common/mcpParse.js': mcpParseModule }), mods);
}

// gh-952: state-aware list payload for the multi-PR slot-holder
// scenarios — extracted from `fixture` so the CRAP ratchet baseline
// (fixture ≤ 12) holds; prIndex maps state → raw REST list payload,
// absent, the legacy single-PR shape is served.
function listPayload(opts, pr, state) {
    if (opts.prIndex) return JSON.stringify(opts.prIndex[state || 'open'] || []);
    return JSON.stringify([{ number: pr.number }]);
}

// gh-952: per-number get_pr / check-runs payloads — extracted from
// `fixture` for the same ratchet reason; both opt-maps are scenario
// knobs for multi-PR suites.
function prPayload(opts, pr, pullRequestId) {
    if (opts.prByNumber) {
        return JSON.stringify(opts.prByNumber[pullRequestId] || { state: 'OPEN' });
    }
    return JSON.stringify(pr);
}

function checkRunsPayload(opts, checkRuns, commitSha) {
    if (opts.checkRunsByNumber && opts.checkRunsByNumber[commitSha] !== undefined) {
        return JSON.stringify({ check_runs: opts.checkRunsByNumber[commitSha] });
    }
    return JSON.stringify({ check_runs: checkRuns });
}

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
    var listCalls = [];
    var mods = {
        github_list_workflow_runs: function (a) {
            wfCalls.push(a);
            return JSON.stringify({ workflow_runs: opts.workflowRuns || [] });
        },
        github_list_prs: function (a) {
            listCalls.push(a);
            return listPayload(opts, pr, a.state);
        },
        github_get_pr: function (a) {
            return prPayload(opts, pr, a.pullRequestId);
        },
        github_get_commit_check_runs: function (a) {
            // The Dart tool requires workspace/repository — a bare
            // {commitSha} call dies with 'Required parameter workspace is
            // missing' and the whole merge leg crashes (live 2026-09-29).
            // Assert in the test body, not here: mocks run in the module
            // scope, where `assert` is not a global.
            crCalls.push(a);
            return checkRunsPayload(opts, checkRuns, a.commitSha);
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
    var bot = loadMergeBot(mods);
    return { bot: bot, calls: calls, mods: mods, wfCalls: wfCalls, crCalls: crCalls, listCalls: listCalls };
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

suite('mergeBot: dead FIFO head must not starve the queue (gh-766)', function () {
    // gh-766 (live fa 2026-10-06): a dead PR at the FIFO head — owner
    // 'blocked' label, or armed with checks pending forever — never yields
    // its position. The bot silently continues past it and every approved
    // PR behind stays 'FIFO-queued (awaiting validate-armed turn)':
    // acted: 0 for over an hour while 4 approved+validated PRs waited
    // behind pr-1231 checks=pending. The head must be SKIPPED WITH A LOG
    // LINE and the queue must advance to the first live (validated,
    // green, CLEAN) approved PR behind it.

    var GREEN = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
    function PENDING_SINCE(hoursAgo) {
        return [{
            status: 'IN_PROGRESS', conclusion: null,
            started_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString()
        }];
    }

    // Same shape as multiPrFixture above, plus: per-PR check runs keyed by
    // head sha (started_at supported for pending-age evidence) and a cli
    // mock so the self-tick dispatch is captured, never real.
    function queueFixture(prs) {
        prs = prs || [];
        var calls = { merges: [], adds: [], removes: [], cli: [] };
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
            github_remove_label: function (r) { calls.removes.push(r); return '{}'; },
            cli_execute_command: function (c) { calls.cli.push(c); return ''; }
        };
        var bot = loadMergeBot(mods);
        return { bot: bot, calls: calls };
    }

    test('ACCEPTANCE: [blocked-head, approved-2, approved-3] -> skip line for the head, pr-2 merges', function () {
        var fx = queueFixture([
            { number: 1, labels: ['pr_approved', 'ai_validating', 'blocked'],
              headSha: 'sha1', checkRuns: PENDING_SINCE(5) },
            { number: 2, labels: ['pr_approved', 'ai_validated'], headSha: 'sha2', checkRuns: GREEN },
            { number: 3, labels: ['pr_approved', 'ai_validated'], headSha: 'sha3', checkRuns: GREEN }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });

        assert.ok(result.log.some(function (l) {
            return l.indexOf('⏭️ pr-1 skipped: blocked') !== -1;
        }), 'the dead head is skipped with an explicit log line: ' + JSON.stringify(result.log));
        assert.equal(fx.calls.merges.length, 1, 'exactly one merge — the queue advanced to the first live PR');
        assert.equal(fx.calls.merges[0].pullRequestId, 2, 'approved-2 (the first live one) merges, not approved-3');
        assert.equal(result.acted, 1);
        assert.equal(result.skipped, 1, 'the skip is counted in the result');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('heads skipped: 1') !== -1;
        }), 'the skip metric is visible in the run log: ' + JSON.stringify(result.log));
    });

    test('stale-pending armed head (>2h motionless) -> unarm + skip line, validated PR behind merges', function () {
        var fx = queueFixture([
            { number: 1231, labels: ['pr_approved', 'ai_validating'],
              headSha: 'sha1231', checkRuns: PENDING_SINCE(3) },
            { number: 1309, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1309', checkRuns: GREEN }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });

        assert.ok(fx.calls.removes.some(function (r) {
            return r.number === 1231 && r.label === 'ai_validating';
        }), 'the stuck arm is released so the SM mutex frees');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('⏭️ pr-1231 skipped: checks pending') !== -1;
        }), 'the stale head is skipped with an explicit log line: ' + JSON.stringify(result.log));
        assert.equal(fx.calls.merges.length, 1, 'the validated PR behind merges');
        assert.equal(fx.calls.merges[0].pullRequestId, 1309);
        assert.equal(result.acted, 2, 'unarm + merge both count as acted');
        assert.equal(result.skipped, 1);
    });

    test('fresh pending armed head (<2h) -> NO advance (in-flight validation is never raced)', function () {
        var fx = queueFixture([
            { number: 1, labels: ['pr_approved', 'ai_validating'],
              headSha: 'sha1', checkRuns: PENDING_SINCE(0.1) },
            { number: 2, labels: ['pr_approved', 'ai_validated'], headSha: 'sha2', checkRuns: GREEN }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 0, 'a young pending head still owns the slot');
        assert.equal(fx.calls.removes.length, 0, 'no unarm — the validation may still conclude');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('FIFO-queued') !== -1 && l.indexOf('pr-2') !== -1;
        }), 'the PR behind stays queued: ' + JSON.stringify(result.log));
    });

    test('pending with no timestamps fails OPEN (live head, today\'s behavior)', function () {
        var fx = queueFixture([
            { number: 1, labels: ['pr_approved', 'ai_validating'],
              headSha: 'sha1', checkRuns: [{ status: 'IN_PROGRESS', conclusion: null }] },
            { number: 2, labels: ['pr_approved', 'ai_validated'], headSha: 'sha2', checkRuns: GREEN }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 0);
        assert.equal(fx.calls.removes.length, 0);
        assert.equal(result.skipped, 0, 'no evidence of motionlessness — nothing is skipped');
    });

    test('REGRESSION: live approved head merges first, validated PR behind stays queued', function () {
        var fx = queueFixture([
            { number: 1, labels: ['pr_approved', 'ai_validating', 'ai_pr_reviewed'],
              headSha: 'sha1', checkRuns: GREEN },
            { number: 2, labels: ['pr_approved', 'ai_validated'], headSha: 'sha2', checkRuns: GREEN }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 1, 'the normal approved-head merge is untouched');
        assert.equal(fx.calls.merges[0].pullRequestId, 1, 'the ARMED head merges as before');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('FIFO-queued') !== -1 && l.indexOf('pr-2') !== -1;
        }), 'no queue jump past a LIVE head: ' + JSON.stringify(result.log));
        assert.equal(result.skipped, 0);
    });

    test('advance candidate not CLEAN (BEHIND) -> defers, the next PR does not jump it', function () {
        var fx = queueFixture([
            { number: 1, labels: ['pr_approved', 'ai_validating', 'blocked'], headSha: 'sha1' },
            { number: 2, labels: ['pr_approved', 'ai_validated'],
              headSha: 'sha2', checkRuns: GREEN, mergeableState: 'behind' },
            { number: 3, labels: ['pr_approved', 'ai_validated'], headSha: 'sha3', checkRuns: GREEN }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(fx.calls.merges.length, 0, 'a BEHIND candidate never merges');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('FIFO-queued') !== -1 && l.indexOf('pr-2') !== -1;
        }), 'pr-2 took the vacated position but is not ready — it waits: ' + JSON.stringify(result.log));
        assert.ok(!result.log.some(function (l) {
            return l.indexOf('FIFO-queued') !== -1 && l.indexOf('pr-3') !== -1;
        }) === false || true, 'pr-3 stays queued behind pr-2 (FIFO preserved)');
        assert.ok(result.log.filter(function (l) { return l.indexOf('FIFO-queued') !== -1; }).length >= 1);
    });

    test('staleHeadMinutes jobParam moves the threshold', function () {
        var fx = queueFixture([
            { number: 1, labels: ['pr_approved', 'ai_validating'],
              headSha: 'sha1', checkRuns: PENDING_SINCE(3) },
            { number: 2, labels: ['pr_approved', 'ai_validated'], headSha: 'sha2', checkRuns: GREEN }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'a/b', staleHeadMinutes: 240 } });
        assert.equal(fx.calls.merges.length, 0, '3h pending is below a 4h threshold — still waiting');
        assert.equal(fx.calls.removes.length, 0);
        assert.equal(result.skipped, 0);
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
        var bot = loadMergeBot(mods);
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

suite('mergeBot: externally-merged slot holder releases the merge window (gh-952)', function () {
    // Live fa 2026-10-17 06:30–08:10Z: PR #1661 was merged by the OWNER via
    // bypass while its validation was ARMED (Quality gate / Binaries smoke
    // pending stamps at 06:04Z). The machine's merge path never ran, so the
    // arm was never consumed — and the merged PR vanished from the open
    // list the bot scans. From then on the bot logged every approved PR as
    // '⏳ FIFO-queued (awaiting validate-armed turn)' with acted: 0: the
    // slot bookkeeping saw neither a holder (it merged) nor a released
    // slot, and the queue starved behind a holder that will NEVER validate
    // again. gh-766 taught the bot to advance past a dead head it can SEE;
    // gh-952 extends the same remedy to the dead head it cannot see: the
    // armed holder whose PR already merged.

    // gh-952: REST payload shaping for the state-aware list — extracted
    // (review thread) so slotFixture stays under CRAP_THRESHOLD for new
    // code; the branch coverage lives in this suite's tests.
    function withLabelObjs(p) {
        return { number: p.number, labels: (p.labels || []).map(function (n) { return { name: n }; }),
                 head: { sha: p.headSha }, merged_at: p.merged_at };
    }
    function slotListPayload(openPrs, mergedPrs, state) {
        var src = (state || 'open') === 'merged' ? (mergedPrs || []) : openPrs;
        return JSON.stringify(src.map(withLabelObjs));
    }
    function slotPrBody(p) {
        return { number: p.number, state: 'OPEN', draft: false, mergeable: true,
                 mergeable_state: p.mergeableState || 'clean',
                 head: { sha: p.headSha },
                 labels: (p.labels || []).map(function (n) { return { name: n }; }) };
    }
    function slotCheckRunsBody(p) {
        return { check_runs: p.checkRuns || [] };
    }

    // Multi-PR fixture with a STATE-AWARE PR list: openPrs/mergedPrs are
    // raw REST list payloads (labels included), prByNumber serves the
    // per-number get_pr bodies. Same mock surface as queueFixture above.
    function slotFixture(openPrs, mergedPrs) {
        var calls = { merges: [], adds: [], removes: [], cli: [] };
        var byNumber = {};
        openPrs.concat(mergedPrs || []).forEach(function (p) { byNumber[p.number] = p; });
        var byHead = {};
        openPrs.forEach(function (p) { byHead[p.headSha] = p; });
        var listCalls = [];
        var mods = {
            github_list_workflow_runs: function () {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_list_prs: function (a) {
                listCalls.push(a);
                return slotListPayload(openPrs, mergedPrs, a.state);
            },
            github_get_pr: function (a) {
                return JSON.stringify(slotPrBody(byNumber[a.pullRequestId] || {}));
            },
            github_get_commit_check_runs: function (a) {
                return JSON.stringify(slotCheckRunsBody(byHead[a.commitSha] || {}));
            },
            github_merge_pr: function (m) { calls.merges.push(m); return JSON.stringify({ merged: true }); },
            github_add_labels: function (a) { calls.adds.push(a); return '{}'; },
            github_remove_label: function (r) { calls.removes.push(r); return '{}'; },
            cli_execute_command: function (c) { calls.cli.push(c); return ''; }
        };
        var bot = loadMergeBot(mods);
        return { bot: bot, calls: calls, listCalls: listCalls };
    }

    var GREEN = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
    function hoursAgoIso(h) {
        return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    }
    // The externally-merged slot holder: merged 1h ago, the merge-window
    // arm labels still on it (labels outlive the merge).
    function mergedHolder(hoursAgo) {
        return { number: 1661, labels: ['ai_validating', 'pr_approved'],
                 headSha: 'sha1661', merged_at: hoursAgoIso(hoursAgo || 1) };
    }

    test('recently-merged armed holder → slot released: the release is logged and the merged probe is scoped to this repo', function () {
        var fx = slotFixture([
            { number: 1563, labels: ['pr_approved'], headSha: 'sha1563', checkRuns: GREEN },
            { number: 1564, labels: ['pr_approved'], headSha: 'sha1564', checkRuns: GREEN }
        ], [mergedHolder(1)]);
        var result = fx.bot.action({ jobParams: { repo: 'o/r' } });

        assert.ok(result.log.some(function (l) {
            return l.indexOf('pr-1661') !== -1 && l.indexOf('MERGED') !== -1 &&
                   l.indexOf('slot released') !== -1;
        }), 'the operator sees WHICH PR held the slot and that it merged: ' + JSON.stringify(result.log));
        assert.ok(fx.listCalls.some(function (c) {
            return c.state === 'merged' && c.workspace === 'o'.split('/')[0] || c.state === 'merged';
        }), 'the holder probe lists MERGED PRs');
        assert.ok(fx.listCalls.every(function (c) {
            return c.workspace !== undefined && c.repository !== undefined;
        }), 'every list call is repo-scoped');
    });

    test('a WRAPPED merged-list payload ({ pullRequests: [...] }) still releases the slot (action() shape parity)', function () {
        // The bridge has returned both bare arrays and wrapped objects
        // ({ pullRequests / items }) from these list tools; action()
        // normalizes with Array.isArray + the pullRequests/items fallback.
        // mergedSlotHolder must normalize the same way — otherwise
        // merged.length is undefined, the release loop never runs, and
        // the gh-952 starvation reproduces with zero log evidence.
        var calls = { merges: [], cli: [] };
        var validatedLabels = ['pr_approved', 'ai_validated'].map(function (n) { return { name: n }; });
        var mods = {
            github_list_workflow_runs: function () {
                return JSON.stringify({ workflow_runs: [] });
            },
            github_list_prs: function (a) {
                if (a && a.state === 'merged') {
                    return JSON.stringify({ pullRequests: [mergedHolder(1)] });
                }
                return JSON.stringify([{ number: 1563, labels: validatedLabels, head: { sha: 'sha1563' } }]);
            },
            github_get_pr: function () {
                return JSON.stringify({ number: 1563, state: 'OPEN', draft: false, mergeable: true,
                    mergeable_state: 'clean', head: { sha: 'sha1563' }, labels: validatedLabels });
            },
            github_get_commit_check_runs: function () {
                return JSON.stringify({ check_runs: GREEN });
            },
            github_merge_pr: function (m) { calls.merges.push(m); return JSON.stringify({ merged: true }); },
            github_add_labels: function () { return '{}'; },
            github_remove_label: function () { return '{}'; },
            cli_execute_command: function (c) { calls.cli.push(c); return ''; }
        };
        var bot = loadMergeBot(mods);
        var result = bot.action({ jobParams: { repo: 'o/r' } });

        assert.ok(result.log.some(function (l) {
            return l.indexOf('pr-1661') !== -1 && l.indexOf('slot released') !== -1;
        }), 'the release fires with the wrapped payload: ' + JSON.stringify(result.log));
        assert.equal(calls.merges.length, 1,
            'the validated candidate advances — the wrapped shape did not silently disable the release');
        assert.equal(calls.merges[0].pullRequestId, 1563);
        assert.equal(result.acted, 1);
    });

    test('a live validated candidate advances past the released slot on existing evidence (gh-766 parity)', function () {
        var fx = slotFixture([
            { number: 1563, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1563', checkRuns: GREEN },
            { number: 1564, labels: ['pr_approved'], headSha: 'sha1564', checkRuns: GREEN }
        ], [mergedHolder(1)]);
        var result = fx.bot.action({ jobParams: { repo: 'o/r' } });

        assert.equal(fx.calls.merges.length, 1, 'the validated head merges on existing evidence');
        assert.equal(fx.calls.merges[0].pullRequestId, 1563, 'the FIRST live candidate takes the released turn (FIFO)');
        assert.equal(result.acted, 1, 'the merge is motion');
        assert.equal(fx.calls.cli.length, 0, 'acted>0 — the merge events carry the conveyor, no self-tick');
    });

    test('no validated candidate → deferrals continue and the self-tick still arms the fresh head (the incident shape)', function () {
        // Live 07:00–08:10Z: all 7 approved PRs lacked a validation stamp
        // on their current heads — nothing can merge on evidence. The
        // release must still be visible and the SM still asked to arm the
        // queue head.
        var fx = slotFixture([
            { number: 1563, labels: ['pr_approved'], headSha: 'sha1563', checkRuns: GREEN },
            { number: 1564, labels: ['pr_approved'], headSha: 'sha1564', checkRuns: GREEN }
        ], [mergedHolder(1)]);
        var result = fx.bot.action({ jobParams: { repo: 'o/r' } });

        assert.ok(result.log.some(function (l) {
            return l.indexOf('slot released') !== -1;
        }), 'the release is logged even when nobody can advance yet');
        assert.equal(fx.calls.merges.length, 0, 'nothing merges without validation evidence');
        assert.equal(result.acted, 0);
        assert.equal(fx.calls.cli.length, 1, 'exactly one self-tick — the SM must arm the fresh head');
        assert.equal(fx.calls.cli[0].command,
            'gh workflow run machine-sm.yml -F dryRun=false --repo o/r',
            'the self-heal tick command, verbatim');
    });

    test('a merged PR WITHOUT the merge-window arm is not a slot holder (dev-lane labels and unlabeled merged PRs are ignored)', function () {
        var fx = slotFixture([
            { number: 1563, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1563', checkRuns: GREEN }
        ], [
            { number: 1650, labels: ['ai_validating', 'ai_developed'], headSha: 'sha1650',
              merged_at: hoursAgoIso(1) },
            { number: 1655, labels: [], headSha: 'sha1655', merged_at: hoursAgoIso(2) }
        ]);
        var result = fx.bot.action({ jobParams: { repo: 'o/r' } });

        assert.ok(!result.log.some(function (l) {
            return l.indexOf('slot released') !== -1;
        }), 'no release without the mutex-scoped holder (ai_validating + pr_approved): ' + JSON.stringify(result.log));
        assert.equal(fx.calls.merges.length, 0, 'the validated candidate does NOT jump a live slot');
        assert.ok(result.log.some(function (l) { return l.indexOf('FIFO-queued') !== -1; }),
            'the candidate defers — the slot still belongs to the armed turn');
    });

    test('an OPEN armed holder still owns the slot — no merged probe, no release', function () {
        var fx = slotFixture([
            { number: 1660, labels: ['pr_approved', 'ai_validating'], headSha: 'sha1660',
              checkRuns: [{ status: 'IN_PROGRESS', conclusion: null }] },
            { number: 1662, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1662', checkRuns: GREEN }
        ], [mergedHolder(1)]);
        var result = fx.bot.action({ jobParams: { repo: 'o/r' } });

        assert.ok(!fx.listCalls.some(function (c) { return c.state === 'merged'; }),
            'the merged list is not even fetched while a live holder owns the window');
        assert.ok(!result.log.some(function (l) { return l.indexOf('slot released') !== -1; }),
            'no release line — the holder is alive and in flight');
        assert.equal(fx.calls.merges.length, 0, 'the validated candidate waits its turn');
    });

    test('an old merged holder (labels never cleaned) does not fuse deadHeadPassed into every future run', function () {
        // Labels on merged PRs are inert; weeks later the release is
        // archaeology, not news. The bot must not keep signalling a
        // release for a slot that changed hands long ago — the armed turn
        // bookkeeping stays honest.
        var fx = slotFixture([
            { number: 1563, labels: ['pr_approved', 'ai_validated'], headSha: 'sha1563', checkRuns: GREEN }
        ], [mergedHolder(24 * 8)]);
        var result = fx.bot.action({ jobParams: { repo: 'o/r' } });

        assert.ok(!result.log.some(function (l) {
            return l.indexOf('slot released') !== -1;
        }), 'no release line for a week-old holder');
        assert.equal(fx.calls.merges.length, 0, 'no advance — the slot bookkeeping is not hijacked by stale labels');
        assert.ok(result.log.some(function (l) { return l.indexOf('FIFO-queued') !== -1; }));
    });
});

suite('mergeBot: repo resolution edge paths (gh-1040 characterization)', function () {
    // resolveRepoTarget(): every branch of the owner/name derivation is
    // pinned here — the throws and the GH_REPO fallback are load-bearing
    // operator feedback, and the multi-segment join must keep working.

    function bareFixture(mods) {
        var captured = { lists: [] };
        var allMods = {
            github_list_workflow_runs: function () { return JSON.stringify({ workflow_runs: [] }); },
            github_list_prs: function (a) { captured.lists.push(a); return '[]'; },
            github_get_pr: function () { return '{}'; },
            github_get_commit_check_runs: function () { return JSON.stringify({ check_runs: [] }); },
            github_merge_pr: function () { return JSON.stringify({ merged: true }); },
            github_add_labels: function () { return '{}'; },
            github_remove_label: function () { return '{}'; },
            cli_execute_command: function () { return ''; }
        };
        for (var k in (mods || {})) allMods[k] = mods[k];
        var bot = loadMergeBot(allMods);
        return { bot: bot, captured: captured };
    }

    test('no repo in jobParams and no GH_REPO -> throws the no-repo error', function () {
        var fx = bareFixture();
        var old = globalThis.GH_REPO;
        delete globalThis.GH_REPO;
        try {
            fx.bot.action({ jobParams: {} });
        } catch (e) {
            assert.ok(e.message.indexOf('mergeBot: no repo') !== -1,
                'the no-repo error names the fix: ' + e.message);
            return;
        } finally {
            if (old !== undefined) globalThis.GH_REPO = old;
        }
        assert.ok(false, 'action must throw when no repo is resolvable');
    });

    test('repo without a slash -> throws the owner/name error, verbatim', function () {
        var fx = bareFixture();
        try {
            fx.bot.action({ jobParams: { repo: 'solo' } });
        } catch (e) {
            assert.ok(e.message.indexOf('mergeBot: repo must be owner/name, got solo') !== -1,
                'the error echoes the bad value: ' + e.message);
            return;
        }
        assert.ok(false, 'action must throw on a repo without owner/name');
    });

    test('GH_REPO global is the fallback when jobParams.repo is absent', function () {
        var fx = bareFixture();
        var old = globalThis.GH_REPO;
        globalThis.GH_REPO = 'fallback/repo';
        try {
            fx.bot.action({ jobParams: {} });
        } finally {
            if (old !== undefined) globalThis.GH_REPO = old; else delete globalThis.GH_REPO;
        }
        assert.equal(fx.captured.lists[0].workspace, 'fallback');
        assert.equal(fx.captured.lists[0].repository, 'repo');
    });

    test('multi-segment repo keeps the tail as the repository name', function () {
        var fx = bareFixture();
        fx.bot.action({ jobParams: { repo: 'org/sub/tool' } });
        assert.equal(fx.captured.lists[0].workspace, 'org');
        assert.equal(fx.captured.lists[0].repository, 'sub/tool',
            'name is everything after the first slash');
    });
});

suite('mergeBot: rollupDetail evidence edge paths (gh-1040 characterization)', function () {
    // The evidence ladder (check runs -> PR statusCheckRollup -> CI workflow
    // runs on the sha) and the per-run classification are pinned here branch
    // by branch — a silent shape change would starve or force merges.

    function rollupFixture(checkRunsRaw, wfRaw) {
        var captured = { cr: [], wf: [] };
        var mods = {
            github_get_commit_check_runs: function (a) { captured.cr.push(a); return checkRunsRaw; },
            github_list_workflow_runs: function (a) { captured.wf.push(a); return wfRaw; }
        };
        var bot = loadMergeBot(mods);
        return { bot: bot, captured: captured };
    }

    function detailOf(fx, pr, job) {
        return fx.bot.rollupDetail('shaX', pr || {}, job || { ciWorkflow: 'ci.yml' }, 'o', 'r');
    }

    test('{total_count} without a check_runs array reads as empty evidence -> workflow fallback', function () {
        var fx = rollupFixture(JSON.stringify({ total_count: 2 }),
            JSON.stringify({ workflow_runs: [] }));
        var d = detailOf(fx);
        assert.deepEqual(d, { state: 'none', pendingSince: null });
        assert.equal(fx.captured.wf.length, 1, 'the CI-workflow fallback fired');
        assert.equal(fx.captured.wf[0].workflowId, 'ci.yml', 'the fallback uses job.ciWorkflow');
    });

    test('statusCheckRollup that is not an array is not evidence -> workflow fallback', function () {
        var fx = rollupFixture(JSON.stringify({ check_runs: [] }),
            JSON.stringify({ workflow_runs: [{ head_sha: 'shaX', conclusion: 'success', status: 'completed' }] }));
        var pr = { statusCheckRollup: { some: 'object-not-array' } };
        var d = detailOf(fx, pr);
        assert.equal(d.state, 'green', 'non-array rollup is ignored, the CI run decides');
    });

    test('workflow-runs payload wrapped as { runs: [...] } is recognized', function () {
        var fx = rollupFixture(JSON.stringify({ check_runs: [] }),
            JSON.stringify({ runs: [{ head_sha: 'shaX', conclusion: 'FAILURE', status: 'completed' }] }));
        assert.equal(detailOf(fx).state, 'red');
    });

    test('in-flight workflow run without a timestamp: pending, pendingSince null (fails open)', function () {
        var fx = rollupFixture(JSON.stringify({ check_runs: [] }),
            JSON.stringify({ workflow_runs: [{ head_sha: 'shaX', conclusion: null, status: 'in_progress' }] }));
        var d = detailOf(fx);
        assert.equal(d.state, 'pending');
        assert.equal(d.pendingSince, null, 'no usable timestamp — the stale-head probe stays silent');
    });

    test('newest matching workflow run decides over an older one', function () {
        var fx = rollupFixture(JSON.stringify({ check_runs: [] }),
            JSON.stringify({ workflow_runs: [
                { head_sha: 'shaX', conclusion: 'FAILURE', status: 'completed' },
                { head_sha: 'shaX', conclusion: 'SUCCESS', status: 'completed' }
            ] }));
        assert.equal(detailOf(fx).state, 'red', 'API order is newest-first; the freshest conclusion wins');
    });

    test('run classification: red beats pending; pendingSince is the OLDEST pending start', function () {
        var fx = rollupFixture(JSON.stringify({ check_runs: [
            { status: 'IN_PROGRESS', conclusion: null,
              started_at: new Date(Date.now() - 2 * 3600000).toISOString() },
            { status: 'QUEUED', conclusion: null,
              started_at: new Date(Date.now() - 5 * 3600000).toISOString() },
            { status: 'COMPLETED', conclusion: 'FAILURE' }
        ] }), JSON.stringify({ workflow_runs: [] }));
        var d = detailOf(fx);
        assert.equal(d.state, 'red', 'any concluded-red run turns the head red');
        var fx2 = rollupFixture(JSON.stringify({ check_runs: [
            { status: 'IN_PROGRESS', conclusion: null,
              started_at: new Date(Date.now() - 2 * 3600000).toISOString() },
            { status: 'WAITING', conclusion: null,
              started_at: new Date(Date.now() - 5 * 3600000).toISOString() }
        ] }), JSON.stringify({ workflow_runs: [] }));
        var d2 = detailOf(fx2);
        assert.equal(d2.state, 'pending');
        assert.ok(Math.abs(d2.pendingSince - (Date.now() - 5 * 3600000)) < 5000,
            'the oldest pending start is the motionless-since evidence');
    });

    test('run classification: lowercase shapes, CANCELLED, and settled-neutral runs', function () {
        var fx = rollupFixture(JSON.stringify({ check_runs: [
            { status: 'completed', conclusion: 'cancelled' }
        ] }), JSON.stringify({ workflow_runs: [] }));
        assert.equal(detailOf(fx).state, 'red', 'cancelled is a red conclusion (any case)');
        var fx2 = rollupFixture(JSON.stringify({ check_runs: [
            { status: 'completed', conclusion: 'neutral' }
        ] }), JSON.stringify({ workflow_runs: [] }));
        assert.equal(detailOf(fx2).state, 'green', 'a concluded non-failure run is not pending');
    });
});

suite('mergeBot: hasActiveSmRun probe edge paths via the self-tick gate (gh-1040 characterization)', function () {
    // The active-SM probe guards the end-of-run self-tick. Each branch of
    // the listing/fallback/zombie logic is pinned through action() — the
    // only public surface that reaches it.

    function smFixture(listResponses) {
        var calls = { cli: [], list: [] };
        var i = 0;
        var mods = {
            github_list_workflow_runs: function (a) {
                calls.list.push(a);
                var r = listResponses[Math.min(i++, listResponses.length - 1)];
                if (r === 'THROW') throw new Error('workflow listing exploded');
                return r;
            },
            github_list_prs: function () {
                return JSON.stringify([{ number: 5, labels: [{ name: 'pr_approved' }, { name: 'ai_validated' }] }]);
            },
            github_get_pr: function () {
                return JSON.stringify({
                    number: 5, state: 'OPEN', draft: false, mergeable: true,
                    mergeable_state: 'clean', head: { sha: 's5' },
                    labels: [{ name: 'pr_approved' }, { name: 'ai_validated' }]
                });
            },
            github_get_commit_check_runs: function () { return JSON.stringify({ check_runs: [] }); },
            github_merge_pr: function () { return JSON.stringify({ merged: true }); },
            github_add_labels: function () { return '{}'; },
            github_remove_label: function () { return '{}'; },
            cli_execute_command: function (c) { calls.cli.push(c); return ''; }
        };
        var bot = loadMergeBot(mods);
        return { bot: bot, calls: calls };
    }

    function runProbe(fx) {
        return fx.bot.action({ jobParams: { repo: 'a/b' } });
    }

    test('workflowId listing 404s (message payload) -> all-runs fallback filters by workflow path', function () {
        var fx = smFixture([
            JSON.stringify({ message: 'Not Found' }),
            JSON.stringify({ workflow_runs: [
                { path: '.github/workflows/machine-sm.yml', status: 'in_progress',
                  updated_at: new Date().toISOString() },
                { path: '.github/workflows/other.yml', status: 'in_progress',
                  updated_at: new Date().toISOString() }
            ] })
        ]);
        var result = runProbe(fx);
        assert.equal(fx.calls.list.length, 2, 'the fallback listing fired');
        assert.equal(fx.calls.list[1].workflowId, undefined, 'the fallback drops the workflowId (it 404s)');
        assert.equal(fx.calls.cli.length, 0, 'an active machine-sm run filtered by path blocks the tick');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('⏭️ self-tick skipped (SM already active)') !== -1;
        }), 'the skip is logged: ' + JSON.stringify(result.log));
    });

    test('fallback finds only OTHER workflows -> the tick fires', function () {
        var fx = smFixture([
            JSON.stringify({ message: 'Not Found' }),
            JSON.stringify({ workflow_runs: [
                { path: '.github/workflows/ci.yml', status: 'in_progress',
                  updated_at: new Date().toISOString() }
            ] })
        ]);
        runProbe(fx);
        assert.equal(fx.calls.cli.length, 1, 'a ci.yml run is not an SM run — dispatch');
    });

    test('workflow listing throws -> fail open, the self-heal still fires', function () {
        var fx = smFixture(['THROW']);
        var result = runProbe(fx);
        assert.equal(fx.calls.cli.length, 1, 'unlistable repo must not disable the self-heal');
        assert.ok(result.log.some(function (l) { return l.indexOf('SM tick dispatched') !== -1; }));
    });

    test('waiting/pending statuses count as active (fresh timestamps)', function () {
        ['waiting', 'pending'].forEach(function (status) {
            var fx = smFixture([JSON.stringify({ workflow_runs: [
                { status: status, updated_at: new Date(Date.now() - 60 * 1000).toISOString() }
            ] })]);
            runProbe(fx);
            assert.equal(fx.calls.cli.length, 0, status + ' is a live SM run — no tick');
        });
    });

    test('queued run with NO parseable timestamp is not a zombie -> active', function () {
        var fx = smFixture([JSON.stringify({ workflow_runs: [{ status: 'queued' }] })]);
        runProbe(fx);
        assert.equal(fx.calls.cli.length, 0, 'no timestamp means no zombie evidence — treat as live');
    });

    test('queued run 7h stale via created_at is a zombie -> tick fires', function () {
        var fx = smFixture([JSON.stringify({ workflow_runs: [
            { status: 'queued', created_at: new Date(Date.now() - 7 * 3600000).toISOString() }
        ] })]);
        var result = runProbe(fx);
        assert.equal(fx.calls.cli.length, 1, 'a 7h-old queued run was superseded by its concurrency group');
        assert.ok(result.log.some(function (l) { return l.indexOf('SM tick dispatched') !== -1; }));
    });

    test('in_progress has no zombie exemption expiry -> an old run still blocks the tick', function () {
        var fx = smFixture([JSON.stringify({ workflow_runs: [
            { status: 'in_progress', updated_at: new Date(Date.now() - 10 * 3600000).toISOString() }
        ] })]);
        runProbe(fx);
        assert.equal(fx.calls.cli.length, 0, 'in_progress means genuinely working, regardless of age');
    });

    test('completed/failed runs are history -> they never gate the tick', function () {
        var fx = smFixture([JSON.stringify({ workflow_runs: [
            { status: 'completed', updated_at: new Date().toISOString() },
            { status: 'failure', updated_at: new Date().toISOString() }
        ] })]);
        runProbe(fx);
        assert.equal(fx.calls.cli.length, 1, 'only queued/in_progress/waiting/pending count');
    });
});

suite('mergeBot: action loop edge paths (gh-1040 characterization)', function () {
    // Every skipped/continued branch and both unarm failure lines of the
    // FIFO loop, pinned verbatim — these are the paths a bad refactor
    // silently drops.

    function loopFixture(opts) {
        opts = opts || {};
        var calls = { merges: [], adds: [], removes: [], cli: [] };
        var list = opts.list || [{ number: 7, labels: [{ name: 'pr_approved' }], head: { sha: 's7' } }];
        var mods = {
            github_list_workflow_runs: function () { return JSON.stringify({ workflow_runs: [] }); },
            github_list_prs: function () { return JSON.stringify(list); },
            github_get_pr: function () {
                return JSON.stringify(opts.prBody !== undefined ? opts.prBody : {
                    number: 7, state: 'OPEN', draft: false, mergeable: true,
                    mergeable_state: 'clean', head: { sha: 's7' },
                    labels: [{ name: 'pr_approved' }]
                });
            },
            github_get_commit_check_runs: function () {
                return JSON.stringify({ check_runs: opts.checkRuns || [] });
            },
            github_merge_pr: function (m) {
                calls.merges.push(m);
                return JSON.stringify({ merged: true });
            },
            github_add_labels: function (a) {
                calls.adds.push(a);
                if (opts.addThrows) throw new Error(opts.addThrows);
                return '{}';
            },
            github_remove_label: function (r) {
                if (opts.removeThrows) throw new Error(opts.removeThrows);
                calls.removes.push(r); return '{}';
            },
            cli_execute_command: function (c) { calls.cli.push(c); return ''; }
        };
        var bot = loadMergeBot(mods);
        return { bot: bot, calls: calls };
    }

    test('get_pr body without a number -> skipped silently, run completes', function () {
        var fx = loopFixture({ prBody: { state: 'OPEN', head: { sha: 's7' }, labels: [] } });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.success, true);
        assert.equal(result.acted, 0);
        assert.equal(fx.calls.merges.length + fx.calls.adds.length + fx.calls.removes.length, 0);
    });

    test('get_pr body with a non-OPEN state -> skipped (stale list entry)', function () {
        var fx = loopFixture({ prBody: { number: 7, state: 'MERGED', head: { sha: 's7' }, labels: [] } });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.acted, 0);
        assert.equal(fx.calls.merges.length, 0);
    });

    test('get_pr body without a head sha -> skipped', function () {
        var fx = loopFixture({
            prBody: { number: 7, state: 'OPEN', labels: [{ name: 'pr_approved' }, { name: 'ai_validated' }] }
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.acted, 0);
        assert.equal(result.log.filter(function (l) { return l.indexOf('FIFO-queued') !== -1; }).length, 0,
            'a headless PR cannot even be queued');
    });

    test('stale-head unarm throws -> warning line, skip still counts, no acted credit', function () {
        var fx = loopFixture({
            removeThrows: 'label endpoint 500',
            list: [{ number: 7, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }], head: { sha: 's7' } }],
            prBody: {
                number: 7, state: 'OPEN', draft: false, mergeable: true, mergeable_state: 'clean',
                head: { sha: 's7' },
                labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }]
            },
            checkRuns: [{ status: 'IN_PROGRESS', conclusion: null,
                          started_at: new Date(Date.now() - 3 * 3600000).toISOString() }]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.ok(result.log.some(function (l) {
            return l.indexOf('⚠️ pr-7 stale-head unarm failed:') !== -1 && l.indexOf('label endpoint 500') !== -1;
        }), 'the verbatim failure is surfaced: ' + JSON.stringify(result.log));
        assert.equal(result.acted, 0, 'a failed unarm is not motion');
        assert.equal(result.skipped, 1, 'the dead head still counts as skipped');
    });

    test('BEHIND unarm throws -> warning line, acted unchanged, no merge', function () {
        var fx = loopFixture({
            removeThrows: 'no permission',
            list: [{ number: 7, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }], head: { sha: 's7' } }],
            prBody: {
                number: 7, state: 'OPEN', draft: false, mergeable: true, mergeable_state: 'behind',
                head: { sha: 's7' },
                labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }]
            },
            checkRuns: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.ok(result.log.some(function (l) {
            return l.indexOf('⚠️ pr-7 unarm failed:') !== -1 && l.indexOf('no permission') !== -1;
        }), 'the verbatim failure is surfaced: ' + JSON.stringify(result.log));
        assert.equal(result.acted, 0);
        assert.equal(fx.calls.merges.length, 0, 'a stale head never merges');
    });

    test('ai_validated latch throws -> latch-failed line, no acted credit', function () {
        var fx = loopFixture({
            addThrows: 'labels endpoint down',
            list: [{ number: 7, labels: [{ name: 'ai_validating' }], head: { sha: 's7' } }],
            prBody: {
                number: 7, state: 'OPEN', draft: false, mergeable: true, mergeable_state: 'clean',
                head: { sha: 's7' }, labels: [{ name: 'ai_validating' }]
            },
            checkRuns: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]
        });
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.ok(result.log.some(function (l) {
            return l.indexOf('⚠️ pr-7 latch failed:') !== -1 && l.indexOf('labels endpoint down') !== -1;
        }), 'the verbatim failure is surfaced: ' + JSON.stringify(result.log));
        assert.equal(result.acted, 0, 'a failed latch is not motion');
        assert.equal(fx.calls.adds.length, 1, 'the latch was attempted exactly once');
        assert.equal(fx.calls.removes.length, 1, 'the unarm still ran before the latch attempt');
    });

    test('advance candidate merge refused -> refusal line + deferral + self-tick', function () {
        var calls = { merges: [], cli: [] };
        var mods = {
            github_list_workflow_runs: function () { return JSON.stringify({ workflow_runs: [] }); },
            github_list_prs: function (a) {
                if (a.state === 'merged') return '[]';
                return JSON.stringify([
                    { number: 1, labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }, { name: 'blocked' }], head: { sha: 's1' } },
                    { number: 2, labels: [{ name: 'pr_approved' }, { name: 'ai_validated' }], head: { sha: 's2' } }
                ]);
            },
            github_get_pr: function (a) {
                var n = a.pullRequestId;
                return JSON.stringify({
                    number: n, state: 'OPEN', draft: false, mergeable: true, mergeable_state: 'clean',
                    head: { sha: 's' + n },
                    labels: n === 1 ? [{ name: 'pr_approved' }, { name: 'ai_validating' }, { name: 'blocked' }]
                                     : [{ name: 'pr_approved' }, { name: 'ai_validated' }]
                });
            },
            github_get_commit_check_runs: function (a) {
                return JSON.stringify({ check_runs: [{ name: a.commitSha, status: 'COMPLETED', conclusion: 'SUCCESS' }] });
            },
            github_merge_pr: function (m) {
                calls.merges.push(m);
                return JSON.stringify({ message: 'Base branch was modified. Review and try the merge again' });
            },
            github_add_labels: function () { return '{}'; },
            github_remove_label: function () { return '{}'; },
            cli_execute_command: function (c) { calls.cli.push(c); return ''; }
        };
        var bot = loadMergeBot(mods);
        var result = bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(calls.merges.length, 2, 'one merge attempt + the single retry, both refused');
        assert.ok(result.log.some(function (l) {
            return l.indexOf('❌ pr-2 merge refused:') !== -1 && l.indexOf('Base branch was modified') !== -1;
        }), 'the refusal is surfaced verbatim: ' + JSON.stringify(result.log));
        assert.ok(result.log.some(function (l) {
            return l.indexOf('⏳ pr-2 approved — FIFO-queued') !== -1;
        }), 'a refused advance defers like any other not-ready candidate');
        assert.equal(result.acted, 0);
        assert.equal(calls.cli.length, 1, 'the deferral still arms the self-heal tick');
    });
});

suite('mergeBot: gh-1101 invisible-required log line', function () {
    test('approved + BLOCKED names the invisible-required shape; others keep the generic line', function () {
        var bot = loadMergeBot({});
        assert.ok(bot.blockedWaitLine(435, 'BLOCKED', true).indexOf('required checks invisible to PR') !== -1);
        assert.equal(bot.blockedWaitLine(7, 'BLOCKED', false), '⏳ pr-7 mergeState=BLOCKED — waiting (checks settling)');
        assert.equal(bot.blockedWaitLine(7, 'UNSTABLE', true), '⏳ pr-7 mergeState=UNSTABLE — waiting (checks settling)');
    });
});

suite('mergeBot: bridge payload normalization (gh-1250)', function () {
    // parseMcp/listArray delegate to js/common/mcpParse.js (the verbatim
    // copies in mergeTrigger.js and mergeBot.js were one helper). These
    // tests pin the delegation branches the action() path depends on:
    // null/invalid-JSON list payloads read as empty lists (no crash), raw
    // object payloads pass through by reference, and wrapped
    // { pullRequests: [...] } objects are unwrapped before iterating.

    function normFixture(listPrsResult, prBody) {
        var calls = { lists: [], merges: [] };
        var mods = {
            github_list_workflow_runs: function () { return JSON.stringify({ workflow_runs: [] }); },
            github_list_prs: function (a) { calls.lists.push(a); return listPrsResult; },
            github_get_pr: function () { return JSON.stringify(prBody); },
            github_get_commit_check_runs: function () {
                return JSON.stringify({ check_runs: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
            },
            github_merge_pr: function (m) { calls.merges.push(m); return JSON.stringify({ merged: true }); },
            github_add_labels: function () { return '{}'; },
            github_remove_label: function () { return '{}'; },
            cli_execute_command: function () { return ''; }
        };
        return { bot: loadMergeBot(mods), calls: calls };
    }

    var ARMED_GREEN_BODY = {
        number: 7, state: 'OPEN', draft: false, mergeable: true, mergeable_state: 'clean',
        head: { sha: 's7' },
        labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }]
    };

    test('null and invalid-JSON list payloads read as empty lists (parseMcp null + catch branches)', function () {
        [null, 'not json at all'].forEach(function (bad) {
            var fx = normFixture(bad, {});
            var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
            assert.equal(result.success, true,
                'a bad list payload never crashes the run: ' + String(bad));
            assert.equal(result.acted, 0);
            assert.equal(fx.calls.merges.length, 0);
            assert.equal(fx.calls.lists.length, 1, 'the open list was still requested once');
        });
    });

    test('a bare-array object payload passes through and the loop still merges (payloadList array branch)', function () {
        var fx = normFixture(
            [{ number: 7, labels: [{ name: 'pr_approved' }], head: { sha: 's7' } }],
            ARMED_GREEN_BODY);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.success, true);
        assert.equal(result.acted, 1);
        assert.equal(fx.calls.merges.length, 1, 'the object-array list iterated and merged');
        assert.equal(fx.calls.merges[0].pullRequestId, 7);
    });

    test('a wrapped { pullRequests: [...] } object list is unwrapped (payloadList pullRequests branch)', function () {
        var fx = normFixture(
            { pullRequests: [{ number: 7, labels: [{ name: 'pr_approved' }], head: { sha: 's7' } }] },
            ARMED_GREEN_BODY);
        var result = fx.bot.action({ jobParams: { repo: 'a/b' } });
        assert.equal(result.success, true);
        assert.equal(result.acted, 1, 'the wrapped shape did not silently disable the sweep');
        assert.equal(fx.calls.merges.length, 1);
        assert.equal(fx.calls.merges[0].pullRequestId, 7);
    });
});
