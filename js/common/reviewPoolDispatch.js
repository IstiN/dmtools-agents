/**
 * reviewPoolDispatch.js — the gh-1471 leg dispatcher's pure core: turning a
 * resolved pool + the round state into the concrete dispatch decisions.
 *
 * The dispatcher's shape (gh-1406 execution layer):
 *   - each enabled reviewer = ONE independent leg over the same diff,
 *     round-gated per its `rounds`/`triggerPaths` (the reviewPool §6 pure
 *     gating, fed here with the round state derived from the PR's records);
 *   - re-fire after a failed leg is DUPLICATE-SAFE: completions are
 *     head-carried PASS markers — a leg with a same-head completion never
 *     re-runs on that head, a failed leg (no marker) always re-fires;
 *   - per-leg identity rides the dispatch (`legParamPatches` → the leg's
 *     customParams.reviewerPoolLeg), so one shared agent config serves the
 *     whole pool and each leg knows its reviewer name + output contract;
 *   - retry mechanics (§ the 429 replay): attempts are counted from the
 *     same-head round records (each round stamps ONE pool-outcome marker),
 *     retries back off exponentially, and a REQUIRED leg past its budget
 *     ESCALATES — never silent merge, never silent approval. A
 *     non-required leg past budget gives up fail-open (the packet notes it).
 *
 * The contract split (invariant 1): the factory generalist (`base`) is the
 * POSTING leg and keeps the verdict-shaped output; every other reviewer —
 * factory specialist or repo-defined — files candidates only.
 *
 * Pure module — no dmtools globals. Requires hoisted (gh-823 pack-require
 * rule). GraalJS-clean (var + plain functions, JSON-safe data only).
 */
'use strict';

var poolModule = require('./reviewPool.js');
var markers = require('./reviewPoolMarkers.js');
var reviewVerdicts = require('./reviewVerdicts.js');

// The posting leg: the factory generalist. Its name is a factory contract
// (instructions/review/base.json + the pool-wide `base` promptAppend key).
var POSTING_REVIEWER = 'base';
var CONTRACT_VERDICT = 'verdict';
var CONTRACT_CANDIDATES = 'candidates';

// The required-leg retry budget (attempts = same-head rounds that expected
// the leg) and the backoff base (ms; delay = base * 2^attempts).
var DEFAULT_MAX_LEG_ATTEMPTS = 3;
var DEFAULT_BACKOFF_BASE_MS = 60000;

// ── the output contract (invariant 1) ────────────────────────────────────────

/** `verdict` for the posting leg, `candidates` for every other reviewer. */
function outputContractOf(skill) {
    return skill && skill.name === POSTING_REVIEWER ? CONTRACT_VERDICT : CONTRACT_CANDIDATES;
}

// ── round state (§6 inputs derived from the PR's records) ────────────────────

function completedOnHeadOf(passMarkers, reviewer, headSha) {
    return markers.hasCompletedOnHead(passMarkers || [], reviewer, headSha);
}

/** `first` counts COMPLETED passes — on ANY head (the §6 completion rule). */
function completedEverOf(passMarkers, reviewer) {
    var list = Array.isArray(passMarkers) ? passMarkers : [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].reviewer === reviewer) return true;
    }
    return false;
}

/**
 * The §6 round state for one reviewer: { firstDone, hasNewHunks,
 * hunksHitTrigger }. `firstDone` reads completions (PASS markers), never
 * attempts — a 429-failed leg leaves no marker, so `first` fires again.
 */
function roundStateForReviewer(skill, roundCtx) {
    var ctx = roundCtx || {};
    return {
        firstDone: completedEverOf(ctx.passMarkers, skill.name),
        hasNewHunks: ctx.hasNewHunks === true,
        hunksHitTrigger: poolModule.triggerPathsHit(skill.triggerPaths, ctx.newHunkPaths)
    };
}

/** The round name stamped into the round's pool-outcome marker. */
function roundNameOf(hasNewHunks) {
    return hasNewHunks ? 'hunks' : 'first';
}

// ── the leg identity (dispatch ↔ leg transport) ──────────────────────────────

/**
 * The customParams patch a dispatcher merges into the leg's encoded config:
 * the leg then knows its reviewer name, output contract, round, head and
 * required flag — the shared agent config specializes per leg.
 */
function legParamPatches(leg, headSha) {
    return {
        reviewerPoolLeg: {
            reviewer: String((leg && leg.reviewer) || ''),
            required: (leg && leg.required) === true,
            contract: String((leg && leg.contract) || ''),
            round: String((leg && leg.round) || ''),
            head: String(headSha || '')
        }
    };
}

function identityOfValue(value) {
    if (!value || typeof value !== 'object' || !value.reviewer) return null;
    return value;
}

/**
 * The leg identity of a run's params (the encoded-config patch path):
 * params.customParams.reviewerPoolLeg, else params.jobParams.customParams…
 * Null for a plain (non-pool) leg.
 */
function legIdentityOf(params) {
    if (!params || typeof params !== 'object') return null;
    return identityOfValue(params.customParams && params.customParams.reviewerPoolLeg) ||
        identityOfValue(params.jobParams && params.jobParams.customParams &&
            params.jobParams.customParams.reviewerPoolLeg) || null;
}

// ── the round plan ───────────────────────────────────────────────────────────

function skipEntry(skill, reason) {
    return { reviewer: skill.name, reason: reason };
}

/**
 * The round plan: which legs dispatch, which are skipped (and why), the
 * round's expected entries ({name, required, completed} — the pool-outcome
 * marker payload) and the posting leg (null when the generalist is
 * disabled — the caller must fail the round loudly, never post without it).
 *
 * Duplicate-safety first: a same-head completion skips the leg whatever its
 * rounds say (a PASS marker on this head is the round's receipt); then the
 * §6 rounds/triggerPaths gating decides.
 */
function buildRoundPlan(pool, roundCtx) {
    var ctx = roundCtx || {};
    var headSha = String(ctx.headSha || '');
    var passMarkers = ctx.passMarkers || [];
    var enabled = poolModule.enabledReviewers(pool);
    var legs = [];
    var skipped = [];
    for (var i = 0; i < enabled.length; i++) {
        var skill = enabled[i];
        if (completedOnHeadOf(passMarkers, skill.name, headSha)) {
            skipped.push(skipEntry(skill, 'already completed on this head (PASS marker)'));
            continue;
        }
        var state = roundStateForReviewer(skill, ctx);
        if (!poolModule.reviewerShouldRun(skill, state)) {
            skipped.push(skipEntry(skill, 'rounds [' + skill.rounds.join(',') + '] do not fire this round'));
            continue;
        }
        legs.push({
            reviewer: skill.name,
            required: poolModule.isRequiredReviewer(pool, skill.name),
            contract: outputContractOf(skill),
            weight: skill.filterWeight === 'high' ? 'high' : 'normal',
            rounds: skill.rounds.slice()
        });
    }
    var postingLeg = null;
    for (var l = 0; l < legs.length; l++) {
        if (legs[l].contract === CONTRACT_VERDICT) postingLeg = legs[l];
    }
    return {
        round: roundNameOf(ctx.hasNewHunks === true),
        head: headSha,
        legs: legs,
        skipped: skipped,
        postingLeg: postingLeg,
        expected: expectedEntriesOf(enabled, pool, passMarkers, headSha)
    };
}

/** The enabled reviewers as {name, required, completed} expectation entries. */
function expectedEntriesOf(enabled, pool, passMarkers, headSha) {
    var entries = [];
    for (var i = 0; i < enabled.length; i++) {
        entries.push({
            name: enabled[i].name,
            required: poolModule.isRequiredReviewer(pool, enabled[i].name),
            completed: completedOnHeadOf(passMarkers, enabled[i].name, headSha)
        });
    }
    return entries;
}

/**
 * The expectation entries of a BUILT plan, recomputed against the current
 * PASS markers (the producer stamps the outcome marker at aggregation time
 * — completions that arrived while the round ran are stamped, not the plan
 * time snapshot).
 */
function outcomeEntriesWithCompletions(plan, passMarkers, headSha) {
    var expected = (plan && plan.expected) || [];
    var entries = [];
    for (var i = 0; i < expected.length; i++) {
        entries.push({
            name: expected[i].name,
            required: expected[i].required === true,
            completed: completedOnHeadOf(passMarkers, expected[i].name, headSha)
        });
    }
    return entries;
}

// ── retry mechanics (the 429 replay) ─────────────────────────────────────────

/**
 * The reviewer's attempt count for one head: the number of same-head round
 * records that EXPECTED it (each round stamps ONE pool-outcome marker — the
 * round bookkeeping). Completed legs stop counting the moment their PASS
 * marker exists.
 */
function attemptCountOf(outcomeRecords, reviewer, headSha) {
    var list = Array.isArray(outcomeRecords) ? outcomeRecords : [];
    var count = 0;
    for (var i = 0; i < list.length; i++) {
        if (!reviewVerdicts.sameHead(list[i].head, headSha)) continue;
        var entries = Array.isArray(list[i].reviewers) ? list[i].reviewers : [];
        for (var e = 0; e < entries.length; e++) {
            if (entries[e] && entries[e].name === reviewer) { count++; break; }
        }
    }
    return count;
}

function backoffDelayMs(attempts, backoffBaseMs) {
    var delay = backoffBaseMs;
    for (var i = 0; i < attempts; i++) delay = delay * 2;
    return delay;
}

/**
 * The retry decisions for the plan's legs. Per leg:
 *   completed → `none` (the round's receipt exists);
 *   required, attempts >= budget → `escalate` (never silent merge — the
 *       caller stamps the escalated hold + the needs-human label);
 *   non-required, attempts >= budget → `give-up` (fail-open; the packet
 *       notes the unavailability, the round proceeds without it);
 *   otherwise → `retry` with an exponential backoff delay.
 * Returns { decisions, escalated }.
 */
function retryDecisions(plan, ctx) {
    var c = ctx || {};
    var maxAttempts = typeof c.maxAttempts === 'number' && c.maxAttempts > 0
        ? c.maxAttempts : DEFAULT_MAX_LEG_ATTEMPTS;
    var backoffBase = typeof c.backoffBaseMs === 'number' && c.backoffBaseMs >= 0
        ? c.backoffBaseMs : DEFAULT_BACKOFF_BASE_MS;
    var decisions = [];
    var escalated = [];
    var legs = (plan && plan.legs) || [];
    for (var i = 0; i < legs.length; i++) {
        var leg = legs[i];
        var attempts = attemptCountOf(c.outcomeRecords, leg.reviewer, c.headSha);
        var decision = {
            reviewer: leg.reviewer,
            required: leg.required === true,
            attempts: attempts
        };
        if (completedOnHeadOf(c.passMarkers, leg.reviewer, c.headSha)) {
            decision.action = 'none';
        } else if (attempts >= maxAttempts && leg.required) {
            decision.action = 'escalate';
            decision.delayMs = backoffDelayMs(attempts, backoffBase);
            escalated.push(leg.reviewer);
        } else if (attempts >= maxAttempts) {
            decision.action = 'give-up';
        } else {
            decision.action = 'retry';
            decision.delayMs = backoffDelayMs(attempts, backoffBase);
        }
        decisions.push(decision);
    }
    return { decisions: decisions, escalated: escalated };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        POSTING_REVIEWER: POSTING_REVIEWER,
        CONTRACT_VERDICT: CONTRACT_VERDICT,
        CONTRACT_CANDIDATES: CONTRACT_CANDIDATES,
        DEFAULT_MAX_LEG_ATTEMPTS: DEFAULT_MAX_LEG_ATTEMPTS,
        DEFAULT_BACKOFF_BASE_MS: DEFAULT_BACKOFF_BASE_MS,
        outputContractOf: outputContractOf,
        roundStateForReviewer: roundStateForReviewer,
        roundNameOf: roundNameOf,
        legParamPatches: legParamPatches,
        legIdentityOf: legIdentityOf,
        buildRoundPlan: buildRoundPlan,
        outcomeEntriesWithCompletions: outcomeEntriesWithCompletions,
        attemptCountOf: attemptCountOf,
        retryDecisions: retryDecisions
    };
}
