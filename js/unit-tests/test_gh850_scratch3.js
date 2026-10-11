// SCRATCH reproduction #3 for gh-850 — focused dev-lane replay with console capture.
suite('gh-850 scratch #3: dev-lane latch void', function () {

    var DEV_RULES = {
        fresh: { source: 'github',
            query: { type: 'pr', checks: ['none', 'pending'],
                notLabels: ['ai_validating', 'pr_approved', 'chore:pin', 'ai_validated'],
                notMergeState: 'BEHIND', draft: false },
            localAction: 'validate_pr', limit: 1, id: 'validate-fresh' },
        masked: { source: 'github',
            query: { type: 'pr', checks: 'green',
                notLabels: ['ai_validating', 'pr_approved', 'chore:pin', 'ai_validated', 'validation_failed'],
                notMergeState: ['BEHIND', 'DIRTY'], draft: false },
            localAction: 'validate_pr', skipIfGreenCi: true, limit: 1, id: 'validate-fresh-masked-green' },
        validatedGreen: { source: 'github',
            query: { type: 'pr', labels: ['ai_validating'], notLabels: ['pr_approved'], checks: 'green' },
            localAction: 'complete_validation', limit: 10, id: 'validated-green' }
    };

    function prItem(n, extra) {
        var it = { key: 'pr-' + n, labels: [], issueNumber: null,
            prNumber: n, draft: false };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    function config(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }

    function dispatched(cmdList) {
        return cmdList.some(function (c) { return c.command.indexOf('gh workflow run') === 0; });
    }

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

    test('dev lane: [ai_validated] UNAPPROVED, head moved, bare new head, rollup none → dispatch?', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            captureConsole: true,
            github: {
                items: [prItem(1457, { labels: ['ai_validated'],
                    branch: 'ai/gh-1457', headSha: '856a145new' })],
                commitCheckRuns: { check_runs: [] },
                prStatus: { checkConclusion: 'none', mergeState: 'BLOCKED' }
            },
            onCliExecute: runsCli('0f320340old')
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: [DEV_RULES.fresh, DEV_RULES.masked, DEV_RULES.validatedGreen] } });
        console.log('DECISION LOG:\n' + sm.capturedLogs.filter(function (l) {
            return l.indexOf('pr-1457') !== -1 || l.indexOf('1457') !== -1;
        }).join('\n'));
        console.log('CLI: ' + JSON.stringify(sm.capturedCliCommands.map(function (c) { return c.command.slice(0, 50); })));
        assert.ok(dispatched(sm.capturedCliCommands), 'gh-850 AC1: dispatch expected');
    });
});
