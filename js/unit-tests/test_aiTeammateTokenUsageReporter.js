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

    test('extracts and sums token usage attempts with request metadata', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            '[INFO] CommandLineUtils - Requests  1 Premium (27m 2s)',
            '[INFO] CommandLineUtils - Tokens    ↑ 2.9m • ↓ 9.4k • 2.8m (cached) • 1.7k (reasoning)',
            'Feedback loop: resuming agent for rework_missing_outputs attempt 1/2',
            '[INFO] CommandLineUtils - Requests  2 Premium (30m 0s)',
            '[INFO] CommandLineUtils - Tokens    ↑ 3.1m • ↓ 10k • 3m (cached) • 2k (reasoning)'
        ].join('\n'));

        assert.equal(usage.requests, 3);
        assert.equal(usage.requestTier, 'Premium');
        assert.equal(usage.requestDuration, '30m 0s');
        assert.equal(usage.readTokens, 6000000);
        assert.equal(usage.writeTokens, 19400);
        assert.equal(usage.cachedTokens, 5800000);
        assert.equal(usage.reasoningTokens, 3700);
        assert.equal(usage.samples, 2);
        assert.equal(usage.resumeDetected, true);
        assert.equal(usage.attempts.length, 2);
        assert.equal(usage.attempts[0].attemptIndex, 1);
        assert.equal(usage.attempts[1].attemptIndex, 2);
        assert.equal(usage.resumeStages[0], 'rework_missing_outputs 1/2');
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

    test('builds aggregate and attempt CSV with resume columns', function() {
        var reporter = loadReporter();
        var aggregateCsv = reporter.buildCsv([{
            runId: '1',
            runNumber: 10,
            createdAt: '2026-06-01T00:00:00Z',
            day: '2026-06-01',
            conclusion: 'success',
            agent: 'pr_rework',
            ticketKey: 'TS-1',
            configFile: 'agents/pr_rework.json',
            title: 'agents/pr_rework.json : TS-1 : TS-1',
            requests: 3,
            readTokens: 6000000,
            writeTokens: 19400,
            cachedTokens: 5800000,
            reasoningTokens: 3700,
            samples: 2,
            resumeDetected: true,
            resumeStages: 'rework_missing_outputs 1/2',
            url: 'https://example.test/run/1'
        }]);
        var attemptsCsv = reporter.buildAttemptsCsv([{
            runId: '1',
            runNumber: 10,
            createdAt: '2026-06-01T00:00:00Z',
            day: '2026-06-01',
            conclusion: 'success',
            agent: 'pr_rework',
            ticketKey: 'TS-1',
            attemptIndex: 2,
            resumeDetected: true,
            requests: 2,
            readTokens: 3100000,
            writeTokens: 10000,
            cachedTokens: 3000000,
            reasoningTokens: 2000,
            rawTokensLine: 'Tokens ↑ 3.1m',
            url: 'https://example.test/run/1'
        }]);

        assert.contains(aggregateCsv.split('\n')[0], 'resumeDetected');
        assert.contains(aggregateCsv, 'rework_missing_outputs 1/2');
        assert.contains(attemptsCsv.split('\n')[0], 'attemptIndex');
        assert.contains(attemptsCsv, 'pr_rework,TS-1,2,true');
    });
});
