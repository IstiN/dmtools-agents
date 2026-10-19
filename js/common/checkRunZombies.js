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

// ── Placeholders (gh-852) ────────────────────────────────────────────────────
//
// The no-cancel variant of the gate ghost (live fa #1457, 2026-10-11, head
// d29efb16 + 3 predecessors): GitHub mints PENDING placeholder check-runs
// ~20s after a dispatch that queued without materializing a job; their
// html_url carries NO numeric run id. Orphaned when the real run never
// stamps their context, they pin mergeStateStatus=BLOCKED (branch
// protection takes the LATEST check-run per (context, head)) even with
// every real check green. A same-sha re-dispatch can NEVER cure them — a
// queued re-dispatch mints FRESH placeholders — so the engine remedy is a
// fresh-sha reset + an immediate-start validation, pool-probed and
// per-PR-window capped (see js/smAgent.js validate_pr).
//
//  - a link-less pending stamp younger than the placeholder grace may be a
//    bridge stamp of a dispatch that JUST fired (its run link lands
//    seconds later) — only AGE past the grace proves no runner is coming;
//  - the reset cap is per PR per window, NOT per head: every reset mints a
//    NEW head, so head-keyed counting would never reach a cap.
var DEFAULT_PLACEHOLDER_MINUTES = 3;
var DEFAULT_PLACEHOLDER_RESET_CAP = 3;
var DEFAULT_PLACEHOLDER_RESET_WINDOW_MS = 2 * 60 * 60 * 1000;

var PLACEHOLDER_MARKER_RE = /\uD83D\uDD01 placeholder reset (\d+)\/(\d+) at (\S+)/g;

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

// ── classify: per-check-run decision helpers (gh-1085) ──────────────────────
//
// The partition verdict for ONE check-run is computed by the small pure
// helpers below; classify() itself only tunes the knobs, iterates and
// tallies. Extraction keeps every branch covered by the characterization
// suite (test_checkRunZombies.js) — CRAP = CC at full coverage.

/** A zombie verdict: the caller re-dispatches (runId ghosts) or resets. */
function zombieVerdict(cr, runId, reason) {
    return { kind: 'zombie', zombie: { name: (cr && cr.name) || null, runId: runId, reason: reason } };
}

/** A live verdict; unresolvable marks the probe-error fail-safe (live + retry next tick). */
function liveVerdict(unresolvable) {
    return { kind: 'live', unresolvable: unresolvable === true };
}

// Linked-run decision tree: probe error → live (fail safe), backing run
// absent → 'no-run' zombie, everything else by the run's state vocabulary.
function classifyLinkedRun(cr, runId, resolveRun, nowMs, graceMs) {
    var state = null;
    var probeError = false;
    try { state = resolveRun(runId); } catch (e) { probeError = true; }
    if (probeError) {
        // Fail SAFE toward live: a missed zombie retries next tick;
        // a wrongful re-dispatch is the churn this guard exists to
        // prevent on healthy heads.
        return liveVerdict(true);
    }
    if (state === null || state === undefined) {
        // The backing run no longer exists (deleted → absent from
        // the head's run list). The #1457 shape: the run was
        // cancelled while queued and later ceased to exist.
        return zombieVerdict(cr, runId, 'no-run');
    }
    return verdictForRunState(cr, runId, state, nowMs, graceMs);
}

// Run-state vocabulary dispatch: ACTIVE → live (AC2), completed → the
// conclusion ladder, unknown vocabulary → live (fail safe).
function verdictForRunState(cr, runId, state, nowMs, graceMs) {
    var st = state.status ? String(state.status).toLowerCase() : '';
    if (ACTIVE_RUN_STATES.indexOf(st) !== -1) {
        return liveVerdict(false);       // AC2 — a runner is (or will be) behind it
    }
    if (st === 'completed') {
        return completedRunVerdict(cr, runId, state, nowMs, graceMs);
    }
    return liveVerdict(false);           // unknown status vocabulary — fail safe
}

// A completed backing run: cancelled → zombie, concluded non-cancelled →
// propagation-lag check, conclusion-less → odd, fail safe toward live.
function completedRunVerdict(cr, runId, state, nowMs, graceMs) {
    var concl = state.conclusion ? String(state.conclusion).toLowerCase() : null;
    if (concl === 'cancelled') {
        return zombieVerdict(cr, runId, 'cancelled');
    }
    if (concl) {
        return concludedRunVerdict(cr, runId, state, nowMs, graceMs);
    }
    return liveVerdict(false);           // completed without a conclusion — odd, fail safe
}

// Non-cancelled conclusion on the backing run: inside the propagation grace
// the conclusion is still landing (live); past it the bridge died mid-stamp.
function concludedRunVerdict(cr, runId, state, nowMs, graceMs) {
    var endTs = Date.parse(state.updated_at || state.created_at || '');
    var lag = isNaN(endTs) ? null : nowMs - endTs;
    if (lag !== null && lag >= 0 && lag <= graceMs) {
        return liveVerdict(false);       // propagation lag — the conclusion is landing
    }
    return zombieVerdict(cr, runId, 'run-concluded');
}

// No run link (dispatch-bridge stamp at arm time carries no details_url):
// staleness is the only liveness evidence. A fresh stamp is a dispatch that
// JUST fired; an old one is a ghost whose run died without concluding it.
// Unparseable/young → fail safe.
function classifyUnlinkedRun(cr, nowMs, staleMs) {
    var started = _startedAtMs(cr || {});
    if (started !== null && (nowMs - started) > staleMs) {
        return zombieVerdict(cr, null, 'stale-no-runner');
    }
    return liveVerdict(false);
}

// One check-run's verdict: settled evidence, a linked-run decision, or the
// link-less staleness decision.
function classifyOne(cr, resolveRun, nowMs, staleMs, graceMs) {
    if (!isPendingCheckRun(cr)) return { kind: 'settled' };

    var runId = runIdOf(cr);
    if (runId !== null && typeof resolveRun === 'function') {
        return classifyLinkedRun(cr, runId, resolveRun, nowMs, graceMs);
    }
    return classifyUnlinkedRun(cr, nowMs, staleMs);
}

// Fold one verdict into the classification output.
function tallyClassifyVerdict(out, verdict) {
    if (verdict.kind === 'zombie') { out.zombies.push(verdict.zombie); return; }
    if (verdict.kind === 'settled') { out.settled++; return; }
    out.live++;
    if (verdict.unresolvable) out.unresolvable++;
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
        tallyClassifyVerdict(out, classifyOne(cr, resolveRun, now, staleMs, graceMs));
    });

    return out;
}

function isPlaceholderShape(checkRun) {
    // The placeholder shape: still pending AND no parseable run id in its
    // URL. Everything else — concluded, linked — carries its own evidence.
    return isPendingCheckRun(checkRun) && runIdOf(checkRun) === null;
}

/**
 * Placeholder detector (gh-852): every pending check-run with NO run id
 * whose stamp is older than the placeholder grace. Fresh/unparseable
 * stamps are NOT placeholders (fail safe toward live — see above).
 *
 * @param checkRuns [{name, status, conclusion, started_at, details_url, id}]
 * @param nowMs     epoch ms (Date.now() at the probe)
 * @param opts      {placeholderMinutes}
 * @returns [{name, runId: null, id, reason: 'placeholder', startedAtMs}]
 *          id = the check-run id (null when the API payload carried none —
 *          such a stamp cannot be PATCH-concluded in place, gh-857).
 */
function placeholders(checkRuns, nowMs, opts) {
    var out = [];
    var graceMs = _num(opts, 'placeholderMinutes', DEFAULT_PLACEHOLDER_MINUTES) * 60 * 1000;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    (checkRuns || []).forEach(function (cr) {
        if (!isPlaceholderShape(cr)) return;
        var started = _startedAtMs(cr || {});
        if (started === null) return;               // fail safe
        if ((now - started) > graceMs) {
            out.push({ name: (cr && cr.name) || null, runId: null,
                       id: (cr && cr.id !== undefined && cr.id !== null) ? cr.id : null,
                       reason: 'placeholder', startedAtMs: started });
        }
    });
    return out;
}

// ── Numeric-id orphans (gh-865) ─────────────────────────────────────────────
//
// The fd1b9aa2 twin of the gh-852 placeholder: GitHub's ~10-13 min
// speculative-placeholder window expired on a head whose kicker suite
// existed but whose required contexts were never stamped — so GitHub
// minted PENDING placeholder check-runs WITH numeric run ids, owned by
// the kicker run itself (live fa #1457, run 38164305157 concluded success
// at 18:33:24 while its three pseudo-job check-runs stayed in_progress
// for 4+ hours, pinning mergeStateStatus=BLOCKED with 4 green CI runs on
// the same head). gh-852's detector keys on the MISSING run id — these
// carry one — and classify()'s 'run-concluded' zombie keeps only the
// same-sha re-dispatch remedy, which cannot cure a stamp nothing will
// ever conclude.
//
// Generalized orphan rule: a PENDING check-run whose OWNING RUN has
// CONCLUSIONED (any conclusion, past the propagation grace) is
// definitionally orphaned. The caller concludes it with the mirrored
// verdict under the gh-857 fail-safes (a real completed-success green
// cover on the head AND no active run on the head) — the verdict mirror
// and the live-run guard are call-site duties, not the detector's.
//
// Disjoint from the other detectors by design:
//  - no run link        → the placeholder detector's domain (gh-852);
//  - owning run ABSENT  → classify()'s 'no-run' zombie — the re-dispatch
//    remedy (AC3) stays its cure;
//  - owning run ACTIVE  → live evidence, never disturbed (AC2).

/**
 * @param checkRuns  [{name, status, conclusion, started_at, details_url, id}]
 * @param resolveRun fn(runId) → null (absent) | {status, conclusion,
 *                   updated_at}; THROWS on probe error (fails safe to live)
 * @param nowMs      epoch ms (Date.now() at the probe)
 * @param opts       {runConcludedGraceMinutes}
 * @returns [{name, runId, id, reason: 'orphan-run-concluded'}]
 *          id = the check-run id (null when the API payload carried none)
 */
function orphanedRunChecks(checkRuns, resolveRun, nowMs, opts) {
    var out = [];
    var graceMs = _num(opts, 'runConcludedGraceMinutes', DEFAULT_RUN_CONCLUDED_GRACE_MINUTES) * 60 * 1000;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    (checkRuns || []).forEach(function (cr) {
        if (!isPendingCheckRun(cr)) return;
        var runId = runIdOf(cr);
        if (runId === null || typeof resolveRun !== 'function') return;
        var state = null;
        try { state = resolveRun(runId); } catch (e) { return; }   // fail safe — retry next tick
        if (state === null || state === undefined) return;          // absent — the 'no-run' zombie's cure
        if (String(state.status || '').toLowerCase() !== 'completed') return;   // ACTIVE — AC2, untouched
        if (!state.conclusion) return;              // completed w/o conclusion — odd, fail safe (classify parity)
        var endTs = Date.parse(state.updated_at || state.created_at || '');
        var lag = isNaN(endTs) ? null : now - endTs;
        if (lag !== null && lag >= 0 && lag <= graceMs) return;     // propagation lag — the conclusion is landing
        out.push({ name: (cr && cr.name) || null, runId: runId,
                   id: (cr && cr.id !== undefined && cr.id !== null) ? cr.id : null,
                   reason: 'orphan-run-concluded' });
    });
    return out;
}

// ── gh-998: placeholder lifecycle + sweper ──────────────────────────────────
//
// Live fa #1563 (2026-10-17, head f3d58647): the SM-registered placeholder
// `Quality gate` (check-run 117469671401, kicker suite 105847141092) stayed
// `in_progress` 40+ minutes past its cycle and held mergeStateStatus=BLOCKED
// with 58 green sibling checks — a pending required check counts per name
// across ALL suites on the head, and no machine action (re-dispatch, fresh
// sha, operator REST close — 404 creator-only) can retire it. The gh-857
// in-place close covers ONLY the success row (and only with a green cover);
// the failure/superseded/cancelled/died rows of the gh-998 capability table
// and every pre-fix leak had NO close path — a cycle that ends without
// landing a verdict stamp on the head leaks its placeholders forever.
//
//  - conclusionForOutcome(outcome) — the capability table (AC1): the
//    cycle's real outcome decides the close conclusion. `neutral` is
//    reserved for the no-verdict rows (superseded/cancelled/died) — a
//    superseded cycle carries no verdict about its head (I3); required-
//    check truth is never laundered into a blanket success.
//  - openCycle/closePlaceholderCycle — the register→outcome→closed state
//    machine (AC1): the five outcomes close with the mapped conclusion and
//    NO transition leaves the object open. An unknown outcome fails SAFE
//    (returns null, the cycle stays open — the close obligation retries
//    next tick, it is never silently dropped). Closing an already-closed
//    cycle is rejected — idempotence, so two racing closers (E1) cannot
//    double-close or double-count the metric.
//  - zombieSweptLine — the I5 machine-log line for every sweeper action:
//    `zombie-swept: <check-run-id> head <sha>`. The sweeper's DETECTION is
//    the gh-865 orphan rule (a pending check-run whose owning run is
//    terminal, past the propagation grace) — reused verbatim; its AC2
//    guarantee (a live owner is never touched) is the gh-865 test suite.
//
// The close TRANSPORT (same-app token, gh-857 family) and the per-tick
// wiring live in js/smAgent.js; the leak counter rides the factory-state
// snapshot (js/factoryState.js, I5).

// gh-998 capability table (AC1). Keys are the five cycle outcomes; values
// are the placeholder close conclusions. `neutral` is deliberate for the
// no-verdict rows — see above.
var CYCLE_OUTCOME_CONCLUSIONS = {
    success: 'success',
    failure: 'failure',
    superseded: 'neutral',
    cancelled: 'neutral',
    died: 'neutral'
};

/** The close conclusion for a cycle outcome; null for an unknown outcome. */
function conclusionForOutcome(outcome) {
    if (!CYCLE_OUTCOME_CONCLUSIONS.hasOwnProperty(outcome)) return null;
    return CYCLE_OUTCOME_CONCLUSIONS[outcome];
}

/**
 * A fresh validation cycle: placeholders registered, nothing concluded yet.
 * @param placeholders [{name, id?}] — the registered placeholder check-runs
 */
function openCycle(placeholders) {
    return { state: 'open', placeholders: (placeholders || []).slice() };
}

/**
 * The finally-path transition (AC1): 'open' + outcome → 'closed' with the
 * mapped conclusion. Returns null (no transition taken) when the cycle is
 * not open or the outcome is unknown — the object can only reach 'closed',
 * never back to open, and never linger open through a KNOWN outcome.
 */
function closePlaceholderCycle(cycle, outcome) {
    if (!cycle || cycle.state !== 'open') return null;
    var conclusion = conclusionForOutcome(outcome);
    if (conclusion === null) return null;
    return {
        state: 'closed',
        conclusion: conclusion,
        outcome: outcome,
        placeholders: (cycle.placeholders || []).slice()
    };
}

/** I5: the machine-log line for one sweeper action. */
function zombieSweptLine(checkRunId, headSha) {
    return 'zombie-swept: ' + checkRunId + ' head ' + headSha;
}

function hasPlaceholderZombies(zombies) {
    // Among a classify() zombie set, the placeholder shape is a ghost with
    // NO backing run id — those are the ones a same-sha re-dispatch cannot
    // cure (gh-852); run-id ghosts ('no-run'/'cancelled'/'run-concluded')
    // keep the legacy re-dispatch remedy (AC3).
    return (zombies || []).some(function (z) { return z && z.runId === null; });
}

/**
 * Per-PR placeholder-reset bookkeeping from marker comment bodies — the
 * cap is "N fresh-sha resets per PR per trailing window" (AC2). Markers
 * older than the window do not count (a quiet 2h restarts the budget);
 * malformed lines and unparsable timestamps are ignored.
 *
 * @returns {count, lastAtMs} — in-window marker count + newest in-window
 *          marker epoch ms (null when none).
 */
function placeholderMarks(bodies, nowMs, windowMs) {
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var win = (typeof windowMs === 'number' && windowMs > 0)
        ? windowMs : DEFAULT_PLACEHOLDER_RESET_WINDOW_MS;
    var count = 0;
    var lastAtMs = null;
    (bodies || []).forEach(function (body) {
        var s = String(body == null ? '' : body);
        PLACEHOLDER_MARKER_RE.lastIndex = 0;
        var m;
        while ((m = PLACEHOLDER_MARKER_RE.exec(s)) !== null) {
            var atMs = Date.parse(m[3]);
            if (isNaN(atMs)) continue;
            if (now - atMs < 0 || now - atMs >= win) continue;   // outside the trailing window
            count++;
            if (lastAtMs === null || atMs > lastAtMs) lastAtMs = atMs;
        }
    });
    return { count: count, lastAtMs: lastAtMs };
}

/** The marker line for the NEXT reset (count = prior in-window + 1). */
function placeholderMarkerLine(count, cap, atIso) {
    return '\uD83D\uDD01 placeholder reset ' + count + '/' + cap +
           ' at ' + (atIso || '');
}

/** AC2 storm gate: a reset is allowed only under the per-PR cap. */
function placeholderRetryAllowed(marks, cap) {
    var c = (typeof cap === 'number' && cap > 0) ? cap : DEFAULT_PLACEHOLDER_RESET_CAP;
    return !marks || (typeof marks.count === 'number' ? marks.count : 0) < c;
}

/** Storm cap: default 3 fresh-sha resets per window (gh-852 AC2). */
function placeholderCapOf(jobParams) {
    var n = (jobParams || {}).placeholderResetCap;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    return (typeof n === 'number' && n > 0) ? Math.floor(n) : DEFAULT_PLACEHOLDER_RESET_CAP;
}

/** Cap window: default 2h per PR (gh-852 AC2). */
function placeholderWindowMsOf(jobParams) {
    var n = (jobParams || {}).placeholderResetWindowMs;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    if (typeof n !== 'number' || isNaN(n) || n < 0) return DEFAULT_PLACEHOLDER_RESET_WINDOW_MS;
    return Math.floor(n);
}

module.exports = {
    classify: classify,
    runIdOf: runIdOf,
    isPendingCheckRun: isPendingCheckRun,
    isPlaceholderShape: isPlaceholderShape,
    placeholders: placeholders,
    orphanedRunChecks: orphanedRunChecks,
    conclusionForOutcome: conclusionForOutcome,
    openCycle: openCycle,
    closePlaceholderCycle: closePlaceholderCycle,
    zombieSweptLine: zombieSweptLine,
    CYCLE_OUTCOME_CONCLUSIONS: CYCLE_OUTCOME_CONCLUSIONS,
    hasPlaceholderZombies: hasPlaceholderZombies,
    placeholderMarks: placeholderMarks,
    placeholderMarkerLine: placeholderMarkerLine,
    placeholderRetryAllowed: placeholderRetryAllowed,
    placeholderCapOf: placeholderCapOf,
    placeholderWindowMsOf: placeholderWindowMsOf,
    PENDING_STATUSES: PENDING_STATUSES,
    ACTIVE_RUN_STATES: ACTIVE_RUN_STATES,
    DEFAULT_STALE_NO_RUNNER_MINUTES: DEFAULT_STALE_NO_RUNNER_MINUTES,
    DEFAULT_RUN_CONCLUDED_GRACE_MINUTES: DEFAULT_RUN_CONCLUDED_GRACE_MINUTES,
    DEFAULT_PLACEHOLDER_MINUTES: DEFAULT_PLACEHOLDER_MINUTES,
    DEFAULT_PLACEHOLDER_RESET_CAP: DEFAULT_PLACEHOLDER_RESET_CAP,
    DEFAULT_PLACEHOLDER_RESET_WINDOW_MS: DEFAULT_PLACEHOLDER_RESET_WINDOW_MS
};
