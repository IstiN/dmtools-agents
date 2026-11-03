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
});
