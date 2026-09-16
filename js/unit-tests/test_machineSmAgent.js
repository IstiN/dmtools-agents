/**
 * Unit tests for machineSmAgent.js — the machine-loop watchdog decision core.
 *
 * The decision core (decideActions, issueFromRunTitle, checkConclusion) is
 * pure; these tests pin the reconciler contract: dead-letter re-fires,
 * rework round cap, review/merge/update-branch routing, concurrency skips.
 */
/* global suite, test, assert, loadModule, makeRequire */

suite('machineSm decision core', function () {

    var agent = loadModule('js/machineSmAgent.js', makeRequire({
        './configLoader.js': { loadProjectConfig: function () { return {}; } },
        './common/smProvider.js': { createSmProvider: function () { return {}; } }
    }), {
        cli_execute_command: function () { return '{}'; }
    });

    function st(labels, pr, active) {
        return {
            issue: { number: 1, labels: labels, assignees: [] },
            pr: pr === undefined ? null : pr,
            activeRunForIssue: !!active
        };
    }

    // ── guard states ─────────────────────────────────────────────────────────

    test('needs-human is terminal — no action', function () {
        var acts = agent.decideActions(st(['needs-human'], null), {});
        assert.equal(acts.length, 1);
        assert.equal(acts[0].type, 'skip');
    });

    test('active run for the issue skips reconciliation', function () {
        var acts = agent.decideActions(st(['agent:dev'], null, true), {});
        assert.equal(acts[0].type, 'skip');
    });

    // ── no PR ────────────────────────────────────────────────────────────────

    test('ai_developed without a PR re-fires rework (dead dev run)', function () {
        var acts = agent.decideActions(st(['ai_developed'], null), {});
        assert.equal(acts[0].type, 'dispatch');
        assert.equal(acts[0].leg, 'rework');
    });

    test('agent:dev without a PR re-fires dev (dead letter)', function () {
        var acts = agent.decideActions(st(['agent:dev'], null), {});
        assert.equal(acts[0].leg, 'dev');
    });

    test('stale agent:rework with no PR re-fires rework', function () {
        var acts = agent.decideActions(st(['agent:rework'], null), {});
        assert.equal(acts[0].leg, 'rework');
    });

    // ── merged / closed ──────────────────────────────────────────────────────

    test('merged PR triggers the close-issue safety net', function () {
        var acts = agent.decideActions(st(['ai_developed'], { number: 9, state: 'MERGED' }), {});
        assert.equal(acts[0].type, 'closeIssue');
    });

    test('closed-unmerged PR is a plain skip', function () {
        var acts = agent.decideActions(st(['ai_developed'], { number: 9, state: 'CLOSED' }), {});
        assert.equal(acts[0].type, 'skip');
    });

    // ── red CI ───────────────────────────────────────────────────────────────

    function redPr() {
        return { number: 7, state: 'OPEN', checkConclusion: 'red',
                 mergeState: 'BLOCKED', mergeable: false };
    }

    test('red CI dispatches rework', function () {
        var acts = agent.decideActions(st(['ai_developed'], redPr()), {});
        assert.equal(acts[0].type, 'dispatch');
        assert.equal(acts[0].leg, 'rework');
    });

    test('red CI with stale agent:rework still re-fires (dead-letter fix, #116)', function () {
        var acts = agent.decideActions(st(['ai_developed', 'agent:rework'], redPr()), {});
        assert.equal(acts[0].leg, 'rework');
    });

    test('red CI after maxReworkRoundscap escalates to needs-human', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'rework-round-1', 'rework-round-2'], redPr()),
            { maxReworkRounds: 2 });
        assert.equal(acts[0].type, 'label');
        assert.equal(acts[0].label, 'needs-human');
    });

    test('pending checks wait for the next tick', function () {
        var acts = agent.decideActions(
            st(['ai_developed'], { number: 7, state: 'OPEN', checkConclusion: 'pending' }), {});
        assert.equal(acts[0].type, 'skip');
    });

    // ── green paths ──────────────────────────────────────────────────────────

    function greenPr(mergeState, mergeable) {
        return { number: 7, state: 'OPEN', checkConclusion: 'green',
                 mergeState: mergeState || 'CLEAN', mergeable: mergeable !== false };
    }

    test('green + ai_developed dispatches review', function () {
        var acts = agent.decideActions(st(['ai_developed'], greenPr()), {});
        assert.equal(acts[0].leg, 'review');
    });

    test('green + reviewed-not-approved + stale agent:rework re-fires rework', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'agent:rework'], greenPr()), {});
        assert.equal(acts[0].leg, 'rework');
    });

    test('approved + BEHIND updates the branch instead of merging', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'], greenPr('BEHIND')), {});
        assert.equal(acts[0].type, 'updateBranch');
    });

    test('approved + CLEAN merges (squash parity with merge-trigger)', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'], greenPr('CLEAN')), {});
        assert.equal(acts[0].type, 'merge');
    });

    test('approved + mergeable null mergeState falls back to mergeable=true', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'],
               greenPr('UNKNOWN', true)), {});
        assert.equal(acts[0].type, 'merge');
    });

    test('approved + BLOCKED + not mergeable skips', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'],
               greenPr('BLOCKED', false)), {});
        assert.equal(acts[0].type, 'skip');
    });

    // ── helpers ──────────────────────────────────────────────────────────────

    test('issueFromRunTitle parses gh-N from run titles', function () {
        assert.equal(agent.issueFromRunTitle('🔧 rework · gh-125: Machine comments'), 125);
        assert.equal(agent.issueFromRunTitle('⚒️ dev · gh-3: no digits elsewhere'), 3);
        assert.equal(agent.issueFromRunTitle('no issue here'), null);
    });

});
