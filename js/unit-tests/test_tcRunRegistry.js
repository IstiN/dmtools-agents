/**
 * Unit tests for js/common/tcRunRegistry.js — gh-1329 per-TC run
 * bookkeeping (validated state, lastGreenSha + env fingerprint, red-round
 * streak) persisted as a house dmtools: marker on the bug ticket.
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({
    './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}))
}));
var registry = loadModule('js/common/tcRunRegistry.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts
}));

var ALLOW = { authorLogins: ['ai-teammate'] };

function machineComment(payload) {
    return { body: payload, user: { login: 'ai-teammate' } };
}

suite('tcRunRegistry: greens validate guards and record fingerprints', function() {

    test('empty registry holds no TC state', function() {
        var r = registry.emptyRegistry();
        assert.equal(r.v, 1);
        assert.deepEqual(r.tcs, {});
        assert.equal(registry.stateOf(r, 'TS-1'), null);
    });

    test('AC: first green turns a fresh TC into a validated guard with lastGreenSha + env fingerprint', function() {
        var r = registry.recordGreen(registry.emptyRegistry(), 'TS-1', {
            sha: 'sha-a', envFingerprint: 'env-1', role: 'regression-guard', at: '2026-01-01T00:00:00.000Z'
        });
        var s = registry.stateOf(r, 'TS-1');
        assert.equal(s.validated, true);
        assert.equal(s.lastGreenSha, 'sha-a');
        assert.equal(s.lastGreenEnvFingerprint, 'env-1');
        assert.equal(s.lastGreenAt, '2026-01-01T00:00:00.000Z');
        assert.equal(s.greens, 1);
        assert.equal(s.redRounds, 0);
    });

    test('a newer green refreshes the fingerprint and resets the red streak (the fix worked)', function() {
        var r = registry.emptyRegistry();
        r = registry.recordFailure(r, 'TS-1', { at: '2026-01-01T00:00:00.000Z' });
        r = registry.recordFailure(r, 'TS-1', { at: '2026-01-02T00:00:00.000Z' });
        r = registry.recordGreen(r, 'TS-1', { sha: 'sha-b', envFingerprint: 'env-2', at: '2026-01-03T00:00:00.000Z' });
        var s = registry.stateOf(r, 'TS-1');
        assert.equal(s.greens, 1);
        assert.equal(s.lastGreenSha, 'sha-b');
        assert.equal(s.redRounds, 0, 'a green between reds resets the streak');
    });

    test('recordFailure counts consecutive red rounds (the bounce-cap input)', function() {
        var r = registry.emptyRegistry();
        r = registry.recordGreen(r, 'TS-2', { sha: 'sha-a', envFingerprint: 'env-1' });
        r = registry.recordFailure(r, 'TS-2', { at: '2026-02-01T00:00:00.000Z', verdict: 'maintenance' });
        r = registry.recordFailure(r, 'TS-2', { at: '2026-02-02T00:00:00.000Z', verdict: 'maintenance' });
        var s = registry.stateOf(r, 'TS-2');
        assert.equal(s.redRounds, 2);
        assert.equal(s.lastRedAt, '2026-02-02T00:00:00.000Z');
        assert.equal(s.lastVerdict, 'maintenance');
        assert.equal(s.greens, 1, 'greens untouched by failures');
    });

    test('failures on different TCs are independent', function() {
        var r = registry.emptyRegistry();
        r = registry.recordGreen(r, 'TS-1', { sha: 'sha-a', envFingerprint: 'env-1' });
        r = registry.recordFailure(r, 'TS-1', { at: '2026-02-01T00:00:00.000Z' });
        r = registry.recordFailure(r, 'TS-2', { at: '2026-02-01T00:00:00.000Z' });
        r = registry.recordFailure(r, 'TS-2', { at: '2026-02-02T00:00:00.000Z' });
        r = registry.recordFailure(r, 'TS-2', { at: '2026-02-03T00:00:00.000Z' });
        assert.equal(registry.stateOf(r, 'TS-1').redRounds, 1);
        assert.equal(registry.stateOf(r, 'TS-2').redRounds, 3);
    });
});

var REGISTRY_MARKER_NO_PAIRS = '<!-- dmtools:tc-run-registry {"v":1,"at":"2026-01-01T00:00:00.000Z","tcs":{"TS-1":{"role":"regression-guard","validated":true,"lastGreenSha":"sha-a","lastGreenEnvFingerprint":"env-1","lastGreenAt":"2026-01-01T00:00:00.000Z","greens":1,"redRounds":0,"lastRedAt":null,"lastVerdict":null}}} -->\nold fixture';

suite('tcRunRegistry: marker persistence (house dmtools: pattern)', function() {

    test('marker round-trips through parse with the machine-author trust gate', function() {
        var r = registry.recordGreen(registry.emptyRegistry(), 'TS-1', { sha: 'sha-a', envFingerprint: 'env-1' });
        var marker = registry.buildRegistryMarker(r);
        assert.contains(marker, '<!-- dmtools:tc-run-registry ');
        var parsed = registry.latestRegistry([machineComment(marker)], ALLOW);
        assert.ok(parsed);
        assert.equal(parsed.registry.tcs['TS-1'].lastGreenSha, 'sha-a');
        assert.equal(parsed.registry.tcs['TS-1'].validated, true);
    });

    test('comments from untrusted authors are ignored', function() {
        var marker = registry.buildRegistryMarker(registry.recordGreen(registry.emptyRegistry(), 'TS-1', { sha: 'sha-a' }));
        assert.equal(registry.latestRegistry([{ body: marker, user: { login: 'rando' } }], ALLOW), null);
    });

    test('no configured allowlist trusts nothing (fail closed)', function() {
        var marker = registry.buildRegistryMarker(registry.recordGreen(registry.emptyRegistry(), 'TS-1', { sha: 'sha-a' }));
        assert.equal(registry.latestRegistry([machineComment(marker)], {}), null);
        assert.equal(registry.latestRegistry([machineComment(marker)]), null);
    });

    test('newest record wins across multiple markers', function() {
        var r1 = registry.recordGreen(registry.emptyRegistry(), 'TS-1', { sha: 'sha-a', envFingerprint: 'env-1', at: '2026-01-01T00:00:00.000Z' });
        var r2 = registry.recordGreen(r1, 'TS-1', { sha: 'sha-b', envFingerprint: 'env-1', at: '2026-03-01T00:00:00.000Z' });
        var m1 = registry.buildRegistryMarker(r1);
        var m2 = registry.buildRegistryMarker(r2);
        var parsed = registry.latestRegistry([machineComment(m1), machineComment(m2)], ALLOW);
        assert.equal(parsed.registry.tcs['TS-1'].lastGreenSha, 'sha-b');
    });

    test('broken payloads and prose are skipped', function() {
        assert.equal(registry.latestRegistry([{ body: 'plain prose' }], ALLOW), null);
        assert.equal(registry.latestRegistry([{ body: '<!-- dmtools:tc-run-registry {broken -->' }], ALLOW), null);
        assert.equal(registry.latestRegistry(null, ALLOW), null);
    });

    test('legacy markers without a pairs map parse with an empty one (additive shape)', function() {
        var parsed = registry.latestRegistry([machineComment(REGISTRY_MARKER_NO_PAIRS)], ALLOW);
        assert.ok(parsed);
        assert.deepEqual(parsed.registry.pairs, {});
    });
});

// ── gh-1331: the cross-lap history beside lastGreenSha ────────────────────────

// A pre-gh-1331 registry marker: no pairs map, no run history, no bounce record.

suite('tcRunRegistry: gh-1331 run history (last K runs + shas beside lastGreenSha)', function() {

    test('greens and reds append to the per-TC run history', function() {
        var r = registry.emptyRegistry();
        r = registry.recordGreen(r, 'TS-1', { sha: 'sha-a', envFingerprint: 'env-1', at: '2026-01-01T00:00:00.000Z' });
        r = registry.recordFailure(r, 'TS-1', { at: '2026-01-02T00:00:00.000Z' });
        var runs = registry.runsOf(r, 'TS-1');
        assert.equal(runs.length, 2);
        assert.equal(runs[0].s, 'green');
        assert.equal(runs[0].sha, 'sha-a');
        assert.equal(runs[1].s, 'red');
    });

    test('AC: the history is a short window (last K runs), not a lifetime log', function() {
        var r = registry.emptyRegistry();
        for (var i = 0; i < 10; i++) {
            r = registry.recordGreen(r, 'TS-1', { sha: 'sha-' + i, envFingerprint: 'env-1' });
        }
        var runs = registry.runsOf(r, 'TS-1');
        assert.equal(runs.length, registry.RUN_HISTORY_LIMIT, 'the window is capped');
        assert.equal(runs[runs.length - 1].sha, 'sha-9', 'the newest run survives');
        assert.equal(runs[0].sha, 'sha-' + (10 - registry.RUN_HISTORY_LIMIT), 'the oldest runs fall off');
    });

    test('the history survives later updates (carried, not dropped)', function() {
        var r = registry.emptyRegistry();
        r = registry.recordGreen(r, 'TS-1', { sha: 'sha-a', envFingerprint: 'env-1' });
        r = registry.recordFailure(r, 'TS-1', { at: '2026-01-02T00:00:00.000Z' });
        assert.equal(registry.runsOf(r, 'TS-1').length, 2, 'the red did not reset the window');
    });

    test('TCs are independent and unknown TCs have no history', function() {
        var r = registry.emptyRegistry();
        r = registry.recordGreen(r, 'TS-1', { sha: 'sha-a', envFingerprint: 'env-1' });
        assert.deepEqual(registry.runsOf(r, 'TS-2'), []);
        assert.deepEqual(registry.runsOf(null, 'TS-1'), []);
    });
});

suite('tcRunRegistry: gh-1331 bounce record (the earned-bounce anchor)', function() {

    test('recordBounce stamps the range anchor + kind on the TC entry', function() {
        var r = registry.recordGreen(registry.emptyRegistry(), 'TS-1', { sha: 'sha-a', envFingerprint: 'env-1' });
        r = registry.recordBounce(r, 'TS-1', { at: '2026-01-02T00:00:00.000Z', lastGreenSha: 'sha-a', kind: 'earned' });
        var s = registry.stateOf(r, 'TS-1');
        assert.equal(s.lastBounceAt, '2026-01-02T00:00:00.000Z');
        assert.equal(s.lastBounceRange, 'sha-a');
        assert.equal(s.lastBounceKind, 'earned');
        assert.equal(s.validated, true, 'the existing entry is kept');
    });

    test('the bounce record carries through later reds and greens', function() {
        var r = registry.recordGreen(registry.emptyRegistry(), 'TS-1', { sha: 'sha-a', envFingerprint: 'env-1' });
        r = registry.recordBounce(r, 'TS-1', { lastGreenSha: 'sha-a', kind: 'earned' });
        r = registry.recordFailure(r, 'TS-1', { at: '2026-01-03T00:00:00.000Z' });
        var s = registry.stateOf(r, 'TS-1');
        assert.equal(s.lastBounceRange, 'sha-a', 'the anchor survives a red');
        assert.equal(s.lastBounceKind, 'earned');
        r = registry.recordGreen(r, 'TS-1', { sha: 'sha-b', envFingerprint: 'env-1' });
        assert.equal(registry.stateOf(r, 'TS-1').lastBounceRange, 'sha-a', 'the anchor survives a green too (range-keyed)');
    });

    test('a newer bounce on a different range overwrites the anchor', function() {
        var r = registry.recordBounce(registry.emptyRegistry(), 'TS-1', { lastGreenSha: 'sha-a', kind: 'earned' });
        r = registry.recordBounce(r, 'TS-1', { at: '2026-01-05T00:00:00.000Z', lastGreenSha: 'sha-c', kind: 'escalated' });
        var s = registry.stateOf(r, 'TS-1');
        assert.equal(s.lastBounceRange, 'sha-c');
        assert.equal(s.lastBounceKind, 'escalated');
    });

    test('the bounce record round-trips through the marker', function() {
        var r = registry.recordBounce(registry.emptyRegistry(), 'TS-1', { at: '2026-01-02T00:00:00.000Z', lastGreenSha: 'sha-a', kind: 'earned' });
        var parsed = registry.latestRegistry([machineComment(registry.buildRegistryMarker(r))], ALLOW);
        assert.equal(parsed.registry.tcs['TS-1'].lastBounceRange, 'sha-a');
    });
});

suite('tcRunRegistry: gh-1331 pair-conflict records in the payload', function() {

    test('pairs survive the marker round-trip', function() {
        var r = registry.emptyRegistry();
        r.pairs = { 'TS-1|TS-2': { state: 'contradictory-or-flaky', detectedAt: '2026-01-02T00:00:00.000Z' } };
        var parsed = registry.latestRegistry([machineComment(registry.buildRegistryMarker(r))], ALLOW);
        assert.ok(parsed.registry.pairs['TS-1|TS-2']);
        assert.equal(parsed.registry.pairs['TS-1|TS-2'].state, 'contradictory-or-flaky');
    });

    test('an empty pairs map serializes without breaking older parsers of the payload', function() {
        var marker = registry.buildRegistryMarker(registry.recordGreen(registry.emptyRegistry(), 'TS-1', { sha: 'sha-a' }));
        assert.contains(marker, '"pairs"');
        var parsed = registry.latestRegistry([machineComment(marker)], ALLOW);
        assert.deepEqual(parsed.registry.pairs, {});
    });
});
