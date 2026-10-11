// SCRATCH reproduction for gh-850 — L2 replay of the fa #1457 05:0x timeline.
// Not for commit: exploration only.
loadModuleTest();

function loadModuleTest() {}

suite('gh-850 scratch: latch-skip deadlock replay', function () {

    var RULES = {
        validate: { source: 'github',
            query: { type: 'pr', labels: ['pr_approved'],
                notLabels: ['ai_validating', 'validation_failed'],
                notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                mutex: 'ai_validating', mutexAmong: ['pr_approved'] },
            localAction: 'validate_pr', skipIfValidatedHead: true, redHeadSkip: true,
            limit: 1, id: 'validate-armed', deferRedHead: true },
        sweep: { source: 'github',
            query: { type: 'pr', labels: ['ai_validating'], notMergeState: ['BEHIND'], draft: false },
            localAction: 'sweep_stale_validation', staleMinutes: 15, limit: 10, id: 'sweep-stale-validating' },
        revalidate: { source: 'github',
            query: { type: 'pr', labels: ['pr_approved', 'ai_validating'],
                notMergeState: ['BEHIND', 'DIRTY'], checks: ['none', 'pending'], draft: false,
                mutex: 'ai_validating', mutexAmong: ['pr_approved'], mutexExcludeSelf: true },
            localAction: 'validate_pr', limit: 1, id: 'revalidate-armed' }
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: ['pr_approved'], issueNumber: null,
            prNumber: n, draft: false };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    // gh-api mock: only the OLD head carries the concluded green dispatched run.
    function runsCli(oldSha) {
        return function (cmd) {
            if (cmd.command.indexOf('actions/workflows/') !== -1 && cmd.command.indexOf('/runs?') !== -1) {
                var m = /head_sha=([^&"]+)/.exec(cmd.command);
                if (m && m[1] === oldSha) {
                    var t = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
                    return JSON.stringify({ workflow_runs: [
                        { status: 'completed', conclusion: 'success', head_sha: oldSha,
                          event: 'workflow_dispatch', created_at: t, updated_at: t }
                    ] });
                }
                return JSON.stringify({ workflow_runs: [] });
            }
            return '';
        };
    }

    function dispatched(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh workflow run') === 0; });
    }

    // AC1 shape: ai_validated latch from an OLD head; current head has NO CI at all.
    test('AC1: [pr_approved, ai_validated], head moved, NO run on new head → dispatch expected', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1457, { labels: ['pr_approved', 'ai_validated'],
                    branch: 'ai/gh-1457', headSha: '856a145new' })],
                // rollup on the CURRENT head: ZERO check runs → 'none'
                commitCheckRuns: { check_runs: [] },
                prStatus: { checkConclusion: 'none', mergeState: 'BLOCKED' }
            },
            onCliExecute: runsCli('0f320340old')
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
            rules: [RULES.validate, RULES.sweep, RULES.revalidate] } });

        console.log('LABEL ADDS: ' + JSON.stringify(sm.capturedPrLabelAdds));
        console.log('CLI: ' + JSON.stringify(sm.capturedCliCommands.map(function (c) { return c.command; })));
        assert.ok(dispatched(sm.capturedCliCommands), 'AC1: next tick dispatches validation');
    });

    // Timeline shape: latch-skip ARM-ONLY on covered head A, THEN head moves to B (no CI).
    // Next tick the ARMED PR carries ai_validating + ai_validated, head B bare.
    test('arm-only latch-skip on head A, head moves to bare head B → next tick must dispatch', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1457, { labels: ['pr_approved', 'ai_validated', 'ai_validating'],
                    branch: 'ai/gh-1457', headSha: '856a145new' })],
                commitCheckRuns: { check_runs: [] },
                prStatus: { checkConclusion: 'none', mergeState: 'BLOCKED' }
            },
            onCliExecute: runsCli('0f320340old')
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b',
            rules: [RULES.validate, RULES.sweep, RULES.revalidate] } });

        console.log('LABEL ADDS: ' + JSON.stringify(sm.capturedPrLabelAdds));
        console.log('LABEL REMOVES: ' + JSON.stringify(sm.capturedPrLabelRemoves));
        console.log('CLI: ' + JSON.stringify(sm.capturedCliCommands.map(function (c) { return c.command; })));
        assert.ok(dispatched(sm.capturedCliCommands), 'armed PR on a bare moved head must get a re-dispatch');
    });
});
