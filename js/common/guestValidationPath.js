/**
 * Guest validation path (gh-113) — the pure half of the guest-PR
 * dead-zone fixes.
 *
 * Live shape (IstiN/flutter_agent_harness, 2026-10-19, PRs #1634/#1615/#1591):
 * guest PRs from a fork sat APROVED + CLEAN + behind=0 for hours with a
 * MANUAL ai_validating label and never merged. Three facts compound:
 *
 *   1. The validation dispatch is fork-blind: `workflow_dispatch` with
 *      `ref: <fork-branch>` answers 422 on the base repo (gh-1075 fixed
 *      the AI-leg lane; the validate_pr lane stays branch-targeted), so
 *      no real validation run is ever dispatched on a guest head.
 *   2. The guest heads carry only the merge bot's SKIPPED stub checks
 *      ('merge / …'). The smProvider ROLLUP label deliberately reads
 *      'pending' for such a head (bookkeeping checks are "no verdict
 *      yet" — that label arms validate-fresh), so merge-validated
 *      (checks: green) never matches either.
 *   3. The red re-validation lane (rework-on-validation-failed) is
 *      machine-author-only, so a stale validation_failed park on a
 *      guest has no self-clear twin of gh-750.
 *
 * The owner-sanctioned policy this module implements: a MANUAL
 * ai_validating label on a guest PR is an EXTERNAL VALIDATION ARM —
 * the human vouches for the head — so the merge lane may treat a
 * zero-failing check rollup (no real red, no real in-flight check;
 * bookkeeping stubs and CANCELLED runs are not verdicts) as green for
 * guests, and the park ladder gains a guest rung that clears a stale
 * validation_failed when the punished head carries no red of its own.
 *
 * Exports:
 *   realCheckTally(checkRuns, bookeepingPrefixes) — the REAL check-run
 *       census { red, pending, real, bokept, canceled }. Deliberately
 *       NOT the smProvider rollup semantics: bookkeeping-only heads
 *       tally zero real checks here (the merge-side policy), while the
 *       rollup label reads 'pending' for them (the arming-side policy).
 *   mergeableZeroFailing(tally) — merge bar: red === 0 && pending === 0.
 *       A real in-flight check owns the verdict — never merge ahead of
 *       it. Degraded input (null) fails closed.
 *   recoverableZeroRed(tally) — park-recovery bar: the head is decided
 *       (real >= 1, the fa#923 undecided-head guard) and red === 0. A
 *       real in-flight run is not red; its verdict re-parks a genuinely
 *       red head one cycle later. Degraded input fails closed.
 *   newestArmEvent(events) — the newest `labeled` event for
 *       ai_validating from an issue-events feed (chronological, so the
 *       LAST match wins); null when the feed carries none.
 *   isManualArm(armEvent, machineAuthor) — the external-arm test: the
 *       event exists and its actor is NOT a machine login (the gh-728
 *       comma-separated knob, gh-1025 [bot]-suffix normalization). No
 *       event → false (fail closed — an irreversible merge needs the
 *       proof). No machineAuthor configured → every actor is external
 *       (a deployment without the knob has no machine identity at all).
 *   blockedGuestEntry(item, pr, isGuest) — the dead-zone shape: guest +
 *       (pr_approved | ai_validating) + CLEAN + rollup none|pending.
 *       Returns the summary entry or null. A failed/absent status probe
 *       (pr === null) is NEVER counted (fail closed).
 *   mergeDeadZoneCary(prev, current) — the cross-tick carry for the
 *       factory-state snapshot: per-PR first-seen timestamps (age never
 *       resets while a guest stays blocked); guests that stopped being
 *       blocked drop out.
 *
 * GraalJS constraints: var declarations, plain functions, JSON-safe
 * data. One hoisted require (./machineAuthor.js — a pure leaf), never
 * lazy (gh-823 pack-require rule).
 */

'use strict';

var machineAuthorModule = require('./machineAuthor.js');

// Parity with smProvider BOOKKEEPING_CHECK_PREFIXES — passed in by the
// caller (smAgent forwards smProviderModule.BOOKEEPING_CHECK_PREFIXES so
// the two lists can never drift); this default only keeps the module
// usable standalone.
var DEFAULT_BOOKEEPING_PREFIXES = ['kicker /', 'Wake-up probe', 'merge /'];

var RED_CONCLUSIONS = ['FAILURE', 'TIMED_OUT'];
var PENDING_STATUSES = ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING'];

// Classify ONE check-run entry (CheckRun name/conclusion/status or
// StatusContext context/state — same dual read as the provider).
function _normalizeRun(c) {
    return {
        name: String((c && (c.name || c.context)) || ''),
        conclusion: (c && c.conclusion)
            ? String(c.conclusion).toUpperCase()
            : ((c && c.state) ? String(c.state).toUpperCase() : null),
        status: (c && c.status) ? String(c.status).toUpperCase() : null
    };
}

function _isBookeeping(name, prefixes) {
    var list = prefixes || DEFAULT_BOOKEEPING_PREFIXES;
    for (var i = 0; i < list.length; i++) {
        if (name.indexOf(list[i]) === 0) return true;
    }
    return false;
}

/**
 * The REAL check-run census of one head.
 * @param {Array|null} checkRuns raw REST check-runs entries
 * @param {Array|null} bookeepingPrefixes stub-name prefixes ('merge /', …)
 * @returns {{red: number, pending: number, real: number, bokept: number,
 *            canceled: number}} — CANCELLED conclusions and bookeeping
 *          stubs are never verdicts; a run with no conclusion or a
 *          queued/in_progress status pends.
 */
function realCheckTally(checkRuns, bookeepingPrefixes) {
    var t = { red: 0, pending: 0, real: 0, bokept: 0, canceled: 0 };
    if (!checkRuns || !checkRuns.length) return t;
    for (var i = 0; i < checkRuns.length; i++) {
        var c = _normalizeRun(checkRuns[i]);
        if (_isBookeeping(c.name, bookeepingPrefixes)) { t.bokept++; continue; }
        if (c.conclusion === 'CANCELLED') { t.canceled++; continue; }
        t.real++;
        if (c.conclusion && RED_CONCLUSIONS.indexOf(c.conclusion) !== -1) t.red++;
        else if (!c.conclusion || PENDING_STATUSES.indexOf(c.status) !== -1) t.pending++;
    }
    return t;
}

/** Merge bar: no real red AND no real in-flight check. Null fails closed. */
function mergeableZeroFailing(tally) {
    return !!tally && tally.red === 0 && tally.pending === 0;
}

/**
 * Park-recovery bar: the head is DECIDED (at least one real concluded
 * check) and carries no red. `real >= 1` is the fa#923 guard — the park
 * is set ON the punished head, so a zero-check head is "undecided", not
 * "the red dissolved"; clearing on it would un-park the stale human
 * heads the sticky park protects. A real in-flight run is not red; its
 * verdict re-parks a genuinely red head one cycle later. Null fails
 * closed.
 */
function recoverableZeroRed(tally) {
    return !!tally && tally.red === 0 && tally.real >= 1;
}

/**
 * The newest ai_validating labeling event from an issue-events feed.
 * GitHub returns events chronological (oldest first) — the LAST match
 * is the newest arm. Tolerates the string label spelling.
 */
function newestArmEvent(events) {
    if (!events || !events.length) return null;
    var newest = null;
    for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (!e || e.event !== 'labeled') continue;
        var name = e.label && typeof e.label === 'object'
            ? e.label.name : e.label;
        if (name !== 'ai_validating') continue;
        newest = {
            login: (e.actor && e.actor.login) || null,
            createdAt: e.created_at || null
        };
    }
    return newest;
}

/**
 * The external-validation-arm test: an arm event exists and its actor is
 * NOT one of the deployment's machine logins. No event → false (an
 * irreversible merge needs the proof). No machineAuthor configured →
 * every actor is external.
 */
function isManualArm(armEvent, machineAuthor) {
    if (!armEvent || !armEvent.login) return false;
    var logins = machineAuthorModule.machineAuthorLogins(machineAuthor);
    if (!logins.length) return true;
    return !machineAuthorModule.loginMatchesList(armEvent.login, logins);
}

/**
 * The tick dead-zone shape (gh-113 AC3): a GUEST PR, approved and/or
 * armed, sitting CLEAN (behind=0) with NO concluded check verdict —
 * the population that can neither merge (merge-validated wants green)
 * nor validate (the fork-blind dispatch never lands). Machine PRs and
 * verdict-carrying heads (green/red) have owners — never counted.
 *
 * @param {Object} item   open-PR list item {prNumber, labels, …}
 * @param {Object|null} pr prStatus {mergeState, checkConclusion} or null
 * @param {boolean} isGuest result of the machineAuthorship probe
 * @returns {Object|null} {prNumber, labels, checkConclusion, mergeState}
 */
function blockedGuestEntry(item, pr, isGuest) {
    if (!isGuest || !item || !item.prNumber) return null;
    if (!pr) return null; // probe failed — never counted (fail closed)
    var labels = (item.labels || []);
    var armed = labels.indexOf('pr_approved') !== -1 ||
        labels.indexOf('ai_validating') !== -1;
    if (!armed) return null;
    if (pr.mergeState !== 'CLEAN') return null;
    if (pr.checkConclusion !== 'none' && pr.checkConclusion !== 'pending') return null;
    return {
        prNumber: item.prNumber,
        labels: labels,
        checkConclusion: pr.checkConclusion,
        mergeState: pr.mergeState
    };
}

/**
 * Cross-tick carry for the factory-state snapshot: the blocked list is
 * THIS scan's; blockedAt keeps each PR's FIRST-SEEN timestamp (age never
 * resets while a guest stays blocked) and drops guests that stopped
 * being blocked. Garbage/absent input degrades to a fresh carry.
 */
function mergeDeadZoneCary(prev, current) {
    var cary = { blocked: [], blockedAt: {} };
    var scannedAt = current && current.scannedAt;
    if (!scannedAt) scannedAt = new Date().toISOString();
    var prevAt = (prev && prev.blockedAt && typeof prev.blockedAt === 'object')
        ? prev.blockedAt : {};
    var blocked = (current && Array.isArray(current.blocked)) ? current.blocked : [];
    for (var i = 0; i < blocked.length; i++) {
        var entry = blocked[i];
        if (!entry || !entry.prNumber) continue;
        cary.blocked.push(entry);
        var key = String(entry.prNumber);
        cary.blockedAt[key] = prevAt[key] || scannedAt;
    }
    return cary;
}

module.exports = {
    realCheckTally: realCheckTally,
    mergeableZeroFailing: mergeableZeroFailing,
    recoverableZeroRed: recoverableZeroRed,
    newestArmEvent: newestArmEvent,
    isManualArm: isManualArm,
    blockedGuestEntry: blockedGuestEntry,
    mergeDeadZoneCary: mergeDeadZoneCary,
    DEFAULT_BOOKEEPING_PREFIXES: DEFAULT_BOOKEEPING_PREFIXES
};
