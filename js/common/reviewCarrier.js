// gh-1540 — the review in-progress carrier (`ai_reviewing`) shared helpers.
//
// The review leg stamps the carrier on the PR and the linked issue at leg
// start (markReviewInProgress — preparePRForReview) and clears it wherever
// the leg concludes: verdict time (postPRReviewComments), the
// missing-review-data exit (same action), and the leg's own failure path
// (preparePRForReview's catch — a leg that dies between the stamp and its
// post-action never reaches a verdict path, so the clear must happen on the
// way out). Every review arming rule on BOTH SM anchors skips while the
// carrier is present and the naked-PR sweep refuses to re-arm under it, so
// a carrier left behind starves the PR/issue from review — the stamp, the
// clears and the PR→linked-issue parse therefore live in ONE shared home
// (PR #1541 rework: threads "module-size pins", "missing-data exit",
// "stamp-then-die"; the extractors keep both host modules under their
// module-size pins and dedup the thrice-copied gh-branch regex).
//
// Non-fatal end to end: a lost label degrades to the pre-gh-1540 behavior
// (the arming rules lose the in-flight skip, never the leg).
'use strict';

var LABELS = require('../config.js').LABELS;

// ── the PR→linked-issue parse (the branch→issue chain the clear/stamp read)
// ────────────────────────────────────────────────────────────────────────────

// The linked-issue number encoded in a machine branch name ('ai/gh-77' → 77)
// — the same whole-token shape the rework/review arms parse (the gh-0*NN
// convention shared by mergeTrigger consumers). Null when the branch names
// no issue.
function branchLinkedIssueNumber(branch) {
    var m = /(^|[^a-z0-9])gh-0*(\d+)([^0-9]|$)/i.exec(String(branch || ''));
    return m ? parseInt(m[2], 10) : null;
}

// The "Closes #N" reference in a PR body (gh-728: only the trailing
// closes/fixes/resolves reference — the linked-issue lookup needs nothing
// more). Null when the body links no issue.
function parseLinkedIssueNumber(prBody) {
    var m = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String(prBody || ''));
    if (!m) return null;
    return parseInt(m[1], 10);
}

// ── quiet label writes (a lost label or a dead tracker must never break
// ── the leg; absent labels are the expected steady state)
// ────────────────────────────────────────────────────────────────────────────

function removePRLabelQuietly(scm, prNumber, label, warnMessage) {
    try {
        scm.removeLabel(prNumber, label);
    } catch (e2) {
        console.warn(warnMessage);
    }
}

/**
 * Quiet tracker-side label removal: a missing label or a dead tracker must
 * never break the verdict flow.
 */
function removeTicketLabelQuietly(tracker, ticketKey, label, why) {
    try {
        tracker.removeLabel(ticketKey, label);
        console.log('✅ Removed ' + label + ' from ' + ticketKey + (why ? ' — ' + why : ''));
    } catch (e) {
        console.warn('Failed to remove ' + label + ' from ' + ticketKey + ' (non-fatal):', e.message || e);
    }
}

// ── the stamp (leg start — preparePRForReview)
// ────────────────────────────────────────────────────────────────────────────

function stampPRCarrier(ctx, prNumber) {
    try {
        ctx.scm.addLabel(prNumber, LABELS.AI_REVIEWING);
        console.log('✅ Stamped ai_reviewing on PR #' + prNumber + ' (review leg in progress — gh-1540)');
    } catch (e) {
        console.warn('Failed to stamp ai_reviewing on PR #' + prNumber + ' (non-fatal):', e.message || e);
    }
}

function stampTicketCarrier(ctx) {
    try {
        ctx.tracker.addLabel(ctx.ticketKey, LABELS.AI_REVIEWING);
        console.log('✅ Stamped ai_reviewing on ticket ' + ctx.ticketKey + ' (the arm convention: both carriers)');
    } catch (e) {
        console.warn('Failed to stamp ai_reviewing on the ticket (non-fatal):', e.message || e);
    }
}

function stampBranchIssueCarrier(ctx, prDetails) {
    var linkedIssue = branchLinkedIssueNumber(prDetails.head && prDetails.head.ref);
    if (!linkedIssue) return;
    try {
        ctx.scm.addLabel(linkedIssue, LABELS.AI_REVIEWING);
        console.log('✅ Stamped ai_reviewing on linked issue #' + linkedIssue + ' (branch anchor)');
    } catch (e) {
        console.warn('Failed to stamp ai_reviewing on the linked issue (non-fatal):', e.message || e);
    }
}

function stampLinkedIssueCarrier(ctx, prDetails) {
    if (ctx.noTicket) {
        stampBranchIssueCarrier(ctx, prDetails);
        return;
    }
    stampTicketCarrier(ctx);
}

/**
 * The review phase's "in progress" carrier — the twin of ai_validating. Set
 * at leg start on the PR and on the linked issue (the ticket when this run
 * is issue-anchored; the branch-parsed issue for PR-anchored runs) so every
 * review arming rule can skip while a leg is actually running and the SM's
 * same-tick latch has a cross-tick anchor.
 */
function markReviewInProgress(ctx, prDetails) {
    if (ctx.dryRun) {
        console.log('[dryRun] Skipping ai_reviewing stamp for PR #' + prDetails.number);
        return;
    }
    stampPRCarrier(ctx, prDetails.number);
    stampLinkedIssueCarrier(ctx, prDetails);
}

// ── the clears (verdict time / missing-data exit / leg failure path)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Clear the carrier wherever `ai_pr_reviewed` is latched (verdict time) so
 * the world returns to "review wanted, not running" exactly when the review
 * phase concludes. Quiet and non-fatal: the PR side clears even when the
 * linked-issue probe fails (fail-open, same shape as the rework re-arm).
 */
function clearReviewInProgressCarrier(ctx, pr, repoInfo, resolveLinkedIssue) {
    removePRLabelQuietly(ctx.scm, pr.number, LABELS.AI_REVIEWING,
        'No ai_reviewing label to remove from PR #' + pr.number);
    try {
        var linkedIssue = resolveLinkedIssue(repoInfo, pr.number, pr.branch);
        if (linkedIssue) {
            removePRLabelQuietly(ctx.scm, linkedIssue, LABELS.AI_REVIEWING,
                'No ai_reviewing label to remove from issue #' + linkedIssue);
        }
    } catch (e) {
        console.warn('Linked-issue ai_reviewing clear failed (non-fatal):', e.message || e);
    }
}

function clearStalePRCarrier(ctx, prNumber) {
    removePRLabelQuietly(ctx.scm, prNumber, LABELS.AI_REVIEWING,
        'No ai_reviewing label to remove from PR #' + prNumber);
    console.log('✅ Cleared the ai_reviewing carrier from PR #' + prNumber + ' (the leg exited without a verdict — gh-1540)');
}

function clearStaleBranchCarrier(ctx, prDetails) {
    var linkedIssue = branchLinkedIssueNumber(prDetails.head && prDetails.head.ref);
    if (!linkedIssue) return;
    removePRLabelQuietly(ctx.scm, linkedIssue, LABELS.AI_REVIEWING,
        'No ai_reviewing label to remove from issue #' + linkedIssue);
}

function clearStaleLinkedCarrier(ctx, prDetails) {
    if (ctx.noTicket) {
        clearStaleBranchCarrier(ctx, prDetails);
        return;
    }
    removeTicketLabelQuietly(ctx.tracker, ctx.ticketKey, LABELS.AI_REVIEWING,
        'the leg exited without a verdict — back to "review wanted, not running"');
}

/**
 * The leg-failure exit (preparePRForReview's catch): a leg that dies between
 * the stamp and its post-action never reaches a verdict path, so the
 * carrier must come off BOTH anchors on the way out — every arming rule
 * skips on it and the naked-PR sweep refuses to re-arm under it (a stuck
 * carrier starves the PR until a human intervenes). Dry-run safe: a dry run
 * never stamped, so it never clears.
 */
function clearStaleCarrierOnLegFailure(ctx, prDetails) {
    if (ctx.dryRun) {
        return;
    }
    clearStalePRCarrier(ctx, prDetails.number);
    clearStaleLinkedCarrier(ctx, prDetails);
}

/**
 * The missing-review-data exit (postPRReviewComments): a leg that ended
 * without a verdict. The ticket side is cleared by the caller; the PR side
 * must clear too — the PR is resolved from the run context (the input
 * folder the pre-action wrote) and both PR anchors are cleared through the
 * same clearReviewInProgressCarrier the verdict path uses. Fail-open end to
 * end: an unresolvable PR keeps the pre-gh-1540 behavior and never masks
 * the missing-output report.
 */
function clearCarrierAfterMissingData(ctx, params, resolvePr, resolveLinkedIssue) {
    try {
        var discovered = resolvePr(params, ctx);
        clearReviewInProgressCarrier(ctx, discovered.pr, discovered.repoInfo, resolveLinkedIssue);
    } catch (e) {
        console.warn('gh-1540: missing-data PR-side carrier clear failed (non-fatal):', e.message || e);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        branchLinkedIssueNumber: branchLinkedIssueNumber,
        parseLinkedIssueNumber: parseLinkedIssueNumber,
        removePRLabelQuietly: removePRLabelQuietly,
        removeTicketLabelQuietly: removeTicketLabelQuietly,
        markReviewInProgress: markReviewInProgress,
        stampPRCarrier: stampPRCarrier,
        stampTicketCarrier: stampTicketCarrier,
        stampBranchIssueCarrier: stampBranchIssueCarrier,
        stampLinkedIssueCarrier: stampLinkedIssueCarrier,
        clearReviewInProgressCarrier: clearReviewInProgressCarrier,
        clearStaleCarrierOnLegFailure: clearStaleCarrierOnLegFailure,
        clearCarrierAfterMissingData: clearCarrierAfterMissingData
    };
}
