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
var dispatch = require('./reviewPoolDispatch.js');
var markers = require('./reviewPoolMarkers.js');
var aggregate = require('./reviewPoolAggregate.js');
var poolModule = require('./reviewPool.js');

// ── the specialist leg (invariant 1) ─────────────────────────────────────────

/**
 * The specialist identity of a run's params, or null. The posting leg
 * (verdict contract) is NEVER a specialist — a malformed identity (no
 * reviewer, wrong contract) degrades to a plain leg.
 */
function specialistLegOf(params) {
    var identity = dispatch.legIdentityOf(params);
    if (!identity || !identity.reviewer) return null;
    if (identity.reviewer === dispatch.POSTING_REVIEWER) return null;
    if (identity.contract !== dispatch.CONTRACT_CANDIDATES) return null;
    return identity;
}

function postQuietly(postComment, body, steps, failures) {
    try {
        postComment(body);
        steps.push(true);
    } catch (e) {
        failures.push(String((e && e.message) || e));
    }
}

/**
 * The specialist leg's post flow. io = { readCandidatesFile() → raw text,
 * headSha() → sha, nowIso(), logins (unused here — parsing trusts only the
 * READER), postComment(text) }. The candidates marker posts only when the
 * leg filed candidates; the PASS marker posts ALWAYS (a completed pass
 * with zero findings is a completion). Fail-soft end to end: a failed
 * post is reported, never thrown — the leg's work is done either way.
 */
function runSpecialistPost(identity, io) {
    var steps = [];
    var failures = [];
    var parsed = candidatesModule.parseCandidatesFile(io.readCandidatesFile());
    var headSha = String(io.headSha() || '');
    var nowIso = String(io.nowIso() || '');
    if (parsed.candidates.length > 0) {
        postQuietly(io.postComment,
            candidatesModule.buildCandidatesMarkerComment(identity.reviewer, headSha, parsed.candidates, nowIso),
            steps, failures);
    }
    postQuietly(io.postComment, markers.buildPassMarkerComment(identity.reviewer, headSha, nowIso), steps, failures);
    return {
        success: true,
        specialist: true,
        reviewer: identity.reviewer,
        required: identity.required === true,
        candidates: parsed.candidates.length,
        candidatesValid: parsed.valid,
        notes: parsed.notes,
        postFailures: failures.length
    };
}

// ── the posting leg's round aggregation ──────────────────────────────────────

function loginsOf(io) {
    return { authorLogins: io.logins || [] };
}

/** The specialist names the round expects candidates from (ran this round, or completed on this head). */
function expectedCandidateNamesOf(plan) {
    var names = [];
    var legs = plan.legs || [];
    var skipped = plan.skipped || [];
    for (var i = 0; i < legs.length; i++) {
        if (legs[i].contract === dispatch.CONTRACT_CANDIDATES) names.push(legs[i].reviewer);
    }
    for (var s = 0; s < skipped.length; s++) {
        if (skipped[s].reason.indexOf('already completed') === 0 &&
                names.indexOf(skipped[s].reviewer) === -1) names.push(skipped[s].reviewer);
    }
    return names;
}

function collectCandidatesOnce(records, expectedNames, headSha) {
    return candidatesModule.collectRoundCandidates(records, expectedNames, headSha);
}

/**
 * The bounded wait: poll the PR's marker comments until every expected
 * specialist arrived or the budget spent. `sleep(seconds)` is the caller's
 * clock (the local auto-chain sleeps via the shell); zero waitSeconds (the
 * default) skips the loop entirely. Fail-open by construction — a
 * timeout just leaves the missing names unavailable.
 */
function waitForCandidates(io, expectedNames, headSha) {
    var waitSeconds = typeof io.waitSeconds === 'number' && io.waitSeconds > 0 ? io.waitSeconds : 0;
    var pollSeconds = typeof io.pollSeconds === 'number' && io.pollSeconds > 0 ? io.pollSeconds : 30;
    var collect = collectCandidatesOnce(
        candidatesModule.parseCandidatesMarkers(io.readComments(), loginsOf(io)), expectedNames, headSha);
    var waited = 0;
    while (collect.unavailable.length > 0 && waited < waitSeconds) {
        if (typeof io.sleep === 'function') io.sleep(pollSeconds);
        waited += pollSeconds;
        collect = collectCandidatesOnce(
            candidatesModule.parseCandidatesMarkers(io.readComments(), loginsOf(io)), expectedNames, headSha);
    }
    return collect;
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
        if (markers.sameHead(holds[i].head, headSha)) return true;
    }
    return false;
}

/**
 * The aggregation point. reviewData is the posting leg's read verdict
 * payload — MUTATED in place (the merged census replaces inlineComments;
 * the census recomputes after the round). pool is the RESOLVED pool;
 * roundCtx = { headSha, passMarkers, hasNewHunks, newHunkPaths }; io =
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
    var plan = dispatch.buildRoundPlan(pool, roundCtx);
    var expectedNames = expectedCandidateNamesOf(plan);

    var collect = waitForCandidates(io, expectedNames, headSha);

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
    if (io.verification === 'filter' && typeof io.runFilterRound === 'function') {
        var candidates = aggregate.filterCandidatesFromMerged(merged.merged, io.policy);
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

    var packet = aggregate.poolPacketOf({
        arrived: collect.arrived,
        unavailable: collect.unavailable,
        roundName: plan.round,
        merged: merged.merged,
        applied: applied,
        dropped: dropped
    });
    if (packet.length > 0 && typeof io.appendToGeneralComment === 'function') {
        io.appendToGeneralComment(packet.join('\n'));
    }

    // ONE pool-outcome marker per round — the attempt record and the
    // expectation record (entries {name, required, completed}).
    var latestComments = io.readComments();
    var passMarkers = markers.parsePassMarkers(latestComments, loginsOf(io));
    var entries = dispatch.outcomeEntriesWithCompletions(plan, passMarkers, headSha);
    try {
        io.postComment(markers.buildPoolOutcomeMarkerComment(headSha, plan.round, entries, io.nowIso()));
    } catch (ePost) {
        console.warn('reviewer pool: the pool-outcome marker post failed (non-fatal):', ePost);
    }

    // The required-reviewer hold (deduped per head) — the posting leg never
    // holds on itself (its PASS stamp lands moments later); the hold-age
    // escalation valve stays owned by the merge gate (§7).
    var missingRequired = [];
    for (var e = 0; e < entries.length; e++) {
        if (entries[e].required && !entries[e].completed && entries[e].name !== dispatch.POSTING_REVIEWER) {
            missingRequired.push(entries[e].name);
        }
    }
    var holdDeduped = false;
    var heldRequired = null;
    if (missingRequired.length > 0) {
        if (hasSameHeadHold(latestComments, io, headSha)) {
            holdDeduped = true;
        } else {
            try {
                io.postComment(markers.buildRequiredReviewerHoldMarker(missingRequired, headSha, io.nowIso(), false, null));
                heldRequired = missingRequired;
            } catch (eHold) {
                console.warn('reviewer pool: the required-reviewer hold post failed (non-fatal):', eHold);
            }
        }
    }

    return {
        round: plan.round,
        arrived: collect.arrived,
        unavailable: collect.unavailable,
        mergedCount: merged.merged.length,
        packet: packet,
        heldRequired: heldRequired,
        holdDeduped: holdDeduped,
        outcomeStamped: true,
        filterApplied: filterApplied,
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
        io.postComment(markers.buildPassMarkerComment(dispatch.POSTING_REVIEWER, String(io.headSha() || ''), io.nowIso()));
        return { success: true, stamped: true };
    } catch (e) {
        console.warn('reviewer pool: the posting leg PASS marker post failed (non-fatal):', e);
        return { success: true, stamped: false, error: String((e && e.message) || e) };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        specialistLegOf: specialistLegOf,
        runSpecialistPost: runSpecialistPost,
        poolRoundStep: poolRoundStep,
        stampPostingLegCompletion: stampPostingLegCompletion,
        expectedCandidateNamesOf: expectedCandidateNamesOf
    };
}
