/**
 * polishLap.js — the bounded polish lap (gh-1352 scope 3, epic
 * gh-1328 §4-disposition).
 *
 * The suggestion-only lap: when a review round concludes APPROVE with the
 * lap-gated census clean and open threads ONLY in `round: polish` tiers
 * (default preset: suggestions > 0, blocking = important = 0), the machine
 * dispatches ONE bounded polish leg instead of merging with open threads
 * (the #1319 pathology) or arming a full rework lap (a dev lap on a
 * suggestion-only round is exactly what the polish lap replaces).
 *
 *   Bounds     single commit, <= bounds.polishMaxThreads (6) threads,
 *              <= bounds.polishMaxChangedLines (80) changed lines,
 *              doc/test-trivial fixes only. The plan takes the top-K
 *              threads; the overflow becomes triage-tagged closures.
 *   Per head   the lap runs ONCE per head — the dmtools:polish-lap marker
 *              family (stamped at dispatch) is the per-head memory.
 *   Stability  2 consecutive polish laps on consecutive heads exhaust the
 *              instability budget (a CROSS-HEAD bound — "once per head"
 *              alone cannot stop a polish cycle that moves the head): the
 *              machine stops polishing and hands the rest to triage +
 *              digest.
 *
 * Pure module — no dmtools globals. GraalJS-clean (var + plain functions,
 * JSON-safe data). Requires hoisted (gh-823).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');
var reviewPolicy = require('./reviewPolicy.js');
var machineAuthor = require('./machineAuthor.js');

// The dmtools: marker family recording one polish-lap dispatch per head
// (the once-per-head + instability-budget memory).
var MARKER_PREFIX = '<!-- dmtools:polish-lap ';
var MARKER_SUFFIX = ' -->';

// The instability budget (gh-1352): consecutive polish laps on consecutive
// heads before polishing stops. Policy-configurable via bounds later if a
// deployment ever needs a different shape — the epic fixes it at 2.
var INSTABILITY_BUDGET = 2;

// ── the trigger ──────────────────────────────────────────────────────────────

// Any open thread census in a `round: polish` policy tier (the open-thread
// half of the trigger; digest never counts — gh-1350 doctrine).
function hasOpenPolishTierCensus(record, p) {
    for (var i = 0; i < reviewPolicy.TIERS.length; i++) {
        var tier = reviewPolicy.TIERS[i];
        var sev = p.severities[tier];
        if (!sev || sev.round !== 'polish') continue;
        if (reviewVerdicts.censusCount(record[reviewPolicy.CENSUS_KEY_BY_TIER[tier]]) > 0) return true;
    }
    return false;
}

/**
 * True when the effective verdict record triggers the polish lap:
 * APPROVE, the lap-gated census clean (reviewPolicy gating tiers), and at
 * least one open thread census in a `round: polish` tier. Digest never
 * counts (it is not an open-thread census — gh-1350 doctrine).
 */
function isPolishTrigger(record, policy) {
    if (!record || record.verdict !== 'APPROVE') return false;
    var p = policy || reviewPolicy.defaultPolicy();
    if (reviewPolicy.gatingCensusCount(record, p).count > 0) return false;
    return hasOpenPolishTierCensus(record, p);
}

// ── the lap plan (top-K + overflow) ─────────────────────────────────────────

// The policy entry a thread body classifies into, or null — non-polish
// tiers and unclassifiable bodies answer null (they never ride the lap).
function polishRoundEntryOf(p, body) {
    var tierKey = String(reviewVerdicts.threadSeverity(body) || 'none').toUpperCase();
    var entry = p.severities[tierKey];
    return (entry && entry.round === 'polish') ? entry : null;
}

/**
 * The polish-tier threads of a thread list: bodies classifying into a tier
 * whose policy round is `polish`. Lap-gated and triage-only tiers stay out.
 */
function polishTierThreads(threads, policy) {
    var p = policy || reviewPolicy.defaultPolicy();
    var out = [];
    (threads || []).forEach(function (t) {
        if (!t || t.resolved) return;
        if (polishRoundEntryOf(p, t.body)) out.push(t);
    });
    return out;
}

/**
 * The lap plan: the top-K polish-tier threads (bounds.polishMaxThreads)
 * plus the overflow that goes to triage tags.
 */
function planLap(threads, policy) {
    var p = policy || reviewPolicy.defaultPolicy();
    var polish = polishTierThreads(threads, p);
    var max = reviewVerdicts.censusCount(p.bounds.polishMaxThreads) || reviewPolicy.DEFAULT_BOUNDS.polishMaxThreads;
    return {
        lapThreads: polish.slice(0, max),
        overflowThreads: polish.slice(max),
        maxThreads: max,
        maxChangedLines: p.bounds.polishMaxChangedLines
    };
}

// ── the cross-head bounds ────────────────────────────────────────────────────

/**
 * Whether THIS head already carries a polish lap (once per head).
 */
function ranOnHead(laps, headSha) {
    var head = String(headSha || '');
    return (laps || []).some(function (l) { return !!l && String(l.head) === head; });
}

/**
 * The instability budget (gh-1352): true when the most recent polish laps
 * cover >= INSTABILITY_BUDGET DISTINCT consecutive heads (and none of them
 * is the head being decided — a fresh head is decided by once-per-head).
 * Duplicate entries for the same head collapse (one lap per head).
 */
function instabilityBudgetExhausted(laps, headSha) {
    var head = String(headSha || '');
    var heads = {};
    (laps || []).forEach(function (l) {
        if (!l || !l.head) return;
        if (String(l.head) === head) return;
        heads[String(l.head)] = true;
    });
    return Object.keys(heads).length >= INSTABILITY_BUDGET;
}

// ── the decision ─────────────────────────────────────────────────────────────

/**
 * The polish-lap decision for one approved head (pure).
 *
 *   record    — the effective verdict record for the head (or null)
 *   threads   — the open thread list (reviewThreadList shape)
 *   headSha   — the head being decided
 *   laps      — parsed dmtools:polish-lap markers (oldest first)
 *   policy    — the resolved reviewPolicy (default when absent)
 *
 * Returns { trigger, dispatch, reason, plan, triageRest }:
 *   trigger            — the trigger shape held (APPROVE, lap-gated clean,
 *                        polish-tier census open);
 *   dispatch=true      — run the lap (plan carries top-K + overflow);
 *   dispatch=false     — once-per-head / instability-budget / not a
 *                        trigger; triageRest=true hands the threads to the
 *                        triage path (+ digest) when the trigger held but
 *                        the lap may not run.
 */
// Why the polish lap is not dispatched on a record that failed the
// trigger shape (pure — the reason rides the audit log and the tests).
function notPolishTriggerReason(record, p) {
    if (!record) return 'no-polish-tier-open';
    if (record.verdict !== 'APPROVE') return 'not-approve';
    if (reviewPolicy.gatingCensusCount(record, p).count > 0) return 'lap-gated-census-open';
    return 'no-polish-tier-open';
}

function polishDecision(record, policy, threads, headSha, laps) {
    var p = policy || reviewPolicy.defaultPolicy();
    var out = { trigger: false, dispatch: false, reason: null, plan: null, triageRest: false };
    if (!isPolishTrigger(record, p)) {
        out.reason = notPolishTriggerReason(record, p);
        return out;
    }
    out.trigger = true;
    out.plan = planLap(threads, p);
    if (ranOnHead(laps, headSha)) {
        out.reason = 'once-per-head';
        out.triageRest = true;
        return out;
    }
    if (instabilityBudgetExhausted(laps, headSha)) {
        out.reason = 'instability-budget';
        out.triageRest = true;
        return out;
    }
    out.dispatch = true;
    out.reason = 'polish-tier-census-open';
    return out;
}

// ── the dmtools:polish-lap marker family ─────────────────────────────────────

/**
 * The dispatch marker for one polish lap: head, thread/overflow counts,
 * the thread ids the lap was planned to address (resolvedThreadIds — the
 * fixed: evidence the triage path reads) and the run URL when known.
 * null on an unbuildable record (no head) — callers skip the post.
 */
function buildPolishLapMarker(headSha, stats) {
    if (!headSha || typeof headSha !== 'string') return null;
    var s = stats || {};
    var payload = {
        head: headSha,
        threads: reviewVerdicts.censusCount(s.threads),
        overflow: reviewVerdicts.censusCount(s.overflow),
        at: s.at || new Date().toISOString()
    };
    if (Array.isArray(s.resolvedThreadIds)) payload.resolvedThreadIds = s.resolvedThreadIds;
    if (s.runUrl) payload.run = String(s.runUrl);
    return MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) + MARKER_SUFFIX + '\n' +
        '\u2728 Polish lap dispatched on head ' + String(headSha).substring(0, 7) + ': ' + payload.threads +
        ' thread(s) in the lap plan, ' + payload.overflow + ' to triage (gh-1352 bounded polish lap).';
}

/**
 * Parses ALL polish-lap markers from a PR comments payload — comments:
 * [{body}] (author fields consulted only when opts.authorLogins is passed;
 * FAILS CLOSED on an absent allowlist — the machineAuthor doctrine).
 * Returns records oldest-first (atMs stamped from `at`).
 */
function parsePolishLapMarkers(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments, opts, MARKER_PREFIX, MARKER_SUFFIX,
        function (parsed) {
            if (!parsed || !parsed.head) return null;
            return {
                head: String(parsed.head),
                threads: reviewVerdicts.censusCount(parsed.threads),
                overflow: reviewVerdicts.censusCount(parsed.overflow),
                resolvedThreadIds: Array.isArray(parsed.resolvedThreadIds) ? parsed.resolvedThreadIds : [],
                run: parsed.run ? String(parsed.run) : null,
                at: String(parsed.at || '')
            };
        }, true);
}

// The trusted-identity gate needs the same login normalization the other
// marker families use; parseMarkerComments applies it via authorAllowed.
// (machineAuthor is required above for symmetry with the other consumers.)

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        INSTABILITY_BUDGET: INSTABILITY_BUDGET,
        isPolishTrigger: isPolishTrigger,
        polishTierThreads: polishTierThreads,
        planLap: planLap,
        ranOnHead: ranOnHead,
        instabilityBudgetExhausted: instabilityBudgetExhausted,
        polishDecision: polishDecision,
        buildPolishLapMarker: buildPolishLapMarker,
        parsePolishLapMarkers: parsePolishLapMarkers
    };
}
