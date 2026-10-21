/**
 * Unit tests for aiTeammateTokenUsageReporter.js
 */

// gh-1108: the reporter now requires two pure siblings at the top (hoisted
// per the pack-require rule) — map them to the REAL modules so every
// loadReporter call below exercises the production wiring.
var dedupModule = loadModule('js/common/teammateEventDedup.js', makeRequire({}), {});
var tokenUsageModule = loadModule('js/factory/token_usage.js', makeRequire({}), {});

function loadReporter(overrides, projectConfig) {
    var configLoaderMock = {
        loadProjectConfig: function() {
            return projectConfig !== undefined ? projectConfig : { repository: { owner: 'IstiN', repo: 'trackstate' } };
        }
    };
    var globals = Object.assign({
        file_write: function() {},
        github_list_workflow_runs: function() { return JSON.stringify({ workflow_runs: [] }); }
    }, overrides || {});
    return loadModule('js/aiTeammateTokenUsageReporter.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/teammateEventDedup.js': dedupModule,
            './factory/token_usage.js': tokenUsageModule
        }),
        globals);
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
            'Copilot rate limit detected; retrying in 90s (attempt 2/2)',
            'Command failed (exit code 124): ./agents/scripts/run-agent.sh',
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
        assert.equal(usage.feedbackLoopCount, 1);
        assert.equal(usage.rateLimitRetryCount, 1);
        assert.equal(usage.rateLimitDetected, true);
        assert.equal(usage.timeoutCount, 1);
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

    test('calculates workflow run duration from GitHub timestamps', function() {
        var reporter = loadReporter();
        var seconds = reporter.calculateDurationSeconds({
            run_started_at: '2026-06-01T05:00:00Z',
            updated_at: '2026-06-01T05:27:02Z'
        });

        assert.equal(seconds, 1622);
        assert.equal(reporter.formatDuration(seconds), '27m 2s');
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
            durationSeconds: 1622,
            duration: '27m 2s',
            requests: 3,
            readTokens: 6000000,
            writeTokens: 19400,
            cachedTokens: 5800000,
            reasoningTokens: 3700,
            samples: 2,
            resumeDetected: true,
            resumeStages: 'rework_missing_outputs 1/2',
            feedbackLoopCount: 1,
            rateLimitRetryCount: 1,
            rateLimitDetected: true,
            timeoutCount: 1,
            url: 'https://example.test/run/1'
        }]);
        var attemptsCsv = reporter.buildAttemptsCsv([{
            runId: '1',
            runNumber: 10,
            createdAt: '2026-06-01T00:00:00Z',
            day: '2026-06-01',
            conclusion: 'success',
            durationSeconds: 1622,
            duration: '27m 2s',
            agent: 'pr_rework',
            ticketKey: 'TS-1',
            attemptIndex: 2,
            resumeDetected: true,
            feedbackLoopCount: 1,
            rateLimitRetryCount: 1,
            rateLimitDetected: true,
            timeoutCount: 1,
            requests: 2,
            readTokens: 3100000,
            writeTokens: 10000,
            cachedTokens: 3000000,
            reasoningTokens: 2000,
            rawTokensLine: 'Tokens ↑ 3.1m',
            url: 'https://example.test/run/1'
        }]);

        assert.contains(aggregateCsv.split('\n')[0], 'resumeDetected');
        assert.contains(aggregateCsv.split('\n')[0], 'durationSeconds');
        assert.contains(aggregateCsv.split('\n')[0], 'feedbackLoopCount');
        assert.contains(aggregateCsv.split('\n')[0], 'rateLimitRetryCount');
        assert.contains(aggregateCsv.split('\n')[0], 'timeoutCount');
        assert.contains(aggregateCsv, 'rework_missing_outputs 1/2');
        assert.contains(attemptsCsv.split('\n')[0], 'attemptIndex');
        assert.contains(attemptsCsv.split('\n')[0], 'rateLimitDetected');
        assert.contains(attemptsCsv, 'pr_rework,TS-1,2,true');
    });

    test('builds HTML with loop KPIs and chart tooltips', function() {
        var reporter = loadReporter();
        var summary = reporter.buildSummary([{
            createdAt: '2026-06-01T00:00:00Z',
            startedAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-01T00:27:02Z',
            day: '2026-06-01',
            agent: 'pr_rework',
            readTokens: 100,
            writeTokens: 10,
            cachedTokens: 50,
            reasoningTokens: 5,
            samples: 2,
            resumeDetected: true,
            feedbackLoopCount: 1,
            rateLimitRetryCount: 1,
            rateLimitDetected: true,
            timeoutCount: 1,
            durationSeconds: 1622
        }], 1);
        var html = reporter.buildHtml([{
            createdAt: '2026-06-01T00:00:00Z',
            agent: 'pr_rework',
            ticketKey: 'TS-1',
            conclusion: 'success',
            samples: 2,
            resumeDetected: true,
            feedbackLoopCount: 1,
            rateLimitRetryCount: 1,
            timeoutCount: 1,
            durationSeconds: 1622,
            duration: '27m 2s',
            readTokens: 100,
            writeTokens: 10,
            cachedTokens: 50,
            reasoningTokens: 5,
            runNumber: 10,
            url: 'https://example.test/run/1'
        }], summary);

        assert.contains(html, '<span>Loops</span><b>1</b>');
        assert.contains(html, '<span>Limit Retries</span><b>1</b>');
        assert.contains(html, '<span>Timeouts</span><b>1</b>');
        assert.contains(html, 'fails with limits');
        assert.contains(html, '<span>Avg Duration</span><b>27m 2s</b>');
        assert.contains(html, '<span>Runner Time</span><b>27m 2s</b>');
        assert.contains(html, '<span>Max Runners</span><b>1</b>');
        assert.contains(html, '<h2>Daily Runner Time</h2>');
        assert.contains(html, '<h2>Runner Time By Agent</h2>');
        assert.contains(html, '>27m 2s</td>');
        assert.contains(html, 'id="chartTooltip"');
        assert.contains(html, 'function showTip');
    });

    test('escapes script-breaking characters in embedded JSON payload', function() {
        var reporter = loadReporter();
        var summary = reporter.buildSummary([{
            createdAt: '2026-06-01T00:00:00Z',
            startedAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-01T00:27:02Z',
            day: '2026-06-01',
            agent: 'pr_rework',
            readTokens: 100,
            writeTokens: 10,
            cachedTokens: 50,
            reasoningTokens: 5,
            samples: 1,
            resumeDetected: false,
            feedbackLoopCount: 0,
            rateLimitRetryCount: 0,
            rateLimitDetected: false,
            timeoutCount: 0,
            durationSeconds: 60
        }], 1);
        var malicious = "';alert(1);//<script>alert(2)</script>" + '\u2028' + '\u2029';
        var html = reporter.buildHtml([{
            createdAt: '2026-06-01T00:00:00Z',
            agent: malicious,
            ticketKey: malicious,
            conclusion: 'success',
            samples: 1,
            resumeDetected: false,
            feedbackLoopCount: 0,
            rateLimitRetryCount: 0,
            timeoutCount: 0,
            durationSeconds: 60,
            duration: '1m 0s',
            readTokens: 10,
            writeTokens: 1,
            cachedTokens: 5,
            reasoningTokens: 0,
            runNumber: 1,
            url: malicious
        }], summary);

        var dataOpen = 'const DATA=JSON.parse("';
        var start = html.indexOf(dataOpen);
        assert.notEqual(start, -1, 'JSON.parse DATA declaration missing');
        var payloadStart = start + dataOpen.length;
        var payloadEnd = html.indexOf('");', payloadStart);
        assert.notEqual(payloadEnd, -1, 'JSON.parse DATA declaration not closed');
        var payload = html.substring(payloadStart, payloadEnd);

        assert.notContains(payload, '<script>', 'payload contains raw <script>');
        assert.notContains(payload, '</script>', 'payload contains raw </script>');
        assert.notContains(payload, "'", 'payload contains raw single quote');
        assert.notContains(payload, '\u2028', 'payload contains raw U+2028');
        assert.notContains(payload, '\u2029', 'payload contains raw U+2029');
        assert.contains(payload, '\\u003c', 'payload does not escape <');
        assert.contains(payload, '\\u003e', 'payload does not escape >');
        assert.contains(payload, '\\u0027', 'payload does not escape single quote');
        assert.contains(payload, '\\u2028', 'payload does not escape U+2028');
        assert.contains(payload, '\\u2029', 'payload does not escape U+2029');
    });

    test('action reuses cached run usage and writes cache progress', function() {
        var writes = {};
        var logDownloads = [];
        var cachedRow = {
            runId: '1',
            runNumber: 10,
            createdAt: '2026-06-01T00:00:00Z',
            startedAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-01T00:01:00Z',
            day: '2026-06-01',
            conclusion: 'success',
            agent: 'pr_review',
            ticketKey: 'TS-1',
            configFile: 'agents/pr_review.json',
            title: 'agents/pr_review.json : TS-1 : TS-1',
            durationSeconds: 60,
            duration: '1m 0s',
            requests: 0,
            readTokens: 100,
            writeTokens: 10,
            cachedTokens: 90,
            reasoningTokens: 5,
            samples: 1,
            resumeDetected: false,
            resumeStages: '',
            feedbackLoopCount: 0,
            rateLimitRetryCount: 0,
            rateLimitDetected: false,
            timeoutCount: 0,
            url: 'https://example.test/run/1'
        };
        var reporter = loadReporter({
            file_read: function(args) {
                if (args.path === 'outputs/token_usage/ai_teammate_token_usage_cache.json') {
                    return JSON.stringify({ version: 1, entries: { '1': { row: cachedRow, attemptRows: [] } } });
                }
                return '';
            },
            file_write: function(args) { writes[args.path] = args.content; },
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [
                    { id: 1, status: 'completed', conclusion: 'success', run_number: 10, created_at: '2026-06-01T00:00:00Z', run_started_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:01:00Z', display_title: 'agents/pr_review.json : TS-1 : TS-1', html_url: 'https://example.test/run/1' },
                    { id: 2, status: 'completed', conclusion: 'success', run_number: 11, created_at: '2026-06-01T00:02:00Z', run_started_at: '2026-06-01T00:02:00Z', updated_at: '2026-06-01T00:03:00Z', display_title: 'agents/pr_rework.json : TS-2 : TS-2', html_url: 'https://example.test/run/2' }
                ] });
            },
            github_get_workflow_run_logs: function(args) {
                logDownloads.push(args.runId);
                return '[INFO] CommandLineUtils - Tokens    ↑ 2k • ↓ 20 • 1k (cached) • 3 (reasoning)';
            }
        });

        var result = reporter.action({
            jobParams: {
                customParams: {
                    workspace: 'IstiN',
                    repository: 'trackstate',
                    outputDir: 'outputs/token_usage',
                    maxPages: 1
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(logDownloads.length, 1);
        assert.equal(logDownloads[0], '2');
        assert.contains(writes['outputs/token_usage/ai_teammate_token_usage_cache.json'], '"1"');
        assert.contains(writes['outputs/token_usage/ai_teammate_token_usage_cache.json'], '"2"');
        assert.equal(result.summary.cache.hits, 1);
        assert.equal(result.summary.cache.logDownloads, 1);
    });

    test('maxLogDownloads zero skips uncached log downloads', function() {
        var logDownloads = [];
        var reporter = loadReporter({
            file_read: function() {
                return JSON.stringify({ version: 1, entries: {} });
            },
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [
                    { id: 1, status: 'completed', conclusion: 'success', run_number: 10, created_at: '2026-06-01T00:00:00Z', run_started_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:01:00Z', display_title: 'agents/pr_review.json : TS-1 : TS-1', html_url: 'https://example.test/run/1' }
                ] });
            },
            github_get_workflow_run_logs: function(args) {
                logDownloads.push(args.runId);
                return '[INFO] CommandLineUtils - Tokens    ↑ 2k • ↓ 20 • 1k (cached) • 3 (reasoning)';
            }
        });

        var result = reporter.action({
            jobParams: {
                customParams: {
                    workspace: 'IstiN',
                    repository: 'trackstate',
                    outputDir: 'outputs/token_usage',
                    maxPages: 1,
                    maxLogDownloads: 0
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(logDownloads.length, 0);
        assert.equal(result.summary.cache.logDownloads, 0);
        assert.equal(result.summary.cache.stoppedByDownloadLimit, true);
    });

    test('cacheOnly writes report from cache without listing or downloading logs', function() {
        var writes = {};
        var listCalls = 0;
        var logDownloads = [];
        var cachedRow = {
            runId: '1',
            runNumber: 10,
            createdAt: '2026-06-01T00:00:00Z',
            startedAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-01T00:01:00Z',
            day: '2026-06-01',
            conclusion: 'success',
            agent: 'pr_review',
            ticketKey: 'TS-1',
            configFile: 'agents/pr_review.json',
            title: 'agents/pr_review.json : TS-1 : TS-1',
            durationSeconds: 60,
            duration: '1m 0s',
            requests: 0,
            readTokens: 100,
            writeTokens: 10,
            cachedTokens: 90,
            reasoningTokens: 5,
            samples: 1,
            resumeDetected: false,
            resumeStages: '',
            feedbackLoopCount: 0,
            rateLimitRetryCount: 0,
            rateLimitDetected: false,
            timeoutCount: 0,
            url: 'https://example.test/run/1'
        };
        var reporter = loadReporter({
            file_read: function(args) {
                if (args.path === 'outputs/token_usage/ai_teammate_token_usage_cache.json') {
                    return JSON.stringify({ version: 1, entries: { '1': { row: cachedRow, attemptRows: [] }, '2': { noUsage: true } } });
                }
                return '';
            },
            file_write: function(args) { writes[args.path] = args.content; },
            github_list_workflow_runs: function() {
                listCalls += 1;
                return JSON.stringify({ workflow_runs: [] });
            },
            github_get_workflow_run_logs: function(args) {
                logDownloads.push(args.runId);
                return '';
            }
        });

        var result = reporter.action({
            jobParams: {
                customParams: {
                    workspace: 'IstiN',
                    repository: 'trackstate',
                    outputDir: 'outputs/token_usage',
                    cacheOnly: true
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.cacheOnly, true);
        assert.equal(listCalls, 0);
        assert.equal(logDownloads.length, 0);
        assert.equal(result.summary.totalRuns, 2);
        assert.equal(result.summary.runsWithTokens, 1);
        assert.contains(writes['outputs/token_usage/ai_teammate_token_usage.html'], 'Daily Token Trend');
    });

    test('parses fa-tokens JSON usage line (IT-7 fixture)', function() {
        var reporter = loadReporter();
        var parsed = reporter.parseTokensLine('fa-tokens: {"sessionId":"gh-1164","segment":2,"input":722300,"output":17600,"cacheRead":421100,"requests":58,"source":"reported"}');

        assert.notEqual(parsed, null);
        assert.equal(parsed.readTokens, 722300);
        assert.equal(parsed.writeTokens, 17600);
        assert.equal(parsed.cachedTokens, 421100);
        assert.equal(parsed.requests, 58);
        assert.equal(parsed.source, 'reported');
        assert.equal(parsed.faSessionId, 'gh-1164');
        assert.equal(parsed.faSegment, 2);
    });

    test('aggregates fa segments per sessionId without double-counting resumed segments', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            'fa-tokens: {"sessionId":"gh-1164","segment":1,"input":100,"output":10,"cacheRead":50,"requests":5,"source":"reported"}',
            'fa-tokens: {"sessionId":"gh-1164","segment":2,"input":200,"output":20,"cacheRead":60,"requests":6,"source":"reported"}',
            'fa-tokens: {"sessionId":"gh-1164","segment":2,"input":200,"output":20,"cacheRead":60,"requests":6,"source":"reported"}',
            'fa-tokens: {"sessionId":"gh-1165","segment":1,"input":300,"output":30,"cacheRead":70,"requests":7,"source":"estimated"}'
        ].join('\n'));

        assert.equal(usage.readTokens, 600);
        assert.equal(usage.writeTokens, 60);
        assert.equal(usage.cachedTokens, 180);
        assert.equal(usage.requests, 18);
        assert.equal(usage.samples, 3);
        assert.equal(usage.source, 'mixed');
        assert.equal(usage.attempts[0].source, 'reported');
        assert.equal(usage.attempts[2].source, 'estimated');
    });

    test('marks estimated token rows visually distinct from reported in dashboard HTML', function() {
        var reporter = loadReporter();
        var rows = [
            { createdAt: '2026-10-05T01:00:00Z', agent: 'story_development', ticketKey: 'TS-1', conclusion: 'success', samples: 1, resumeDetected: false, feedbackLoopCount: 0, rateLimitRetryCount: 0, timeoutCount: 0, durationSeconds: 60, duration: '1m 0s', readTokens: 100, writeTokens: 10, cachedTokens: 50, reasoningTokens: 0, source: 'reported', runNumber: 10, url: 'https://example.test/run/10' },
            { createdAt: '2026-10-05T02:00:00Z', agent: 'story_development', ticketKey: 'TS-2', conclusion: 'success', samples: 2, resumeDetected: true, feedbackLoopCount: 0, rateLimitRetryCount: 0, timeoutCount: 0, durationSeconds: 120, duration: '2m 0s', readTokens: 200, writeTokens: 20, cachedTokens: 80, reasoningTokens: 0, source: 'estimated', runNumber: 11, url: 'https://example.test/run/11' }
        ];
        var summary = reporter.buildSummary(rows.map(function(r) {
            return {
                createdAt: r.createdAt,
                startedAt: r.createdAt,
                updatedAt: r.createdAt,
                day: r.createdAt.substring(0, 10),
                agent: r.agent,
                readTokens: r.readTokens,
                writeTokens: r.writeTokens,
                cachedTokens: r.cachedTokens,
                reasoningTokens: r.reasoningTokens,
                samples: r.samples,
                resumeDetected: r.resumeDetected,
                feedbackLoopCount: 0,
                rateLimitRetryCount: 0,
                rateLimitDetected: false,
                timeoutCount: 0,
                durationSeconds: r.durationSeconds
            };
        }), 2);
        var html = reporter.buildHtml(rows, summary);

        assert.contains(html, '>Source</th>');
        assert.contains(html, 'src-badge src-rep');
        assert.contains(html, 'src-badge src-est');
        assert.contains(html, 'class="row-est"');
        assert.contains(html, '.row-est');
    });

    test('includes source column in aggregate and attempt CSVs', function() {
        var reporter = loadReporter();
        var aggregateCsv = reporter.buildCsv([{
            runId: '1',
            runNumber: 10,
            createdAt: '2026-10-05T01:00:00Z',
            day: '2026-10-05',
            conclusion: 'success',
            agent: 'story_development',
            ticketKey: 'TS-1',
            configFile: 'agents/story_development.json',
            title: 'agents/story_development.json : TS-1 : TS-1',
            durationSeconds: 60,
            duration: '1m 0s',
            requests: 58,
            requestTier: '',
            requestDuration: '',
            readTokens: 722300,
            writeTokens: 17600,
            cachedTokens: 421100,
            reasoningTokens: 0,
            samples: 2,
            resumeDetected: true,
            resumeStages: '',
            feedbackLoopCount: 0,
            rateLimitRetryCount: 0,
            rateLimitDetected: false,
            timeoutCount: 0,
            source: 'reported',
            url: 'https://example.test/run/10'
        }]);
        var attemptsCsv = reporter.buildAttemptsCsv([{
            runId: '1',
            runNumber: 10,
            createdAt: '2026-10-05T01:00:00Z',
            day: '2026-10-05',
            conclusion: 'success',
            durationSeconds: 60,
            duration: '1m 0s',
            agent: 'story_development',
            ticketKey: 'TS-1',
            attemptIndex: 2,
            resumeDetected: true,
            feedbackLoopCount: 0,
            rateLimitRetryCount: 0,
            rateLimitDetected: false,
            timeoutCount: 0,
            requests: 58,
            requestTier: '',
            requestDuration: '',
            readTokens: 722300,
            writeTokens: 17600,
            cachedTokens: 421100,
            reasoningTokens: 0,
            rawTokensLine: 'fa-tokens: {...}',
            source: 'reported',
            url: 'https://example.test/run/10'
        }]);

        assert.contains(aggregateCsv.split('\n')[0], 'source');
        assert.contains(aggregateCsv, 'reported');
        assert.contains(attemptsCsv.split('\n')[0], 'source');
        assert.contains(attemptsCsv, 'reported');
    });

    test('fa-tokens line with trailing content still parses via brace-balanced payload', function() {
        var reporter = loadReporter();
        var parsed = reporter.parseTokensLine('fa-tokens: {"sessionId":"s1","segment":1,"input":100,"output":10,"cacheRead":5,"requests":3,"source":"reported"} (replayed by runner)');

        assert.notEqual(parsed, null);
        assert.equal(parsed.readTokens, 100);
        assert.equal(parsed.faSessionId, 's1');
        assert.equal(parsed.faSegment, 1);
    });

    test('falls through to CommandLineUtils parsing when fa-tokens payload is malformed', function() {
        var reporter = loadReporter();
        var parsed = reporter.parseTokensLine('fa-tokens: {broken json [INFO] CommandLineUtils - Tokens    ↑ 1.2k • ↓ 300');

        assert.notEqual(parsed, null);
        assert.equal(parsed.readTokens, 1200);
        assert.equal(parsed.writeTokens, 300);
    });

    test('fa payloads without segment are not deduped together', function() {
        var reporter = loadReporter();
        var parsed = reporter.parseTokensLine('fa-tokens: {"sessionId":"s1","input":100,"output":10,"cacheRead":5,"requests":3,"source":"reported"}');
        assert.equal(parsed.faSegment, null);

        var usage = reporter.extractTokenUsage([
            'fa-tokens: {"sessionId":"s1","input":100,"output":10,"cacheRead":5,"requests":3,"source":"reported"}',
            'fa-tokens: {"sessionId":"s1","input":200,"output":20,"cacheRead":6,"requests":4,"source":"reported"}'
        ].join('\n'));

        assert.equal(usage.samples, 2);
        assert.equal(usage.readTokens, 300);
        assert.equal(usage.requests, 7);
        assert.equal(usage.source, 'reported');
    });

    test('renders unknown source values with a neutral badge instead of the reported styling', function() {
        var reporter = loadReporter();
        var rows = [
            { createdAt: '2026-10-05T01:00:00Z', agent: 'story_development', ticketKey: 'TS-1', conclusion: 'success', samples: 1, resumeDetected: false, feedbackLoopCount: 0, rateLimitRetryCount: 0, timeoutCount: 0, durationSeconds: 60, duration: '1m 0s', readTokens: 100, writeTokens: 10, cachedTokens: 50, reasoningTokens: 0, source: 'typo-value', runNumber: 10, url: 'https://example.test/run/10' }
        ];
        var summary = reporter.buildSummary(rows.map(function(r) {
            return {
                createdAt: r.createdAt,
                startedAt: r.createdAt,
                updatedAt: r.createdAt,
                day: r.createdAt.substring(0, 10),
                agent: r.agent,
                readTokens: r.readTokens,
                writeTokens: r.writeTokens,
                cachedTokens: r.cachedTokens,
                reasoningTokens: r.reasoningTokens,
                samples: r.samples,
                resumeDetected: r.resumeDetected,
                feedbackLoopCount: 0,
                rateLimitRetryCount: 0,
                rateLimitDetected: false,
                timeoutCount: 0,
                durationSeconds: r.durationSeconds
            };
        }), 1);
        var html = reporter.buildHtml(rows, summary);

        assert.contains(html, 'src-badge src-unknown');
        assert.contains(html, '.src-unknown');
        assert.notContains(html, 'src-badge src-rep');
        assert.notContains(html, 'class="row-est"');
    });

    test('does not merge stale lastRequests metadata into fa-tokens lines', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            'Requests 99 (pro)',
            'fa-tokens: {"sessionId":"s1","segment":1,"input":100,"output":10,"cacheRead":5,"requests":3,"source":"reported"}'
        ].join('\n'));

        assert.equal(usage.requests, 3);
        assert.equal(usage.attempts[0].requestTier, '');

        var usageNoRequests = reporter.extractTokenUsage([
            'Requests 99 (pro)',
            'fa-tokens: {"sessionId":"s2","segment":1,"input":100,"output":10,"cacheRead":5,"source":"reported"}'
        ].join('\n'));

        assert.equal(usageNoRequests.requests, 0);
        assert.equal(usageNoRequests.attempts[0].requestTier, '');
    });

    test('renderOnly renders HTML from an existing token usage JSON', function() {
        var writes = {};
        var reporter = loadReporter({
            file_read: function(args) {
                if (args.path === 'outputs/token_usage/ai_teammate_token_usage.json') {
                    return JSON.stringify({
                        summary: reporter.buildSummary([], 0),
                        rows: []
                    });
                }
                return '';
            },
            file_write: function(args) { writes[args.path] = args.content; }
        });

        var result = reporter.action({
            jobParams: {
                customParams: {
                    workspace: 'IstiN',
                    repository: 'trackstate',
                    outputDir: 'outputs/token_usage',
                    renderOnly: true
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.renderOnly, true);
        assert.equal(result.jsonPath, 'outputs/token_usage/ai_teammate_token_usage.json');
        assert.equal(result.htmlPath, 'outputs/token_usage/ai_teammate_token_usage.html');
        assert.contains(writes['outputs/token_usage/ai_teammate_token_usage.html'], 'Daily Token Trend');
        assert.equal(writes['outputs/token_usage/ai_teammate_token_usage.csv'], undefined);
    });

    test('renderOnly fails when the token usage JSON is missing or invalid', function() {
        var writes = {};
        var reporter = loadReporter({
            file_read: function() { return 'not json {'; },
            file_write: function(args) { writes[args.path] = args.content; }
        });

        var result = reporter.action({
            jobParams: {
                customParams: {
                    workspace: 'IstiN',
                    repository: 'trackstate',
                    outputDir: 'outputs/token_usage',
                    renderOnly: true
                }
            }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'Cannot render HTML: invalid token usage JSON at outputs/token_usage/ai_teammate_token_usage.json');
        assert.equal(writes['outputs/token_usage/ai_teammate_token_usage.html'], undefined);
    });

    test('fails when workspace and repository cannot be resolved', function() {
        var reporter = loadReporter({}, {});

        var result = reporter.action({
            jobParams: {
                customParams: {}
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'customParams.workspace and customParams.repository are required');
    });

    test('continues past a run whose log download fails and caches the error', function() {
        var writes = {};
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function(msg) { warnings.push(String(msg)); };
        var reporter = null;
        try {
            reporter = loadReporter({
                file_read: function() {
                    return JSON.stringify({ version: 1, entries: {} });
                },
                file_write: function(args) { writes[args.path] = args.content; },
                github_list_workflow_runs: function() {
                    return JSON.stringify({ workflow_runs: [
                        { id: 1, status: 'completed', conclusion: 'failure', run_number: 10, created_at: '2026-06-01T00:00:00Z', run_started_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:01:00Z', display_title: 'agents/pr_review.json : TS-1 : TS-1', html_url: 'https://example.test/run/1' }
                    ] });
                },
                github_get_workflow_run_logs: function() {
                    throw new Error('logs exploded');
                }
            });

            var result = reporter.action({
                jobParams: {
                    customParams: {
                        workspace: 'IstiN',
                        repository: 'trackstate',
                        outputDir: 'outputs/token_usage',
                        maxPages: 1
                    }
                }
            });

            assert.equal(result.success, true);
            assert.equal(result.summary.runsWithTokens, 0);
            assert.equal(warnings.length, 1);
            assert.contains(warnings[0], 'failed to process run 1');
            assert.contains(warnings[0], 'logs exploded');
            assert.contains(writes['outputs/token_usage/ai_teammate_token_usage_cache.json'], '"error": "logs exploded"');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('caches noUsage for runs without a token summary', function() {
        var writes = {};
        var logs = [];
        var originalLog = console.log;
        console.log = function(msg) { logs.push(String(msg)); };
        var reporter = null;
        try {
            reporter = loadReporter({
                file_read: function() {
                    return JSON.stringify({ version: 1, entries: {} });
                },
                file_write: function(args) { writes[args.path] = args.content; },
                github_list_workflow_runs: function() {
                    return JSON.stringify({ workflow_runs: [
                        { id: 7, status: 'completed', conclusion: 'success', run_number: 70, created_at: '2026-06-01T00:00:00Z', run_started_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:01:00Z', display_title: 'agents/pr_review.json : TS-7 : TS-7', html_url: 'https://example.test/run/7' }
                    ] });
                },
                github_get_workflow_run_logs: function() {
                    return 'just a plain log line without any token summary';
                }
            });

            var result = reporter.action({
                jobParams: {
                    customParams: {
                        workspace: 'IstiN',
                        repository: 'trackstate',
                        outputDir: 'outputs/token_usage',
                        maxPages: 1,
                        verbose: true
                    }
                }
            });

            assert.equal(result.success, true);
            assert.equal(result.summary.runsWithTokens, 0);
            assert.contains(writes['outputs/token_usage/ai_teammate_token_usage_cache.json'], '"noUsage": true');
            assert.contains(logs.join('\n'), 'no token summary found');
        } finally {
            console.log = originalLog;
        }
    });

    test('maxLogDownloads stops downloading mid-loop but keeps cached rows', function() {
        var logDownloads = [];
        var reporter = loadReporter({
            file_read: function() {
                return JSON.stringify({ version: 1, entries: {
                    '1': { noUsage: true }
                } });
            },
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [
                    { id: 1, status: 'completed', conclusion: 'success', run_number: 10, created_at: '2026-06-01T00:00:00Z', run_started_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:01:00Z', display_title: 'agents/pr_review.json : TS-1 : TS-1', html_url: 'https://example.test/run/1' },
                    { id: 2, status: 'completed', conclusion: 'success', run_number: 11, created_at: '2026-06-01T00:02:00Z', run_started_at: '2026-06-01T00:02:00Z', updated_at: '2026-06-01T00:03:00Z', display_title: 'agents/pr_rework.json : TS-2 : TS-2', html_url: 'https://example.test/run/2' },
                    { id: 3, status: 'completed', conclusion: 'success', run_number: 12, created_at: '2026-06-01T00:04:00Z', run_started_at: '2026-06-01T00:04:00Z', updated_at: '2026-06-01T00:05:00Z', display_title: 'agents/pr_rework.json : TS-3 : TS-3', html_url: 'https://example.test/run/3' }
                ] });
            },
            github_get_workflow_run_logs: function(args) {
                logDownloads.push(args.runId);
                return '[INFO] CommandLineUtils - Tokens    ↑ 2k • ↓ 20 • 1k (cached) • 3 (reasoning)';
            }
        });

        var result = reporter.action({
            jobParams: {
                customParams: {
                    workspace: 'IstiN',
                    repository: 'trackstate',
                    outputDir: 'outputs/token_usage',
                    maxPages: 1,
                    maxLogDownloads: 1
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(logDownloads.length, 1);
        assert.equal(result.summary.cache.logDownloads, 1);
        assert.equal(result.summary.cache.stoppedByDownloadLimit, true);
        assert.equal(result.summary.cache.hits, 1);
        assert.equal(result.summary.runsWithTokens, 1);
    });

    test('useCache false never reads or writes the usage cache', function() {
        var cacheReads = 0;
        var cacheWrites = 0;
        var reporter = loadReporter({
            file_read: function(args) {
                if (args.path === 'outputs/token_usage/ai_teammate_token_usage_cache.json') cacheReads += 1;
                return '';
            },
            file_write: function(args) {
                if (args.path === 'outputs/token_usage/ai_teammate_token_usage_cache.json') cacheWrites += 1;
            },
            github_list_workflow_runs: function() {
                return JSON.stringify({ workflow_runs: [
                    { id: 2, status: 'completed', conclusion: 'success', run_number: 11, created_at: '2026-06-01T00:02:00Z', run_started_at: '2026-06-01T00:02:00Z', updated_at: '2026-06-01T00:03:00Z', display_title: 'agents/pr_rework.json : TS-2 : TS-2', html_url: 'https://example.test/run/2' }
                ] });
            },
            github_get_workflow_run_logs: function() {
                return '[INFO] CommandLineUtils - Tokens    ↑ 2k • ↓ 20 • 1k (cached) • 3 (reasoning)';
            }
        });

        var result = reporter.action({
            jobParams: {
                customParams: {
                    workspace: 'IstiN',
                    repository: 'trackstate',
                    outputDir: 'outputs/token_usage',
                    maxPages: 1,
                    useCache: false
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(cacheReads, 0);
        assert.equal(cacheWrites, 0);
        assert.equal(result.summary.cache.enabled, false);
        assert.equal(result.summary.cache.path, '');
        assert.equal(result.summary.runsWithTokens, 1);
    });
});

suite('aiTeammateTokenUsageReporter action helpers', function() {

    test('firstDefined returns first truthy value or the fallback', function() {
        var reporter = loadReporter();

        assert.equal(reporter.firstDefined('a', 'b', 'x'), 'a');
        assert.equal(reporter.firstDefined('', 'b', 'x'), 'b');
        assert.equal(reporter.firstDefined(0, null, undefined, 'x'), 'x');
        assert.equal(reporter.firstDefined('', 'x'), 'x');
    });

    test('resolveRepository resolves aliases and placeholder fallbacks', function() {
        var reporter = loadReporter();

        var custom = reporter.resolveRepository(
            { owner: 'octo', repo: 'hello' },
            { repository: { owner: 'cfg-owner', repo: 'cfg-repo' } }
        );
        assert.equal(custom.workspace, 'octo');
        assert.equal(custom.repository, 'hello');
        assert.equal(custom.workflowId, 'ai-teammate.yml');

        var fromConfig = reporter.resolveRepository(
            { workspace: '{workspace}', repository: '{repository}' },
            { repository: { owner: 'cfg-owner', repo: 'cfg-repo' } }
        );
        assert.equal(fromConfig.workspace, 'cfg-owner');
        assert.equal(fromConfig.repository, 'cfg-repo');

        var keepsWorkflow = reporter.resolveRepository(
            { workspace: 'w', repository: 'r', workflowId: 'custom.yml' },
            {}
        );
        assert.equal(keepsWorkflow.workflowId, 'custom.yml');
    });

    test('resolveOutputPaths applies defaults and explicit overrides', function() {
        var reporter = loadReporter();

        var defaults = reporter.resolveOutputPaths({});
        assert.equal(defaults.outputDir, 'outputs/token_usage');
        assert.equal(defaults.csvPath, 'outputs/token_usage/ai_teammate_token_usage.csv');
        assert.equal(defaults.attemptsCsvPath, 'outputs/token_usage/ai_teammate_token_usage_attempts.csv');
        assert.equal(defaults.jsonPath, 'outputs/token_usage/ai_teammate_token_usage.json');
        assert.equal(defaults.htmlPath, 'outputs/token_usage/ai_teammate_token_usage.html');
        assert.equal(defaults.cachePath, 'outputs/token_usage/ai_teammate_token_usage_cache.json');

        var overrides = reporter.resolveOutputPaths({
            outputDir: 'out/dir',
            csvPath: 'custom.csv',
            cachePath: 'custom-cache.json'
        });
        assert.equal(overrides.outputDir, 'out/dir');
        assert.equal(overrides.csvPath, 'custom.csv');
        assert.equal(overrides.jsonPath, 'out/dir/ai_teammate_token_usage.json');
        assert.equal(overrides.cachePath, 'custom-cache.json');
    });

    test('parseCacheOptions normalizes cache-related customParams', function() {
        var reporter = loadReporter();

        var defaults = reporter.parseCacheOptions({});
        assert.equal(defaults.useCache, true);
        assert.equal(defaults.cacheWriteEvery, 25);
        assert.equal(defaults.logDownloadSleepMs, 0);
        assert.equal(defaults.maxLogDownloads, null);

        assert.equal(reporter.parseCacheOptions({ useCache: false }).useCache, false);
        assert.equal(reporter.parseCacheOptions({ useCache: 'false' }).useCache, false);
        assert.equal(reporter.parseCacheOptions({ cacheWriteEvery: '0' }).cacheWriteEvery, 25);
        assert.equal(reporter.parseCacheOptions({ cacheWriteEvery: '10' }).cacheWriteEvery, 10);
        assert.equal(reporter.parseCacheOptions({ logDownloadSleepMs: '250' }).logDownloadSleepMs, 250);

        assert.equal(reporter.parseMaxLogDownloads({}), null);
        assert.equal(reporter.parseMaxLogDownloads({ maxLogDownloads: '' }), null);
        assert.equal(reporter.parseMaxLogDownloads({ maxLogDownloads: '5' }), 5);
        assert.equal(reporter.parseMaxLogDownloads({ maxLogDownloads: 'abc' }), 0);
        assert.equal(reporter.parseMaxLogDownloads({ maxLogDownloads: '-3' }), 0);
    });

    test('shouldLogRunProgress logs first, last and every logEvery-th run', function() {
        var reporter = loadReporter();

        assert.equal(reporter.shouldLogRunProgress(false, 0, 10, 50), true);
        assert.equal(reporter.shouldLogRunProgress(false, 9, 10, 50), true);
        assert.equal(reporter.shouldLogRunProgress(false, 49, 100, 50), true);
        assert.equal(reporter.shouldLogRunProgress(false, 1, 100, 50), false);
        assert.equal(reporter.shouldLogRunProgress(true, 3, 100, 50), true);
    });

    test('getCachedRunState classifies row, noUsage and error entries', function() {
        var reporter = loadReporter();
        var cache = {
            version: 1,
            entries: {
                '1': { row: { runId: '1' }, attemptRows: [{ attemptIndex: 1 }] },
                '2': { noUsage: true },
                '3': { error: 'boom' }
            }
        };

        var rowState = reporter.getCachedRunState(cache, '1', true);
        assert.equal(rowState.kind, 'row');
        assert.equal(rowState.row.runId, '1');
        assert.equal(rowState.attemptRows.length, 1);

        assert.equal(reporter.getCachedRunState(cache, '2', true).kind, 'noUsage');
        assert.equal(reporter.getCachedRunState(cache, '3', true), null);
        assert.equal(reporter.getCachedRunState(cache, '4', true), null);
        assert.equal(reporter.getCachedRunState(cache, '1', false), null);
    });

    test('applyCachedRunState pushes cached rows and counts hits', function() {
        var reporter = loadReporter();
        var state = { rows: [], attemptRows: [], cacheHits: 0, verbose: false };

        assert.equal(reporter.applyCachedRunState(state, null), false);
        assert.equal(state.cacheHits, 0);

        assert.equal(reporter.applyCachedRunState(state, { kind: 'row', row: { runId: '1' }, attemptRows: [{ a: 1 }] }), true);
        assert.equal(state.rows.length, 1);
        assert.equal(state.attemptRows.length, 1);
        assert.equal(state.cacheHits, 1);

        assert.equal(reporter.applyCachedRunState(state, { kind: 'noUsage' }), true);
        assert.equal(state.rows.length, 1);
        assert.equal(state.cacheHits, 2);
    });

    test('buildUsageRow maps run, meta and usage into the aggregate row shape', function() {
        var reporter = loadReporter();
        var run = {
            id: 42,
            run_number: 7,
            created_at: '2026-06-01T00:00:00Z',
            run_started_at: '2026-06-01T00:00:30Z',
            updated_at: '2026-06-01T00:10:00Z',
            conclusion: 'success',
            html_url: 'https://example.test/run/42'
        };
        var meta = { title: 'agents/x.json : TS-1 : TS-1', configFile: 'agents/x.json', agent: 'x', ticketKey: 'TS-1' };
        var usage = {
            requests: 3,
            requestTier: 'Premium',
            requestDuration: '27m 2s',
            readTokens: 100,
            writeTokens: 10,
            cachedTokens: 50,
            reasoningTokens: 5,
            samples: 2,
            resumeDetected: true,
            resumeStages: ['stage 1/2'],
            feedbackLoopCount: 1,
            rateLimitRetryCount: 2,
            rateLimitDetected: true,
            timeoutCount: 1,
            source: 'reported'
        };

        var row = reporter.buildUsageRow(run, meta, 570, '9m 30s', usage);

        assert.equal(row.runId, '42');
        assert.equal(row.runNumber, 7);
        assert.equal(row.createdAt, '2026-06-01T00:00:00Z');
        assert.equal(row.startedAt, '2026-06-01T00:00:30Z');
        assert.equal(row.updatedAt, '2026-06-01T00:10:00Z');
        assert.equal(row.day, '2026-06-01');
        assert.equal(row.conclusion, 'success');
        assert.equal(row.agent, 'x');
        assert.equal(row.ticketKey, 'TS-1');
        assert.equal(row.durationSeconds, 570);
        assert.equal(row.duration, '9m 30s');
        assert.equal(row.requests, 3);
        assert.equal(row.requestTier, 'Premium');
        assert.equal(row.samples, 2);
        assert.equal(row.resumeDetected, true);
        assert.equal(row.resumeStages, 'stage 1/2');
        assert.equal(row.rateLimitDetected, true);
        assert.equal(row.source, 'reported');
        assert.equal(row.url, 'https://example.test/run/42');

        var camelRun = { databaseId: 43, runNumber: 8, createdAt: '2026-06-02T00:00:00Z', runStartedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:01:00Z', htmlUrl: 'https://example.test/run/43' };
        var camelRow = reporter.buildUsageRow(camelRun, meta, 60, '1m 0s', usage);
        assert.equal(camelRow.runId, '43');
        assert.equal(camelRow.runNumber, 8);
        assert.equal(camelRow.day, '2026-06-02');
        assert.equal(camelRow.url, 'https://example.test/run/43');
    });

    test('buildAttemptRow maps an attempt sample with run metadata', function() {
        var reporter = loadReporter();
        var run = {
            id: 42,
            run_number: 7,
            created_at: '2026-06-01T00:00:00Z',
            conclusion: 'success',
            html_url: 'https://example.test/run/42'
        };
        var meta = { title: 'agents/x.json : TS-1 : TS-1', configFile: 'agents/x.json', agent: 'x', ticketKey: 'TS-1' };
        var usage = {
            resumeDetected: false,
            feedbackLoopCount: 0,
            rateLimitRetryCount: 0,
            rateLimitDetected: false,
            timeoutCount: 0
        };
        var attempt = {
            attemptIndex: 2,
            requests: 3,
            requestTier: 'Premium',
            requestDuration: '27m 2s',
            readTokens: 100,
            writeTokens: 10,
            cachedTokens: 50,
            reasoningTokens: 5,
            rawTokensLine: 'Tokens ↑ 100',
            source: 'reported'
        };

        var row = reporter.buildAttemptRow(run, meta, 570, '9m 30s', usage, attempt);

        assert.equal(row.runId, '42');
        assert.equal(row.runNumber, 7);
        assert.equal(row.day, '2026-06-01');
        assert.equal(row.agent, 'x');
        assert.equal(row.attemptIndex, 2);
        assert.equal(row.resumeDetected, false);
        assert.equal(row.requests, 3);
        assert.equal(row.rawTokensLine, 'Tokens ↑ 100');
        assert.equal(row.source, 'reported');
        assert.equal(row.url, 'https://example.test/run/42');
    });

    test('buildCacheSummaryInfo reflects useCache on/off', function() {
        var reporter = loadReporter();
        var state = {
            cacheHits: 2,
            downloadedLogs: 3,
            stoppedByDownloadLimit: true
        };

        var enabled = reporter.buildCacheSummaryInfo(
            { useCache: true, maxLogDownloads: 5, logDownloadSleepMs: 100 },
            { cachePath: 'cache.json' },
            state
        );
        assert.equal(enabled.enabled, true);
        assert.equal(enabled.path, 'cache.json');
        assert.equal(enabled.hits, 2);
        assert.equal(enabled.logDownloads, 3);
        assert.equal(enabled.maxLogDownloads, 5);
        assert.equal(enabled.stoppedByDownloadLimit, true);
        assert.equal(enabled.logDownloadSleepMs, 100);

        var disabled = reporter.buildCacheSummaryInfo(
            { useCache: false, maxLogDownloads: null, logDownloadSleepMs: 0 },
            { cachePath: 'cache.json' },
            state
        );
        assert.equal(disabled.enabled, false);
        assert.equal(disabled.path, '');
        assert.equal(disabled.maxLogDownloads, null);
    });
});

// ── gh-1108 — run-title anchor + leg (one vocabulary with the dedup module) ──

suite('aiTeammateTokenUsageReporter parseRunAnchor (gh-1108)', function() {

    test('stub title with a PR anchor keys pr-N and keeps the leg', function() {
        var reporter = loadReporter();
        var a = reporter.parseRunAnchor('teammate: workflow_dispatch #1040 · pr-1123 review');
        assert.equal(a.key, 'pr-1123');
        assert.equal(a.pr, 1123);
        assert.equal(a.issue, 1040);
        assert.equal(a.leg, 'review');
    });

    test('issue-only stub title keys issue-N', function() {
        var reporter = loadReporter();
        var a = reporter.parseRunAnchor('teammate: workflow_dispatch #1040 dev');
        assert.equal(a.key, 'issue-1040');
        assert.equal(a.pr, null);
        assert.equal(a.issue, 1040);
        assert.equal(a.leg, 'dev');
    });

    test('bare event-path title keys issue-N with an unknown leg', function() {
        var reporter = loadReporter();
        var a = reporter.parseRunAnchor('teammate: assigned #1040');
        assert.equal(a.key, 'issue-1040');
        assert.equal(a.leg, '');
    });

    test('factory SM title family keys issue-N via the gh-<n> anchor', function() {
        var reporter = loadReporter();
        var a = reporter.parseRunAnchor('▶ review (SM) · gh-1040');
        assert.equal(a.key, 'issue-1040');
        assert.equal(a.leg, 'review');
    });

    test('template emoji title family keys issue-N via the gh-<n> anchor', function() {
        var reporter = loadReporter();
        var a = reporter.parseRunAnchor('⚒️ dev · gh-1041');
        assert.equal(a.key, 'issue-1041');
        assert.equal(a.leg, 'dev');
    });

    test('trailing-digit guard: #1040 is never #104, pr-1123 never pr-112', function() {
        var reporter = loadReporter();
        assert.equal(reporter.parseRunAnchor('teammate: assigned #1040').issue, 1040);
        assert.equal(reporter.parseRunAnchor('· pr-1123 review').pr, 1123);
    });

    test('PR anchor wins when a title carries both anchors', function() {
        var reporter = loadReporter();
        var a = reporter.parseRunAnchor('teammate: workflow_dispatch #1040 · pr-1123 rework');
        assert.equal(a.key, 'pr-1123', 'the PR is the finer anchor');
        assert.equal(a.leg, 'rework');
    });

    test('unresolvable title (Jira-key family) yields a null key — never a wrong key', function() {
        var reporter = loadReporter();
        var a = reporter.parseRunAnchor('agents/bug_development.json : TS-1307 : bug_development');
        assert.equal(a.key, null);
        assert.equal(a.pr, null);
        assert.equal(a.issue, null);
    });

    test('empty / absent title yields a null key', function() {
        var reporter = loadReporter();
        assert.equal(reporter.parseRunAnchor('').key, null);
        assert.equal(reporter.parseRunAnchor(null).key, null);
    });
});

// ── gh-1108 — the keyed tokens projection (UT-prod-1/2) ──────────────────────

suite('aiTeammateTokenUsageReporter buildTokensMap (gh-1108 UT-prod)', function() {

    function row(over) {
        return Object.assign({
            runId: '1', createdAt: '2026-10-13T10:00:00Z',
            agent: 'story_development', ticketKey: '',
            title: 'teammate: workflow_dispatch #1040 dev',
            readTokens: 1000, writeTokens: 500, cachedTokens: 900
        }, over || {});
    }

    test('maps runs to pr-N rows; a multi-row key keeps every leg (2+ items)', function() {
        var reporter = loadReporter();
        var map = reporter.buildTokensMap([
            row({ title: 'teammate: workflow_dispatch #1040 · pr-1123 review',
                  agent: 'pr_review', createdAt: '2026-10-13T09:00:00Z',
                  readTokens: 2000, writeTokens: 300, cachedTokens: 1500 }),
            row({ title: 'teammate: workflow_dispatch #1040 · pr-1123 rework',
                  agent: 'pr_rework', createdAt: '2026-10-13T11:00:00Z',
                  readTokens: 3000, writeTokens: 700, cachedTokens: 2500 }),
            row()
        ]);
        assert.equal(map['pr-1123'].length, 2, 'both PR legs ride the same key');
        assert.equal(map['issue-1040'].length, 1);
    });

    test('row shape is the printf contract the tick normalizes', function() {
        var reporter = loadReporter();
        var map = reporter.buildTokensMap([row({
            title: 'teammate: workflow_dispatch #1040 · pr-1123 review',
            agent: 'pr_review', createdAt: '2026-10-13T09:00:00Z',
            readTokens: 2000, writeTokens: 300, cachedTokens: 1500 })]);
        assert.deepEqual(map['pr-1123'], [{
            leg: 'review', at: '2026-10-13T09:00:00Z',
            prompt: 2000, completion: 300, total: 2300,
            cacheRead: 1500, model: ''
        }]);
    });

    test('unresolvable run yields NO row (never a wrong key)', function() {
        var reporter = loadReporter();
        var map = reporter.buildTokensMap([
            row({ title: 'agents/bug_development.json : TS-1307 : bug_development',
                  readTokens: 999999, writeTokens: 999999 }),
            row({ title: '', agent: '' })
        ]);
        assert.deepEqual(map, {}, 'an unanchorable run is dropped, not mis-keyed');
    });

    test('agent basename recovers the leg when the title carries none', function() {
        var reporter = loadReporter();
        var map = reporter.buildTokensMap([
            row({ title: 'teammate: assigned #1040', agent: 'pr_rework' }),
            row({ title: 'teammate: assigned #1041', agent: 'story_development' }),
            row({ title: 'teammate: assigned #1042', agent: 'pr_review' })
        ]);
        assert.equal(map['issue-1040'][0].leg, 'rework');
        assert.equal(map['issue-1041'][0].leg, 'dev');
        assert.equal(map['issue-1042'][0].leg, 'review');
    });

    test('rows sort by at ascending inside a key', function() {
        var reporter = loadReporter();
        var map = reporter.buildTokensMap([
            row({ runId: '2', createdAt: '2026-10-13T11:00:00Z' }),
            row({ runId: '1', createdAt: '2026-10-13T09:00:00Z' })
        ]);
        assert.equal(map['issue-1040'][0].at, '2026-10-13T09:00:00Z');
        assert.equal(map['issue-1040'][1].at, '2026-10-13T11:00:00Z');
    });

    test('retention: rows older than the window drop, keep-per-key caps the tail', function() {
        var reporter = loadReporter();
        var rows = [];
        for (var i = 1; i <= 5; i++) {
            rows.push(row({ runId: String(i), agent: 'pr_review',
                title: 'teammate: workflow_dispatch #1040 · pr-1123 review',
                createdAt: '2026-10-' + (10 + i) + 'T10:00:00Z' }));
        }
        rows.push(row({ runId: '9', createdAt: '2026-09-01T10:00:00Z' })); // stale
        var map = reporter.buildTokensMap(rows, { now: '2026-10-16T10:00:00Z',
            windowDays: 14, keepPerKey: 3 });
        assert.equal(map['pr-1123'].length, 3, 'capped to the newest 3');
        assert.equal(map['pr-1123'][0].at, '2026-10-13T10:00:00Z');
        assert.equal(map['pr-1123'][2].at, '2026-10-15T10:00:00Z');
    });

    test('rows outside the 14d window are dropped entirely', function() {
        var reporter = loadReporter();
        var map = reporter.buildTokensMap(
            [row({ createdAt: '2026-09-01T10:00:00Z' })],
            { now: '2026-10-16T10:00:00Z', windowDays: 14, keepPerKey: 40 });
        assert.deepEqual(map, {});
    });

    test('numbers only: the serialized map carries no log text and no URLs', function() {
        var reporter = loadReporter();
        var json = JSON.stringify(reporter.buildTokensMap([
            row({ url: 'https://example.test/run/1' })
        ]));
        assert.notContains(json, 'http', 'no URLs beyond the state snapshot');
        assert.notContains(json, 'rawTokensLine', 'no raw log excerpts');
        assert.notContains(json, 'resumeStages', 'no log metadata');
    });

    test('empty / null rows produce an empty map', function() {
        var reporter = loadReporter();
        assert.deepEqual(reporter.buildTokensMap([]), {});
        assert.deepEqual(reporter.buildTokensMap(null), {});
    });
});

// ── gh-1108 — the publish step (IT-pub-1): keyed map → factory-data branch ───

suite('aiTeammateTokenUsageReporter publishTokensMap (gh-1108 IT-pub-1)', function() {

    var MAP = { 'pr-31': [{ leg: 'review', at: '2026-10-13T09:00:00Z',
        prompt: 2000, completion: 300, total: 2300, cacheRead: 1500, model: '' }] };

    function stubGhPut(state, map) {
        state.puts += 1;
        if (state.puts <= (map.failPuts || 0)) {
            state.failed += 1;
            throw new Error('gh: 409 sha was not supplied');
        }
        return { output: '' };
    }

    function stubGhSha(map) {
        if (map.sha == null) throw new Error('gh: Not Found (404)');
        return { output: map.sha };
    }

    function stubGhBody(map) {
        if (map.body == null) throw new Error('gh: Not Found (404)');
        return { output: map.body };
    }

    function stubGhCommand(state, map, cmd) {
        if (cmd.indexOf('-X PUT') !== -1) return stubGhPut(state, map);
        if (cmd.indexOf('--jq .sha') !== -1) return stubGhSha(map);
        if (cmd.indexOf('base64 -d') !== -1) return stubGhBody(map);
        return { output: '' }; // bootstrap ref POST
    }

    function publishExec(map) {
        // map: { sha: '…', body: '…', failPuts: N } — failPuts PUTs throw
        // before succeeding, mirroring the Contents API 409 dance between
        // concurrent publishers.
        var state = { commands: [], puts: 0, failed: 0 };
        return {
            state: state,
            exec: function (args) {
                var cmd = String((args && args.command) || args || '');
                state.commands.push(cmd);
                return stubGhCommand(state, map, cmd);
            }
        };
    }

    function embeddedJson(putCommand) {
        var marker = "printf %s '";
        var start = putCommand.indexOf(marker);
        var end = putCommand.indexOf("' | base64", start);
        return JSON.parse(putCommand.substring(start + marker.length, end));
    }

    test('first publish: bootstraps the branch, PUTs the keyed JSON at the exact asset path', function() {
        var reporter = loadReporter();
        var stub = publishExec({});
        var res = reporter.publishTokensMap(MAP, { repo: 'o/r', asset: 'agents-tokens.json' },
            { exec: stub.exec, log: function () {} });
        assert.equal(res.status, 'published');
        assert.equal(res.path, 'data/agents-tokens.json');
        var put = stub.state.commands.filter(function (c) { return c.indexOf('-X PUT') !== -1; })[0];
        assert.ok(put.indexOf('repos/o/r/contents/data/agents-tokens.json ') !== -1,
            'PUT hits data/agents-tokens.json');
        assert.contains(put, '-f branch=factory-data');
        assert.deepEqual(embeddedJson(put), MAP, 'the branch file IS the keyed map');
        var boot = stub.state.commands[0];
        assert.contains(boot, 'git/refs -f ref=refs/heads/factory-data', 'branch bootstrap first');
    });

    test('update: the existing-file sha rides the PUT', function() {
        var reporter = loadReporter();
        var stub = publishExec({ sha: 'abc123' });
        var res = reporter.publishTokensMap(MAP, { repo: 'o/r', asset: 'agents-tokens.json' },
            { exec: stub.exec, log: function () {} });
        assert.equal(res.status, 'published');
        var put = stub.state.commands.filter(function (c) { return c.indexOf('-X PUT') !== -1; })[0];
        assert.contains(put, "-f sha='abc123'");
    });

    test('PUT conflict refetches and retries; exhaustion gives up without throwing', function() {
        var reporter = loadReporter();
        var retry = publishExec({ failPuts: 1 });
        var ok = reporter.publishTokensMap(MAP, { repo: 'o/r', asset: 'agents-tokens.json' },
            { exec: retry.exec, log: function () {} });
        assert.equal(ok.status, 'published');
        assert.equal(ok.attempts, 2);

        var dead = publishExec({ failPuts: 99 });
        var gaveUp = reporter.publishTokensMap(MAP, { repo: 'o/r', asset: 'agents-tokens.json' },
            { exec: dead.exec, log: function () {} });
        assert.equal(gaveUp.status, 'gave-up');
        assert.equal(gaveUp.attempts, 3, 'default 3 attempts, then honest surrender');
    });

    test('empty map skips with ZERO gh traffic (never erase the previous file)', function() {
        var reporter = loadReporter();
        var stub = publishExec({});
        var res = reporter.publishTokensMap({}, { repo: 'o/r', asset: 'agents-tokens.json' },
            { exec: stub.exec, log: function () {} });
        assert.equal(res.status, 'skipped');
        assert.equal(res.reason, 'no-rows');
        assert.equal(stub.state.commands.length, 0);
    });

    test('asset defaults to <repoName>-tokens.json (fetchPreviousState derivation)', function() {
        var reporter = loadReporter();
        var stub = publishExec({});
        var res = reporter.publishTokensMap(MAP, { repo: 'o/coolwidgets' },
            { exec: stub.exec, log: function () {} });
        assert.equal(res.path, 'data/coolwidgets-tokens.json');
    });

    test('missing repo skips — nothing to publish against', function() {
        var reporter = loadReporter();
        var stub = publishExec({});
        var res = reporter.publishTokensMap(MAP, {}, { exec: stub.exec, log: function () {} });
        assert.equal(res.status, 'skipped');
        assert.equal(stub.state.commands.length, 0);
    });

    test('AC1: the published map fed to buildFactoryState lands on cards in the normTokenRow contract shape', function() {
        var machineAuthorModule = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
        var reworkLatchModule = loadModule('js/common/reworkLatch.js', makeRequire({}), {});
        var fsModule = loadModule('js/factoryState.js',
            makeRequire({
                './common/machineAuthor.js': machineAuthorModule,
                './common/reworkLatch.js': reworkLatchModule
            }), {});
        var reporter = loadReporter();
        function row2(title, agent, at, read, write, cached) {
            return { runId: '1', createdAt: at, agent: agent, title: title,
                readTokens: read, writeTokens: write, cachedTokens: cached };
        }
        var map = reporter.buildTokensMap([
            row2('teammate: workflow_dispatch #1040 · pr-31 review', 'pr_review',
                '2026-10-13T09:00:00Z', 2000, 300, 1500)
        ]);
        var st = fsModule.buildFactoryState({
            repoInfo: { owner: 'o', repo: 'r' }, now: '2026-10-13T13:10:00Z',
            prs: [{ number: 31, title: 't', labels: [],
                head: { ref: 'b', sha: 's' }, user: { login: 'bot' },
                created_at: '2026-10-13T06:00:00Z' }],
            runs: [], tokens: map
        });
        var tokens = st.lanes.pr_created[0].tokens;
        assert.equal(tokens.length, 1);
        assert.deepEqual(Object.keys(tokens[0]).sort(),
            ['at', 'cacheRead', 'completion', 'leg', 'model', 'prompt', 'total'],
            'exactly the normTokenRow contract, nothing more');
        assert.equal(tokens[0].prompt, 2000);
        assert.equal(tokens[0].completion, 300);
        assert.equal(tokens[0].total, 2300);
        assert.equal(tokens[0].cacheRead, 1500);
        assert.equal(tokens[0].model, null, 'logs carry no model id — honest unknown');
    });
});

// ── gh-1108 — deployment wiring (AC3): asset isolation is a CONFIG fact ──────

suite('gh-1108 deployment wiring (AC3)', function() {

    test('machine-sm.yml statePublish carries tokensAsset agents-tokens.json, never fa-tokens.json', function() {
        var yml = file_read({ path: '.github/workflows/machine-sm.yml' });
        assert.ok(yml, 'machine-sm.yml readable');
        var m = /state-publish:\s*'([^']+)'/.exec(yml);
        assert.ok(m, 'state-publish payload present');
        var cfg = JSON.parse(m[1]);
        assert.equal(cfg.tokensAsset, 'agents-tokens.json',
            'the agents tick resolves ITS asset — asset isolation (AC3)');
        assert.notContains(yml, 'fa-tokens.json',
            'data/fa-tokens.json is never consulted by this deployment');
    });

    test('the producer config publishes the same asset', function() {
        var cfg = JSON.parse(file_read({ path: 'ai_teammate_token_usage_reporter.json' }));
        var custom = cfg.params.jobParams.customParams;
        assert.equal(custom.tokensAsset, 'agents-tokens.json',
            'producer and tick must agree on the asset name');
        assert.equal(custom.publishTokens, true, 'publish path is wired on');
    });
});

suite('gh-1108 action wiring — publish rides the scan', function() {

    test('action publishes the keyed map when publishTokens is set', function() {
        var writes = [];
        var execCalls = [];
        var reporter = loadReporter({
            file_write: function (o) { writes.push(o); },
            github_list_workflow_runs: function () {
                return JSON.stringify({ total_count: 1, workflow_runs: [{
                    id: 77, status: 'completed', conclusion: 'success',
                    created_at: '2026-10-13T09:00:00Z',
                    run_started_at: '2026-10-13T09:00:00Z',
                    updated_at: '2026-10-13T10:00:00Z',
                    display_title: 'teammate: workflow_dispatch #1040 · pr-1123 review',
                    html_url: 'https://example.test/run/77', run_number: 5
                }] });
            },
            github_get_workflow_run_logs: function () {
                return 'fa-tokens: {"sessionId":"s","segment":1,"input":200,"output":300,"cacheRead":150,"source":"reported"}';
            },
            cli_execute_command: function (args) {
                var cmd = String((args && args.command) || '');
                execCalls.push(cmd);
                if (cmd.indexOf('-X PUT') !== -1) return { output: '' };
                if (cmd.indexOf('--jq .sha') !== -1) throw new Error('gh: Not Found (404)');
                return { output: '' };
            }
        });
        var res = reporter.action({ jobParams: { customParams: {
            workspace: 'o', repository: 'r',
            publishTokens: true, tokensAsset: 'agents-tokens.json',
            tokensNow: '2026-10-16T10:00:00Z'
        } } });
        assert.equal(res.success, true);
        assert.ok(res.tokens, 'publish summary rides the action result');
        assert.equal(res.tokens.status, 'published');
        assert.equal(res.tokens.path, 'data/agents-tokens.json');
        assert.equal(res.tokens.rowCount, 1);
        var keyed = writes.filter(function (w) {
            return w.path === 'outputs/token_usage/agents-tokens.json';
        })[0];
        assert.ok(keyed, 'local keyed copy written next to the reports');
        var map = JSON.parse(keyed.content);
        assert.ok(map['pr-1123'] && map['pr-1123'][0].prompt === 200 &&
            map['pr-1123'][0].cacheRead === 150, 'keyed rows carry the run usage');
        assert.ok(execCalls.some(function (c) {
            return c.indexOf('data/agents-tokens.json') !== -1 && c.indexOf('-X PUT') !== -1;
        }), 'the branch PUT hits the exact asset path');
    });

    test('action skips the publish entirely when publishTokens is unset', function() {
        var execCalls = [];
        var reporter = loadReporter({
            cli_execute_command: function (args) {
                execCalls.push(String((args && args.command) || ''));
                return { output: '' };
            }
        });
        var res = reporter.action({ jobParams: { customParams: {
            cacheOnly: true, repository: 'o/r'
        } } });
        assert.equal(res.success, true);
        assert.equal(res.tokens, undefined, 'no tokens key when the knob is off');
        assert.equal(execCalls.length, 0, 'zero gh traffic without the knob');
    });
});

suite('gh-1108 publish hardening — decorative by contract', function() {

    test('no exec transport skips without throwing', function() {
        var reporter = loadReporter();
        var res = reporter.publishTokensMap(
            { 'pr-31': [{ leg: 'dev', at: 't', prompt: 1, completion: 2,
                total: 3, cacheRead: 0, model: '' }] },
            { repo: 'o/r', asset: 'agents-tokens.json' },
            { exec: null, log: function () {} });
        assert.equal(res.status, 'skipped');
        assert.equal(res.reason, 'no-exec');
    });

    test('a failing local keyed copy never blocks the branch publish', function() {
        var execCalls = [];
        var reporter = loadReporter({
            file_write: function () { throw new Error('disk full'); },
            cli_execute_command: function (args) {
                var cmd = String((args && args.command) || '');
                execCalls.push(cmd);
                if (cmd.indexOf('-X PUT') !== -1) return { output: '' };
                if (cmd.indexOf('--jq .sha') !== -1) throw new Error('gh: Not Found (404)');
                return { output: '' };
            }
        });
        var res = reporter.publishKeyedTokens(
            { publishTokens: true, workspace: 'o', repository: 'r',
              tokensAsset: 'agents-tokens.json' },
            { outputDir: 'outputs/token_usage' },
            [{ runId: '1', createdAt: '2026-10-13T09:00:00Z', agent: 'pr_review',
               title: 'teammate: workflow_dispatch #1040 · pr-1123 review',
               readTokens: 10, writeTokens: 20, cachedTokens: 5 }]);
        assert.ok(res, 'publish summary returned');
        assert.equal(res.status, 'published');
        assert.ok(execCalls.some(function (c) {
            return c.indexOf('-X PUT') !== -1;
        }), 'the branch publish still ran');
    });
});

suite('gh-1108 asset default — the derivation path', function() {

    test('publishKeyedTokens derives <repoName>-tokens.json when the knob is omitted', function() {
        var writes = [];
        var reporter = loadReporter({
            file_write: function (o) { writes.push(o); },
            cli_execute_command: function (args) {
                var cmd = String((args && args.command) || '');
                if (cmd.indexOf('-X PUT') !== -1) return { output: '' };
                if (cmd.indexOf('--jq .sha') !== -1) throw new Error('gh: Not Found (404)');
                return { output: '' };
            }
        });
        var res = reporter.publishKeyedTokens(
            { publishTokens: true, workspace: 'o', repository: 'coolwidgets' },
            { outputDir: 'outputs/token_usage' },
            [{ runId: '1', createdAt: '2026-10-13T09:00:00Z', agent: 'pr_review',
               title: 'teammate: workflow_dispatch #1040 · pr-31 review',
               readTokens: 10, writeTokens: 20, cachedTokens: 5 }]);
        assert.equal(res.status, 'published');
        assert.equal(res.asset, 'coolwidgets-tokens.json',
            'fetchPreviousState-style derivation, not a fixed cross-factory asset');
        assert.ok(writes.some(function (w) {
            return w.path === 'outputs/token_usage/coolwidgets-tokens.json';
        }), 'the local keyed copy rides the derived asset name');
    });
});

suite('aiTeammateTokenUsageReporter extraction characterization (gh-1078)', function() {

    test('extractTokenUsage returns null for null, empty and tokenless logs', function() {
        var reporter = loadReporter();

        assert.equal(reporter.extractTokenUsage(null), null);
        assert.equal(reporter.extractTokenUsage(''), null);
        assert.equal(reporter.extractTokenUsage('just a plain log line'), null);
    });

    test('extractTokenUsage tolerates empty lines interleaved with content', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            '',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100 • 50 (cached)',
            '',
            '[INFO] CommandLineUtils - Tokens    ↑ 2k • ↓ 200 • 60 (cached)',
            ''
        ].join('\n'));

        assert.notEqual(usage, null);
        assert.equal(usage.samples, 2);
        assert.equal(usage.readTokens, 3000);
        assert.equal(usage.writeTokens, 300);
        assert.equal(usage.cachedTokens, 110);
    });

    test('bare --resume marker marks resume without a feedback loop stage', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            './scripts/run-agent.sh --resume --ticket TS-1',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100'
        ].join('\n'));

        assert.equal(usage.resumeDetected, true);
        assert.equal(usage.feedbackLoopCount, 0);
        assert.deepEqual(usage.resumeStages, []);
        assert.equal(usage.rateLimitRetryCount, 0);
    });

    test('run-agent.sh --continue marker marks resume without a feedback loop stage', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            './scripts/run-agent.sh --continue',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100'
        ].join('\n'));

        assert.equal(usage.resumeDetected, true);
        assert.equal(usage.feedbackLoopCount, 0);
        assert.deepEqual(usage.resumeStages, []);
    });

    test('feedback loop line takes precedence over the --resume marker check', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            'Feedback loop: resuming agent for review_comments attempt 2/3 --resume',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100'
        ].join('\n'));

        assert.equal(usage.resumeDetected, true);
        assert.equal(usage.feedbackLoopCount, 1);
        assert.deepEqual(usage.resumeStages, ['review_comments 2/3']);
    });

    test('generic rate limit wording marks detection without a retry count', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            "You've hit your rate limit. Limit resets at 17:00 UTC",
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100'
        ].join('\n'));

        assert.equal(usage.rateLimitDetected, true);
        assert.equal(usage.rateLimitRetryCount, 0);
    });

    test('limit reset wording marks detection without a retry count', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            'rate limit reset in 42 minutes',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100'
        ].join('\n'));

        assert.equal(usage.rateLimitDetected, true);
        assert.equal(usage.rateLimitRetryCount, 0);
    });

    test('counts every timeout marker variant across the log', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            'Command failed (exit code 124): ./agents/scripts/run-agent.sh',
            'The command timed out after 30 minutes',
            'cli_execute_command hit the command timeout of 1800s',
            'timeout guard killed the runaway process',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100'
        ].join('\n'));

        assert.equal(usage.timeoutCount, 4);
        assert.equal(usage.samples, 1);
    });

    test('samples without any Requests line keep empty request metadata', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage('[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100');

        assert.notEqual(usage, null);
        assert.equal(usage.requests, 0);
        assert.equal(usage.requestTier, '');
        assert.equal(usage.requestDuration, '');
    });

    test('non-fa samples merge the most recent Requests line, fa samples never do', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            '[INFO] CommandLineUtils - Requests  3 Premium (11m 0s)',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100',
            '[INFO] CommandLineUtils - Requests  4 Pro (12m 0s)',
            'fa-tokens: {"sessionId":"s9","segment":1,"input":500,"output":50,"cacheRead":10,"requests":2,"source":"reported"}'
        ].join('\n'));

        assert.equal(usage.attempts.length, 2);
        assert.equal(usage.attempts[0].requests, 3);
        assert.equal(usage.attempts[0].requestTier, 'Premium');
        assert.equal(usage.attempts[1].requests, 2);
        assert.equal(usage.attempts[1].requestTier, '');
        assert.equal(usage.attempts[1].attemptIndex, 2);
    });

    test('source is empty when only CommandLineUtils samples exist', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage('[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100');

        assert.equal(usage.source, '');
    });

    test('single resume with one sample still flags resumeDetected from the marker', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            'Feedback loop: resuming agent for polish attempt 1/2',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100'
        ].join('\n'));

        assert.equal(usage.resumeDetected, true);
        assert.equal(usage.samples, 1);
        assert.equal(usage.resumeStages.length, 1);
    });

    test('resumeDetected falls back to true for multi-sample logs without markers', function() {
        var reporter = loadReporter();
        var usage = reporter.extractTokenUsage([
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100',
            '[INFO] CommandLineUtils - Tokens    ↑ 2k • ↓ 200'
        ].join('\n'));

        assert.equal(usage.resumeDetected, true);
        assert.equal(usage.feedbackLoopCount, 0);
        assert.deepEqual(usage.resumeStages, []);
    });

    test('processRunLogs sleeps between downloads when logDownloadSleepMs is set', function() {
        var reporter = loadReporter({
            github_get_workflow_run_logs: function() {
                return '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100';
            }
        });
        var run = { id: 9, run_number: 1, created_at: '2026-06-01T00:00:00Z', html_url: 'https://example.test/run/9' };
        var meta = { title: 'agents/x.json : TS-1 : TS-1', configFile: 'agents/x.json', agent: 'x', ticketKey: 'TS-1' };
        var state = {
            rows: [],
            attemptRows: [],
            cache: { version: 1, entries: {} },
            downloadedLogs: 1,
            cacheHits: 0,
            stoppedByDownloadLimit: false,
            verbose: false,
            cachePath: 'cache.json'
        };
        var options = { useCache: false, cacheWriteEvery: 25, logDownloadSleepMs: '5', maxLogDownloads: null };

        var startedAt = Date.now();
        reporter.processRunLogs({}, run, '9', meta, 60, '1m 0s', state, options);
        var elapsed = Date.now() - startedAt;

        assert.equal(state.downloadedLogs, 2);
        assert.equal(state.rows.length, 1);
        assert.equal(state.stoppedByDownloadLimit, false);
        assert.equal(elapsed >= 5, true, 'expected a >=5ms pause between downloads, got ' + elapsed + 'ms');
    });

    test('processRunLogs skips the sleep for the first download and for unparseable values', function() {
        var reporter = loadReporter({
            github_get_workflow_run_logs: function() {
                return '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100';
            }
        });
        var run = { id: 9, run_number: 1, created_at: '2026-06-01T00:00:00Z', html_url: 'https://example.test/run/9' };
        var meta = { title: 'agents/x.json : TS-1 : TS-1', configFile: 'agents/x.json', agent: 'x', ticketKey: 'TS-1' };
        var firstState = {
            rows: [], attemptRows: [], cache: { version: 1, entries: {} },
            downloadedLogs: 0, cacheHits: 0, stoppedByDownloadLimit: false, verbose: false, cachePath: 'cache.json'
        };

        var startedAt = Date.now();
        reporter.processRunLogs({}, run, '9', meta, 60, '1m 0s', firstState, { useCache: false, cacheWriteEvery: 25, logDownloadSleepMs: '5000', maxLogDownloads: null });
        assert.equal(Date.now() - startedAt < 1000, true, 'first download must not sleep');

        var junkState = {
            rows: [], attemptRows: [], cache: { version: 1, entries: {} },
            downloadedLogs: 1, cacheHits: 0, stoppedByDownloadLimit: false, verbose: false, cachePath: 'cache.json'
        };
        startedAt = Date.now();
        reporter.processRunLogs({}, run, '9', meta, 60, '1m 0s', junkState, { useCache: false, cacheWriteEvery: 25, logDownloadSleepMs: 'soon', maxLogDownloads: null });
        assert.equal(Date.now() - startedAt < 1000, true, 'unparseable sleep value must not sleep');
        assert.equal(junkState.downloadedLogs, 2);
    });

    test('processRunLogs checks maxLogDownloads before sleeping or downloading', function() {
        var downloads = [];
        var reporter = loadReporter({
            github_get_workflow_run_logs: function(args) {
                downloads.push(args.runId);
                return '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100';
            }
        });
        var run = { id: 9, run_number: 1, created_at: '2026-06-01T00:00:00Z', html_url: 'https://example.test/run/9' };
        var meta = { title: 'agents/x.json : TS-1 : TS-1', configFile: 'agents/x.json', agent: 'x', ticketKey: 'TS-1' };
        var state = {
            rows: [], attemptRows: [], cache: { version: 1, entries: {} },
            downloadedLogs: 2, cacheHits: 0, stoppedByDownloadLimit: false, verbose: false, cachePath: 'cache.json'
        };
        var options = { useCache: false, cacheWriteEvery: 25, logDownloadSleepMs: '5000', maxLogDownloads: 2 };

        var startedAt = Date.now();
        reporter.processRunLogs({}, run, '9', meta, 60, '1m 0s', state, options);

        assert.equal(downloads.length, 0);
        assert.equal(state.downloadedLogs, 2);
        assert.equal(state.stoppedByDownloadLimit, true);
        assert.equal(Date.now() - startedAt < 1000, true, 'limit check must precede the sleep');
    });
});

suite('aiTeammateTokenUsageReporter extraction helpers (gh-1078)', function() {

    test('newUsageTracking starts zeroed', function() {
        var reporter = loadReporter();
        assert.deepEqual(reporter.newUsageTracking(), {
            lastRequests: null,
            samples: [],
            seenFaSegments: {},
            resumeDetected: false,
            resumeStages: [],
            feedbackLoopCount: 0,
            rateLimitRetryCount: 0,
            rateLimitDetected: false,
            timeoutCount: 0
        });
    });

    test('parseResumeSignal classifies feedback loop, markers and clean lines', function() {
        var reporter = loadReporter();

        var feedback = reporter.parseResumeSignal('Feedback loop: resuming agent for rework attempt 2/4');
        assert.equal(feedback.resumed, true);
        assert.equal(feedback.feedbackStage, 'rework 2/4');

        var bareResume = reporter.parseResumeSignal('./scripts/run-agent.sh --resume --ticket TS-1');
        assert.equal(bareResume.resumed, true);
        assert.equal(bareResume.feedbackStage, null);

        var continueMarker = reporter.parseResumeSignal('./scripts/run-agent.sh --continue');
        assert.equal(continueMarker.resumed, true);
        assert.equal(continueMarker.feedbackStage, null);

        var clean = reporter.parseResumeSignal('just a plain log line');
        assert.equal(clean.resumed, false);
        assert.equal(clean.feedbackStage, null);
    });

    test('parseRateLimitSignal separates retries from plain detection', function() {
        var reporter = loadReporter();

        assert.deepEqual(
            reporter.parseRateLimitSignal('Copilot rate limit detected; retrying in 90s'),
            { retry: true, detected: true }
        );
        assert.deepEqual(
            reporter.parseRateLimitSignal("You've hit your rate limit. Limit resets at 17:00"),
            { retry: false, detected: true }
        );
        assert.deepEqual(
            reporter.parseRateLimitSignal('all good here'),
            { retry: false, detected: false }
        );
    });

    test('isTimeoutLine matches every marker variant', function() {
        var reporter = loadReporter();

        assert.equal(reporter.isTimeoutLine('failed with exit code 124'), true);
        assert.equal(reporter.isTimeoutLine('the command timed out'), true);
        assert.equal(reporter.isTimeoutLine('command timeout of 1800s'), true);
        assert.equal(reporter.isTimeoutLine('timeout guard intervened'), true);
        assert.equal(reporter.isTimeoutLine('completed successfully'), false);
    });

    test('applyLogSignals routes resume, rate limit and timeout onto the tracker', function() {
        var reporter = loadReporter();
        var tracking = reporter.newUsageTracking();

        reporter.applyLogSignals(tracking, 'Feedback loop: resuming agent for polish attempt 1/2', ''.toLowerCase());
        reporter.applyLogSignals(tracking, 'Copilot rate limit detected; retrying in 90s', 'copilot rate limit detected; retrying in 90s');
        reporter.applyLogSignals(tracking, 'Command failed (exit code 124)', 'command failed (exit code 124)');
        reporter.applyLogSignals(tracking, 'nothing notable', 'nothing notable');

        assert.equal(tracking.resumeDetected, true);
        assert.deepEqual(tracking.resumeStages, ['polish 1/2']);
        assert.equal(tracking.feedbackLoopCount, 1);
        assert.equal(tracking.rateLimitRetryCount, 1);
        assert.equal(tracking.rateLimitDetected, true);
        assert.equal(tracking.timeoutCount, 1);

        var untouched = reporter.newUsageTracking();
        reporter.applyLogSignals(untouched, 'nothing notable', 'nothing notable');
        assert.equal(untouched.resumeDetected, false);
        assert.equal(untouched.rateLimitDetected, false);
        assert.equal(untouched.timeoutCount, 0);
    });

    test('isFaSegmentReplay dedupes by sessionId+segment and ignores segmentless lines', function() {
        var reporter = loadReporter();
        var tracking = reporter.newUsageTracking();

        assert.equal(reporter.isFaSegmentReplay(tracking, { faSessionId: 's1', faSegment: 1 }), false);
        assert.equal(reporter.isFaSegmentReplay(tracking, { faSessionId: 's1', faSegment: 1 }), true, 'same segment must replay');
        assert.equal(reporter.isFaSegmentReplay(tracking, { faSessionId: 's1', faSegment: 2 }), false);
        assert.equal(reporter.isFaSegmentReplay(tracking, { faSessionId: 's2', faSegment: 1 }), false);
        assert.equal(reporter.isFaSegmentReplay(tracking, { faSessionId: '', faSegment: 1 }), false);
        assert.equal(reporter.isFaSegmentReplay(tracking, { faSessionId: 's1', faSegment: null }), false);
    });

    test('appendUsageSample numbers attempts and merges only unsourced request metadata', function() {
        var reporter = loadReporter();
        var tracking = reporter.newUsageTracking();
        tracking.lastRequests = { requests: 3, requestTier: 'Premium', requestDuration: '11m 0s' };

        reporter.appendUsageSample(tracking, { readTokens: 100, writeTokens: 10 });
        reporter.appendUsageSample(tracking, { readTokens: 200, writeTokens: 20, requests: 7, requestTier: 'Pro', requestDuration: '12m 0s' });

        assert.equal(tracking.samples.length, 2);
        assert.equal(tracking.samples[0].attemptIndex, 1);
        assert.equal(tracking.samples[0].requests, 3);
        assert.equal(tracking.samples[0].requestTier, 'Premium');
        assert.equal(tracking.samples[1].attemptIndex, 2);
        assert.equal(tracking.samples[1].requests, 7);
        assert.equal(tracking.samples[1].requestTier, 'Pro');
    });

    test('collectUsageSamples walks lines end-to-end into samples', function() {
        var reporter = loadReporter();
        var tracking = reporter.newUsageTracking();
        reporter.collectUsageSamples(tracking, [
            'Feedback loop: resuming agent for rework attempt 1/2',
            '[INFO] CommandLineUtils - Requests  2 Premium (5m 0s)',
            '[INFO] CommandLineUtils - Tokens    ↑ 1k • ↓ 100',
            'fa-tokens: {"sessionId":"s1","segment":1,"input":500,"output":50,"cacheRead":10,"requests":2,"source":"reported"}',
            'fa-tokens: {"sessionId":"s1","segment":1,"input":500,"output":50,"cacheRead":10,"requests":2,"source":"reported"}'
        ]);

        assert.equal(tracking.samples.length, 2);
        assert.equal(tracking.lastRequests.requests, 2);
        assert.equal(tracking.resumeStages[0], 'rework 1/2');
        assert.deepEqual(tracking.seenFaSegments, { 's1:1': true });
    });

    test('buildUsageAggregate returns null for empty samples and sums otherwise', function() {
        var reporter = loadReporter();

        assert.equal(reporter.buildUsageAggregate(reporter.newUsageTracking()), null);

        var tracking = reporter.newUsageTracking();
        reporter.appendUsageSample(tracking, { readTokens: 100, writeTokens: 10, cachedTokens: 5, reasoningTokens: 1, requests: 2, requestTier: 'Pro', requestDuration: '3m 0s' });
        reporter.appendUsageSample(tracking, { readTokens: 200, writeTokens: 20, cachedTokens: 6, reasoningTokens: 2, requests: 3, requestTier: 'Premium', requestDuration: '4m 0s', source: 'reported' });
        var aggregate = reporter.buildUsageAggregate(tracking);

        assert.equal(aggregate.readTokens, 300);
        assert.equal(aggregate.writeTokens, 30);
        assert.equal(aggregate.cachedTokens, 11);
        assert.equal(aggregate.reasoningTokens, 3);
        assert.equal(aggregate.requests, 5);
        assert.equal(aggregate.samples, 2);
        assert.equal(aggregate.source, 'reported');
        assert.equal(aggregate.requestTier, 'Premium', 'final sample wins');
        assert.equal(aggregate.requestDuration, '4m 0s');
    });

    test('buildUsageAggregate derives source as empty, single or mixed', function() {
        var reporter = loadReporter();

        var noSource = reporter.newUsageTracking();
        reporter.appendUsageSample(noSource, { readTokens: 1 });
        assert.equal(reporter.buildUsageAggregate(noSource).source, '');

        var single = reporter.newUsageTracking();
        reporter.appendUsageSample(single, { readTokens: 1, source: 'estimated' });
        assert.equal(reporter.buildUsageAggregate(single).source, 'estimated');

        var mixed = reporter.newUsageTracking();
        reporter.appendUsageSample(mixed, { readTokens: 1, source: 'reported' });
        reporter.appendUsageSample(mixed, { readTokens: 2, source: 'estimated' });
        assert.equal(reporter.buildUsageAggregate(mixed).source, 'mixed');
    });

    test('buildUsageAggregate flags resume from markers or multiple samples', function() {
        var reporter = loadReporter();

        var markerResume = reporter.newUsageTracking();
        reporter.applyLogSignals(markerResume, 'run-agent.sh --continue', 'run-agent.sh --continue');
        reporter.appendUsageSample(markerResume, { readTokens: 1 });
        assert.equal(reporter.buildUsageAggregate(markerResume).resumeDetected, true);

        var multiSample = reporter.newUsageTracking();
        reporter.appendUsageSample(multiSample, { readTokens: 1 });
        reporter.appendUsageSample(multiSample, { readTokens: 2 });
        assert.equal(reporter.buildUsageAggregate(multiSample).resumeDetected, true);
    });
});

suite('aiTeammateTokenUsageReporter sleepMilliseconds helpers (gh-1078)', function() {

    function loadReporterWithJava(javaGlobal) {
        return loadReporter({ Java: javaGlobal });
    }

    test('parseSleepMilliseconds clamps unparseable and non-positive values to 0', function() {
        var reporter = loadReporter();

        assert.equal(reporter.parseSleepMilliseconds('5'), 5);
        assert.equal(reporter.parseSleepMilliseconds(250), 250);
        assert.equal(reporter.parseSleepMilliseconds('12px'), 12);
        assert.equal(reporter.parseSleepMilliseconds('abc'), 0);
        assert.equal(reporter.parseSleepMilliseconds(0), 0);
        assert.equal(reporter.parseSleepMilliseconds(-3), 0);
        assert.equal(reporter.parseSleepMilliseconds(null), 0);
        assert.equal(reporter.parseSleepMilliseconds(undefined), 0);
    });

    test('hasJavaThread is true only when the Java interop exposes type', function() {
        assert.equal(loadReporterWithJava({ type: function() { return {}; } }).hasJavaThread(), true);
        assert.equal(loadReporterWithJava({}).hasJavaThread(), false);
    });

    test('sleepMilliseconds routes positive durations to Thread.sleep under the Java interop', function() {
        var sleeps = [];
        var reporter = loadReporterWithJava({
            type: function(name) {
                return { sleep: function(ms) { sleeps.push({ name: name, ms: ms }); } };
            }
        });

        reporter.sleepMilliseconds('7');
        reporter.sleepMilliseconds(0);
        reporter.sleepMilliseconds(-5);
        reporter.sleepMilliseconds('soon');

        assert.equal(sleeps.length, 1);
        assert.equal(sleeps[0].name, 'java.lang.Thread');
        assert.equal(sleeps[0].ms, 7);
    });

    test('sleepMilliseconds busy-waits when the Java interop is unavailable', function() {
        var reporter = loadReporter();

        var startedAt = Date.now();
        reporter.sleepMilliseconds(2);
        var elapsed = Date.now() - startedAt;
        assert.equal(elapsed >= 2, true, 'expected a >=2ms busy wait, got ' + elapsed + 'ms');
    });

    test('sleepMilliseconds busy-waits when Java.type is absent even with Java defined', function() {
        var reporter = loadReporterWithJava({});

        var startedAt = Date.now();
        reporter.sleepMilliseconds(2);
        var elapsed = Date.now() - startedAt;
        assert.equal(elapsed >= 2, true, 'expected a >=2ms busy wait fallback, got ' + elapsed + 'ms');
    });
});
