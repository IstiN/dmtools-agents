/**
 * Unit tests for js/common/probeCache.js — the live-probe layer + tick
 * counters (fa issue #224).
 *
 * Live incident 2026-11-17 (IstiN/flutter_agent_harness): the SM tick's
 * residual API fan-out was live-layer scans, not io-cache misses —
 * the mutex phantom probe re-read the full open-PR list PER RULE while an
 * arm was held (83 identical github_list_prs calls in one live tick) and
 * validationCheckSync's run-jobs poll fired 84 identical
 * `actions/runs/<id>/jobs` calls for 3 run ids in one dry tick.
 *
 * Contract ("scan cached, act live"):
 *   - SCANS ride a short-TTL layer (30s default, `liveProbeTtlMs`
 *     jobParam, 0 = always live) — bounded staleness, bounded fan-out;
 *   - ACTION-time verifiers keep true live reads (they never pass the
 *     probe flag);
 *   - the layer is SEPARATE from smProvider's per-tick ioCache (gh-1000:
 *     the io-cache may be the stale layer a phantom holder rides on);
 *   - counters aggregate hit/miss/expired/puts/drops for the tick summary.
 *
 * Pure module — no globals; the deterministic-clock tests inject `now`
 * into probeGet instead of sleeping.
 */

var assert = globalThis.assert;

var probeCache = loadModule('js/common/probeCache.js', makeRequire({}), {});

var NOW = Date.now(); // real clock; offsets make expiry deterministic

suite('probeCache: probeGet/probePut basics', function () {

test('miss on an empty holder counts a miss and returns undefined', function () {
    probeCache._reset();
    assert.equal(probeCache.probeGet('k', 30000, NOW), undefined);
    var s = probeCache.ioCacheStats();
    assert.equal(s.miss, 1);
    assert.equal(s.hit, 0);
    assert.equal(s.entries, 0);
});

test('put then get within TTL is a hit and returns the payload', function () {
    probeCache._reset();
    probeCache.probePut('k', { a: 1 });
    var v = probeCache.probeGet('k', 30000, NOW + 1000);
    assert.deepEqual(v, { a: 1 });
    var s = probeCache.ioCacheStats();
    assert.equal(s.hit, 1);
    assert.equal(s.puts, 1);
    assert.equal(s.entries, 1);
});

test('past-TTL reads expire the entry: expired++, miss++, entry dropped', function () {
    probeCache._reset();
    probeCache.probePut('k', { a: 1 });
    assert.equal(probeCache.probeGet('k', 30000, NOW + 31000), undefined);
    var s = probeCache.ioCacheStats();
    assert.equal(s.expired, 1);
    assert.equal(s.miss, 1);
    assert.equal(s.entries, 0);
    // the expired entry is gone: a second read is a plain miss
    assert.equal(probeCache.probeGet('k', 30000, NOW + 31000), undefined);
    assert.equal(probeCache.ioCacheStats().expired, 1, 'no double-expire counting');
});

});

suite('probeCache: liveProbeTtlMs tuning', function () {

test('default TTL is 30s until a jobParam overrides it', function () {
    probeCache._reset();
    assert.equal(probeCache.probeTtlMs(), 30000);
    probeCache.applyProbeTuning(undefined);
    probeCache.applyProbeTuning({});
    probeCache.applyProbeTuning({ liveProbeTtlMs: 'nope' });
    probeCache.applyProbeTuning({ liveProbeTtlMs: -5 });
    assert.equal(probeCache.probeTtlMs(), 30000, 'invalid tuning is ignored');
});

test('liveProbeTtlMs >= 0 applies; 0 means always live', function () {
    probeCache._reset();
    probeCache.applyProbeTuning({ liveProbeTtlMs: 500 });
    assert.equal(probeCache.probeTtlMs(), 500);
    probeCache.applyProbeTuning({ liveProbeTtlMs: 0 });
    assert.equal(probeCache.probeTtlMs(), 0);
    // ttl 0: any delta past the put instant expires
    probeCache.probePut('k', 1);
    assert.equal(probeCache.probeGet('k', 0, NOW + 1), undefined);
});

});

suite('probeCache: cachedProbe (generic scan wrapper)', function () {

test('first call fetches and caches; second call is served from the layer', function () {
    probeCache._reset();
    var fetches = 0;
    var fetch = function () { fetches++; return ['x']; };
    assert.deepEqual(probeCache.cachedProbe('scan', fetch), ['x']);
    assert.deepEqual(probeCache.cachedProbe('scan', fetch), ['x']);
    assert.equal(fetches, 1, 'the second scan must not re-fetch');
});

test('null/undefined payloads stay uncached (the next scan re-fetches)', function () {
    probeCache._reset();
    var fetch = function () { return null; };
    assert.equal(probeCache.cachedProbe('scan', fetch), null);
    assert.equal(probeCache.cachedProbe('scan', fetch), null);
    assert.equal(probeCache.ioCacheStats().puts, 0, 'nothing cached for a null scan');
});

});

suite('probeCache: cachedRunJobs (validationCheckSync run-jobs poll)', function () {

function makeDeps() {
    var execCount = 0, warns = [];
    return {
        deps: {
            exec: function () {
                execCount++;
                return { jobs: [{ name: 'build', conclusion: 'success' }] };
            },
            warn: function (m) { warns.push(m); }
        },
        execCount: function () { return execCount; },
        warns: warns
    };
}

test('one poll per run per TTL; the jobs table rides the layer', function () {
    probeCache._reset();
    var d = makeDeps();
    var repoInfo = { owner: 'o', repo: 'r' };
    var first = probeCache.cachedRunJobs(d.deps, repoInfo, 42, function (res) {
        return res.jobs;
    });
    var second = probeCache.cachedRunJobs(d.deps, repoInfo, 42, function (res) {
        return res.jobs;
    });
    assert.equal(first.length, 1);
    assert.deepEqual(second, first);
    assert.equal(d.execCount(), 1, '84 identical polls collapse to fetches/TTL');
    // a different run id is a separate key
    probeCache.cachedRunJobs(d.deps, repoInfo, 43, function (res) { return res.jobs; });
    assert.equal(d.execCount(), 2);
});

test('exec failure warns and returns [] without caching the failure', function () {
    probeCache._reset();
    var warns = [];
    var deps = {
        exec: function () { throw new Error('boom'); },
        warn: function (m) { warns.push(m); }
    };
    var out = probeCache.cachedRunJobs(deps, { owner: 'o', repo: 'r' }, 7, function () {
        return [];
    });
    assert.deepEqual(out, []);
    assert.equal(warns.length, 1);
    assert.ok(warns[0].indexOf('stamp job-table probe failed') !== -1);
});

});

suite('probeCache: livePrItems (gh-1000 phantom probe, scan cached / act live)', function () {

var prLabels = function (p) {
    return (p.labels || []).map(function (l) { return l.name || l; });
};
var asItemsArray = function (v) { return v || []; };

function makeProvider(live) {
    var calls = 0;
    return {
        provider: { listOpenPrsLive: function () { calls++; return live; } },
        calls: function () { return calls; }
    };
}

test('null provider / missing facade method / missing repo fail closed to null', function () {
    probeCache._reset();
    assert.equal(probeCache.livePrItems(null, { owner: 'o', repo: 'r' }, true, prLabels, asItemsArray), null);
    assert.equal(probeCache.livePrItems({}, { owner: 'o', repo: 'r' }, true, prLabels, asItemsArray), null);
    assert.equal(probeCache.livePrItems({ listOpenPrsLive: function () {} }, null, true, prLabels, asItemsArray), null);
});

test('probeCache=false is a true live read: every call fetches (action-time contract)', function () {
    probeCache._reset();
    var p = makeProvider([{ number: 1, labels: [{ name: 'ai_validating' }] }]);
    var a = probeCache.livePrItems(p.provider, { owner: 'o', repo: 'r' }, false, prLabels, asItemsArray);
    var b = probeCache.livePrItems(p.provider, { owner: 'o', repo: 'r' }, false, prLabels, asItemsArray);
    assert.equal(p.calls(), 2, 'action-time re-verifies never ride the layer');
    assert.deepEqual(a, [{ number: 1, labels: ['ai_validating'] }]);
    assert.deepEqual(b, a);
});

test('probeCache=true caches the normalized live payload for the scan', function () {
    probeCache._reset();
    var p = makeProvider([{ number: 2, labels: ['pr_approved'] }]);
    var a = probeCache.livePrItems(p.provider, { owner: 'o', repo: 'r' }, true, prLabels, asItemsArray);
    var b = probeCache.livePrItems(p.provider, { owner: 'o', repo: 'r' }, true, prLabels, asItemsArray);
    assert.equal(p.calls(), 1, 'the scan fan-out collapses to one live read per TTL');
    assert.deepEqual(a, [{ number: 2, labels: ['pr_approved'] }]);
    assert.deepEqual(b, a);
    assert.equal(probeCache.ioCacheStats().puts, 1);
});

test('an empty live board normalizes to [] and IS cached (valid scan result)', function () {
    probeCache._reset();
    var p = makeProvider(null); // asItemsArray(null) === []
    var a = probeCache.livePrItems(p.provider, { owner: 'o', repo: 'r' }, true, prLabels, asItemsArray);
    assert.deepEqual(a, []);
    var b = probeCache.livePrItems(p.provider, { owner: 'o', repo: 'r' }, true, prLabels, asItemsArray);
    assert.deepEqual(b, []);
    assert.equal(p.calls(), 1, 'the empty board is a valid cached scan');
    // the defensive null-normalize branch stays covered directly
    assert.equal(probeCache.normalizeLive(null, prLabels), null);
});

test('a live-read failure logs the gh-1000 fail-closed warning and returns null', function () {
    probeCache._reset();
    var provider = {
        listOpenPrsLive: function () { throw new Error('socket hung'); }
    };
    var out = probeCache.livePrItems(provider, { owner: 'o', repo: 'r' }, true, prLabels, asItemsArray);
    assert.equal(out, null, 'fail-closed keeps the cached mutex decision');
});

});

suite('probeCache: tick counters', function () {

test('ioCacheStats aggregates the counters and carries the eval marker', function () {
    probeCache._reset();
    probeCache.bump('drops');
    probeCache.probePut('k', 1);
    probeCache.probeGet('k', 30000, NOW + 1);
    var s = probeCache.ioCacheStats();
    assert.equal(s.drops, 1);
    assert.equal(s.puts, 1);
    assert.equal(s.hit, 1);
    assert.equal(typeof s.eval, 'string');
    assert.ok(s.eval.length > 0, 'eval marker identifies the module instance');
});

});
