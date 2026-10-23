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
// StatusContext context/state — same dual read as the provider). Kept in
// tiny pieces: the crap4js gate (CRAP <= 8) measures every helper, and
// GraalJS forbids the array combinators that would shrink the branching.
function _runField(c, primary, fallback) {
    return (c && (c[primary] || c[fallback])) || null;
}

function _upperOrNull(v) {
    return v ? String(v).toUpperCase() : null;
}

function _normalizeRun(c) {
    return {
        name: String(_runField(c, 'name', 'context') || ''),
        conclusion: _upperOrNull(_runField(c, 'conclusion', 'state')),
        status: _upperOrNull(c && c.status)
    };
}

function _isBookeeping(name, prefixes) {
    var list = prefixes || DEFAULT_BOOKEEPING_PREFIXES;
    for (var i = 0; i < list.length; i++) {
        if (name.indexOf(list[i]) === 0) return true;
    }
    return false;
}

function _isRedConclusion(conclusion) {
    return !!conclusion && RED_CONCLUSIONS.indexOf(conclusion) !== -1;
}

function _isPendingRun(conclusion, status) {
    return !conclusion || PENDING_STATUSES.indexOf(status) !== -1;
}

// One run → exactly one tally bucket ('bokept' | 'canceled' | 'red' |
// 'pending' | 'real'). Order is the policy: stubs and CANCELLED are
// never verdicts; a red conclusion is never also pending.
function _tallyBucket(c, bookeepingPrefixes) {
    if (_isBookeeping(c.name, bookeepingPrefixes)) return 'bokept';
    if (c.conclusion === 'CANCELLED') return 'canceled';
    if (_isRedConclusion(c.conclusion)) return 'red';
    if (_isPendingRun(c.conclusion, c.status)) return 'pending';
    return 'real';
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
        var bucket = _tallyBucket(_normalizeRun(checkRuns[i]), bookeepingPrefixes);
        if (bucket === 'red' || bucket === 'pending') t.real++;
        t[bucket]++;
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

// The label spelling of one event (object {name} or plain string).
function _labelName(e) {
    return (e.label && typeof e.label === 'object') ? e.label.name : e.label;
}

// One event → the arm shape, or null when it is not an ai_validating
// labeling event.
function _armEventOf(e) {
    if (!e || e.event !== 'labeled') return null;
    if (_labelName(e) !== 'ai_validating') return null;
    return {
        login: (e.actor && e.actor.login) || null,
        createdAt: e.created_at || null
    };
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
        var arm = _armEventOf(events[i]);
        if (arm) newest = arm;
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

// The lifecycle-arm test on the item's labels: approved and/or armed.
function _armedLabels(labels) {
    var list = labels || [];
    return list.indexOf('pr_approved') !== -1 ||
        list.indexOf('ai_validating') !== -1;
}

// A countable item: a GUEST with a PR number — or null. Garbage in, null
// out (the scan never counts what it cannot read).
function _knownGuestItem(item, isGuest) {
    if (!isGuest || !item || !item.prNumber) return null;
    return (item.labels || []);
}

/**
 * Cheap pre-filter before calling prStatus in the dead-zone scan (gh-1181):
 * returns the normalized labels array iff the item is a known guest PR
 * carrying pr_approved or ai_validating, else null.
 */
function _armedGuestLabels(item, isGuest) {
    var labels = _knownGuestItem(item, isGuest);
    if (!labels || !_armedLabels(labels)) return null;
    return labels;
}

function isArmedGuestItem(item, isGuest) {
    return !!_armedGuestLabels(item, isGuest);
}

// A verdict-less CLEAN head (the dead-zone rollup: none | pending) — or
// null. A failed/absent status probe (pr === null) is NEVER counted
// (fail closed).
function _deadZoneRollup(pr) {
    if (!pr) return null;
    if (pr.mergeState !== 'CLEAN') return null;
    if (pr.checkConclusion !== 'none' && pr.checkConclusion !== 'pending') return null;
    return pr;
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
    var labels = _armedGuestLabels(item, isGuest);
    if (!labels || !_deadZoneRollup(pr)) return null;
    return {
        prNumber: item.prNumber,
        labels: labels,
        checkConclusion: pr.checkConclusion,
        mergeState: pr.mergeState
    };
}

// The previous snapshot's first-seen stamps — or {} when absent/garbage.
function _prevBlockedAt(prev) {
    return (prev && prev.blockedAt && typeof prev.blockedAt === 'object')
        ? prev.blockedAt : {};
}

// This scan's blocked list — or [] when absent/garbage.
function _blockedEntries(current) {
    return (current && Array.isArray(current.blocked)) ? current.blocked : [];
}

// The scan timestamp — or now() when the caller did not stamp one.
function _scannedAtOf(current) {
    return (current && current.scannedAt) || new Date().toISOString();
}

/**
 * Cross-tick carry for the factory-state snapshot: the blocked list is
 * THIS scan's; blockedAt keeps each PR's FIRST-SEEN timestamp (age never
 * resets while a guest stays blocked) and drops guests that stopped
 * being blocked. Garbage/absent input degrades to a fresh carry.
 */
function mergeDeadZoneCary(prev, current) {
    var cary = { blocked: [], blockedAt: {} };
    var scannedAt = _scannedAtOf(current);
    var prevAt = _prevBlockedAt(prev);
    var blocked = _blockedEntries(current);
    for (var i = 0; i < blocked.length; i++) {
        var entry = blocked[i];
        if (!entry || !entry.prNumber) continue;
        cary.blocked.push(entry);
        cary.blockedAt[String(entry.prNumber)] =
            prevAt[String(entry.prNumber)] || scannedAt;
    }
    return cary;
}

function _rawPrLabelName(l) {
    return (l && l.name) || l;
}

function _rawPrNumber(p) {
    return p.number || p.prNumber;
}

function _rawPrLabels(p) {
    return (p.labels || []).map(_rawPrLabelName);
}

function _rawPrAuthor(p) {
    var user = p.user;
    return (user && user.login) || p.author || '';
}

function _rawPrItem(p) {
    if (!p) return { prNumber: undefined, labels: [], author: '' };
    return {
        prNumber: _rawPrNumber(p),
        labels: _rawPrLabels(p),
        author: _rawPrAuthor(p)
    };
}

function _probePrStatusSafe(provider, prNumber) {
    try { return provider.prStatus(prNumber); } catch (e) { return null; }
}

function _asOpenPrArray(dzPrs) {
    return Array.isArray(dzPrs) ? dzPrs : [];
}

/**
 * Scan one repository's open PR list for guest PRs stuck in the validation
 * dead zone (gh-113 AC3, gh-1181 pre-filter). Pre-filters by machine
 * authorship and armed labels BEFORE calling provider.prStatus(prNumber).
 *
 * @param {Object} provider     smProvider instance ({listOpenPrs, prStatus})
 * @param {Object} repoInfo     {owner, repo}
 * @param {string} machineAuthor deployment machineAuthor setting
 * @param {Array}  blockedOut   accumulator array for blocked guest entries
 * @returns {Object} {totalOpen, probedCount}
 */
function scanRepoGuestDeadZone(provider, repoInfo, machineAuthor, blockedOut) {
    var dzList = _asOpenPrArray(provider.listOpenPrs());
    var probedCount = 0;
    for (var i = 0; i < dzList.length; i++) {
        var item = _rawPrItem(dzList[i]);
        var isGuest = !machineAuthorModule.isMachineAuthored(item, machineAuthor, repoInfo.owner);
        if (!isArmedGuestItem(item, isGuest)) continue;
        probedCount++;
        var entry = blockedGuestEntry(
            item, _probePrStatusSafe(provider, item.prNumber), isGuest);
        if (entry) blockedOut.push(entry);
    }
    return { totalOpen: dzList.length, probedCount: probedCount };
}

module.exports = {
    realCheckTally: realCheckTally,
    mergeableZeroFailing: mergeableZeroFailing,
    recoverableZeroRed: recoverableZeroRed,
    newestArmEvent: newestArmEvent,
    isManualArm: isManualArm,
    isArmedGuestItem: isArmedGuestItem,
    blockedGuestEntry: blockedGuestEntry,
    scanRepoGuestDeadZone: scanRepoGuestDeadZone,
    mergeDeadZoneCary: mergeDeadZoneCary,
    DEFAULT_BOOKEEPING_PREFIXES: DEFAULT_BOOKEEPING_PREFIXES
};
