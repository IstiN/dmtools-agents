/**
 * Unit tests for js/common/checkRunZombies.js — the gate-ghost classifier (gh-842).
 *
 * Bug (live fa #1457, 2026-10-10, head 7d00a1b2): a dispatched CI run was
 * CANCELLED while queued (gh-748 twin-guard family); the in_progress check
 * runs it registered on the head were never concluded. Branch protection
 * takes the LATEST check-run per (context, head), so the ghosts held
 * mergeStateStatus=BLOCKED for ~2h even though the head also carried GREEN
 * terminal entries from the earlier run 38057801418. The tick's green-cover
 * guard (skipIfGreenCi) read the green run as covering the head and never
 * re-dispatched — the gate idled until an operator nudged a fresh dispatch.
 *
 * Coverage (ticket test plan L1 — zombie classification):
 *   no-run           — in_progress check-run whose backing run no longer
 *                      exists (absent from the head's run list / 404)
 *   cancelled        — backing run concluded cancelled
 *   stale-no-runner  — no run link (bridge stamp) and older than the
 *                      stale threshold with no runner behind it
 *   run-concluded    — backing run concluded (non-cancelled) past the
 *                      propagation grace — the run ended, the check ghosted
 *   live (AC2)       — backing run ACTIVE, fresh stamp, propagation lag, or
 *                      probe error — a genuinely in-progress run is NEVER
 *                      disturbed; probe failures fail SAFE toward live
 *   settled checks   — concluded check-runs are not zombies (a green
 *                      terminal entry next to a ghost stays green evidence)
 *   #1457 replay     — the real timeline: 3 ghost contexts (run deleted)
 *                      + green terminal entries from the older run
 *
 * Pure module — no tool globals; loadModule with no mocks.
 */

var assert = globalThis.assert;

var cz = loadModule('js/common/checkRunZombies.js', makeRequire({}), {});

var NOW = Date.parse('2026-10-10T15:00:00Z');
var RUN_GREEN = '38057801418';          // the 13:58 green run (fa #1457)
var RUN_DEAD = '38099999999';           // the cancelled-then-deleted run
var RUN_LIVE = '38111111111';           // a genuinely in-flight run

function cr(extra) {
    var base = { name: 'Quality gate', status: 'in_progress', conclusion: null,
                 started_at: '2026-10-10T14:30:00Z',
                 details_url: 'https://github.com/o/r/actions/runs/' + RUN_DEAD };
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) base[k] = extra[k]; } }
    return base;
}

function resolver(map, opts) {
    // resolveRun mock: runId → run object | null (deleted/404) |
    // throw (probe error, when opts.throwFor contains the id).
    return function (runId) {
        if (opts && opts.throwFor && opts.throwFor.indexOf(runId) !== -1) {
            throw new Error('API hiccup for run ' + runId);
        }
        return map.hasOwnProperty(runId) ? map[runId] : null;
    };
}

// ── runIdOf ─────────────────────────────────────────────────────────────────

suite('checkRunZombies runIdOf', function () {
    test('parses the workflow-run id out of details_url / html_url', function () {
        assert.equal(cz.runIdOf(cr()), RUN_DEAD);
        assert.equal(cz.runIdOf({ html_url: 'https://github.com/o/r/actions/runs/123/job/456' }), '123');
        assert.equal(cz.runIdOf({ detailsUrl: 'https://github.com/o/r/actions/runs/42' }), '42');
    });

    test('no usable link → null (bridge stamps carry no details_url at dispatch time)', function () {
        assert.equal(cz.runIdOf({ name: 'x', status: 'in_progress' }), null);
        assert.equal(cz.runIdOf(null), null);
        assert.equal(cz.runIdOf({ details_url: 'https://example.com/nope' }), null);
    });
});

// ── isPendingCheckRun ────────────────────────────────────────────────────────

suite('checkRunZombies isPendingCheckRun', function () {
    test('queued / in_progress / waiting / pending without a conclusion are pending', function () {
        assert.equal(cz.isPendingCheckRun(cr({ status: 'queued' })), true);
        assert.equal(cz.isPendingCheckRun(cr({ status: 'in_progress' })), true);
        assert.equal(cz.isPendingCheckRun(cr({ status: 'waiting' })), true);
        assert.equal(cz.isPendingCheckRun(cr({ status: 'pending' })), true);
    });

    test('a concluded check-run is NOT pending — settled evidence is never a zombie', function () {
        assert.equal(cz.isPendingCheckRun(cr({ status: 'completed', conclusion: 'success' })), false);
        assert.equal(cz.isPendingCheckRun(cr({ status: 'completed', conclusion: 'cancelled' })), false);
        assert.equal(cz.isPendingCheckRun(cr({ status: 'completed', conclusion: 'failure' })), false);
        assert.equal(cz.isPendingCheckRun(null), false);
    });
});

// ── classify: zombies ────────────────────────────────────────────────────────

suite('checkRunZombies classify — zombies', function () {
    test('L1 no-run: an in_progress check-run whose run no longer exists (404/deleted)', function () {
        // The fa #1457 shape: the cancelled run was deleted — it is ABSENT
        // from the head's run list, which is the 404-equivalent read.
        var out = cz.classify([cr()], resolver({}, {}), NOW, {});
        assert.equal(out.zombies.length, 1);
        assert.equal(out.zombies[0].name, 'Quality gate');
        assert.equal(out.zombies[0].runId, RUN_DEAD);
        assert.equal(out.zombies[0].reason, 'no-run');
        assert.equal(out.live, 0);
    });

    test('L1 cancelled: the backing run concluded cancelled (the ghost the run itself left)', function () {
        var map = {};
        map[RUN_DEAD] = { id: RUN_DEAD, status: 'completed', conclusion: 'cancelled',
                          updated_at: '2026-10-10T14:31:00Z' };
        var out = cz.classify([cr()], resolver(map, {}), NOW, {});
        assert.equal(out.zombies.length, 1);
        assert.equal(out.zombies[0].reason, 'cancelled');
    });

    test('L1 stale-no-runner: no run link and older than the stale threshold', function () {
        // Dispatch-bridge stamps carry no details_url at arm time; a run
        // cancelled while queued never concludes them.
        var stamp = cr({ details_url: null, started_at: '2026-10-10T14:00:00Z' });
        var out = cz.classify([stamp], resolver({}, {}), NOW, {});
        assert.equal(out.zombies.length, 1);
        assert.equal(out.zombies[0].reason, 'stale-no-runner');
        assert.equal(out.zombies[0].runId, null);
    });

    test('run-concluded: the backing run ended (non-cancelled) past the propagation grace', function () {
        var map = {};
        map[RUN_DEAD] = { id: RUN_DEAD, status: 'completed', conclusion: 'success',
                          updated_at: '2026-10-10T14:35:00Z' };
        var out = cz.classify([cr()], resolver(map, {}), NOW, {});
        assert.equal(out.zombies.length, 1);
        assert.equal(out.zombies[0].reason, 'run-concluded');
    });

    test('mixed head: ONLY the pending ghosts are zombies — settled green entries stay evidence', function () {
        var checkRuns = [
            cr(),                                                              // ghost (run deleted)
            cr({ name: 'Binaries smoke gate' }),                               // ghost (run deleted)
            cr({ name: 'Quality gate', status: 'completed', conclusion: 'success',
                 details_url: 'https://github.com/o/r/actions/runs/' + RUN_GREEN }),  // green terminal entry
            cr({ name: 'CodeQL', status: 'completed', conclusion: 'success',
                 details_url: 'https://github.com/o/r/actions/runs/' + RUN_GREEN })
        ];
        var map = {};
        map[RUN_GREEN] = { id: RUN_GREEN, status: 'completed', conclusion: 'success',
                           updated_at: '2026-10-10T13:58:00Z' };
        var out = cz.classify(checkRuns, resolver(map, {}), NOW, {});
        assert.equal(out.zombies.length, 2);
        assert.equal(out.settled, 2);
        assert.equal(out.live, 0);
    });
});

// ── classify: live (AC2 — never disturb a genuinely in-progress run) ─────────

suite('checkRunZombies classify — live', function () {
    test('AC2: the backing run is ACTIVE (runner alive) — LIVE, never a zombie', function () {
        var map = {};
        map[RUN_LIVE] = { id: RUN_LIVE, status: 'in_progress', conclusion: null };
        var live = cz.classify([cr({ details_url: 'https://github.com/o/r/actions/runs/' + RUN_LIVE })],
                               resolver(map, {}), NOW, {});
        assert.equal(live.zombies.length, 0);
        assert.equal(live.live, 1);

        map[RUN_LIVE] = { id: RUN_LIVE, status: 'queued', conclusion: null };
        var queued = cz.classify([cr({ details_url: 'https://github.com/o/r/actions/runs/' + RUN_LIVE })],
                                 resolver(map, {}), NOW, {});
        assert.equal(queued.zombies.length, 0, 'a queued (waiting-for-runner) run is LIVE');
    });

    test('a FRESH bridge stamp (younger than the stale threshold) is LIVE — the dispatch just fired', function () {
        var stamp = cr({ details_url: null, started_at: '2026-10-10T14:55:00Z' });
        var out = cz.classify([stamp], resolver({}, {}), NOW, {});
        assert.equal(out.zombies.length, 0);
        assert.equal(out.live, 1);
    });

    test('propagation lag: run concluded non-cancelled inside the grace is LIVE', function () {
        var map = {};
        map[RUN_DEAD] = { id: RUN_DEAD, status: 'completed', conclusion: 'success',
                          updated_at: '2026-10-10T14:58:00Z' };   // 2 min ago
        var out = cz.classify([cr()], resolver(map, {}), NOW, {});
        assert.equal(out.zombies.length, 0, 'the check-run conclusion is still propagating');
        assert.equal(out.live, 1);
    });

    test('fail safe: a resolveRun PROBE error classifies LIVE (a missed zombie retries next tick; a wrongful re-dispatch churns CI)', function () {
        var out = cz.classify([cr()], resolver({}, { throwFor: [RUN_DEAD] }), NOW, {});
        assert.equal(out.zombies.length, 0);
        assert.equal(out.live, 1);
        assert.equal(out.unresolvable, 1);
    });

    test('an UNPARSEABLE stamp timestamp is LIVE (fail safe — cannot prove staleness)', function () {
        var stamp = cr({ details_url: null, started_at: 'not-a-date' });
        var out = cz.classify([stamp], resolver({}, {}), NOW, {});
        assert.equal(out.zombies.length, 0);
        assert.equal(out.live, 1);
    });

    test('an odd run status is LIVE (fail safe on vocabulary drift)', function () {
        var map = {};
        map[RUN_DEAD] = { id: RUN_DEAD, status: 'unknown_future_state', conclusion: null };
        var out = cz.classify([cr()], resolver(map, {}), NOW, {});
        assert.equal(out.zombies.length, 0);
        assert.equal(out.live, 1);
    });
});

// ── classify: knobs ──────────────────────────────────────────────────────────

suite('checkRunZombies classify — knobs', function () {
    test('staleNoRunnerMinutes tunes the no-link staleness threshold', function () {
        var stamp = cr({ details_url: null, started_at: '2026-10-10T14:45:00Z' }); // 15 min old
        var strict = cz.classify([stamp], resolver({}, {}), NOW, { staleNoRunnerMinutes: 10 });
        assert.equal(strict.zombies.length, 1, 'older than 10 min ⇒ zombie');
        var lax = cz.classify([stamp], resolver({}, {}), NOW, { staleNoRunnerMinutes: 30 });
        assert.equal(lax.zombies.length, 0, 'younger than 30 min ⇒ live');
    });

    test('runConcludedGraceMinutes tunes the propagation-lag window', function () {
        var map = {};
        map[RUN_DEAD] = { id: RUN_DEAD, status: 'completed', conclusion: 'success',
                          updated_at: '2026-10-10T14:50:00Z' };   // 10 min ago
        var wide = cz.classify([cr()], resolver(map, {}), NOW, { runConcludedGraceMinutes: 15 });
        assert.equal(wide.zombies.length, 0, 'inside a 15-min grace ⇒ live');
        var narrow = cz.classify([cr()], resolver(map, {}), NOW, { runConcludedGraceMinutes: 5 });
        assert.equal(narrow.zombies.length, 1, 'past a 5-min grace ⇒ zombie');
    });

    test('defaults: 30-min no-link staleness, 5-min propagation grace', function () {
        assert.equal(typeof cz.DEFAULT_STALE_NO_RUNNER_MINUTES, 'number');
        assert.equal(typeof cz.DEFAULT_RUN_CONCLUDED_GRACE_MINUTES, 'number');
    });
});

// ── gh-852: placeholders — the no-cancel gate-pinning variant ────────────────
//
// Live fa #1457 (2026-10-11, head d29efb16 + 3 predecessors): a dispatch
// queued without materializing a job; GitHub minted PENDING placeholder
// check-runs (~20s after dispatch, html_url with NO numeric run id) on
// contexts the later real run never stamped. Branch protection takes the
// LATEST check-run per (context, head) ⇒ placeholders pin BLOCKED with
// every real check green. A same-sha re-dispatch re-mints placeholders
// when it queues again — ONLY a fresh sha + an immediate-start validation
// cures the gate. Detection: the placeholder grace (minutes), not the
// 30-min zombie staleness; remedy: fresh-sha reset, pool-free probe,
// per-PR per-window retry cap.

suite('checkRunZombies placeholders — detection (gh-852)', function () {
    test('a link-less pending stamp older than the placeholder grace IS a placeholder', function () {
        // The d29efb16 shape: placeholder minted 12:06:29, probed 12:10.
        var stamp = cr({ name: 'Quality gate', details_url: null,
                         started_at: '2026-10-11T12:06:29Z' });
        var out = cz.placeholders([stamp],
                                  Date.parse('2026-10-11T12:10:00Z'), {});
        assert.equal(out.length, 1);
        assert.equal(out[0].name, 'Quality gate');
        assert.equal(out[0].runId, null);
        assert.equal(out[0].reason, 'placeholder');
    });

    test('the check-run id rides the placeholder entry (gh-857 in-place PATCH target)', function () {
        // The conclusion PATCH needs the check-run id; a payload without
        // one yields id null (the caller falls back to the gh-852 reset).
        var stamp = cr({ id: 991234001, name: 'Quality gate', details_url: null,
                         started_at: '2026-10-11T12:06:29Z' });
        var out = cz.placeholders([stamp],
                                  Date.parse('2026-10-11T12:10:00Z'), {});
        assert.equal(out.length, 1);
        assert.equal(out[0].id, 991234001);
        var noId = cz.placeholders([cr({ name: 'Quality gate', details_url: null,
                                         started_at: '2026-10-11T12:06:29Z' })],
                                   Date.parse('2026-10-11T12:10:00Z'), {});
        assert.equal(noId[0].id, null);
        assert.ok(noId[0].id === null, 'id is exactly null, not undefined');
    });

    test('a FRESH link-less stamp is NOT a placeholder — the dispatch may still materialize', function () {
        // Fail safe toward live: a bridge stamp of a dispatch that JUST
        // fired carries no run link for seconds — age is the only proof.
        var stamp = cr({ name: 'Quality gate', details_url: null,
                         started_at: '2026-10-11T12:09:30Z' });
        var out = cz.placeholders([stamp],
                                  Date.parse('2026-10-11T12:10:00Z'), {});
        assert.equal(out.length, 0);
    });

    test('an UNPARSEABLE stamp timestamp is NOT a placeholder (fail safe)', function () {
        var stamp = cr({ name: 'Quality gate', details_url: null,
                         started_at: 'not-a-date' });
        var out = cz.placeholders([stamp],
                                  Date.parse('2026-10-11T12:10:00Z'), {});
        assert.equal(out.length, 0);
    });

    test('a stamp WITH a run id and a settled check are NOT placeholders', function () {
        var withId = cr({ started_at: '2026-10-11T12:00:00Z' });       // has details_url
        var settled = cr({ status: 'completed', conclusion: 'success',
                           started_at: '2026-10-11T12:00:00Z' });
        var out = cz.placeholders([withId, settled],
                                  Date.parse('2026-10-11T12:10:00Z'), {});
        assert.equal(out.length, 0);
    });

    test('placeholderMinutes tunes the grace (young by default, placeholder at 1 min)', function () {
        var stamp = cr({ details_url: null, started_at: '2026-10-11T12:08:30Z' });
        var at = Date.parse('2026-10-11T12:10:00Z');
        assert.equal(cz.placeholders([stamp], at, {}).length, 0, '90 s old < 3-min default grace');
        assert.equal(cz.placeholders([stamp], at, { placeholderMinutes: 1 }).length, 1);
    });

    test('the #1457 d29efb16 replay: placeholders next to a green real run are detected at the 3-min grace', function () {
        // classify() alone reads the young placeholder LIVE (30-min stale
        // threshold) — the placeholder detector catches it 27 min earlier.
        var ph = cr({ name: 'Quality gate', details_url: null,
                      started_at: '2026-10-11T12:06:29Z' });
        var green = cr({ name: 'Quality gate', status: 'completed', conclusion: 'success',
                         started_at: '2026-10-11T12:08:00Z',
                         details_url: 'https://github.com/o/r/actions/runs/38137997380' });
        var at = Date.parse('2026-10-11T12:10:00Z');
        var out = cz.placeholders([ph, green], at, {});
        assert.equal(out.length, 1, 'exactly the placeholder — the green real stamp is evidence');
        // And the classify() partition still sees the ghost as live this
        // early (AC3 — the zombie path is untouched):
        var cls = cz.classify([ph, green], function () { return null; }, at, {});
        assert.equal(cls.zombies.length, 0);
    });
});

suite('checkRunZombies placeholders — zombie-shape partition (gh-852)', function () {
    test('hasPlaceholderZombies: true only when a zombie carries no run id (the placeholder shape)', function () {
        assert.equal(cz.hasPlaceholderZombies([{ name: 'a', runId: null, reason: 'stale-no-runner' }]), true);
        assert.equal(cz.hasPlaceholderZombies([{ name: 'a', runId: '42', reason: 'no-run' }]), false);
        assert.equal(cz.hasPlaceholderZombies([]), false);
        assert.equal(cz.hasPlaceholderZombies(null), false);
    });
});

suite('checkRunZombies placeholders — reset cap bookkeeping (gh-852 AC2)', function () {
    test('placeholderMarks counts ONLY markers inside the trailing per-PR window', function () {
        var now = Date.parse('2026-10-11T14:00:00Z');
        var bodies = [
            cz.placeholderMarkerLine(1, 3, '2026-10-11T13:30:00Z'),   // in window (30 min ago)
            cz.placeholderMarkerLine(2, 3, '2026-10-11T13:45:00Z'),   // in window (15 min ago)
            cz.placeholderMarkerLine(3, 3, '2026-10-11T11:00:00Z')    // OUTSIDE the 2h window
        ];
        var marks = cz.placeholderMarks(bodies, now, 2 * 60 * 60 * 1000);
        assert.equal(marks.count, 2, 'the stale 11:00 marker does not count against the cap');
        assert.equal(marks.lastAtMs, Date.parse('2026-10-11T13:45:00Z'));
    });

    test('placeholderRetryAllowed: under the cap yes, at the cap no', function () {
        assert.equal(cz.placeholderRetryAllowed({ count: 0, lastAtMs: null }, 3), true);
        assert.equal(cz.placeholderRetryAllowed({ count: 2, lastAtMs: 1 }, 3), true);
        assert.equal(cz.placeholderRetryAllowed({ count: 3, lastAtMs: 1 }, 3), false);
        assert.equal(cz.placeholderRetryAllowed(null, 3), true, 'no marks → allowed');
    });

    test('marker line round-trips through placeholderMarks', function () {
        var now = Date.parse('2026-10-11T14:00:00Z');
        var marks = cz.placeholderMarks([cz.placeholderMarkerLine(1, 3, '2026-10-11T13:59:00Z')],
                                        now, 2 * 60 * 60 * 1000);
        assert.equal(marks.count, 1);
    });

    test('cap/window knobs: defaults 3 per 2h, jobParams-tunable (string numbers too)', function () {
        assert.equal(cz.placeholderCapOf({}), 3);
        assert.equal(cz.placeholderCapOf({ placeholderResetCap: '5' }), 5);
        assert.equal(cz.placeholderCapOf({ placeholderResetCap: 0 }), 3, 'non-positive falls back');
        assert.equal(cz.placeholderWindowMsOf({}), 2 * 60 * 60 * 1000);
        assert.equal(cz.placeholderWindowMsOf({ placeholderResetWindowMs: '3600000' }), 3600000);
        assert.equal(typeof cz.DEFAULT_PLACEHOLDER_MINUTES, 'number');
    });
});

// ── gh-865: orphaned run-linked checks — the numeric-id placeholder twin ────
//
// Live fa #1457 (2026-10-11, head fd1b9aa2): a rework push created the
// kicker suite instantly; the SM dispatched CI only on its next tick
// (+18 min); GitHub's ~10-13 min speculative-placeholder window expired
// with no required-context stamps, so GitHub minted PENDING placeholder
// check-runs ON THE KICKER'S SUITE — WITH numeric run ids (run 38164305157,
// concluded success at 18:33:24). gh-852's detector keys on the ABSENT
// run id, so the gh-857 conclude step never saw them; classify() flags
// them 'run-concluded' but that path's remedy (same-sha re-dispatch)
// cannot cure a stamp nothing will ever conclude. They pinned
// mergeStateStatus=BLOCKED for 4+ hours with every real check green.
//
// Generalized orphan rule: a PENDING check-run whose OWNING RUN has
// CONCLUSIONED (any conclusion, past the propagation grace) is
// definitionally orphaned — conclude it with the mirrored verdict. The
// call site keeps the gh-857 fail-safes (real green cover required, no
// live run on the head).

suite('checkRunZombies orphanedRunChecks — detection (gh-865)', function () {
    var KICKER_RUN = '38164305157';     // the concluded kicker suite run
    var AT = Date.parse('2026-10-11T22:40:00Z');

    function orphanCr(extra) {
        var base = { id: 114566277295, name: 'Quality gate',
                     status: 'in_progress', conclusion: null,
                     started_at: '2026-10-11T18:33:45Z',
                     details_url: 'https://github.com/o/r/actions/runs/' + KICKER_RUN };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) base[k] = extra[k]; } }
        return base;
    }

    function kickerResolver(extra, opts) {
        var map = {};
        map[KICKER_RUN] = { id: KICKER_RUN, status: 'completed', conclusion: 'success',
                            updated_at: '2026-10-11T18:33:24Z' };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) map[k] = extra[k]; } }
        return resolver(map, opts || {});
    }

    test('the fd1b9aa2 replay: an in_progress check-run whose owning run concluded IS an orphan', function () {
        var out = cz.orphanedRunChecks([orphanCr()], kickerResolver(), AT, {});
        assert.equal(out.length, 1);
        assert.equal(out[0].name, 'Quality gate');
        assert.equal(out[0].runId, KICKER_RUN);
        assert.equal(out[0].id, 114566277295, 'the check-run id rides the entry (PATCH target)');
        assert.equal(out[0].reason, 'orphan-run-concluded');
    });

    test('MULTI-ITEM: three orphan contexts on one concluded suite are all detected', function () {
        // The real head carried THREE pseudo-job check-runs on the same
        // kicker suite — a single-item test would pass while multi-item
        // iteration was broken.
        var crs = [
            orphanCr({ id: 114566277295, name: 'Quality gate' }),
            orphanCr({ id: 114566278905, name: 'JS engine integration (quickjs-ng)',
                       started_at: '2026-10-11T18:33:50Z' }),
            orphanCr({ id: 114566280823, name: 'Binaries smoke gate',
                       started_at: '2026-10-11T18:33:55Z' })
        ];
        var out = cz.orphanedRunChecks(crs, kickerResolver(), AT, {});
        assert.equal(out.length, 3);
        assert.deepEqual(out.map(function (o) { return o.id; }),
            [114566277295, 114566278905, 114566280823]);
    });

    test('the owning run still in_progress → the check is NOT an orphan (AC2 — untouched)', function () {
        var live = {};
        live[KICKER_RUN] = { id: KICKER_RUN, status: 'in_progress', conclusion: null };
        var out = cz.orphanedRunChecks([orphanCr()], resolver(live, {}), AT, {});
        assert.equal(out.length, 0);
    });

    test('a run that concluded CANCELLED still orphans its pending checks (any conclusion)', function () {
        var map = {};
        map[KICKER_RUN] = { id: KICKER_RUN, status: 'completed', conclusion: 'cancelled',
                            updated_at: '2026-10-11T18:33:24Z' };
        var out = cz.orphanedRunChecks([orphanCr()], resolver(map, {}), AT, {});
        assert.equal(out.length, 1, 'the run is over — nothing will ever conclude the check');
        assert.equal(out[0].reason, 'orphan-run-concluded');
    });

    test('the owning run ABSENT from the head list is NOT this detector\'s orphan (no-run keeps the legacy remedy)', function () {
        // classify() 'no-run' zombies deliberately keep the re-dispatch
        // remedy (AC3) — the two detectors are disjoint by design.
        var out = cz.orphanedRunChecks([orphanCr()], resolver({}, {}), AT, {});
        assert.equal(out.length, 0);
    });

    test('a conclusion inside the propagation grace is still landing — NOT an orphan (fail safe)', function () {
        var young = Date.parse('2026-10-11T18:36:00Z');   // 2.5 min after 18:33:24
        var out = cz.orphanedRunChecks([orphanCr()], kickerResolver(), young, {});
        assert.equal(out.length, 0);
        var later = Date.parse('2026-10-11T18:39:00Z');   // 5.5 min after
        out = cz.orphanedRunChecks([orphanCr()], kickerResolver(), later, {});
        assert.equal(out.length, 1, 'past the 5-min grace the same check is an orphan');
    });

    test('a probe error fails SAFE toward live (retry next tick, never a wrongful conclusion)', function () {
        var out = cz.orphanedRunChecks([orphanCr()],
                                       kickerResolver({}, { throwFor: [KICKER_RUN] }), AT, {});
        assert.equal(out.length, 0);
    });

    test('a completed run with NO conclusion is odd — NOT an orphan (mirrors classify fail-safe)', function () {
        var map = {};
        map[KICKER_RUN] = { id: KICKER_RUN, status: 'completed', conclusion: null,
                            updated_at: '2026-10-11T18:33:24Z' };
        var out = cz.orphanedRunChecks([orphanCr()], resolver(map, {}), AT, {});
        assert.equal(out.length, 0);
    });

    test('settled check-runs and link-less stamps are NOT orphans (complementary to the placeholder detector)', function () {
        var settled = orphanCr({ status: 'completed', conclusion: 'success' });
        var linkLess = orphanCr({ id: 991234001, details_url: null,
                                  started_at: '2026-10-11T18:33:45Z' });
        var out = cz.orphanedRunChecks([settled, linkLess], kickerResolver(), AT, {});
        assert.equal(out.length, 0, 'the placeholder detector owns the link-less shape');
        // And the placeholder detector does NOT see the numeric-id orphan:
        var ph = cz.placeholders([orphanCr(), linkLess], AT, {});
        assert.equal(ph.length, 1);
        assert.equal(ph[0].id, 991234001);
    });

    test('runConcludedGraceMinutes tunes the propagation window', function () {
        var at4min = Date.parse('2026-10-11T18:37:24Z');   // exactly 4 min after
        assert.equal(cz.orphanedRunChecks([orphanCr()], kickerResolver(), at4min, {}).length, 0);
        assert.equal(cz.orphanedRunChecks([orphanCr()], kickerResolver(), at4min,
                                          { runConcludedGraceMinutes: 2 }).length, 1);
    });
});

suite('checkRunZombies — #1457 timeline replay', function () {
    test('three ghost contexts (run deleted) next to green terminal entries ⇒ 3 zombies, gate ghost-held', function () {
        // fa #1457 head 7d00a1b2, 2026-10-10 ~14:30→16:00Z:
        //   "Quality gate" / "Binaries smoke gate" / "JS engine integration
        //   (quickjs-ng)" each carried an in_progress check-run whose run
        //   no longer exists (html_url unresolvable) — the 14:3x dispatch
        //   was cancelled while queued and the run later deleted;
        //   PLUS terminal SUCCESS entries from run 38057801418 (green, 13:58).
        var headRuns = {};
        headRuns[RUN_GREEN] = { id: RUN_GREEN, status: 'completed', conclusion: 'success',
                                updated_at: '2026-10-10T13:58:00Z' };
        // RUN_DEAD is ABSENT — the deleted run is not in the head's list.
        var checkRuns = [
            cr({ name: 'Quality gate' }),
            cr({ name: 'Binaries smoke gate' }),
            cr({ name: 'JS engine integration (quickjs-ng)' }),
            cr({ name: 'Quality gate', status: 'completed', conclusion: 'success',
                 details_url: 'https://github.com/o/r/actions/runs/' + RUN_GREEN }),
            cr({ name: 'Binaries smoke gate', status: 'completed', conclusion: 'success',
                 details_url: 'https://github.com/o/r/actions/runs/' + RUN_GREEN }),
            cr({ name: 'JS engine integration (quickjs-ng)', status: 'completed', conclusion: 'success',
                 details_url: 'https://github.com/o/r/actions/runs/' + RUN_GREEN })
        ];
        var out = cz.classify(checkRuns, resolver(headRuns, {}),
                              Date.parse('2026-10-10T15:00:00Z'), {});
        assert.equal(out.zombies.length, 3);
        assert.deepEqual(out.zombies.map(function (z) { return z.reason; }),
            ['no-run', 'no-run', 'no-run']);
        assert.equal(out.live, 0);
        assert.equal(out.settled, 3, 'the green 13:58 terminal entries are settled evidence');
    });
});

// ── gh-998: placeholder lifecycle state machine + sweper ────────────────────
//
// Live fa #1563 (2026-10-17, head f3d58647): the SM-registered placeholder
// `Quality gate` (check-run 117469671401, kicker suite 105847141092) stayed
// in_progress 40+ minutes past its cycle and held mergeStateStatus=BLOCKED
// with 58 green sibling checks (incl. a genuine Quality gate success). The
// gh-857 close path only covers the SUCCESS row (and only with a green
// cover); failure/superseded/cancelled/died rows and pre-fix leaks had no
// close path at all. AC1: the lifecycle state machine; the sweper detection
// reuses the gh-865 orphan rule (terminal owner) — covered above.

suite('checkRunZombies cycle lifecycle — conclusion mapping (gh-998 AC1)', function () {
    test('the capability table: success→success, failure→failure, superseded/cancelled/died→neutral', function () {
        assert.equal(cz.conclusionForOutcome('success'), 'success');
        assert.equal(cz.conclusionForOutcome('failure'), 'failure');
        assert.equal(cz.conclusionForOutcome('superseded'), 'neutral');
        assert.equal(cz.conclusionForOutcome('cancelled'), 'neutral');
        assert.equal(cz.conclusionForOutcome('died'), 'neutral');
    });

    test('an UNKNOWN outcome maps to null (no verdict is invented)', function () {
        assert.equal(cz.conclusionForOutcome('bogus'), null);
        assert.equal(cz.conclusionForOutcome(null), null);
        assert.equal(cz.conclusionForOutcome(undefined), null);
    });
});

suite('checkRunZombies cycle lifecycle — state machine (gh-998 AC1)', function () {
    test('register → open; each of the five outcomes closes with the mapped conclusion — no transition leaves the object open', function () {
        ['success', 'failure', 'superseded', 'cancelled', 'died'].forEach(function (outcome) {
            var cycle = cz.openCycle([{ name: 'Quality gate' }, { name: 'Binaries smoke gate' }]);
            assert.equal(cycle.state, 'open');
            var closed = cz.closePlaceholderCycle(cycle, outcome);
            assert.ok(closed, outcome + ' closes the cycle');
            assert.equal(closed.state, 'closed');
            assert.equal(closed.conclusion, cz.conclusionForOutcome(outcome));
            assert.equal(closed.placeholders.length, 2, 'the close obligation covers EVERY registered placeholder');
        });
    });

    test('MULTI-ITEM: one close call concludes a whole 3-placeholder cycle (no per-item leak)', function () {
        var cycle = cz.openCycle([{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }]);
        var closed = cz.closePlaceholderCycle(cycle, 'superseded');
        assert.equal(closed.conclusion, 'neutral');
        assert.equal(closed.placeholders.length, 3);
    });

    test('an UNKNOWN outcome leaves the cycle OPEN (fail safe — the close obligation is retried, never dropped)', function () {
        var cycle = cz.openCycle([{ name: 'Quality gate' }]);
        assert.equal(cz.closePlaceholderCycle(cycle, 'bogus'), null);
        assert.equal(cycle.state, 'open');
    });

    test('closing a CLOSED cycle is rejected (idempotence — no double close, no double metric count, gh-998 E1)', function () {
        var cycle = cz.openCycle([{ name: 'Quality gate' }]);
        var closed = cz.closePlaceholderCycle(cycle, 'cancelled');
        assert.equal(cz.closePlaceholderCycle(closed, 'success'), null,
            'a second close of the same cycle is a no-op');
    });

    test('closing a null / non-open cycle is rejected', function () {
        assert.equal(cz.closePlaceholderCycle(null, 'success'), null);
        assert.equal(cz.closePlaceholderCycle({ state: 'closed' }, 'success'), null);
    });
});

suite('checkRunZombies sweper — observability (gh-998 I5)', function () {
    test('zombie-swept machine-log line: `zombie-swept: <check-run-id> head <sha>`', function () {
        assert.equal(cz.zombieSweptLine(117469671401, 'f3d58647'),
                     'zombie-swept: 117469671401 head f3d58647');
    });
});

// ── classify: fail-safe corners + multi-item batch (gh-1085 characterization) ─

suite('checkRunZombies classify — fail-safe corners', function () {
    test('completed + conclusion-less backing run → live', function () {
        var map = {};
        map[RUN_DEAD] = { status: 'completed', conclusion: null, updated_at: '2026-10-10T14:55:00Z' };
        var out = cz.classify([cr()], resolver(map, {}), NOW, {});
        assert.equal(out.live, 1);
        assert.equal(out.zombies.length, 0);
        assert.equal(out.unresolvable, 0);
    });

    test('completed + EMPTY-string conclusion → live (odd, fail safe)', function () {
        var map = {};
        map[RUN_DEAD] = { status: 'completed', conclusion: '', updated_at: '2026-10-10T14:55:00Z' };
        var out = cz.classify([cr()], resolver(map, {}), NOW, {});
        assert.equal(out.live, 1);
        assert.equal(out.zombies.length, 0);
    });

    test('unknown backing-run status vocabulary → live (fail safe)', function () {
        var map = {};
        map[RUN_DEAD] = { status: 'weird_vocabulary', updated_at: '2026-10-10T14:55:00Z' };
        var out = cz.classify([cr()], resolver(map, {}), NOW, {});
        assert.equal(out.live, 1);
        assert.equal(out.zombies.length, 0);
        assert.equal(out.unresolvable, 0);
    });
});

suite('checkRunZombies classify — multi-item batch (gh-1085)', function () {
    test('one call partitions a mixed batch: every reason lands exactly once, zombies keep input order', function () {
        var RUN_LAG = '38222222222';     // concluded inside the propagation grace → live
        var RUN_ODD = '38333333333';     // completed, no conclusion → live (fail safe)
        var RUN_GONE = '38099999998';    // absent from the head's run list → no-run
        var checkRuns = [
            cr({ name: 'ctx-no-run', details_url: 'https://github.com/o/r/actions/runs/' + RUN_GONE }),
            cr({ name: 'ctx-cancelled' }),                                         // (same dead run id — cancelled below)
            cr({ name: 'ctx-live', details_url: 'https://github.com/o/r/actions/runs/' + RUN_LIVE }),
            cr({ name: 'ctx-lag', details_url: 'https://github.com/o/r/actions/runs/' + RUN_LAG }),
            cr({ name: 'ctx-odd', details_url: 'https://github.com/o/r/actions/runs/' + RUN_ODD }),
            { name: 'ctx-stale', status: 'in_progress', conclusion: null,
              started_at: '2026-10-10T13:00:00Z' },                                 // no link, 2h old → stale-no-runner
            cr({ name: 'ctx-probe-error', details_url: 'https://github.com/o/r/actions/runs/999' }),
            { name: 'ctx-settled', status: 'completed', conclusion: 'success' }      // terminal — never zombie material
        ];
        var map = {};
        map[RUN_DEAD] = { status: 'completed', conclusion: 'cancelled', updated_at: '2026-10-10T14:00:00Z' };
        map[RUN_LIVE] = { status: 'in_progress', updated_at: '2026-10-10T14:59:00Z' };
        map[RUN_LAG] = { status: 'completed', conclusion: 'success', updated_at: '2026-10-10T14:56:30Z' };
        map[RUN_ODD] = { status: 'completed', conclusion: null, updated_at: '2026-10-10T14:50:00Z' };
        var out = cz.classify(checkRuns, resolver(map, { throwFor: ['999'] }), NOW, {});

        assert.equal(out.zombies.length, 3);
        assert.equal(out.zombies[0].name, 'ctx-no-run');
        assert.equal(out.zombies[0].reason, 'no-run');
        assert.equal(out.zombies[1].name, 'ctx-cancelled');
        assert.equal(out.zombies[1].reason, 'cancelled');
        assert.equal(out.zombies[2].name, 'ctx-stale');
        assert.equal(out.zombies[2].reason, 'stale-no-runner');
        assert.equal(out.live, 4, 'live + lag + odd + probe-error');
        assert.equal(out.unresolvable, 1);
        assert.equal(out.settled, 1);
    });
});
