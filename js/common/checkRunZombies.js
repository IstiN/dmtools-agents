/**
 * Check-run zombies (gh-842) — the gate-ghost classifier.
 *
 * Live fa #1457 (2026-10-10, head 7d00a1b2, ~14:30→16:00Z): a dispatched CI
 * run was CANCELLED while queued (gh-748 twin-guard family) and later ceased
 * to exist; the `in_progress` check runs it had registered on the head were
 * never concluded. Branch protection takes the LATEST check-run per
 * (context, head), so the ghosts held mergeStateStatus=BLOCKED for ~2h even
 * though the head ALSO carried terminal GREEN entries from the earlier run
 * 38057801418 (green, 13:58). The tick's green-cover guard (skipIfGreenCi)
 * read the surviving green run as covering the head — "the blocker is not
 * this CI" — and never re-dispatched; the window idled until an operator
 * nudged a fresh dispatch. The gh-821 zombie sweep missed it because the
 * dispatched-RUN probe reads green (the newest EXISTING run is the old
 * green one) — gh-821 classifies runs, gh-842 classifies the check-RUN
 * ghosts those dead runs leave on the gate.
 *
 * This module is the pure half of the fix:
 *
 *   classify(checkRuns, resolveRun, nowMs, opts)
 *                      — partition a head's check-runs: every PENDING
 *                      (queued/in_progress, no conclusion) check-run whose
 *                      backing workflow run is ABSENT (deleted/404),
 *                      concluded CANCELLED, concluded non-cancelled past a
 *                      short propagation grace, or link-less and stale past
 *                      the no-runner threshold, is a ZOMBIE. Everything
 *                      else — concluded checks, live runs, fresh stamps,
 *                      probe errors — is LIVE (AC2: a genuinely in-progress
 *                      run is NEVER disturbed; every unprovable case fails
 *                      SAFE toward live, a missed zombie retries next tick
 *                      while a wrongful re-dispatch burns CI).
 *   runIdOf(checkRun)  — the backing workflow-run id parsed out of
 *                      details_url/html_url (`/actions/runs/<id>`); bridge
 *                      stamps dispatched without a run URL carry none.
 *
 * A zombie's context counts as ABSENT (gh-921 semantics) in the caller: the
 * surviving evidence decides the real rollup, and the caller re-dispatches
 * validation so the fresh stamps become the LATEST per context and override
 * the ghosts on the gate.
 *
 * Pure functions, no tool globals — smAgent wires the transport (the
 * bridge check-runs tool + the head run list as the resolver's source),
 * tests inject nothing. CommonJS module like every other js/ module.
 * GraalJS rules apply: var + plain functions only.
 */

'use strict';

// A check-run is PENDING when GitHub reports it queued/in-flight and no
// conclusion has landed. The settled vocabulary (concluded check-runs) is
// never zombie material — a green terminal entry next to a ghost stays
// green evidence for the surviving rollup.
var PENDING_STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

// Run states that mean "a runner is (or will be) behind this" — the AC2
// vocabulary, same live-run bias as validationLiveness.ACTIVE_RUN_STATES
// plus GitHub's 'requested' pre-queue state.
var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

// Defaults (jobParams-tunable at the smAgent call site):
//  - a link-less bridge stamp older than 30 min with no runner behind it is
//    a ghost (a live dispatch concludes/updates its stamp well inside that);
//  - a check run whose backing run concluded non-cancelled inside 5 min is
//    still propagating its conclusion (lag, not a ghost).
var DEFAULT_STALE_NO_RUNNER_MINUTES = 30;
var DEFAULT_RUN_CONCLUDED_GRACE_MINUTES = 5;

function runIdOf(checkRun) {
    if (!checkRun) return null;
    var url = checkRun.details_url || checkRun.detailsUrl ||
              checkRun.html_url || checkRun.htmlUrl || '';
    var m = /\/actions\/runs\/(\d+)/.exec(String(url));
    return m ? m[1] : null;
}

function isPendingCheckRun(checkRun) {
    if (!checkRun || checkRun.conclusion) return false;
    var s = checkRun.status ? String(checkRun.status).toLowerCase() : '';
    return PENDING_STATUSES.indexOf(s) !== -1;
}

function _num(opts, key, dflt) {
    var n = opts ? opts[key] : null;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    return (typeof n === 'number' && !isNaN(n) && n >= 0) ? n : dflt;
}

function _startedAtMs(checkRun) {
    var ts = Date.parse(checkRun.started_at || checkRun.startedAt ||
                        checkRun.created_at || checkRun.createdAt || '');
    return isNaN(ts) ? null : ts;
}

/**
 * Partition the head's check-runs into zombies vs live.
 *
 * @param checkRuns  [{name, status, conclusion, started_at, details_url}]
 * @param resolveRun fn(runId) → null when the backing run does NOT exist
 *                   (deleted/404 — the resolver's source is the head's run
 *                   list: absent ⇒ 404-equivalent) | {status, conclusion,
 *                   updated_at}; THROWS on probe error (fails safe to live).
 * @param nowMs      epoch ms (Date.now() at the probe).
 * @param opts       {staleNoRunnerMinutes, runConcludedGraceMinutes}
 * @returns {zombies: [{name, runId, reason}], live, settled, unresolvable}
 *          reason ∈ 'no-run' | 'cancelled' | 'run-concluded' | 'stale-no-runner'
 */
function classify(checkRuns, resolveRun, nowMs, opts) {
    var out = { zombies: [], live: 0, settled: 0, unresolvable: 0 };
    var staleMs = _num(opts, 'staleNoRunnerMinutes', DEFAULT_STALE_NO_RUNNER_MINUTES) * 60 * 1000;
    var graceMs = _num(opts, 'runConcludedGraceMinutes', DEFAULT_RUN_CONCLUDED_GRACE_MINUTES) * 60 * 1000;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();

    (checkRuns || []).forEach(function (cr) {
        if (!isPendingCheckRun(cr)) { out.settled++; return; }

        var runId = runIdOf(cr);
        if (runId !== null && typeof resolveRun === 'function') {
            var state = null;
            var probeError = false;
            try { state = resolveRun(runId); } catch (e) { probeError = true; }
            if (probeError) {
                // Fail SAFE toward live: a missed zombie retries next tick;
                // a wrongful re-dispatch is the churn this guard exists to
                // prevent on healthy heads.
                out.live++;
                out.unresolvable++;
                return;
            }
            if (state === null || state === undefined) {
                // The backing run no longer exists (deleted → absent from
                // the head's run list). The #1457 shape: the run was
                // cancelled while queued and later ceased to exist.
                out.zombies.push({ name: (cr && cr.name) || null, runId: runId, reason: 'no-run' });
                return;
            }
            var st = state.status ? String(state.status).toLowerCase() : '';
            if (ACTIVE_RUN_STATES.indexOf(st) !== -1) {
                out.live++;          // AC2 — a runner is (or will be) behind it
                return;
            }
            if (st === 'completed') {
                var concl = state.conclusion ? String(state.conclusion).toLowerCase() : null;
                if (concl === 'cancelled') {
                    out.zombies.push({ name: (cr && cr.name) || null, runId: runId, reason: 'cancelled' });
                    return;
                }
                if (concl) {
                    var endTs = Date.parse(state.updated_at || state.updated_at ||
                                           state.created_at || '');
                    var lag = isNaN(endTs) ? null : now - endTs;
                    if (lag !== null && lag >= 0 && lag <= graceMs) {
                        out.live++;  // propagation lag — the conclusion is landing
                        return;
                    }
                    // The run ended (non-cancelled) and nobody concluded the
                    // check — a bridge that died mid-stamp left a ghost.
                    out.zombies.push({ name: (cr && cr.name) || null, runId: runId, reason: 'run-concluded' });
                    return;
                }
                out.live++;          // completed without a conclusion — odd, fail safe
                return;
            }
            out.live++;              // unknown status vocabulary — fail safe
            return;
        }

        // No run link (dispatch-bridge stamp at arm time carries no
        // details_url): staleness is the only liveness evidence. A fresh
        // stamp is a dispatch that JUST fired; an old one is a ghost whose
        // run died without concluding it. Unparseable/young → fail safe.
        var started = _startedAtMs(cr || {});
        if (started !== null && (now - started) > staleMs) {
            out.zombies.push({ name: (cr && cr.name) || null, runId: null, reason: 'stale-no-runner' });
            return;
        }
        out.live++;
    });

    return out;
}

module.exports = {
    classify: classify,
    runIdOf: runIdOf,
    isPendingCheckRun: isPendingCheckRun,
    PENDING_STATUSES: PENDING_STATUSES,
    ACTIVE_RUN_STATES: ACTIVE_RUN_STATES,
    DEFAULT_STALE_NO_RUNNER_MINUTES: DEFAULT_STALE_NO_RUNNER_MINUTES,
    DEFAULT_RUN_CONCLUDED_GRACE_MINUTES: DEFAULT_RUN_CONCLUDED_GRACE_MINUTES
};
