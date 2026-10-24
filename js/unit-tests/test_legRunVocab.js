/**
 * Unit tests: js/common/legRunVocab.js — the leg-run freshness vocabulary
 * shared by branchLegGuard / reworkLatch / teammateEventDedup (gh-1248 dedup).
 */

suite('legRunVocab — isLegRun', function () {
    var vocab = loadModule('js/common/legRunVocab.js', makeRequire({}), {});

    test('a run whose path ends with /<workflowFile> is a leg run', function () {
        assert.equal(vocab.isLegRun({ path: 'IstiN/repo/.github/workflows/ai-teammate.yml' }), true);
        assert.equal(vocab.isLegRun({ path: 'org/repo/.github/workflows/custom.yml' }, 'custom.yml'), true);
    });

    test('validation CI or kicker runs on other workflows are not leg runs', function () {
        assert.equal(vocab.isLegRun({ path: 'org/repo/.github/workflows/quality.yml' }), false);
        assert.equal(vocab.isLegRun({ path: 'org/repo/.github/workflows/ai-teammate.yml.bak' }), false);
    });

    test('null run or missing path is not a leg run', function () {
        assert.equal(vocab.isLegRun(null), false);
        assert.equal(vocab.isLegRun({}), false);
    });
});

suite('legRunVocab — runTimestampMs', function () {
    var vocab = loadModule('js/common/legRunVocab.js', makeRequire({}), {});

    test('updated_at wins over created_at', function () {
        var run = { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' };
        assert.equal(vocab.runTimestampMs(run), Date.parse('2026-02-01T00:00:00Z'));
    });

    test('falls back to created_at and answers null without either', function () {
        assert.equal(vocab.runTimestampMs({ created_at: '2026-01-01T00:00:00Z' }),
            Date.parse('2026-01-01T00:00:00Z'));
        assert.equal(vocab.runTimestampMs({}), null);
    });

    test('unparsable timestamps answer null', function () {
        assert.equal(vocab.runTimestampMs({ updated_at: 'not-a-date' }), null);
    });
});

suite('legRunVocab — isStaleNonRunning', function () {
    var vocab = loadModule('js/common/legRunVocab.js', makeRequire({}), {});
    var NOW = Date.parse('2026-03-01T00:00:00Z');

    test('an in_progress run is never stale', function () {
        var run = { status: 'in_progress', updated_at: '2020-01-01T00:00:00Z' };
        assert.equal(vocab.isStaleNonRunning(run, NOW, 3600000), false);
    });

    test('a non-running run older than the stale bound is stale', function () {
        var run = { status: 'completed', updated_at: '2026-02-01T00:00:00Z' };
        assert.equal(vocab.isStaleNonRunning(run, NOW, 3600000), true);
        var fresh = { status: 'completed', updated_at: '2026-02-28T23:59:59Z' };
        assert.equal(vocab.isStaleNonRunning(fresh, NOW, 3600000), false);
    });

    test('missing timestamps or missing now answer not-stale (caller gates)', function () {
        assert.equal(vocab.isStaleNonRunning({ status: 'completed' }, NOW, 3600000), false);
        assert.equal(vocab.isStaleNonRunning({ status: 'completed', updated_at: '2026-02-01T00:00:00Z' },
            null, 3600000), false);
    });
});

suite('legRunVocab — isFreshActiveRun', function () {
    var vocab = loadModule('js/common/legRunVocab.js', makeRequire({}), {});
    var NOW = Date.parse('2026-03-01T00:00:00Z');
    var ACTIVE = ['in_progress', 'queued', 'requested'];

    test('an active run within the stale bound is fresh', function () {
        var run = { status: 'queued', updated_at: '2026-02-28T23:00:00Z' };
        assert.equal(vocab.isFreshActiveRun(run, ACTIVE, NOW, 3600000), true);
    });

    test('a non-in_progress active run past the stale bound is a zombie (not fresh)', function () {
        var run = { status: 'queued', updated_at: '2026-02-01T00:00:00Z' };
        assert.equal(vocab.isFreshActiveRun(run, ACTIVE, NOW, 3600000), false);
    });

    test('in_progress runs ignore the stale bound', function () {
        var run = { status: 'in_progress', updated_at: '2020-01-01T00:00:00Z' };
        assert.equal(vocab.isFreshActiveRun(run, ACTIVE, NOW, 3600000), true);
    });

    test('a status outside the caller activeStates list is not fresh', function () {
        var run = { status: 'completed', updated_at: '2026-02-28T12:00:00Z' };
        assert.equal(vocab.isFreshActiveRun(run, ACTIVE, NOW, 3600000), false);
    });

    test('callers can pass an extended activeStates vocabulary (reworkLatch requested)', function () {
        var run = { status: 'requested', updated_at: '2026-02-28T23:00:00Z' };
        assert.equal(vocab.isFreshActiveRun(run, ACTIVE, NOW, 3600000), true);
        assert.equal(vocab.isFreshActiveRun(run, ['in_progress', 'queued'], NOW, 3600000), false);
    });
});

suite('legRunVocab — makeRunProbes', function () {
    var vocab = loadModule('js/common/legRunVocab.js', makeRequire({}), {});
    var NOW = Date.parse('2026-03-01T00:00:00Z');

    test('binds the caller activeStates list into the probe bundle', function () {
        var probes = vocab.makeRunProbes(['in_progress', 'queued', 'requested']);
        assert.equal(probes.isActiveStatus('requested'), true);
        assert.equal(probes.isActiveStatus('completed'), false);
        assert.equal(probes.runTimestampMs({ updated_at: '2026-02-28T23:00:00Z' }),
            Date.parse('2026-02-28T23:00:00Z'));
        assert.equal(probes.isStaleNonRunning({ status: 'completed',
            updated_at: '2026-02-01T00:00:00Z' }, NOW, 3600000), true);
        assert.equal(probes.isFreshActiveRun({ status: 'requested',
            updated_at: '2026-02-28T23:00:00Z' }, NOW, 3600000), true);
        assert.equal(probes.isFreshActiveRun({ status: 'requested',
            updated_at: '2026-02-01T00:00:00Z' }, NOW, 3600000), false);
    });

    test('two bundles with different lists stay independent', function () {
        var withRequested = vocab.makeRunProbes(['in_progress', 'requested']);
        var without = vocab.makeRunProbes(['in_progress']);
        var run = { status: 'requested', updated_at: '2026-02-28T23:00:00Z' };
        assert.equal(withRequested.isFreshActiveRun(run, NOW, 3600000), true);
        assert.equal(without.isFreshActiveRun(run, NOW, 3600000), false);
    });
});
