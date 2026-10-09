/**
 * Unit tests for js/common/reworkLatch.js — the rework in-flight latch
 * (gh-806): one arming decision per (pr-number, head-sha); the tick's armers
 * consult the latch before labeling/dispatching, the latch clears when the
 * leg's ai-teammate run on the latched head concludes (success or failure),
 * and a latch older than the stale timeout with no matching active run
 * self-heals (no human).
 *
 * Pure module — no tool globals; loadModule with no mocks.
 *
 * Time convention: `now` may be an epoch-ms number or an ISO string (both
 * shapes flow through the tick); entries carry ISO `at` stamps because the
 * latch persists inside the fa-state.json snapshot.
 */

var assert = globalThis.assert;

var latch = loadModule('js/common/reworkLatch.js', makeRequire({}), {});

var T0 = '2026-10-09T04:01:00.000Z';
var T0_MS = Date.parse(T0);
var TEN_MIN = 10 * 60 * 1000;
var STALE_MS = latch.DEFAULT_STALE_MS;
var HEAD = '23dacd10deadbeefcafe0123456789abcdef0123';

function legRun(status, updatedAt, path) {
    return {
        status: status,
        conclusion: status === 'completed' ? 'success' : null,
        head_sha: HEAD,
        path: path || '.github/workflows/ai-teammate.yml',
        updated_at: updatedAt || null
    };
}

// ── keys + normalization ─────────────────────────────────────────────────────

suite('reworkLatch — keys and normalization', function () {
    test('latchKey builds pr-N@head', function () {
        assert.equal(latch.latchKey(1428, HEAD), 'pr-1428@' + HEAD);
    });

    test('latchKey is null for missing pr or head', function () {
        assert.equal(latch.latchKey(null, HEAD), null);
        assert.equal(latch.latchKey(1428, ''), null);
        assert.equal(latch.latchKey(undefined, null), null);
    });

    test('normalizeMap drops garbage and keeps well-formed entries', function () {
        var raw = {
            'pr-1@aaa': { head: 'aaa', at: T0 },
            'pr-2': { head: 'bbb', at: T0 },          // key without @ → garbage
            'pr-3@ccc': { at: T0 },                    // no head → garbage
            'pr-4@ddd': { head: 'ddd' },               // no at → garbage
            'nonsense': 'x'
        };
        var map = latch.normalizeMap(raw);
        assert.deepEqual(Object.keys(map), ['pr-1@aaa']);
        assert.equal(map['pr-1@aaa'].head, 'aaa');
    });

    test('normalizeMap tolerates null/undefined/non-objects', function () {
        assert.deepEqual(latch.normalizeMap(null), {});
        assert.deepEqual(latch.normalizeMap('x'), {});
        assert.deepEqual(latch.normalizeMap([]), {});
    });
});

// ── arm / isActive (AC1) ─────────────────────────────────────────────────────

suite('reworkLatch — arm and isActive', function () {
    test('unlatched (pr, head) is not active', function () {
        var res = latch.isActive({}, 1428, HEAD, { now: T0_MS });
        assert.notOk(res.active);
        assert.equal(res.cause, 'absent');
    });

    test('missing head sha never latches (legacy items re-arm normally)', function () {
        var map = latch.arm({}, 1428, null, T0);
        assert.deepEqual(latch.normalizeMap(map), {});
        var res = latch.isActive(map, 1428, null, { now: T0_MS });
        assert.notOk(res.active);
    });

    test('fresh latch is active — the armer must log and dispatch nothing (AC1)', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var res = latch.isActive(map, 1428, HEAD, { now: T0_MS + TEN_MIN });
        assert.ok(res.active);
        assert.equal(res.cause, 'in-flight');
    });

    test('a different head on the same PR is a different key (AC2: new push re-arms)', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var newHead = 'f00d' + HEAD.substring(4);
        var res = latch.isActive(map, 1428, newHead, { now: T0_MS + TEN_MIN });
        assert.notOk(res.active);
    });

    test('a different PR never inherits the latch', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        assert.notOk(latch.isActive(map, 1429, HEAD, { now: T0_MS }).active);
    });

    test('active leg run keeps an otherwise-stale latch alive (leg still flying)', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var runs = [legRun('in_progress', null)];
        var res = latch.isActive(map, 1428, HEAD, {
            now: T0_MS + STALE_MS + TEN_MIN, runs: runs
        });
        assert.ok(res.active);
        assert.equal(res.cause, 'in-flight');
    });
});

// ── stale self-heal (AC3) ────────────────────────────────────────────────────

suite('reworkLatch — stale timeout (AC3: 45 min, no matching active run)', function () {
    test('latch older than 45 min with no run at all is stale', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var res = latch.isActive(map, 1428, HEAD, { now: T0_MS + STALE_MS + 1 });
        assert.notOk(res.active);
        assert.equal(res.cause, 'stale');
    });

    test('latch just under 45 min is still in flight', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var res = latch.isActive(map, 1428, HEAD, { now: T0_MS + STALE_MS - 1 });
        assert.ok(res.active);
    });

    test('staleMs is overridable (knob, not magic)', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var res = latch.isActive(map, 1428, HEAD, {
            now: T0_MS + 5 * 60 * 1000, staleMs: 4 * 60 * 1000
        });
        assert.notOk(res.active);
        assert.equal(res.cause, 'stale');
    });

    test('stale clock uses ISO strings too (now as ISO)', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var res = latch.isActive(map, 1428, HEAD, {
            now: '2026-10-09T05:00:00.000Z' // +59 min
        });
        assert.notOk(res.active);
    });

    test('unparsable entry timestamp fails CLOSED (stale, self-heals)', function () {
        var map = latch.normalizeMap({ ['pr-1428@' + HEAD]: { head: HEAD, at: 'not-a-date' } });
        var res = latch.isActive(map, 1428, HEAD, { now: T0_MS });
        assert.notOk(res.active);
        assert.equal(res.cause, 'stale');
    });
});

// ── leg termination clears the latch (AC2) ───────────────────────────────────

suite('reworkLatch — leg run conclusion clears the latch (AC2)', function () {
    test('leg run completed AFTER the arm clears the latch (success or failure)', function () {
        var concludedAt = '2026-10-09T04:20:00.000Z';
        [ 'success', 'failure' ].forEach(function (conclusion) {
            var map = latch.arm({}, 1428, HEAD, T0);
            var run = legRun('completed', concludedAt);
            run.conclusion = conclusion;
            var res = latch.isActive(map, 1428, HEAD, {
                now: T0_MS + TEN_MIN, runs: [run]
            });
            assert.notOk(res.active, 'conclusion ' + conclusion + ' must clear');
            assert.equal(res.cause, 'terminated');
        });
    });

    test('leg run concluded BEFORE this arm (old attempt on the same head) does NOT clear', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var oldRun = legRun('completed', '2026-10-09T03:00:00.000Z');
        var res = latch.isActive(map, 1428, HEAD, {
            now: T0_MS + TEN_MIN, runs: [oldRun]
        });
        assert.ok(res.active);
    });

    test('a concluded NON-leg run (validation CI) never clears the latch', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var ciRun = legRun('completed', '2026-10-09T04:20:00.000Z',
            '.github/workflows/quality.yml');
        var res = latch.isActive(map, 1428, HEAD, {
            now: T0_MS + TEN_MIN, runs: [ciRun]
        });
        assert.ok(res.active);
    });

    test('runs on a DIFFERENT head are ignored', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var other = legRun('completed', '2026-10-09T04:20:00.000Z');
        other.head_sha = '0000000000000000000000000000000000000000';
        var res = latch.isActive(map, 1428, HEAD, {
            now: T0_MS + TEN_MIN, runs: [other]
        });
        assert.ok(res.active);
    });

    test('workflowFile is configurable (deployment may rename the leg workflow)', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var run = legRun('completed', '2026-10-09T04:20:00.000Z',
            '.github/workflows/custom-leg.yml');
        var res = latch.isActive(map, 1428, HEAD, {
            now: T0_MS + TEN_MIN, runs: [run], workflowFile: 'custom-leg.yml'
        });
        assert.notOk(res.active);
    });

    test('a null (failed) runs probe reads as no termination — fresh latch stays', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var res = latch.isActive(map, 1428, HEAD, {
            now: T0_MS + TEN_MIN, runs: null
        });
        assert.ok(res.active);
    });
});

// ── clear + prune ────────────────────────────────────────────────────────────

suite('reworkLatch — clear and prune', function () {
    test('clear removes exactly the keyed entry', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        map = latch.arm(map, 1429, HEAD, T0);
        map = latch.clear(map, 1428, HEAD);
        assert.equal(map['pr-1428@' + HEAD], undefined);
        assert.ok(map['pr-1429@' + HEAD]);
    });

    test('clear is a no-op on an unknown key', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        latch.clear(map, 9999, HEAD);
        assert.ok(map['pr-1428@' + HEAD]);
    });

    test('prune drops stale and terminated entries, keeps fresh ones', function () {
        var freshHead = 'aaaabbbbccccddddeeeeffff000111122223333';
        var map = latch.arm({}, 1428, HEAD, T0);                              // terminated below
        map = latch.arm(map, 1429, freshHead, T0);                            // fresh → kept
        var staleHead = '9999bbbbccccddddeeeeffff000111122223333';
        map = latch.arm(map, 1430, staleHead, '2026-10-08T00:00:00.000Z');    // ancient → stale
        var concluded = legRun('completed', '2026-10-09T04:10:00.000Z');
        var res = latch.pruneStale(map, {
            now: T0_MS + TEN_MIN,
            runs: [concluded, legRun('in_progress', null)]
        });
        assert.deepEqual(res.cleared.sort(), ['pr-1428@' + HEAD, 'pr-1430@' + staleHead].sort());
        assert.ok(res.map['pr-1429@' + freshHead], 'fresh latch survives');
        assert.equal(res.map['pr-1428@' + HEAD], undefined);
        assert.equal(res.map['pr-1430@' + staleHead], undefined);
    });

    test('prune keeps a stale-aged entry whose leg run is STILL active', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var res = latch.pruneStale(map, {
            now: T0_MS + STALE_MS + TEN_MIN,
            runs: [legRun('in_progress', null)]
        });
        assert.deepEqual(res.cleared, []);
        assert.ok(res.map['pr-1428@' + HEAD]);
    });

    test('prune on a null runs probe still ages out stale entries (AC3 self-heal)', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var res = latch.pruneStale(map, { now: T0_MS + STALE_MS + TEN_MIN, runs: null });
        assert.deepEqual(res.cleared, ['pr-1428@' + HEAD]);
    });
});

// ── the arming-storm filter (L2: replay 9 identical decisions → 1 dispatch) ──

suite('reworkLatch — arming-storm dedupe (L2)', function () {
    test('9 identical arming decisions yield exactly 1 dispatch', function () {
        var map = {};
        var storm = [];
        for (var i = 0; i < 9; i++) storm.push({ prNumber: 1428, headSha: HEAD });
        var res = latch.dedupeArms(map, storm, { now: T0_MS });
        assert.equal(res.allowed.length, 1, 'exactly one arm passes the filter');
        assert.equal(res.suppressed.length, 8, 'eight duplicates are suppressed');
        assert.equal(res.allowed[0].prNumber, 1428);
    });

    test('suppressed decisions carry the in-flight cause for the ⏭️ log', function () {
        var map = {};
        var storm = [
            { prNumber: 1428, headSha: HEAD },
            { prNumber: 1428, headSha: HEAD }
        ];
        var res = latch.dedupeArms(map, storm, { now: T0_MS });
        assert.equal(res.allowed.length, 1);
        assert.equal(res.suppressed[0].cause, 'in-flight');
    });

    test('decisions for other (pr, head) pairs still pass during a storm', function () {
        var map = {};
        var storm = [
            { prNumber: 1428, headSha: HEAD },
            { prNumber: 1428, headSha: HEAD },
            { prNumber: 1428, headSha: 'bbbb' + HEAD.substring(4) },
            { prNumber: 1429, headSha: HEAD }
        ];
        var res = latch.dedupeArms(map, storm, { now: T0_MS });
        assert.equal(res.allowed.length, 3);
        assert.equal(res.suppressed.length, 1);
    });

    test('decisions without a head sha never latch (always pass)', function () {
        var map = {};
        var storm = [
            { prNumber: 1428, headSha: null },
            { prNumber: 1428, headSha: null }
        ];
        var res = latch.dedupeArms(map, storm, { now: T0_MS });
        assert.equal(res.allowed.length, 2);
    });

    test('a decision matching a terminated latch re-arms (AC2 through the filter)', function () {
        var map = latch.arm({}, 1428, HEAD, T0);
        var concluded = legRun('completed', '2026-10-09T04:10:00.000Z');
        var res = latch.dedupeArms(map, [{ prNumber: 1428, headSha: HEAD }],
            { now: T0_MS + TEN_MIN, runs: [concluded] });
        assert.equal(res.allowed.length, 1, 'terminated leg re-arms');
    });
});
