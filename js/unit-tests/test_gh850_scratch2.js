// SCRATCH reproduction #2 for gh-850 — full real rule set replay.
suite('gh-850 scratch #2: full-rules replay', function () {

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

    function realRules() {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        return cfg.params.jobParams.rules;
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

    // Full real rule set, APPROVED latched PR, head moved, no CI on the new head.
    test('FULL RULES: [pr_approved, ai_validated] head moved, bare head → dispatch?', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1457, { labels: ['pr_approved', 'ai_validated'],
                    branch: 'ai/gh-1457', headSha: '856a145new', body: 'Fixes #1457' })],
                commitCheckRuns: { check_runs: [] },
                prStatus: { checkConclusion: 'none', mergeState: 'BLOCKED' },
                issueSearch: { items: [] }
            },
            onCliExecute: runsCli('0f320340old')
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: realRules() } });
        console.log('CLI: ' + JSON.stringify(sm.capturedCliCommands.map(function (c) { return c.command.slice(0, 60); })));
        console.log('LABEL ADDS: ' + JSON.stringify(sm.capturedPrLabelAdds));
        console.log('LABEL REMOVES: ' + JSON.stringify(sm.capturedPrLabelRemoves));
        assert.ok(dispatched(sm.capturedCliCommands), 'FULL RULES AC1: dispatch expected');
    });

    // UNAPPROVED latched PR (dev lane), head moved, no CI on the new head.
    test('FULL RULES: [ai_validated] UNAPPROVED, head moved, bare head → dispatch?', function () {
        var sm = makeSmAgent(Object.assign(config('a', 'b'), {
            github: {
                items: [prItem(1457, { labels: ['ai_validated'],
                    branch: 'ai/gh-1457', headSha: '856a145new', body: 'Fixes #1457' })],
                commitCheckRuns: { check_runs: [] },
                prStatus: { checkConclusion: 'none', mergeState: 'BLOCKED' },
                issueSearch: { items: [] }
            },
            onCliExecute: runsCli('0f320340old')
        }));
        sm.action({ jobParams: { owner: 'a', repo: 'b', rules: realRules() } });
        console.log('CLI: ' + JSON.stringify(sm.capturedCliCommands.map(function (c) { return c.command.slice(0, 60); })));
        console.log('LABEL ADDS: ' + JSON.stringify(sm.capturedPrLabelAdds));
        console.log('LABEL REMOVES: ' + JSON.stringify(sm.capturedPrLabelRemoves));
        assert.ok(dispatched(sm.capturedCliCommands), 'dev-lane: dispatch expected');
    });
});
