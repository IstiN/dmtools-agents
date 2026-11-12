/**
 * reviewPoolMarkers.js — the gh-1406 §7 reviewer-pool marker family: the
 * head-carried completion + round records the merge gate reads.
 *
 *   <!-- dmtools:review-pass {"reviewer":"security","head":"<sha>","at":"..."} -->
 *   <!-- dmtools:review-pool {"head":"<sha>","round":"first",
 *        "reviewers":[{"name":"base","required":true}],"at":"..."} -->
 *
 * §7 mechanics: every reviewer leg stamps a PASS marker on completion
 * (`first` counts COMPLETIONS, not attempts); the round stamps ONE
 * pool-outcome marker naming the enabled reviewers and their required
 * flags; the SM merge-time check (gh-1370 lane) withholds the merge while
 * any required reviewer of the head's pool outcome lacks a same-head PASS
 * marker (never silent merge, never silent approval — the gh-957 doctrine).
 *
 * Trust: both record families parse ONLY from machine identities (the
 * machineAuthor allowlist via reviewVerdicts.parseMarkerComments,
 * fail closed) — an unconfigured/empty allowlist trusts nothing, so a
 * forged PASS marker can never satisfy the gate. The required-reviewer
 * hold rides the shared dmtools:merge-hold family (reason
 * "required-reviewer" — a separate dedup budget from the open-threads and
 * verdict holds) and, like those, is accepted from ANY author for DEDUP
 * purposes (a hold never enables a merge, it only documents one).
 *
 * Pure module — no dmtools globals. Requires hoisted (gh-823). Keep it
 * GraalJS-clean (var + plain functions, JSON-safe data only).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');

// The marker family (§7).
var PASS_MARKER_PREFIX = '<!-- dmtools:review-pass ';
var POOL_MARKER_PREFIX = '<!-- dmtools:review-pool ';
var MARKER_SUFFIX = ' -->';

// The required-reviewer hold rides the shared dmtools:merge-hold family
// (one marker grammar; the reason field separates the dedup budgets).
var HOLD_REASON = 'required-reviewer';

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}

// ── markers (§7) ─────────────────────────────────────────────────────────────

/**
 * The reviewer completion marker comment (head-carried, §7): the machine
 * record that the reviewer's pass COMPLETED on this head — `first` counts
 * these, and the merge gate reads them for required reviewers.
 */
function buildPassMarkerComment(skillName, headSha, nowIso) {
    var payload = {
        reviewer: String(skillName || ''),
        head: String(headSha || ''),
        at: String(nowIso || '')
    };
    return PASS_MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        MARKER_SUFFIX + '\n\uD83E\uDD16 Reviewer pool: `' + String(skillName || '') +
        '` completed its review pass on head ' + String(headSha || '').substring(0, 7) + '.';
}

function passRecordFromPayload(parsed) {
    if (!parsed || !isNonEmptyString(parsed.reviewer) || !isNonEmptyString(parsed.head)) return null;
    return { reviewer: parsed.reviewer, head: String(parsed.head), at: String(parsed.at || '') };
}

/**
 * The trusted PASS markers of a PR, newest-first per the shared comparator.
 * opts = { authorLogins: [...] } — the machineAuthor allowlist; an
 * unconfigured allowlist trusts NOTHING ([] — fail closed: a forged PASS
 * marker can never satisfy the merge gate).
 */
function parsePassMarkers(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments || [], opts || {},
        PASS_MARKER_PREFIX, MARKER_SUFFIX, passRecordFromPayload, true);
}

/** Has this reviewer a PASS marker on this head (prefix sha equality)? */
function hasCompletedOnHead(passMarkers, skillName, headSha) {
    var list = Array.isArray(passMarkers) ? passMarkers : [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].reviewer === skillName && reviewVerdicts.sameHead(list[i].head, headSha)) return true;
    }
    return false;
}

/** The {name, required} normalization of the round's enabled reviewers. */
function poolOutcomeEntriesOf(entries) {
    var list = Array.isArray(entries) ? entries : [];
    return list.map(function(e) {
        return { name: String((e && e.name) || ''), required: (e && e.required) === true };
    });
}

/** The human note's reviewer list: ⛔ marks the required ones. */
function poolOutcomeNamesOf(entries) {
    var names = [];
    for (var i = 0; i < entries.length; i++) {
        names.push((entries[i].required ? '\u26D4 ' : '') + String((entries[i] && entries[i].name) || ''));
    }
    return names;
}

/**
 * The round's pool-outcome marker comment (§7): ONE per round, naming the
 * enabled reviewers the round expected plus their required flags and
 * completion state. This is the merge gate's expectation record.
 */
function buildPoolOutcomeMarkerComment(headSha, roundName, entries, nowIso) {
    var reviewers = poolOutcomeEntriesOf(entries);
    var payload = {
        head: String(headSha || ''),
        round: String(roundName || ''),
        reviewers: reviewers,
        at: String(nowIso || '')
    };
    var names = poolOutcomeNamesOf(reviewers);
    return POOL_MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        MARKER_SUFFIX + '\n\uD83E\uDD16 Reviewer pool round `' + String(roundName || '') +
        '` pool round on head ' + String(headSha || '').substring(0, 7) + ': ' +
        (names.length ? names.join(', ') : '(no enabled reviewers)') + '.';
}

/** The {name, required} entries of a parsed pool payload (nameless skipped). */
function poolEntryListOf(reviewers) {
    var entries = [];
    var list = Array.isArray(reviewers) ? reviewers : [];
    for (var i = 0; i < list.length; i++) {
        var e = list[i] || {};
        if (!isNonEmptyString(e.name)) continue;
        entries.push({ name: e.name, required: e.required === true });
    }
    return entries;
}

function poolRecordFromPayload(parsed) {
    if (!parsed || !isNonEmptyString(parsed.head)) return null;
    return {
        head: String(parsed.head),
        round: String(parsed.round || ''),
        reviewers: poolEntryListOf(parsed.reviewers),
        at: String(parsed.at || '')
    };
}

/** The trusted pool-outcome markers (machineAuthor allowlist, fail closed). */
function parsePoolOutcomeMarkers(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments || [], opts || {},
        POOL_MARKER_PREFIX, MARKER_SUFFIX, poolRecordFromPayload, true);
}

/** The newest pool-outcome record for one head, or null. */
function newestPoolOutcomeForHead(poolRecords, headSha) {
    var list = Array.isArray(poolRecords) ? poolRecords : [];
    for (var i = list.length - 1; i >= 0; i--) {
        if (reviewVerdicts.sameHead(list[i].head, headSha)) return list[i];
    }
    return null;
}

/**
 * The required reviewers of a pool outcome that lack a same-head PASS
 * marker (§7 — the gate's gap list).
 */
function requiredReviewerGaps(outcome, passMarkers, headSha) {
    if (!outcome) return [];
    var gaps = [];
    var entries = Array.isArray(outcome.reviewers) ? outcome.reviewers : [];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e || e.required !== true) continue;
        if (!hasCompletedOnHead(passMarkers, e.name, headSha)) gaps.push(e.name);
    }
    return gaps;
}

/** The merge-hold payload of the required-reviewer hold (shared grammar). */
function requiredHoldPayload(missing, headSha, nowIso, escalated, heldSince) {
    var payload = {
        reason: HOLD_REASON,
        missing: Array.isArray(missing) ? missing : [],
        head: String(headSha || ''),
        at: String(nowIso || ''),
        escalated: escalated === true
    };
    if (heldSince) payload.heldSince = heldSince;
    return payload;
}

/** The human note under the marker: the plain hold, or the ESCALATED one. */
function requiredHoldNote(payload, headSha) {
    var names = payload.missing.join(', ') || '(none)';
    var head = String(headSha || '').substring(0, 7);
    if (payload.escalated) {
        return '\uD83E\uDD16 Merge hold ESCALATED: the required reviewer(s) ' + names +
            ' still have no PASS marker on head ' + head +
            ' — needs-human; the review leg exhausted its retry budget (never silent merge, never silent approval).';
    }
    return '\uD83E\uDD16 Merge hold: required reviewer(s) ' + names +
        ' have no PASS marker on head ' + head +
        ' — the merge is withheld until their review legs complete (retry with backoff; a failed required leg never merges).';
}

/**
 * The required-reviewer merge-hold marker (the shared dmtools:merge-hold
 * family, reason "required-reviewer" — a separate dedup budget from the
 * open-threads and verdict holds).
 */
function buildRequiredReviewerHoldMarker(missing, headSha, nowIso, escalated, heldSince) {
    var payload = requiredHoldPayload(missing, headSha, nowIso, escalated, heldSince);
    return '<!-- dmtools:merge-hold ' + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        MARKER_SUFFIX + '\n' + requiredHoldNote(payload, headSha);
}

function holdRecordFromPayload(parsed) {
    if (!parsed || String(parsed.reason || '') !== HOLD_REASON || !isNonEmptyString(parsed.head)) return null;
    return {
        head: String(parsed.head),
        at: String(parsed.at || ''),
        escalated: parsed.escalated === true,
        missing: Array.isArray(parsed.missing) ? parsed.missing : []
    };
}

/** The existing required-reviewer hold markers, oldest-first. */
function parseRequiredReviewerHolds(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments || [], opts || {},
        '<!-- dmtools:merge-hold ', MARKER_SUFFIX, holdRecordFromPayload, false);
}

/**
 * The merge-gate state for one PR head (§7): is there a same-head pool
 * outcome naming required reviewers, and which of them lack a same-head
 * PASS marker? comments is the PR comment list; logins the machineAuthor
 * allowlist (empty → nothing is trusted → no gaps are ever computed from
 * forged markers). Returns { applicable, outcome, missing, hold } —
 * `hold` is the existing same-head required-reviewer hold (the caller's
 * dedup + escalation-clock key), or null.
 */
function requiredReviewerHoldState(comments, logins, headSha, nowIso) {
    var opts = { authorLogins: Array.isArray(logins) ? logins : [] };
    var poolRecords = parsePoolOutcomeMarkers(comments, opts);
    var outcome = newestPoolOutcomeForHead(poolRecords, headSha);
    if (!outcome) return { applicable: false, outcome: null, missing: [], hold: null };
    var passMarkers = parsePassMarkers(comments, opts);
    var missing = requiredReviewerGaps(outcome, passMarkers, headSha);
    var holds = parseRequiredReviewerHolds(comments, opts);
    var hold = null;
    for (var i = 0; i < holds.length; i++) {
        if (reviewVerdicts.sameHead(holds[i].head, headSha)) { hold = holds[i]; break; }
    }
    return { applicable: true, outcome: outcome, missing: missing, hold: hold };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PASS_MARKER_PREFIX: PASS_MARKER_PREFIX,
        POOL_MARKER_PREFIX: POOL_MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        HOLD_REASON: HOLD_REASON,
        buildPassMarkerComment: buildPassMarkerComment,
        parsePassMarkers: parsePassMarkers,
        hasCompletedOnHead: hasCompletedOnHead,
        buildPoolOutcomeMarkerComment: buildPoolOutcomeMarkerComment,
        parsePoolOutcomeMarkers: parsePoolOutcomeMarkers,
        newestPoolOutcomeForHead: newestPoolOutcomeForHead,
        requiredReviewerGaps: requiredReviewerGaps,
        buildRequiredReviewerHoldMarker: buildRequiredReviewerHoldMarker,
        parseRequiredReviewerHolds: parseRequiredReviewerHolds,
        requiredReviewerHoldState: requiredReviewerHoldState
    };
}
