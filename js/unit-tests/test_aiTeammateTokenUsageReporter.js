/**
 * Unit tests for aiTeammateTokenUsageReporter.js
 */

function loadReporter(overrides) {
    var configLoaderMock = {
        loadProjectConfig: function() {
            return { repository: { owner: 'IstiN', repo: 'trackstate' } };
        }
    };
    var globals = Object.assign({
        file_write: function() {},
        github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); }
    }, overrides || {});
    return loadModule('js/aiTeammateTokenUsageReporter.js', makeRequire({ './configLoader.js': configLoaderMock }), globals);
}

suite('aiTeammateTokenUsageReporter parsing', function() {

    test('parses suffixed token counts', function() {
        var reporter = loadReporter();
        assert.equal(reporter.parseNumberWithSuffix('2.9m'), 2900000);
        assert.equal(reporter.parseNumberWithSuffix('9.4k'), 9400);
        assert.equal(reporter.parseNumberWithSuffix('1700'), 1700);
    });

    test('parses CommandLineUtils token summary line', function() {
        var reporter = loadReporter();
        var parsed = reporter.parseTokensLine('[INFO] CommandLineUtils - Tokens    ↑ 2.9m • ↓ 9.4k • 2.8m (cached) • 1.7k (reasoning)');

        assert.equal(parsed.readTokens, 2900000);
        assert.equal(parsed.writeTokens, 9400);
        assert.equal(parsed.cachedTokens, 2800000);
        assert.equal(parsed.reasoningTokens, 1700);
    });

    test('extracts the final token usage sample with request metadata', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            '[INFO] CommandLineUtils - Requests  1 Premium (27m 2s)',
            '[INFO] CommandLineUtils - Tokens    ↑ 2.9m • ↓ 9.4k • 2.8m (cached) • 1.7k (reasoning)',
            '[INFO] CommandLineUtils - Requests  2 Premium (30m 0s)',
            '[INFO] CommandLineUtils - Tokens    ↑ 3.1m • ↓ 10k • 3m (cached) • 2k (reasoning)'
        ].join('\n'));

        assert.equal(usage.requests, 2);
        assert.equal(usage.requestTier, 'Premium');
        assert.equal(usage.requestDuration, '30m 0s');
        assert.equal(usage.readTokens, 3100000);
        assert.equal(usage.writeTokens, 10000);
        assert.equal(usage.cachedTokens, 3000000);
        assert.equal(usage.reasoningTokens, 2000);
        assert.equal(usage.samples, 2);
    });

    test('extracts agent and ticket key from ai-teammate run title', function() {
        var reporter = loadReporter();
        var parsed = reporter.extractAgentAndKey({
            display_title: 'agents/bug_development.json : TS-1307 : bug_development'
        });

        assert.equal(parsed.configFile, 'agents/bug_development.json');
        assert.equal(parsed.agent, 'bug_development');
        assert.equal(parsed.ticketKey, 'TS-1307');
    });

    test('lists completed workflow runs across MCP pages', function() {
        var calls = [];
        var reporter = loadReporter({
            github_list_workflow_runs: function(workspace, repository, status, workflowId, perPage, page) {
                calls.push({ workspace: workspace, repository: repository, status: status, workflowId: workflowId, perPage: perPage, page: page });
                if (page === 1) {
                    return JSON.stringify({ workflow_runs: [
                        { id: 1, status: 'completed', created_at: '2026-06-01T00:00:00Z' },
                        { id: 2, status: 'completed', created_at: '2026-05-31T00:00:00Z' }
                    ] });
                }
                if (page === 2) {
                    return JSON.stringify({ workflow_runs: [
                        { id: 3, status: 'completed', created_at: '2026-05-30T00:00:00Z' }
                    ] });
                }
                return JSON.stringify({ workflow_runs: [] });
            }
        });

        var runs = reporter.listCompletedRuns({
            workspace: 'IstiN',
            repository: 'trackstate',
            workflowId: 'ai-teammate.yml',
            statuses: ['completed'],
            perStatusLimit: 2,
            maxPages: 10
        });

        assert.equal(runs.length, 3);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].page, 1);
        assert.equal(calls[1].page, 2);
    });
});
