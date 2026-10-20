/**
 * gh-1114 — SM tick layering: the rule-id → layer map for the deployed
 * sm_github.json tick, plus the merge-first capacity math.
 *
 * The SM tick runs in layers (relative order inside each layer = the
 * sm_github.json order):
 *
 *   L0 hygiene    rerun-cancelled-checks, rerun-any-cancelled-checks,
 *                 reconcile-*                          (no head moves)
 *   L1 freshness  unarm-stale-validation, silent-update-behind, park-reset
 *                 (heads may move here — silent branch refreshes)
 *   L2 verdict    merge-validated, fail-validation, rework-on-red-gate-unlatched,
 *                 rework-on-validation-failed, sweep-stale-validating
 *   L3 dispatch   validate-armed/-fresh/-masked-green, revalidate-armed(-green),
 *                 validated-green
 *   L4 agents     conflict-rework … review-on-issue-label
 *   L5 close      close-on-merge
 *
 * Freshness before verdicts: a head this tick's L1 rules moved carries no
 * checks yet, so an L2 verdict read against the superseded head is a false
 * verdict (live epam/dmtools-dart#435: fail-validation re-parked a PR on a
 * stale head seconds before silent-update-behind moved it). smAgent guards
 * the L2 actions with the tick's movedThisTick set and drops the openPrs
 * ioCache on the L1→L2 boundary so verdict queries read current heads.
 *
 * Merge-first capacity (owner directive 2026-10-19): one workflow slot
 * (jobParams.mergeReservedSlots, or the whole gh-837 parallel width) is
 * reserved for the approved merge path. L4 dispatch rules and fresh
 * validations may spend only cap − reserved until L3 has decided for the
 * merge candidate; an unused reservation is released to agent legs in the
 * same tick (no idle cap).
 *
 * UT-1 (gh-1114 AC6) pins this map against sm_github.json: every deployed
 * rule id must appear here with its layer, and the file order must be
 * non-decreasing by layer — adding a rule without registering it FAILS the
 * suite. Both the file and this map live in the same repo on purpose.
 *
 * GraalJS constraints: var declarations, plain functions, JSON-safe data.
 */

var LAYER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

var LAYERS = {
    // L0 hygiene — cancelled-run kickers + verdict reconciliation (no head moves).
    'rerun-cancelled-checks': 'L0',
    'rerun-any-cancelled-checks': 'L0',
    'reconcile-rework-vs-approval': 'L0',
    'reconcile-issue-rework-vs-approval': 'L0',
    'reconcile-approval-vs-changes': 'L0',
    // L1 freshness — the only layer allowed to move a head.
    'unarm-stale-validation': 'L1',
    'silent-update-behind': 'L1',
    'park-reset': 'L1',
    // L2 verdict — merge/fail/arm/sweep on heads that did NOT move this tick.
    'merge-validated': 'L2',
    'merge-validated-guest': 'L2',
    'fail-validation': 'L2',
    'rework-on-red-gate-unlatched': 'L2',
    'rework-on-validation-failed': 'L2',
    'sweep-stale-validating': 'L2',
    // L3 dispatch — CI validation arms + the green latch.
    'validate-armed': 'L3',
    'revalidate-armed': 'L3',
    'revalidate-armed-green': 'L3',
    'validate-fresh': 'L3',
    'validate-fresh-masked-green': 'L3',
    'validated-green': 'L3',
    // L4 agents — rework/dev/review legs.
    'conflict-rework': 'L4',
    'rework-on-red-ci': 'L4',
    'rework-on-label': 'L4',
    'rework-arm-restore': 'L4',
    'dev-on-assignment': 'L4',
    'develop-done': 'L4',
    'review-after-dev': 'L4',
    'review-external-once': 'L4',
    'review-machine-unlinked': 'L4',
    'review-stale-verdict': 'L4',
    'review-threads-resolved': 'L4',
    'review-stale-verdict-unchecked': 'L4',
    'rework-unresolved-threads': 'L4',
    'review-on-label': 'L4',
    'review-on-issue-label': 'L4',
    // L5 close.
    'close-on-merge': 'L5'
};

// The L2 verdict actions (gh-1114 AC7): skipped for a PR whose head moved
// this tick. Keyed by localAction — rework-unresolved-threads (L4) shares
// arm_rework and defers with them, which invariant I5 states outright
// ('moved PR is never parked/reworked/commented in the same tick').
var VERDICT_DEFER_ACTIONS = ['merge_pr', 'fail_validation', 'arm_rework', 'sweep_stale_validation'];

// Layer indexes (numeric) used for the boundary checks.
var L1_IDX = LAYER_ORDER.indexOf('L1');
var L3_IDX = LAYER_ORDER.indexOf('L3');

function layerOf(rule) {
    var id = rule && rule.id;
    return (id && LAYERS[id]) || null;
}

// Numeric layer index of a rule, or -1 for a rule the map does not know
// (jira rules, custom project smRules) — unknown rules never trigger a
// layer transition and are never merge-path.
function layerIndex(rule) {
    var layer = layerOf(rule);
    return layer === null ? -1 : LAYER_ORDER.indexOf(layer);
}

function isVerdictAction(rule) {
    return !!rule && VERDICT_DEFER_ACTIONS.indexOf(rule.localAction) !== -1;
}

// Merge-path rules — the only dispatch lanes allowed to spend the reserved
// capacity slot (and the only validations deferred for a head moved this
// tick, AC12):
//   - the approved merge-window arms (validate-armed + the revalidate
//     recovery twins — detected structurally so project-config clones of
//     these rules keep the property);
//   - rework-on-red-ci: a rework leg on an approved PR whose validation
//     went red is a merge-path leg (owner directive 2026-10-19) — it goes
//     before review/dev legs of non-approved PRs when the budget is short.
function isMergePathRule(rule) {
    if (!rule) return false;
    if (rule.id === 'rework-on-red-ci') return true;
    if (rule.localAction === 'validate_pr') {
        var q = rule.query || {};
        return q.mutex === 'ai_validating' &&
            Array.isArray(q.mutexAmong) &&
            q.mutexAmong.indexOf('pr_approved') !== -1;
    }
    return false;
}

// The string spelling of jobParams.mergeReservedSlots (repo variables arrive
// as strings): 'false' disables, any other value parses as an integer
// (unparsable → NaN → junk). Callers treat a non-positive result as disabled.
function parseReservedSlotsString(raw) {
    var trimmed = raw.trim();
    if (trimmed === 'false') return 0;
    return parseInt(trimmed, 10);
}

// Coerces jobParams.mergeReservedSlots to its numeric slot count, or null
// when the value is unset or junk (anything that is not a usable count:
// booleans map to 1/0, strings parse, NaN and non-numbers are junk).
function reservedSlotsValue(jobParams) {
    var raw = (jobParams || {}).mergeReservedSlots;
    if (typeof raw === 'string') raw = parseReservedSlotsString(raw);
    if (typeof raw === 'number' && !isNaN(raw)) return Math.floor(raw);
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    return null;
}

// jobParams.mergeReservedSlots — the merge-path reservation, default 1.
// 0 / false (or the string 'false') disables the reservation (bit-identical
// with the pre-gh-1114 capacity behavior).
function mergeReservedSlots(jobParams) {
    var slots = reservedSlotsValue(jobParams);
    if (slots !== null) return slots > 0 ? slots : 0;
    var raw = (jobParams || {}).mergeReservedSlots;
    return raw == null ? 1 : 0; // unset (or null) → default; junk disables rather than guess
}

// The reservation width for the tick: the whole gh-837 parallel width when
// parallel validation is active (queue ≥ watermark), else mergeReservedSlots.
// An EXPLICIT disable (slots <= 0) wins in every mode — mergeReservedSlots
// documents 0/false as the kill switch ("bit-identical with the pre-gh-1114
// capacity behavior"), so the parallel override must never resurrect the
// reservation (PR #1120 review, thread smRuleLayers.js:167).
function reservationFor(mergeSlots, validationMutexMax) {
    var slots = mergeSlots || 0;
    if (slots <= 0) return 0;
    var mutexMax = validationMutexMax || 1;
    return mutexMax > 1 ? mutexMax : slots;
}

module.exports = {
    LAYER_ORDER: LAYER_ORDER,
    LAYERS: LAYERS,
    VERDICT_DEFER_ACTIONS: VERDICT_DEFER_ACTIONS,
    L1_IDX: L1_IDX,
    L3_IDX: L3_IDX,
    layerOf: layerOf,
    layerIndex: layerIndex,
    isVerdictAction: isVerdictAction,
    isMergePathRule: isMergePathRule,
    mergeReservedSlots: mergeReservedSlots,
    reservationFor: reservationFor
};
