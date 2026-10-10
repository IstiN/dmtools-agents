/**
 * Red-verdict convergence (gh-832) — repeated red validation verdicts on an
 * approved head must CONVERGE, never loop dispatch→red→unarm→rearm forever.
 *
 * Live fa PR #1453 (2026-10-10 00:20–08:00Z): 12 dispatch→red→unarm→rearm
 * cycles on an approved head, 5 concluded FAILUREs in a row (the PTY/CLI
 * shard 0/3 flake), zero merges fleet-wide for 3.5h. The existing guards
 * could not stop it: the empty-lap cap and the redHeadSkip arm-side skip
 * are per-head-SHA marker counters — every head refresh resets them, and
 * even when they fire their terminal state is a SILENT log line (no park,
 * no comment). Machine-authored PRs were never parked at all (gh-757 parks
 * guests only) — so a fleet-wide flake in main looped the whole window,
 * and the quarantine PR (#1470) could not merge through it.
 *
 * This module is the pure half of the fix: the consecutive-red streak is
 * DERIVED from the head's own dispatched run history (the durable per-head
 * record, same github_list_workflow_runs list the fail path already fetches
 * for its failed-run link line) — no new markers, no new state carriers:
 *
 *   streakFromRuns(runs, headSha) — trailing count of consecutive concluded
 *      red verdict runs on THIS head (workflow_dispatch only, newest-first).
 *      A 'success' run breaks the streak (gh-832 AC2: a green verdict resets
 *      the counter); 'cancelled' runs are skipped (gh-755 — CANCELLED is
 *      never a verdict, it neither counts nor resets); any other concluded
 *      conclusion (failure/timed_out/…) counts as a red verdict word (sweep
 *      parity). A head change resets the streak by construction — the count
 *      is filtered to the exact head SHA (gh-832 AC2).
 *   parkCapOf(jobParams) — jobParams.redHeadParkCap (default 2): at N
 *      consecutive reds on the unchanged head the fail path parks
 *      validation_failed + a report naming the failing job(s). 0 or
 *      'false' disables the park (deployment escape hatch; the red-head
 *      marker audit trail and the 3-red arm-side skip are unaffected).
 *
 * Pure functions, no tool globals — smAgent wires the transport, tests
 * inject nothing. CommonJS module like every other js/ module. GraalJS
 * rules apply: var + plain functions only.
 */

'use strict';

/**
 * The head's consecutive concluded-red verdict count, derived from the
 * dispatched-run list (REST shape: [{ event, head_sha, status, conclusion,
 * created_at, updated_at }, …], any order — sorted here newest-first).
 *
 * Walk newest-first over THIS head's workflow_dispatch runs:
 *   completed + conclusion 'success'      → streak ends (green reset, AC2)
 *   completed + conclusion 'cancelled'    → skipped (gh-755: never a verdict)
 *   completed + anything else             → red verdict — streak++
 *   any other status (queued/…)           → ignored (not a verdict)
 * Runs of other heads, other events, and null entries never participate.
 * A null/failed fetch degrades to 0 (fail OPEN: no park on a degraded read —
 * the red-head marker skip still bounds the re-arm arm at 3).
 */
function streakFromRuns(runs, headSha) {
    if (!headSha || !Array.isArray(runs)) return 0;
    var mine = runs.filter(function (r) {
        return r && r.event === 'workflow_dispatch' &&
            r.head_sha === headSha && r.status === 'completed';
    });
    mine.sort(function (a, b) {
        return Date.parse(b.updated_at || b.created_at || 0) -
               Date.parse(a.updated_at || a.created_at || 0);
    });
    var streak = 0;
    for (var i = 0; i < mine.length; i++) {
        var c = mine[i].conclusion ? String(mine[i].conclusion) : null;
        if (!c || c === 'cancelled') continue;      // gh-755 — no verdict word
        if (c === 'success') break;                 // AC2 — green resets
        streak++;
    }
    return streak;
}

/**
 * The convergence park threshold: how many consecutive red verdicts on an
 * unchanged head park validation_failed. Default 2 (gh-832 AC1: the SECOND
 * consecutive red parks — no third dispatch). jobParams.redHeadParkCap tunes
 * it per deployment; 0 / negative / 'false' disable the park entirely.
 */
function parkCapOf(jobParams) {
    if (String((jobParams || {}).redHeadParkCap) === 'false') return 0;
    var n = (jobParams || {}).redHeadParkCap;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    if (typeof n !== 'number' || isNaN(n) || n <= 0) return 2;
    return Math.floor(n);
}

/**
 * The park decision at fail time: the CURRENT red is already in the fetched
 * run list, so the streak includes it — park when streak >= cap.
 */
function shouldPark(streak, cap) {
    return cap > 0 && streak >= cap;
}

module.exports = {
    streakFromRuns: streakFromRuns,
    parkCapOf: parkCapOf,
    shouldPark: shouldPark
};
