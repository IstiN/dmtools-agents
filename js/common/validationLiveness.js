/**
 * Validation liveness (gh-821) — the arm-must-mean-a-live-run state machine.
 *
 * Live fa PR #1443 (2026-10-09 13:36–15:00Z): the dispatched validation run
 * concluded CANCELLED (kicker/dispatch race, gh-748 guard family) while the
 * `ai_validating` arm stayed on; the stale-arm sweeper skipped it ("no
 * concluded-and-stale validation run on the head — arm stays") and four
 * validated PRs deferred on the mutex for ~2h until a manual
 * `gh workflow run ci.yml --ref <head>` unstick. CANCELLED is never a
 * VERDICT (gh-755 — no rework on a cancel), but a cancel (or a lost
 * dispatch) behind an arm is a ZOMBIE: the mutex is held with no live run
 * behind it, which is exactly what the serial slot must never do.
 *
 * This module is the pure half of the fix:
 *
 *   classify(probe)  — the liveness state machine over a
 *                      probeDispatchedState bundle: 'running' (in-flight,
 *                      or concluded inside the check-visibility grace),
 *                      'green' / 'red' (verdict paths — callers keep their
 *                      existing consumption), 'zombie-cancelled' /
 *                      'zombie-no-run' (the arm holds the slot with no
 *                      live run; caller re-dispatches, bounded).
 *   zombie marks     — durable per-head re-dispatch bookkeeping carried in
 *                      marker comments (the red-head/empty-lap carrier:
 *                      per-PR state with zero extra infrastructure). One
 *                      marker per re-dispatch gives the crash-loop guard
 *                      (3 in a row on the same head ⇒ park) and the rate
 *                      bound (1 auto re-dispatch per head per hour).
 *
 * Probe-error degeneracy: newestDispatchedRun fails CLOSED (null on error
 * AND on an empty list), so a degraded read classifies as 'zombie-no-run'.
 * That is the documented fail-open contract of the dispatch guards — the
 * worst case is one bounded duplicate CI run (1/head/hour), never a wedge;
 * the alternative (treating a probe outage as live) re-creates the deadlock
 * this module exists to break.
 *
 * Pure functions, no tool globals — smAgent wires the transport, tests
 * inject nothing. CommonJS module like every other js/ module. GraalJS
 * rules apply: var + plain functions only.
 */

'use strict';

// Run states that mean "a run is materially in flight" — THE single source
// of truth for that vocabulary (gh-821 round-2 review): smAgent's
// hasActiveDispatchedRun and hasActiveHeadRun consume this constant instead
// of keeping parallel inline lists that drift. The PROBE_WORKER_SOURCE copy
// in smAgent keeps its own literal list by necessity (the worker source is
// serialized via fn.toString() and cannot close over module scope).
var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending'];

// ── Liveness classification ────────────────────────────────────────────────

/**
 * Classify the head's dispatched-run state from one probeDispatchedState
 * bundle ({ active, verdict, green, newest }).
 *
 *   'running'          — a live run exists (queued/in_progress/waiting/
 *                        pending), OR the newest run concluded inside the
 *                        check-visibility grace (hasActiveDispatchedRun
 *                        counts a completed run active for 15 min after its
 *                        conclusion — the verdict race window gh-755 and the
 *                        rerun-cancelled-checks remedy own; a FRESH cancel
 *                        therefore still reads 'running', never a zombie).
 *   'green'            — newest concluded success (verdict path).
 *   'red'              — newest concluded failure/timed_out/… — any
 *                        non-cancelled, non-success conclusion is a verdict
 *                        word (sweep parity: the existing code treats every
 *                        `conclusion !== 'cancelled'` as sweepable).
 *   'zombie-cancelled' — newest concluded CANCELLED outside every grace —
 *                        no verdict, no live run: the arm dead-holds.
 *   'zombie-no-run'    — no dispatched run on the head at all (lost
 *                        dispatch, silent gh CLI failure): same dead-hold.
 *
 * Missing probe / odd per-facet shapes fail SAFE toward 'running' (arm
 * stays). A fully-failed probe (every facet at its catch default) reads
 * 'zombie-no-run' — the deliberate gh-821 bias documented in the header:
 * worst case one bounded duplicate CI run, never a wedge.
 */
function classify(probe) {
    var newest = (probe && probe.newest) || null;
    if (!probe) return 'running';                 // no probe at all — fail safe
    if (probe.active === true) return 'running';
    if (!newest) return 'zombie-no-run';
    if (newest.status !== 'completed') return 'running'; // defensive: active should have caught it
    var c = newest.conclusion ? String(newest.conclusion) : null;
    if (!c) return 'running';                     // completed, no conclusion yet
    if (c === 'cancelled') return 'zombie-cancelled';
    if (c === 'success') return 'green';
    return 'red';
}

// ── Zombie re-dispatch markers (durable per-head bookkeeping) ───────────────
//
// One standalone PR comment per zombie re-dispatch, carrying the marker
// line the next tick's guard re-reads (failMarkerState parity — same
// single github_get_pr_comments fetch as the red-head/empty-lap markers):
//
//   🔄 zombie re-dispatch <fullHeadSha> — zombie <N>/<cap> at <iso>
//
// The head SHA keys the count: a head move (new push) starts a fresh
// count by construction, so "3 in a row on the same head" is exactly
// "3 markers for this SHA".

var ZOMBIE_MARKER_RE = /\uD83D\uDD04 zombie re-dispatch ([0-9a-f]{7,40}) \u2014 zombie (\d+)\/\d+ at (\S+)/g;

/**
 * Aggregate marker lines over comment bodies →
 * { <fullSha>: { count: <max N>, lastAtMs: <newest marker epoch ms> } }.
 * Malformed lines and other heads' markers are ignored; unparsable
 * timestamps degrade to lastAtMs=null (the rate bound then cannot fire —
 * the crash-loop cap still can, it reads the count only).
 */
function zombieMarks(bodies) {
    var map = {};
    (bodies || []).forEach(function (body) {
        var s = String(body == null ? '' : body);
        ZOMBIE_MARKER_RE.lastIndex = 0;
        var m;
        while ((m = ZOMBIE_MARKER_RE.exec(s)) !== null) {
            var sha = m[1];
            var n = parseInt(m[2], 10) || 0;
            var atMs = Date.parse(m[3]);
            var cur = map[sha];
            if (!cur) {
                cur = map[sha] = { count: 0, lastAtMs: null };
            }
            if (n > cur.count) cur.count = n;
            if (!isNaN(atMs) && (cur.lastAtMs === null || atMs > cur.lastAtMs)) {
                cur.lastAtMs = atMs;
            }
        }
    });
    return map;
}

/**
 * The marker line for the NEXT re-dispatch on this head (count = prior + 1 —
 * the caller holds the already-read marks; no second comment fetch).
 */
function zombieMarkerLine(count, headSha, cap, atIso) {
    return '\uD83D\uDD04 zombie re-dispatch ' + headSha +
        ' \u2014 zombie ' + count + '/' + cap + ' at ' + (atIso || '');
}

/**
 * Crash-loop cap: 3 zombie re-dispatches in a row on the same head (gh-821
 * AC2). jobParams.zombieRedispatchCap tunes it per deployment.
 */
function zombieCapOf(jobParams) {
    var n = (jobParams || {}).zombieRedispatchCap;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    return (typeof n === 'number' && n > 0) ? Math.floor(n) : 3;
}

/**
 * Rate bound: 1 auto re-dispatch per head per hour (gh-821 zombie rule —
 * bounded churn under a repeated cancel-loop). jobParams.zombieRedispatchMinMs
 * tunes it per deployment; 0 disables the bound (cap still applies).
 */
function zombieWindowMsOf(jobParams) {
    var n = (jobParams || {}).zombieRedispatchMinMs;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    if (typeof n !== 'number' || isNaN(n) || n < 0) return 60 * 60 * 1000;
    return Math.floor(n);
}

// ── Stale-cancel markers (gh-846) ───────────────────────────────────────────
//
// The refresh-path twin of the zombie marker: when a silent update moves
// the head, every dispatched validation run on the superseded head is
// cancelled (its result would be discarded). One marker line per cancelled
// head records the 'cancelled: stale base' reason durably on the PR — the
// gh-755 parity contract: CANCELLED is never a VERDICT, so the line is
// bookkeeping/audit only. No tick-side machinery consumes it (the verdict
// probes skip cancelled conclusions by construction; the zombie re-dispatch
// and red-head counters key on head shas and only ever read the CURRENT
// head), which is exactly why a cancelled-stale run can never trip
// fail-validation / zombie re-dispatch / red-head counting (AC3).
//
//   🛑 stale-cancel <fullHeadSha> — stale base at <iso>

var STALE_CANCEL_MARKER_RE = /\uD83D\uDED1 stale-cancel ([0-9a-f]{7,40}) \u2014 stale base at (\S+)/g;

/**
 * The marker line for one stale-cancelled head. Caller dedupes shas and
 * joins lines; count/cap are meaningless here (a head is cancelled once).
 */
function staleCancelMarkerLine(headSha, atIso) {
    return '\uD83D\uDED1 stale-cancel ' + headSha +
        ' \u2014 stale base at ' + (atIso || '');
}

module.exports = {
    classify: classify,
    zombieMarks: zombieMarks,
    zombieMarkerLine: zombieMarkerLine,
    zombieCapOf: zombieCapOf,
    zombieWindowMsOf: zombieWindowMsOf,
    ZOMBIE_MARKER_RE: ZOMBIE_MARKER_RE,
    ACTIVE_RUN_STATES: ACTIVE_RUN_STATES,
    STALE_CANCEL_MARKER_RE: STALE_CANCEL_MARKER_RE,
    staleCancelMarkerLine: staleCancelMarkerLine
};
