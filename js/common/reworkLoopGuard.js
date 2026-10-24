/**
 * reworkLoopGuard.js — the rework no-op loop guard (gh-957), pure side.
 *
 * Live pathology (dart PR #424, 2026-10-17 08:00–10:55Z): the SM armed
 * agent:rework on unresolved review threads 7 times in 2 hours; every leg
 * closed itself 'successful' with ZERO pushed commits and ZERO resolved
 * threads on the same head; the arm rule re-matched on the next tick every
 * time and the loop starved the whole machine queue (7 other PRs got
 * nothing). The existing empty-lap cap (review #703) only covers the
 * red-gate arm via fail_validation's 🔴 markers — the threads-armed path
 * had NO bound.
 *
 * This module is the pure side of the bound:
 *
 *   Lap markers   — the rework post-action (js/pushReworkChanges.js) stamps
 *                   ONE machine-parseable marker per leg close recording
 *                   {head, pushed: 0|1, resolved: N, at}. Trusted only from
 *                   machine identities (the same allowlist doctrine as
 *                   reviewVerdicts.js / reworkConsumption.js — the marker
 *                   format is public).
 *   The decision  — consecutiveNoopLaps(): the newest-first run of laps on
 *                   the SAME head with pushed === 0 AND resolved === 0. A
 *                   progress lap (pushed or resolved) or a different head
 *                   ends the run — so a human push (new head) or a leg that
 *                   actually resolves threads resets the budget by
 *                   construction. At >= maxNoopLaps the SM arm actions
 *                   (arm_rework + restore_rework_arm) WITHHOLD the arm and
 *                   escalate the owner ONCE per head (escalation marker
 *                   dedup): a label (ESCALATION_LABEL) + a 🛑 PR comment.
 *
 * Pure module — no dmtools globals; smAgent feeds it comment payloads and
 * applies the decisions; pushReworkChanges builds the lap markers.
 * GraalJS-clean (var + plain functions, JSON-safe data only).
 */
'use strict';

var machineAuthor = require('./machineAuthor.js');
var reviewVerdicts = require('./reviewVerdicts.js');

// gh-957: consecutive no-op rework laps on one head before the arm is
// withheld. Deployment-tunable via jobParams.noopLapMax (same shape as
// redHeadCap / emptyLapMax).
var DEFAULT_NOOP_LAP_MAX = 2;

// One hidden marker per leg close + one visible audit line.
var LAP_MARKER_PREFIX = '<!-- dmtools:rework-lap ';
// One hidden marker per escalation (the once-per-head dedup the arm
// actions consult before re-posting).
var ESCALATION_MARKER_PREFIX = '<!-- dmtools:rework-loop-escalated ';
var MARKER_SUFFIX = ' -->';

// The escalation carrier on the PR: the machine stops re-arming while this
// label stands; a human push (new head) resets the lap budget, and clearing
// the label is a human decision.
var ESCALATION_LABEL = 'rework-loop-escalated';

/**
 * The marker payload: {head, pushed: 0|1, resolved: N, at} (+ run URL when
 * known). null on an unbuildable record — callers skip the post.
 */
function lapPayload(headSha, pushed, resolved, runUrl, atIso) {
    if (!headSha || typeof headSha !== 'string') return null;
    var payload = {
        head: headSha,
        pushed: pushed ? 1 : 0,
        resolved: (typeof resolved === 'number' && resolved > 0) ? Math.floor(resolved) : 0,
        at: atIso || new Date().toISOString()
    };
    if (runUrl) payload.run = String(runUrl);
    return payload;
}

/**
 * Builds the per-leg-close audit marker comment. pushed: 0|1 (a real
 * production change landed), resolved: count of threads the leg resolved.
 * runUrl: the rework run URL for the audit trail (null on local runs).
 * Returns null on an unbuildable record — callers skip the post.
 */
function buildLapMarker(headSha, pushed, resolved, runUrl, atIso) {
    var payload = lapPayload(headSha, pushed, resolved, runUrl, atIso);
    if (!payload) return null;
    return LAP_MARKER_PREFIX + JSON.stringify(payload) + MARKER_SUFFIX + '\n' +
        '📓 rework lap on head ' + String(headSha).substring(0, 7) + ': pushed ' +
        payload.pushed + ', resolved ' + payload.resolved + ' (gh-957 loop-guard audit).';
}

/**
 * Builds the once-per-head escalation comment (🛑 + hidden marker). Posted
 * by the SM arm actions when the no-op lap budget is exhausted.
 */
function buildEscalationComment(headSha, laps, maxLaps, atIso) {
    if (!headSha || typeof headSha !== 'string') return null;
    var payload = { head: headSha, laps: laps, at: atIso || new Date().toISOString() };
    return ESCALATION_MARKER_PREFIX + JSON.stringify(payload) + MARKER_SUFFIX + '\n' +
        '🛑 rework no-op loop guard (gh-957) — ' + laps + '/' + maxLaps +
        ' consecutive rework leg(s) on head ' + headSha + ' closed with ZERO pushed commits and ZERO resolved threads. ' +
        'The machine stops re-arming agent:rework here (label `' + ESCALATION_LABEL + '`) — a human owns this PR: ' +
        'push a fix (a NEW head resets the budget) or resolve/dismiss the open review threads. ' +
        'The threads census and the leg input are now the same source (GraphQL reviewThreads), so a leg that ' +
        'determines every thread is addressed/invalid can resolve them with an audit reply — that path also ' +
        'resets this budget.';
}

function commentAuthorLogin(item) {
    return machineAuthor.commentAuthorLogin(item);
}

/**
 * Machine-author gate (the marker format is public — only trusted identities
 * count): true when the comment author is in the allowlist.
 */
function isTrustedAuthor(item, allow) {
    // gh-1025 review: normalize ONE trailing '[bot]' on both sides —
    // App-authored lap/escalation markers are trusted under the bare knob.
    var who = machineAuthor.trustedLogin(commentAuthorLogin(item));
    for (var a = 0; a < allow.length; a++) {
        if (who && who === machineAuthor.trustedLogin(allow[a])) return true;
    }
    return false;
}

/**
 * Extract and JSON-parse ONE marker payload from a comment body: null when
 * the prefix/suffix are absent or the payload is not an object.
 */
function extractMarker(body, prefix) {
    return reviewVerdicts.extractMarkerJson(body, prefix, MARKER_SUFFIX);
}

/**
 * Timestamp order, payload order as tiebreak (reworkConsumption parity).
 */
function sortMarkersByTime(out) {
    out.sort(function(a, b) {
        var aTime = isNaN(a.atMs) ? -1 : a.atMs;
        var bTime = isNaN(b.atMs) ? -1 : b.atMs;
        if (aTime !== bTime) return aTime < bTime ? -1 : 1;
        return (a.order || 0) - (b.order || 0);
    });
    return out;
}

/**
 * The machine-author allowlist from the options — null when absent/empty
 * (every author counts when there is no allowlist).
 */
function authorAllowlist(opts) {
    if (opts && Array.isArray(opts.authorLogins) && opts.authorLogins.length) {
        return opts.authorLogins;
    }
    return null;
}

function parseMarkers(comments, prefix, opts) {
    var list = Array.isArray(comments) ? comments : [];
    var allow = authorAllowlist(opts);
    var out = [];
    for (var i = 0; i < list.length; i++) {
        if (allow && !isTrustedAuthor(list[i], allow)) continue;
        var parsed = extractMarker(list[i] && list[i].body, prefix);
        if (!parsed) continue;
        parsed.atMs = Date.parse(parsed.at || '');
        parsed.order = i;
        out.push(parsed);
    }
    return sortMarkersByTime(out);
}
function parseLapMarkers(comments, opts) {
    return parseMarkers(comments, LAP_MARKER_PREFIX, opts);
}

function parseEscalationMarkers(comments, opts) {
    return parseMarkers(comments, ESCALATION_MARKER_PREFIX, opts);
}

function isNoopLap(m) {
    return !!m && m.pushed === 0 && (typeof m.resolved !== 'number' || m.resolved === 0);
}

/**
 * The newest-first run of no-op laps on ONE head: walks the (time-sorted)
 * lap markers backward from the newest, counting while the lap is a no-op
 * (pushed === 0 && resolved === 0) on the requested head. Stops at the
 * first progress lap or a different head — so one resolving/pushing leg or
 * a head move resets the budget. Markers for other heads are skipped, not
 * terminating — a quiet interleave must not mask the run on THIS head.
 */
function consecutiveNoopLaps(markers, headSha) {
    if (!headSha) return 0;
    var list = (markers || []).filter(function(m) {
        return !!m && m.head === headSha;
    });
    var run = 0;
    for (var i = list.length - 1; i >= 0; i--) {
        if (!isNoopLap(list[i])) break;
        run++;
    }
    return run;
}

/**
 * True when an escalation was already posted for this head (the once-per-head
 * dedup the withholding branches consult before re-posting).
 */
function hasEscalationForHead(escalationMarkers, headSha) {
    if (!headSha) return false;
    return (escalationMarkers || []).some(function(m) {
        return !!m && m.head === headSha;
    });
}

/**
 * gh-990 (2nd live instance, dart #424 ~16:37Z / #419 ~17:2xZ, 2026-10-17):
 * the FALSE-POSITIVE refinement of the escalation. When the no-op budget is
 * exhausted on a head that has NOTHING to rework (unresolvedThreads === 0 —
 * the operator already addressed every thread, which is exactly why the
 * legs no-op'd) AND the head carries NO red validation (headRed === false —
 * no validation_failed park, no failing head check), parking the PR (label
 * + 🛑 comment) is a false positive: the escalated label wedged the whole
 * queue's validate-armed pointer behind a human-owned PR while the correct
 * move was to let validation re-flow. The arm stays WITHHELD (the gh-957
 * bound is unchanged — only the human-handoff escalation is suppressed);
 * validate-armed matches the approved PR independently of this guard.
 *
 * Suppression requires POSITIVE evidence of BOTH sides: an unknown census
 * (-1) or an unknown red probe (null) keeps the legacy escalation.
 */
function escalationIsFalsePositive(state) {
    var s = state || {};
    return s.unresolvedThreads === 0 && s.headRed === false;
}

/**
 * The arm-side decision (pure). state:
 *   markers          — time-sorted lap markers (parseLapMarkers output)
 *   escalationMarkers— parsed escalation markers (same comments, dedup)
 *   headSha          — the head the arm would send the leg to
 *   maxNoopLaps      — the budget (jobParams.noopLapMax, default
 *                      DEFAULT_NOOP_LAP_MAX)
 * Returns { withhold, laps, escalate, maxLaps } — escalate is true when the
 * budget is exhausted AND no escalation marker exists for the head yet (the
 * caller posts label + comment and treats the key as processed).
 */
function shouldWithholdArm(state) {
    var s = state || {};
    var maxLaps = (typeof s.maxNoopLaps === 'number' && s.maxNoopLaps > 0)
        ? s.maxNoopLaps : DEFAULT_NOOP_LAP_MAX;
    var laps = consecutiveNoopLaps(s.markers, s.headSha);
    var over = laps >= maxLaps;
    return {
        withhold: over,
        laps: laps,
        maxLaps: maxLaps,
        escalate: over && !hasEscalationForHead(s.escalationMarkers, s.headSha)
    };
}

module.exports = {
    DEFAULT_NOOP_LAP_MAX: DEFAULT_NOOP_LAP_MAX,
    LAP_MARKER_PREFIX: LAP_MARKER_PREFIX,
    ESCALATION_MARKER_PREFIX: ESCALATION_MARKER_PREFIX,
    ESCALATION_LABEL: ESCALATION_LABEL,
    buildLapMarker: buildLapMarker,
    buildEscalationComment: buildEscalationComment,
    parseLapMarkers: parseLapMarkers,
    parseEscalationMarkers: parseEscalationMarkers,
    consecutiveNoopLaps: consecutiveNoopLaps,
    hasEscalationForHead: hasEscalationForHead,
    escalationIsFalsePositive: escalationIsFalsePositive,
    shouldWithholdArm: shouldWithholdArm
};
