/**
 * reworkConsumption.js — fail-closed `agent:rework` consumption bookkeeping
 * and the consumed-without-work sweep decision (gh-840).
 *
 * Live pathology (dmtools-agents PR #826 / gh-825, 2026-10-10 ~10:00Z):
 * `agent:rework` was armed (twice, comments present) and later CONSUMED —
 * yet no rework leg ever ran, no fix commit landed on the head, 4/6 review
 * threads stayed unresolved and no closing bookkeeping comment existed.
 * Root cause: the PR-carrier rule's `consumeLabels` removes the label on
 * dispatch (or on the gh-715 cross-anchor suppression — any leg in flight
 * under the other anchor "fulfills" the request, even a REVIEW leg), with
 * nothing recording the consumption and nothing verifying a leg-close
 * marker. The armer that should have recovered (arm_rework /
 * rework-unresolved-threads) is withheld in this state (gh-806 latch,
 * gh-807 verdict gate, agent:review notLabels), so the arm never returned:
 * 4h+ hang.
 *
 * This module is the pure side of the fix:
 *
 *   Audit log  — every consumption posts ONE machine-parseable marker
 *                comment on the PR recording its path (dispatch |
 *                cross-anchor), the head sha and a timestamp. Markers are
 *                trusted only from machine identities (the same allowlist
 *                doctrine as reviewVerdicts.js — the format is public).
 *   Sweep      — shouldRestoreArm(): a PR with unresolved MACHINE review
 *                threads, no agent:rework label, no rework in flight,
 *                evidence of a prior consumption (consume/restore marker),
 *                quiet longer than staleMs (default 30 min ≈ 6 ticks at a
 *                ~5-min cron) → restore the arm. Fail-closed everywhere:
 *                no evidence, no restore (AC3 — human-thread-only PRs are
 *                untouched); no clock, no restore. The close proof is
 *                thread OWNERSHIP, not head position (gh-840 rework
 *                review, IMPORTANT): a head move with the same open
 *                machine threads is a silentUpdateBranch refresh, not a
 *                close — a healthy close resolves the machine threads
 *                ('no-unresolved-threads'); a bare head advance must never
 *                suppress the sweep.
 *
 * Pure module — no dmtools globals; smAgent feeds it comment payloads and
 * applies the decisions. GraalJS-clean (var + plain functions, JSON-safe
 * data only).
 */
'use strict';

// gh-840 AC1 bound: N ticks. The SM cron ticks every ~5 min; 30 min = 6
// ticks — the ticket's "≤6 ticks" self-heal bound. Deployment-tunable via
// the rule's staleMinutes knob (same shape as sweep_stale_validation).
var DEFAULT_RESTORE_STALE_MS = 30 * 60 * 1000;

// The consumption audit marker — one line, JSON payload, invisible in the
// rendered PR (same protocol family as the gh-807 verdict marker).
var CONSUME_MARKER_PREFIX = '<!-- dmtools:rework-consume ';
var RESTORE_MARKER_PREFIX = '<!-- dmtools:rework-restore ';
var MARKER_SUFFIX = ' -->';

// The only legal consumption paths (the guard vocabulary):
//   'dispatch'      — consumeLabels fired after an accepted workflow_dispatch
//   'cross-anchor'  — consumeLabels fired after the gh-715 cross-anchor
//                     suppression consumed the request
var CONSUME_PATHS = ['dispatch', 'cross-anchor'];

function isLegalConsumePath(path) {
    return CONSUME_PATHS.indexOf(path) !== -1;
}

/**
 * Builds the consumption-audit comment body. path must be one of
 * CONSUME_PATHS; headSha anchors the consumption to the head it was
 * supposed to rework (the sweep's close-proof check compares the recorded
 * head against the live head). Returns null on an unbuildable record —
 * callers skip the post; an unattributed consumption must never exist.
 */
function buildConsumeAuditComment(path, headSha, atIso) {
    if (!isLegalConsumePath(path)) return null;
    if (!headSha || typeof headSha !== 'string') return null;
    var payload = {
        path: path,
        head: headSha,
        at: atIso || new Date().toISOString()
    };
    return CONSUME_MARKER_PREFIX + JSON.stringify(payload) + MARKER_SUFFIX + '\n' +
        '🏷️ agent:rework consumed (path: ' + path + ', head ' +
        String(headSha).substring(0, 7) + ') — gh-840 consumption audit. ' +
        'The label must come off ONLY via a successful rework close; if no close ' +
        'follows, the tick sweep re-arms it.';
}

/**
 * Builds the sweep's restore bookkeeping marker (gh-821-style durability:
 * the next ticks read it as the newest quiet-window anchor, so a restore
 * whose arm is re-consumed without work re-enters the same bounded cycle
 * instead of being mistaken for fresh state).
 */
function buildRestoreMarkerComment(headSha, reason, atIso) {
    if (!headSha || typeof headSha !== 'string') return null;
    var payload = {
        head: headSha,
        reason: reason || 'restore',
        at: atIso || new Date().toISOString()
    };
    return RESTORE_MARKER_PREFIX + JSON.stringify(payload) + MARKER_SUFFIX + '\n' +
        '🔄 rework arm restored — previous consumption left threads unresolved (gh-840).';
}

function extractMarker(body, prefix) {
    var text = String(body || '');
    var start = text.indexOf(prefix);
    if (start === -1) return null;
    start += prefix.length;
    var end = text.indexOf(MARKER_SUFFIX, start);
    if (end === -1) return null;
    var raw = text.substring(start, end).trim();
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    return (parsed && typeof parsed === 'object') ? parsed : null;
}

function commentAuthorLogin(item) {
    if (!item) return null;
    var u = item.user || item.author;
    if (!u) return null;
    var login = u.login || u.name;
    return login ? String(login).toLowerCase() : null;
}

/**
 * Marker list parser shared by consume/restore markers. comments: [{body,
 * user?|author?}] — opts.authorLogins, when a non-empty array, restricts to
 * machine identities (case-insensitive; forge hardening — the marker format
 * is public). Entries keep their payload order (comment streams arrive
 * chronological) and gain atMs (Date.parse of the embedded `at`, NaN when
 * unparsable — consumers must fail closed on NaN).
 */
function parseMarkers(comments, prefix, opts) {
    var list = Array.isArray(comments) ? comments : [];
    var allow = (opts && Array.isArray(opts.authorLogins) && opts.authorLogins.length)
        ? opts.authorLogins : null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
        if (allow) {
            var who = commentAuthorLogin(list[i]);
            var trusted = false;
            for (var a = 0; a < allow.length; a++) {
                if (who && who === String(allow[a] || '').toLowerCase()) { trusted = true; break; }
            }
            if (!trusted) continue;
        }
        var rec = extractMarker(list[i] && list[i].body, prefix);
        if (!rec) continue;
        rec.atMs = Date.parse(rec.at || '');
        rec.order = i;
        out.push(rec);
    }
    // Timestamp order, payload order as tiebreak (reviewVerdicts parity):
    // callers ask for the NEWEST marker — payload order alone is arbitrary
    // when several markers carry the same clock tick.
    out.sort(function (a, b) {
        var aTime = isNaN(a.atMs) ? -1 : a.atMs;
        var bTime = isNaN(b.atMs) ? -1 : b.atMs;
        if (aTime !== bTime) return aTime < bTime ? -1 : 1;
        return (a.order || 0) - (b.order || 0);
    });
    return out;
}

function parseConsumeMarkers(comments, opts) {
    var out = parseMarkers(comments, CONSUME_MARKER_PREFIX, opts);
    // Only legal paths count — a forged/garbled path marker is not evidence.
    return out.filter(function (m) { return isLegalConsumePath(m.path); });
}

function parseRestoreMarkers(comments, opts) {
    return parseMarkers(comments, RESTORE_MARKER_PREFIX, opts);
}

/**
 * The sweep decision (pure — gh-840 AC1–AC3). state:
 *   unresolvedMachineThreads        — unresolved threads authored by the
 *                                     machine (the caller's census; >0 is
 *                                     the "threads to own" proof and the
 *                                     ONLY close-proof inverse — a healthy
 *                                     close resolves the machine threads);
 *   hasReworkLabel                  — agent:rework present on the PR;
 *   reworkInFlight                  — gh-806 latch OR an active leg run on
 *                                     the head;
 *   consumedAtMs / restoredAtMs     — newest marker timestamps (null when
 *                                     no evidence exists);
 *   nowMs, staleMs                  — the clock and the quiet bound.
 * Returns { restore, reason }:
 *   'restore'                  — re-arm agent:rework + restore comment;
 *   'no-unresolved-threads'    — nothing to own (AC2 close proof);
 *   'arm-present'              — the label is there; the armer owns it;
 *   'rework-in-flight'         — a leg owns the threads;
 *   'no-consumption-evidence'  — never consumed (AC3 — human-thread-only
 *                                PRs untouched);
 *   'within-grace'             — quiet window not elapsed (bounded re-arm);
 *   'bad-clock'                — missing/unparsable clock → fail closed.
 *
 * IMPORTANT (gh-840 rework review): there is deliberately NO head-position
 * gate. silentUpdateBranch's silent refresh merges advance the head without
 * a leg and without resolving threads; an advanced head carrying the same
 * open machine threads is refresh evidence, not close evidence. Head
 * position is still consulted by the caller for the gh-806 latch, the
 * in-flight leg gate and the marker bookkeeping — never as a close proof.
 */
function shouldRestoreArm(state) {
    var s = state || {};
    if (s.hasReworkLabel) return { restore: false, reason: 'arm-present' };
    if (s.reworkInFlight) return { restore: false, reason: 'rework-in-flight' };
    if (!(Number(s.unresolvedMachineThreads) > 0)) {
        return { restore: false, reason: 'no-unresolved-threads' };
    }
    var consumed = (typeof s.consumedAtMs === 'number' && !isNaN(s.consumedAtMs))
        ? s.consumedAtMs : null;
    var restored = (typeof s.restoredAtMs === 'number' && !isNaN(s.restoredAtMs))
        ? s.restoredAtMs : null;
    if (consumed === null && restored === null) {
        return { restore: false, reason: 'no-consumption-evidence' };
    }
    var quietSince = consumed === null ? restored
        : (restored === null ? consumed : Math.max(consumed, restored));
    var nowMs = (typeof s.nowMs === 'number' && !isNaN(s.nowMs)) ? s.nowMs : null;
    if (nowMs === null) return { restore: false, reason: 'bad-clock' };
    var staleMs = (typeof s.staleMs === 'number' && s.staleMs > 0)
        ? s.staleMs : DEFAULT_RESTORE_STALE_MS;
    if (nowMs - quietSince < staleMs) return { restore: false, reason: 'within-grace' };
    return { restore: true, reason: 'restore' };
}

module.exports = {
    DEFAULT_RESTORE_STALE_MS: DEFAULT_RESTORE_STALE_MS,
    CONSUME_MARKER_PREFIX: CONSUME_MARKER_PREFIX,
    RESTORE_MARKER_PREFIX: RESTORE_MARKER_PREFIX,
    CONSUME_PATHS: CONSUME_PATHS,
    buildConsumeAuditComment: buildConsumeAuditComment,
    buildRestoreMarkerComment: buildRestoreMarkerComment,
    parseConsumeMarkers: parseConsumeMarkers,
    parseRestoreMarkers: parseRestoreMarkers,
    shouldRestoreArm: shouldRestoreArm
};
