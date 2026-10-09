/**
 * Rework in-flight latch (gh-806) — one arming decision per (pr-number,
 * head-sha).
 *
 * Live fa PR #1428 (2026-10-09 04:01–05:04Z): the SM tick logged 9 rework
 * arming decisions for ONE push; 8 legs died silently (dispatch accepted,
 * run never materialized) because rework idempotency lived only in the
 * `agent:rework` label lifecycle and the dispatch-time in-flight-run guards
 * — neither keys the ARMING decision on the PR head. This module is that
 * missing latch:
 *
 *   AC1  while a rework leg for (pr, head) is latched, the tick's armer
 *        logs `⏭️ … rework already in flight for (pr, head)` and dispatches
 *        nothing — `isActive` is the gate every rework arming path consults.
 *   AC2  the latch clears when the leg terminates: a CONCLUDED leg run
 *        (`ai-teammate.yml` workflow) on the latched head that concluded at
 *        or after the arm — success or failure — clears it; a NEW head is a
 *        new key and re-arms normally by construction.
 *   AC3  a latch older than DEFAULT_STALE_MS (45 min) with NO matching
 *        active run is stale and cleared — a leg that never produced a run
 *        is re-armable after a bounded timeout, no human needed.
 *   AC4  lives in the thread fetchers (githubHelpers/scm providers), not
 *        here — resolved threads are filtered before the agent sees them.
 *
 * Persistence: the tick keeps ONE map in memory per pass and rides it into
 * the factory-state snapshot (`state.reworkInFlight`, js/factoryState.js),
 * which the next tick loads back — fa-state.json on the `factory-data`
 * branch is the store, exactly like tick.processed.
 *
 * Pure functions, no tool globals — smAgent wires the transport, tests
 * inject nothing. CommonJS module like every other js/ module. GraalJS
 * rules apply: var + plain functions only.
 */

'use strict';

// gh-806 AC3: N = 45 minutes. A rework leg that produced no run within this
// window is treated as silently dead and the (pr, head) becomes re-armable.
var DEFAULT_STALE_MS = 45 * 60 * 1000;

// The rework/review leg workflow (smAgent dispatches it via workflowRef={branch}).
// Configurable per call so a deployment that renames the workflow stays exact.
var DEFAULT_LEG_WORKFLOW = 'ai-teammate.yml';

var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

function latchKey(prNumber, headSha) {
    if (prNumber === null || prNumber === undefined || prNumber === '') return null;
    if (!headSha || typeof headSha !== 'string') return null;
    return 'pr-' + prNumber + '@' + headSha;
}

/**
 * Epoch-ms from an epoch number OR an ISO string; null when unparsable.
 */
function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return isNaN(value) ? null : value;
    var parsed = Date.parse(String(value));
    return isNaN(parsed) ? null : parsed;
}

function nowMsOf(opts) {
    var ms = toMs(opts && opts.now);
    return ms === null ? Date.now() : ms;
}

function staleMsOf(opts) {
    var ms = toMs(opts && opts.staleMs);
    return (ms === null || ms <= 0) ? DEFAULT_STALE_MS : ms;
}

function workflowFileOf(opts) {
    var wf = opts && opts.workflowFile;
    return (wf && typeof wf === 'string') ? wf : DEFAULT_LEG_WORKFLOW;
}

/**
 * Sanitize a persisted latch map (the snapshot's reworkInFlight). Keeps only
 * well-formed entries — 'pr-<N>@<head>' keys with a non-empty head string and
 * an `at` field (the timestamp may itself be unparsable; isActive then fails
 * CLOSED to stale so a corrupt stamp can never latch forever). Anything else
 * is dropped: the latch must never wedge the armer on snapshot drift.
 */
function normalizeMap(raw) {
    var map = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
    Object.keys(raw).forEach(function (key) {
        var entry = raw[key];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        if (typeof key !== 'string' || key.indexOf('@') === -1) return;
        if (!entry.head || typeof entry.head !== 'string') return;
        if (!entry.at) return;
        map[key] = { head: entry.head, at: entry.at };
        if (entry.by) map[key].by = String(entry.by);
    });
    return map;
}

/**
 * Record an arming decision for (prNumber, headSha) at `atIso` (default now).
 * No head sha → nothing to key on → no-op (legacy items keep re-arming).
 * Mutates and returns `map` so callers can chain on their own instance.
 */
function arm(map, prNumber, headSha, atIso, by) {
    var key = latchKey(prNumber, headSha);
    if (!key) return map;
    var target = (map && typeof map === 'object') ? map : {};
    target[key] = {
        head: headSha,
        at: atIso || new Date().toISOString()
    };
    if (by) target[key].by = String(by);
    return target;
}

/**
 * Remove the latch for (prNumber, headSha). No-op on unknown keys.
 */
function clear(map, prNumber, headSha) {
    var key = latchKey(prNumber, headSha);
    if (key && map && typeof map === 'object') delete map[key];
    return map;
}

function entryFor(map, prNumber, headSha) {
    var key = latchKey(prNumber, headSha);
    if (!key || !map || typeof map !== 'object') return null;
    var entry = map[key];
    return (entry && typeof entry === 'object') ? entry : null;
}

/**
 * True when the run belongs to the rework/review LEG workflow (path ends
 * with '/<workflowFile>') — the same shape hasActiveLegRun matches in
 * smAgent. Validation CI or kicker runs on the same head must never
 * influence the latch.
 */
function isLegRun(run, workflowFile) {
    if (!run) return false;
    var suffix = '/' + String(workflowFile || DEFAULT_LEG_WORKFLOW);
    var path = String(run.path || '');
    return path.length >= suffix.length &&
        path.slice(path.length - suffix.length) === suffix;
}

function isActiveStatus(status) {
    return ACTIVE_RUN_STATES.indexOf(status) !== -1;
}

/**
 * Does this run keep (active) or resolve (concluded after the arm) a latch
 * for `headSha` set at entryAtMs? Returns 'in-flight', 'terminated' or null.
 * Runs on other heads are ignored — the latch is keyed per head.
 */
function latchEffectOfRun(run, headSha, entryAtMs, workflowFile) {
    if (!isLegRun(run, workflowFile)) return null;
    if (headSha && run.head_sha && String(run.head_sha) !== String(headSha)) return null;
    var status = run.status;
    if (isActiveStatus(status)) return 'in-flight';
    if (status === 'completed') {
        var endedMs = toMs(run.updated_at || run.run_started_at);
        if (endedMs !== null && entryAtMs !== null && endedMs >= entryAtMs) {
            return 'terminated';
        }
    }
    return null;
}

/**
 * Evaluate one entry against the clock and the head's run rollup.
 * Returns the latch cause:
 *   'in-flight'  — fresh latch, or a leg run on the head is still active
 *   'terminated' — a leg run on the head concluded at/after the arm (AC2)
 *   'stale'      — older than staleMs with no matching active run (AC3);
 *                  also the fail-closed answer for an unparsable stamp
 *   'absent'     — no entry
 */
function evaluate(entry, opts) {
    if (!entry) return 'absent';
    var nowMs = nowMsOf(opts);
    var atMs = toMs(entry.at);
    // Unparsable stamp fails CLOSED: treated as stale so a corrupt entry
    // self-heals instead of latching the armer forever.
    if (atMs === null) return 'stale';
    var workflowFile = workflowFileOf(opts);
    var runs = (opts && Array.isArray(opts.runs)) ? opts.runs : null;
    if (runs) {
        for (var i = 0; i < runs.length; i++) {
            var effect = latchEffectOfRun(runs[i], entry.head, atMs, workflowFile);
            if (effect === 'in-flight') return 'in-flight';
            if (effect === 'terminated') return 'terminated';
        }
    }
    if (nowMs - atMs > staleMsOf(opts)) return 'stale';
    return 'in-flight';
}

/**
 * The AC1 gate: is a rework leg in flight for (prNumber, headSha)?
 * Returns { active, cause, entry } — active=true means the armer must log
 * `⏭️ … rework already in flight for (pr, head)` and dispatch nothing.
 * `opts.runs` is the optional head rollup (github_list_workflow_runs shape:
 * {status, conclusion, head_sha, path, updated_at}); a null/absent rollup
 * (failed probe) degrades to age-only evaluation — fail-safe toward
 * suppressing one extra arm, never toward stacking legs.
 */
function isActive(map, prNumber, headSha, opts) {
    var entry = entryFor(map, prNumber, headSha);
    var cause = evaluate(entry, opts);
    return { active: cause === 'in-flight', cause: cause, entry: entry };
}

/**
 * Age-based + run-based sweep for the persisted snapshot: drops entries that
 * are stale (AC3) or whose leg already terminated (AC2). Entries whose leg
 * run is still ACTIVE survive even past the stale window (the leg is really
 * flying — a queued run on a jammed runner must not invite a duplicate).
 * Returns { map, cleared } where cleared lists the dropped keys.
 */
function pruneStale(map, opts) {
    var out = {};
    var cleared = [];
    if (!map || typeof map !== 'object') return { map: out, cleared: cleared };
    Object.keys(map).forEach(function (key) {
        var entry = map[key];
        var cause = evaluate(entry, opts);
        if (cause === 'stale' || cause === 'terminated') {
            cleared.push(key);
        } else {
            out[key] = entry;
        }
    });
    return { map: out, cleared: cleared };
}

/**
 * The arming-storm filter (gh-806 L2): replay N arming decisions against the
 * map — the FIRST decision for a (pr, head) passes and arms the latch, every
 * repeat is suppressed with its cause. Decisions without a head sha never
 * latch and always pass (nothing to key the single-flight on — the dispatch
 * guards stay their only protection, unchanged behavior).
 *
 *   decisions — [{prNumber, headSha}] in tick order
 *   returns   — { allowed, suppressed }; allowed entries are armed into the
 *               map, suppressed entries carry `cause` for the ⏭️ log.
 */
function dedupeArms(map, decisions, opts) {
    var target = (map && typeof map === 'object') ? map : {};
    var allowed = [];
    var suppressed = [];
    (decisions || []).forEach(function (d) {
        var d0 = d || {};
        var verdict = isActive(target, d0.prNumber, d0.headSha, opts);
        if (verdict.active) {
            suppressed.push({
                prNumber: d0.prNumber,
                headSha: d0.headSha,
                cause: verdict.cause
            });
            return;
        }
        arm(target, d0.prNumber, d0.headSha,
            (opts && opts.nowIso) || undefined, (opts && opts.by) || undefined);
        allowed.push({ prNumber: d0.prNumber, headSha: d0.headSha });
    });
    return { allowed: allowed, suppressed: suppressed };
}

module.exports = {
    latchKey: latchKey,
    normalizeMap: normalizeMap,
    arm: arm,
    clear: clear,
    entryFor: entryFor,
    isActive: isActive,
    pruneStale: pruneStale,
    dedupeArms: dedupeArms,
    isLegRun: isLegRun,
    evaluate: evaluate,
    DEFAULT_STALE_MS: DEFAULT_STALE_MS,
    DEFAULT_LEG_WORKFLOW: DEFAULT_LEG_WORKFLOW
};
