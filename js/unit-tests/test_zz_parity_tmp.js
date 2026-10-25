// TEMPORARY parity check (gh-1262) — deleted after the run.
var dedupModule = loadModule('js/common/teammateEventDedup.js', makeRequire({ './legRunVocab.js': legRunVocabReal() }), {});
var tokenUsageModule = loadModule('js/factory/token_usage.js', makeRequire({}), {});
function loadOld() {
    return loadModule('js/.parity-old-reporter.js',
        makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return { repository: { owner: 'o', repo: 'r' } }; } },
            './common/teammateEventDedup.js': dedupModule,
            './factory/token_usage.js': tokenUsageModule
        }), {});
}
function loadNew() {
    return loadModule('js/aiTeammateTokenUsageReporter.js',
        makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return { repository: { owner: 'o', repo: 'r' } }; } },
            './common/teammateEventDedup.js': dedupModule,
            './factory/token_usage.js': tokenUsageModule
        }), {});
}

suite('gh-1262 parity old vs new', function() {
    var oldM = loadOld();
    var newM = loadNew();
    var run = { id: 42, run_number: 7, created_at: '2026-06-01T00:00:00Z', run_started_at: '2026-06-01T00:00:30Z', updated_at: '2026-06-01T00:10:00Z', conclusion: 'success', html_url: 'https://x/42' };
    var camelRun = { databaseId: 43, runNumber: 8, createdAt: '2026-06-02T00:00:00Z', runStartedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:01:00Z', htmlUrl: 'https://x/43' };
    var meta = { title: 't', configFile: 'c.json', agent: 'a', ticketKey: 'TS-1' };
    var usage = { requests: 3, requestTier: 'Premium', requestDuration: '27m 2s', readTokens: 100, writeTokens: 10, cachedTokens: 50, reasoningTokens: 5, samples: 2, resumeDetected: true, resumeStages: ['s 1/2'], feedbackLoopCount: 1, rateLimitRetryCount: 2, rateLimitDetected: true, timeoutCount: 1, source: 'reported' };
    var attempt = { attemptIndex: 2, requests: 3, requestTier: 'Premium', requestDuration: '27m 2s', readTokens: 100, writeTokens: 10, cachedTokens: 50, reasoningTokens: 5, rawTokensLine: 'Tokens x 100', source: 'reported' };

    test('buildUsageRow identical (snake + camel)', function() {
        assert.deepEqual(newM.buildUsageRow(run, meta, 570, '9m 30s', usage), oldM.buildUsageRow(run, meta, 570, '9m 30s', usage));
        assert.deepEqual(newM.buildUsageRow(camelRun, meta, 60, '1m 0s', usage), oldM.buildUsageRow(camelRun, meta, 60, '1m 0s', usage));
    });
    test('buildAttemptRow identical', function() {
        assert.deepEqual(newM.buildAttemptRow(run, meta, 570, '9m 30s', usage, attempt), oldM.buildAttemptRow(run, meta, 570, '9m 30s', usage, attempt));
        assert.deepEqual(newM.buildAttemptRow(camelRun, meta, 60, '1m 0s', usage, attempt), oldM.buildAttemptRow(camelRun, meta, 60, '1m 0s', usage, attempt));
    });
    test('buildCsv / buildAttemptsCsv byte-identical', function() {
        var rows = [oldM.buildUsageRow(run, meta, 570, '9m 30s', usage), oldM.buildUsageRow(camelRun, meta, 60, '1m 0s', usage)];
        var att = [oldM.buildAttemptRow(run, meta, 570, '9m 30s', usage, attempt), oldM.buildAttemptRow(camelRun, meta, 60, '1m 0s', usage, attempt)];
        assert.equal(newM.buildCsv(rows), oldM.buildCsv(rows));
        assert.equal(newM.buildAttemptsCsv(att), oldM.buildAttemptsCsv(att));
        assert.equal(newM.buildCsv([]), oldM.buildCsv([]));
    });
    test('buildSummary identical (incl. empty)', function() {
        var rows = [oldM.buildUsageRow(run, meta, 570, '9m 30s', usage)];
        assert.deepEqual(newM.buildSummary(rows, 5), oldM.buildSummary(rows, 5));
        assert.deepEqual(newM.buildSummary([], 0), oldM.buildSummary([], 0));
    });
    test('newGroupBucket / groupBy identical', function() {
        assert.deepEqual(newM.newGroupBucket('k'), oldM.newGroupBucket('k'));
        var rows = [oldM.buildUsageRow(run, meta, 570, '9m 30s', usage), oldM.buildUsageRow(camelRun, meta, 60, '1m 0s', usage)];
        assert.deepEqual(newM.groupBy(rows, function(r) { return r.day; }), oldM.groupBy(rows, function(r) { return r.day; }));
    });
});
