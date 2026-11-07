/**
 * mergeStateStatus reconcile (gh-140) — the SM check-tracker's blind spot
 * closure. Live gh-1392 (2026-11-06/07): the tracked verdict check (the
 * machine's own Quality run) went green, while a SEPARATE repo workflow
 * (docs-freshness) failed on the same head — GitHub's real mergeStateStatus
 * read UNSTABLE, the machine's merge lanes refuse UNSTABLE (mergeTrigger
 * parity: 'checks not green'), and every re-derivation lane that keys on
 * the verdict said green — the PR froze for ~12h with no rework lap.
 *
 * The reconcile: when the check-tracker's fold over the rollup sees NO
 * failure ('green'/'none') but the PR body REPORTS an unstable merge state,
 * the tracked set does not cover what GitHub counts — the verdict downgrades
 * to 'red' (the existing bounded red-head rework flow reacts within one
 * tick) and the actually-failing check names are registered on the status
 * (untrackedFailingChecks — auditable, feeds the state JSON).
 *
 *   AC1  green tracked verdict + failing untracked check → red within one
 *        tick (bounded by the existing red-head caps — semantics unchanged)
 *   AC2  fully-green PRs (CLEAN / reported-but-not-unstable) never reconcile
 *   AC3  the failing names ride the status / state JSON (auditable)
 *
 * Pure module — no tool globals, no requires (smProvider requires THIS;
 * the reverse would close a cycle). GraalJS constraints: var, plain
 * functions, JSON-safe data.
 */

'use strict';

// GitHub mergeStateStatus spellings that mean "a check GitHub reports fails
// on this head": UNSTABLE (REST mergeable_state — failing non-blocking
// checks; the machine merge lanes treat it as blocked) and FAILED (older
// GraphQL spelling). BLOCKED is deliberately NOT here: with a green fold a
// BLOCKED report is the conversation-resolution gate (gh-828), not a check
// failure — the fold saw no red check to register.
var UNSTABLE_MERGE_STATES = ['UNSTABLE', 'FAILED'];

// Tracked-verdict labels that mean the fold saw NO failure — only these
// reconcile. A fold that already reads red/pending owns the verdict (the
// failing check is IN the rollup; nothing to reconcile).
var GREEN_VERDICTS = ['green', 'none'];

// Rollup entries that ARE a failure (normalized casing; REST check runs
// arrive lowercase, GraphQL uppercase — normalize once, compare here).
var FAILING_CONCLUSIONS = ['FAILURE', 'TIMED_OUT'];

// The machine's own check-run stamps are bookkeeping, not verdicts
// (dmtools-agents#628/#635). Literal fallback mirrors the canonical list —
// callers holding it (smProvider.BOOKKEEPING_CHECK_PREFIXES) pass it in.
var DEFAULT_BOOKKEEPING_PREFIXES = ['kicker /', 'Wake-up probe', 'merge /'];

/**
 * Uppercase a reported mergeStateStatus (REST mergeable_state or the
 * bridge's mergeStateStatus merge) — null when absent/empty. NEVER a
 * fabricated fallback: only a REPORTED verdict may feed the reconcile.
 */
function normalizeMergeStateStatus(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim().toUpperCase();
    return s || null;
}

/** True when the reported merge state says a check GitHub counts fails. */
function isUnstableMergeState(raw) {
    var s = normalizeMergeStateStatus(raw);
    return !!s && UNSTABLE_MERGE_STATES.indexOf(s) !== -1;
}

/** True for a tracked-verdict label the reconcile may still override. */
function isReconcilableVerdict(label) {
    return !!label && GREEN_VERDICTS.indexOf(String(label).toLowerCase()) !== -1;
}

function isBookeepingCheckName(name, prefixes) {
    var list = prefixes && prefixes.length ? prefixes : DEFAULT_BOOKKEEPING_PREFIXES;
    var n = String(name || '');
    for (var i = 0; i < list.length; i++) {
        if (n.indexOf(list[i]) === 0) return true;
    }
    return false;
}

// LATEST check-run per context (#695 branch-protection semantics): newest
// wins by completed_at, then started_at, then id, then position. Same key
// order as smProvider.latestCheckRunConclusions — an older FAILURE under a
// newer SUCCESS is NOT a failure. The comparison lives in small pure helpers
// (conclusionOf/rawTimestampOf/sortTimeOf/idOf/winsLatest) — each stays
// under the CRAP complexity gate with full branch coverage.

/** Conclusion of one rollup entry: the check-run conclusion, else the
 * commit-status state, else null (a pending entry carries neither). */
function conclusionOf(r) {
    if (r && r.conclusion) return String(r.conclusion).toUpperCase();
    if (r && r.state) return String(r.state).toUpperCase();
    return null;
}

/** Raw timestamp field of one entry: completion (snake or camel), else
 * start (snake or camel), else '' — never a fabricated date. */
function rawTimestampOf(r) {
    return (r && (r.completed_at || r.completedAt)) ||
        (r && (r.started_at || r.startedAt)) || '';
}

/** Sort time of one entry: the parsed completion/start time, 0 when the
 * entry carries no parsable timestamp (absent or garbage degrades to 0). */
function sortTimeOf(r) {
    return Date.parse(rawTimestampOf(r)) || 0;
}

/** Numeric run id: id, else the GraphQL databaseId, else 0 (no id at all).
 * Only called for entries that carry a name — r is always an object here. */
function idOf(r) {
    if (r.id !== undefined) return Number(r.id) || 0;
    return Number(r.databaseId) || 0;
}

/** Newest-wins comparison against the stored latest entry: a later time
 * wins, then the greater id, then the later arrival position. */
function winsLatest(t, id, pos, prev) {
    if (!prev) return true;
    if (t > prev.t) return true;
    if (t < prev.t) return false;
    if (id > prev.id) return true;
    if (id < prev.id) return false;
    return pos > prev.pos;
}

function latestConclusions(rollup) {
    var latest = {};
    (rollup || []).forEach(function (r, pos) {
        var name = r && (r.name || r.context);
        if (!name) return;
        var t = sortTimeOf(r);
        var id = idOf(r);
        if (!winsLatest(t, id, pos, latest[name])) return;
        latest[name] = { t: t, id: id, pos: pos, concl: conclusionOf(r) };
    });
    return latest;
}

/**
 * The actually-failing check names on a head: latest-per-context
 * FAILURE/TIMED_OUT conclusions, the machine's own bookeeping stamps folded
 * out. GraphQL StatusContext nodes (context/state spelling) count too — a
 * commit-status failure is exactly the shape the check-runs fold cannot see.
 * Returns names in first-failure order (stable for the audit trail).
 */
function failingCheckNames(rollup, bookkeepingPrefixes) {
    var latest = latestConclusions(rollup);
    var names = Object.keys(latest);
    var out = [];
    for (var i = 0; i < names.length; i++) {
        if (isBookeepingCheckName(names[i], bookkeepingPrefixes)) continue;
        var concl = latest[names[i]].concl;
        if (concl && FAILING_CONCLUSIONS.indexOf(concl) !== -1) out.push(names[i]);
    }
    return out;
}

/**
 * The reconcile decision — null when the tracked verdict stands, else the
 * downgrade record. Applies ONLY when BOTH hold:
 *   (a) the fold saw no failure ('green' or 'none' — see isReconcilableVerdict),
 *   (b) the PR body REPORTS an unstable merge state (isUnstableMergeState).
 * A no-rollup ('none') + UNSTABLE head reconciles with an EMPTY census: the
 * failing context is invisible to the check-runs API entirely (commit-status
 * spelling) — the mergeStateStatus is the registration (reason names it).
 *
 * input : { checkConclusion, rawMergeState, rollup, bookkeepingPrefixes }
 * return: null | {
 *   verdict: 'red',                  — the effective verdict after reconcile
 *   trackedVerdict: 'green'|'none',  — what the tracked fold said (kept)
 *   untrackedFailingChecks: [name],  — the auditable registration (may be [])
 *   rawMergeState: 'UNSTABLE',       — the reported value that triggered it
 *   reason: '...'                    — the audit line for logs/state
 * }
 */
function reconcileDecision(input) {
    input = input || {};
    var fold = String(input.checkConclusion || '').toLowerCase();
    var raw = normalizeMergeStateStatus(input.rawMergeState);
    if (!isReconcilableVerdict(fold)) return null;
    if (!isUnstableMergeState(raw)) return null;
    var failing = failingCheckNames(input.rollup, input.bookkeepingPrefixes);
    return {
        verdict: 'red',
        trackedVerdict: fold,
        untrackedFailingChecks: failing,
        rawMergeState: raw,
        reason: 'mergeStateStatus ' + raw +
            ' with a ' + fold + ' tracked verdict — failing checks outside the ' +
            'tracked set: ' + (failing.length ? failing.join(', ') : '(not in the check-runs rollup)')
    };
}

module.exports = {
    UNSTABLE_MERGE_STATES: UNSTABLE_MERGE_STATES,
    GREEN_VERDICTS: GREEN_VERDICTS,
    FAILING_CONCLUSIONS: FAILING_CONCLUSIONS,
    DEFAULT_BOOKKEEPING_PREFIXES: DEFAULT_BOOKKEEPING_PREFIXES,
    normalizeMergeStateStatus: normalizeMergeStateStatus,
    isUnstableMergeState: isUnstableMergeState,
    isReconcilableVerdict: isReconcilableVerdict,
    failingCheckNames: failingCheckNames,
    latestConclusions: latestConclusions,
    reconcileDecision: reconcileDecision
};
