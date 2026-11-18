/**
 * Live-probe cache + tick counters for the SM engine (fa issue #224).
 *
 * Live incident 2026-11-17 (IstiN/flutter_agent_harness, run 44054383749):
 * the tick's residual API fan-out was NOT io-cache misses — the per-tick
 * ioCache is healthy (instrumented: hit=237 miss=9 expired=0). The tail was
 * LIVE-layer scans:
 *  - the mutex phantom probe (gh-1000, githubSource livePrItems ->
 *    listOpenPrsLive) re-read the full open-PR list PER RULE while an
 *    ai_validating arm was held — 83 identical github_list_prs calls in
 *    one live tick;
 *  - validationCheckSync's run-jobs poll fired 84 identical
 *    `actions/runs/<id>/jobs` calls for 3 run ids in one dry tick.
 *
 * Contract ("scan cached, act live"): SCANS ride this short-TTL layer
 * (default 30s, `liveProbeTtlMs` jobParam, 0 = always live); ACTION-time
 * verifiers keep true live reads — the phantom probe exists precisely
 * because the io-cache may be the stale layer (gh-1000), so this layer is
 * separate from smProvider's per-tick ioCache and bounded by its own TTL.
 *
 * Also carries the tick counters: tickOrchestrator prints
 * `iocache[hit=… miss=… expired=… puts=… drops=…]` in the SM Agent complete
 * line (production telemetry for the cache health).
 *
 * Pure module — no requires, no globals: IO enters through arguments
 * (deps.exec for cachedRunJobs), the label/normalize mappers for
 * livePrItems are call-site arguments (they live in githubSource.js).
 * Unit tests reset the holder via _reset().
 */
'use strict';

var DEFAULT_PROBE_TTL_MS = 30 * 1000;
var _evalId = String(Math.random()).slice(2, 8);
var _probes = {};
var _ttlOverride = null;
var _stats = {
    eval: _evalId, hit: 0, miss: 0, expired: 0, puts: 0, drops: 0
};

// ── tick counters ────────────────────────────────────────────────────────
function bump(kind) {
    if (_stats[kind] === undefined) _stats[kind] = 0;
    _stats[kind] += 1;
}

function ioCacheStats() {
    return {
        eval: _stats.eval, hit: _stats.hit, miss: _stats.miss,
        expired: _stats.expired, puts: _stats.puts, drops: _stats.drops,
        entries: Object.keys(_probes).length
    };
}

// ── the probe layer ──────────────────────────────────────────────────────
function probeTtlMs() {
    return _ttlOverride === null ? DEFAULT_PROBE_TTL_MS : _ttlOverride;
}

// jobParams tuning (smAgent.initTickState): liveProbeTtlMs, 0 = always live.
function applyProbeTuning(jobParams) {
    var p = jobParams || {};
    if (p && typeof p.liveProbeTtlMs === 'number' && p.liveProbeTtlMs >= 0) {
        _ttlOverride = p.liveProbeTtlMs;
    }
}

function _fresh(entry, ttlMs, now) {
    return entry && now - entry.at <= ttlMs;
}

function probeGet(key, ttlMs, now) {
    var at = (now === undefined) ? Date.now() : now;
    var entry = _probes[key];
    // ttl 0 = always live (liveProbeTtlMs jobParam contract): an entry is
    // NEVER served — a <=0ms-staleness window would race the wall clock
    // (a put in the same millisecond as the read reads as fresh), so the
    // zero case short-circuits deterministically instead.
    if (ttlMs === 0 || !_fresh(entry, ttlMs, at)) {
        if (entry) {
            delete _probes[key];
            _stats.expired++;
        }
        _stats.miss++;
        return undefined;
    }
    _stats.hit++;
    return entry.data;
}

function probePut(key, data) {
    _probes[key] = { at: Date.now(), data: data };
    _stats.puts++;
}

// Generic scan wrapper: return the <=ttlMs-stale layer or run fetch() once
// and cache non-empty results.
function cachedProbe(key, fetch) {
    var cached = probeGet(key, probeTtlMs());
    if (cached !== undefined) return cached;
    var data = fetch();
    if (data !== undefined && data !== null) probePut(key, data);
    return data;
}

// validationCheckSync.run-jobs poll (the 84-identical-calls site): one poll
// per run per probe TTL. The jobs table is informational (stamp summary
// body). Contract (pr #1514 review round 1): a FAILED or EMPTY listing
// stays UNCACHED — the caller gets [] but the next rule re-executes, so a
// transient gh api failure self-retries instead of sticking for the TTL.
function cachedRunJobs(deps, repoInfo, runId, parse) {
    var key = 'runJobs:' + repoInfo.owner + '/' + repoInfo.repo + ':' + runId;
    var cached = probeGet(key, probeTtlMs());
    if (cached !== undefined) return cached;
    var jobs;
    try {
        jobs = parse(deps.exec({
            command: 'gh api repos/' + repoInfo.owner + '/' +
                repoInfo.repo + '/actions/runs/' + runId +
                '/jobs?per_page=100'
        })) || [];
    } catch (e) {
        deps.warn('  ⚠️  stamp job-table probe failed: ' + e);
        return [];
    }
    if (!jobs.length) return [];
    probePut(key, jobs);
    return jobs;
}

// Self-heal companion (gh-1000): when the io-cache entry is dropped the
// probe layer must not keep serving the pre-heal list for the rest of its
// TTL — drop it too and count the drop (production telemetry).
function probeDrop(key) {
    if (key in _probes) {
        delete _probes[key];
        _stats.drops++;
    }
}

// githubSource.livePrItems (gh-1000 live re-read), probeCache-aware.
// `prLabels` and `asItemsArray` are githubSource call-site helpers.
// The live payload carries the same label shape github_list_prs returns
// (REST: {name} objects) — normalize to the probe's plain-string contract
// here or every mutex defer would misread as a phantom.
function normalizeLive(live, prLabels) {
    if (!live) return null;
    return live.map(function (p) {
        return { number: p.number, labels: prLabels(p) };
    });
}

function livePrItems(provider, repoInfo, probeCache, prLabels, asItemsArray) {
    if (!provider || typeof provider.listOpenPrsLive !== 'function' || !repoInfo) return null;
    var key = 'livePrs:' + repoInfo.owner + '/' + repoInfo.repo;
    if (probeCache) {
        var cached = probeGet(key, probeTtlMs());
        if (cached) return cached;
    }
    try {
        var live = asItemsArray(provider.listOpenPrsLive());
        var normalized = normalizeLive(live, prLabels);
        if (probeCache && normalized) probePut(key, normalized);
        return normalized;
    } catch (e) {
        console.log('   ⚠️ gh-1000 phantom-heal live re-read failed: ' +
            String((e && e.message) || e) +
            ' — keeping cached mutex decision (fail-closed)');
        return null;
    }
}

// Unit-test hook: fresh holder between tests (the runner re-uses module
// instances across suites).
function _reset() {
    _probes = {};
    _ttlOverride = null;
    _stats = {
        eval: _evalId, hit: 0, miss: 0, expired: 0, puts: 0, drops: 0
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        probeGet: probeGet,
        probePut: probePut,
        probeTtlMs: probeTtlMs,
        applyProbeTuning: applyProbeTuning,
        cachedProbe: cachedProbe,
        cachedRunJobs: cachedRunJobs,
        probeDrop: probeDrop,
        livePrItems: livePrItems,
        normalizeLive: normalizeLive,
        ioCacheStats: ioCacheStats,
        bump: bump,
        _reset: _reset
    };
}
