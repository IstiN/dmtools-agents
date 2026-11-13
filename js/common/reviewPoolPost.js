/**
 * reviewPoolPost.js — the gh-1471 post-action orchestration logic: the
 * pure decisions both leg kinds make at their post step, over injected io.
 *
 * Two flows share this module:
 *
 * SPECIALIST LEG (invariant 1 — the machine half): the leg filed
 * candidates only; its post action stamps the candidates marker (the
 * leg→aggregation transport) and its own PASS marker (the completion
 * receipt the §6 rounds gating and the required-reviewer merge gate read).
 * It NEVER posts a review, a label or a status change — a specialist
 * cannot mint a verdict.
 *
 * POSTING LEG (the aggregation point): the round's specialist candidates
 * merge into the review (reviewPoolAggregate — one census), the gh-1403
 * filter pass runs over the MERGED census with the pool duties, the packet
 * (availability + census + drop visibility) rides the general comment, and
 * the round stamps ONE pool-outcome marker — the attempt record the retry
 * mechanics count and the expectation record the required-reviewer gate
 * reads. Required reviewers missing at aggregation time stamp the
 * required-reviewer hold (deduped per head); the hold-age escalation valve
 * stays owned by the merge gate (gh-1406 §7 — one writer per concern).
 *
 * Waiting is bounded and fail-open: the posting leg polls the PR's marker
 * comments for the expected specialists until they arrive or the round
 * timeout spends — a late/failed specialist degrades to an availability
 * note, never a lost review.
 *
 * Pure module — no dmtools globals (all io injected). Requires hoisted
 * (gh-823 pack-require rule). GraalJS-clean (var + plain functions,
 * JSON-safe data only).
 */
'use strict';

var candidatesModule = require('./reviewPoolCandidates.js');
var markers = require('./reviewPoolMarkers.js');
var aggregate = require('./reviewPoolAggregate.js');
var poolModule = require('./reviewPool.js');
var reviewVerdicts = require('./reviewVerdicts.js');
var inJob = require('./reviewPoolInJob.js');

// The posting reviewer's skill name (the base/generalist lens — the leg that
// posts the merged review and stamps the pool state).
var POSTING_REVIEWER = 'base';

function postQuietly(postComment, body, steps, failures) {
    try {
        postComment(body);
        steps.push(true);
    } catch (e) {
        failures.push(String((e && e.message) || e));
    }
}

// ── the posting leg's round aggregation ──────────────────────────────────────

function loginsOf(io) {
    return { authorLogins: io.logins || [] };
}

/**
 * The specialist names the round expects candidates from — the IN-JOB
 * selection (the same deterministic selection the pre-cli runner used, so
 * the post action recomputes it from policy + the round context alone).
 */
function expectedCandidateNamesOf(plan) {
    var names = [];
    var legs = plan.legs || [];
    for (var i = 0; i < legs.length; i++) names.push(legs[i].reviewer);
    return names;
}

/** The in-job plan: {round, legs} from the pool + this run's round context. */
function buildInJobPlan(pool, roundCtx) {
    var selected = inJob.selectSpecialists(pool, roundCtx);
    var legs = [];
    for (var i = 0; i < selected.length; i++) {
        legs.push({
            reviewer: selected[i].name,
            required: poolModule.isRequiredReviewer(pool, selected[i].name),
            contract: 'candidates'
        });
    }
    return { round: inJob.roundTypeOf(roundCtx), legs: legs };
}

function weightedListsOf(lists, weightsByName) {
    return (lists || []).map(function(list) {
        return Object.assign({}, list, {
            filterWeight: ((weightsByName || {})[list.reviewer] || 'normal') === 'high' ? 'high' : 'normal'
        });
    });
}

function hasSameHeadHold(comments, io, headSha) {
    var holds = markers.parseRequiredReviewerHolds(comments, loginsOf(io));
    for (var i = 0; i < holds.length; i++) {
        if (reviewVerdicts.sameHead(holds[i].head, headSha)) return true;
    }
    return false;
}

/**
 * The aggregation point. reviewData is the posting leg's read verdict
 * payload — MUTATED in place (the merged census replaces inlineComments;
 * the census recomputes after the round). pool is the RESOLVED pool;
 * roundCtx = { headSha, hasNewHunks, newHunkPaths, inJob }; io =
 * { readComments, logins, nowIso, postComment, resolveClaim, policy,
 * weightsByName, runFilterRound?, stampDemotionFiles, recomputeCensus,
 * appendToGeneralComment, waitSeconds?, pollSeconds?, sleep?,
 * verification? }.
 *
 * Returns { round, arrived, unavailable, mergedCount, packet, heldRequired,
 * holdDeduped, outcomeStamped, filterApplied } — everything the caller (and
 * the run log) needs about the round.
 */
function poolRoundStep(reviewData, pool, roundCtx, io) {
    var headSha = String(roundCtx.headSha || '');
    var plan = buildInJobPlan(pool, roundCtx);
    var expectedNames = expectedCandidateNamesOf(plan);

    // The in-job round already ran (the pre-cli action executed the
    // specialists): the candidates are FILES on this head — no polling, no
    // marker collection. roundCtx.inJob = { completed, unavailable,
    // candidates (validated records) } from reviewPoolInJob.runSpecialists.
    var inJobRound = roundCtx.inJob || {};
    var coverageNotes = Array.isArray(inJobRound.coverageNotes) ? inJobRound.coverageNotes : [];
    var completed = Array.isArray(inJobRound.completed) ? inJobRound.completed : [];
    var unavailable = Array.isArray(inJobRound.unavailable) ? inJobRound.unavailable : expectedNames.slice();
    var records = Array.isArray(inJobRound.candidates) ? inJobRound.candidates : [];
    var collect = {
        lists: records.map(function(r) { return r; }),
        arrived: completed,
        unavailable: unavailable.filter(function(name) { return completed.indexOf(name) === -1; })
    };

    // The specialists' PASS markers — the posting leg stamps them itself
    // (single writer): one marker per completed specialist on THIS head, so
    // the gh-1406 merge gate's same-head PASS semantics stay untouched.
    var stampFailures = [];
    for (var s = 0; s < collect.arrived.length; s++) {
        postQuietly(io.postComment,
            markers.buildPassMarkerComment(collect.arrived[s], headSha, io.nowIso()),
            [], stampFailures);
    }
    if (stampFailures.length > 0) {
        console.warn('reviewer pool: ' + stampFailures.length + ' specialist PASS stamp(s) failed (non-fatal)');
    }

    var roundInput = {
        lists: weightedListsOf(collect.lists, io.weightsByName),
        arrived: collect.arrived,
        unavailable: collect.unavailable,
        roundName: plan.round
    };
    var merged = aggregate.mergePoolCensus(reviewData, roundInput, io.resolveClaim, io.weightsByName);
    aggregate.applyMergedInline(reviewData, merged.merged);

    var applied = [];
    var dropped = [];
    var filterApplied = false;
    var filterCandidatesCount = 0;
    if (io.verification === 'filter' && typeof io.runFilterRound === 'function') {
        var candidates = aggregate.filterCandidatesFromMerged(merged.merged, io.policy);
        filterCandidatesCount = candidates.length;
        if (candidates.length > 0) {
            var parsed = io.runFilterRound(candidates);
            if (parsed) {
                var out = aggregate.applyPoolVerdicts(reviewData, merged.merged, candidates, parsed.verdicts);
                applied = out.result.applied;
                dropped = out.result.dropped;
                if (typeof io.stampDemotionFiles === 'function') io.stampDemotionFiles(reviewData, applied);
                filterApplied = true;
            }
        }
    }
    if (typeof io.recomputeCensus === 'function') {
        // gh-1403 machine semantics hold for the pool round too: the census
        // recomputes AFTER the round's filtering, from the posted-evidence set.
        reviewData.issueCounts = io.recomputeCensus(reviewData, dropped.length);
    }

    // Partial coverage: completed specialists that flagged truncated=true
    // (the candidates contract's partial-review signal).
    var partialCoverage = [];
    for (var pc = 0; pc < records.length; pc++) {
        if (records[pc] && records[pc].truncated === true &&
            collect.arrived.indexOf(records[pc].reviewer) !== -1 &&
            partialCoverage.indexOf(records[pc].reviewer) === -1) {
            partialCoverage.push(records[pc].reviewer);
        }
    }
    var packet = aggregate.poolPacketOf({
        arrived: collect.arrived,
        unavailable: collect.unavailable,
        roundName: plan.round,
        partialCoverage: partialCoverage,
        coverageNotes: coverageNotes,
        merged: merged.merged,
        applied: applied,
        dropped: dropped
    });
    if (packet.length > 0 && typeof io.appendToGeneralComment === 'function') {
        io.appendToGeneralComment(packet.join('\n'));
    }

    // ONE pool-outcome marker per round — the attempt record and the
    // expectation record (entries {name, required, completed}). In-job the
    // completions are THIS run's own (the specialists ran before this step).
    var latestComments = io.readComments();
    var entries = [];
    for (var w = 0; w < plan.legs.length; w++) {
        entries.push({
            name: plan.legs[w].reviewer,
            required: plan.legs[w].required === true,
            completed: collect.arrived.indexOf(plan.legs[w].reviewer) !== -1
        });
    }
    try {
        io.postComment(markers.buildPoolOutcomeMarkerComment(headSha, plan.round, entries, io.nowIso()));
    } catch (ePost) {
        console.warn('reviewer pool: the pool-outcome marker post failed (non-fatal):', ePost);
    }

    // The required-reviewer hold (deduped per head) — it fires only for a
    // required specialist that NEVER showed up (no candidates marker, no
    // completion): arrived-but-incomplete legs are mid-flight, and their
    // crash-window hold is the merge gate's own §7 concern. The posting leg
    // never holds on itself (its PASS stamp lands moments later); the
    // hold-age escalation valve stays owned by the merge gate.
    var existingHold = hasSameHeadHold(latestComments, io, headSha);
    var arrivedSet = {};
    for (var a = 0; a < collect.arrived.length; a++) arrivedSet[collect.arrived[a]] = true;
    var missingRequired = [];
    for (var e = 0; e < entries.length; e++) {
        if (!entries[e].required || entries[e].completed) continue;
        if (entries[e].name === POSTING_REVIEWER || arrivedSet[entries[e].name]) continue;
        missingRequired.push(entries[e].name);
    }
    var heldRequired = null;
    if (missingRequired.length > 0 && !existingHold) {
        try {
            io.postComment(markers.buildRequiredReviewerHoldMarker(missingRequired, headSha, io.nowIso(), false, null));
            heldRequired = missingRequired;
        } catch (eHold) {
            console.warn('reviewer pool: the required-reviewer hold post failed (non-fatal):', eHold);
        }
    }

    return {
        round: plan.round,
        arrived: collect.arrived,
        unavailable: collect.unavailable,
        mergedCount: merged.merged.length,
        packet: packet,
        heldRequired: heldRequired,
        existingHold: existingHold,
        outcomeStamped: true,
        filterApplied: filterApplied,
        candidatesTotal: filterCandidatesCount,
        applied: applied,
        dropped: dropped,
        expected: expectedNames
    };
}

// ── the posting leg's completion stamp ───────────────────────────────────────

/**
 * The posting leg's own PASS marker (io = { headSha(), nowIso(),
 * postComment }). Fail-soft: a failed post reports unstamped — the next
 * round re-fires the leg (duplicate-safe re-fire) and the gate keeps
 * holding. Never throws.
 */
function stampPostingLegCompletion(io) {
    try {
        io.postComment(markers.buildPassMarkerComment(POSTING_REVIEWER, String(io.headSha() || ''), io.nowIso()));
        return { success: true, stamped: true };
    } catch (e) {
        console.warn('reviewer pool: the posting leg PASS marker post failed (non-fatal):', e);
        return { success: true, stamped: false, error: String((e && e.message) || e) };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        POSTING_REVIEWER: POSTING_REVIEWER,
        buildInJobPlan: buildInJobPlan,
        poolRoundStep: poolRoundStep,
        stampPostingLegCompletion: stampPostingLegCompletion,
        expectedCandidateNamesOf: expectedCandidateNamesOf
    };
}
