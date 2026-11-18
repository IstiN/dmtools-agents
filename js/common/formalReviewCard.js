/**
 * formalReviewCard.js — gh-1510: the compact formal-review verdict card.
 *
 * One artifact per role on a `formalGithubReview` PR review leg: the
 * discussion comment carries the full review text, the formal review
 * (native Approve / Request Changes via the Review API) carries this COMPACT
 * VERDICT CARD — the branch-protection signal: verdict headline + thread
 * census + a pointer to the full review — and the verdict record stays the
 * machine marker (gh-807). The card never repeats the general text (the
 * gh-1510 verbatim duplication: the formal review used to resolve
 * `reviewData.generalComment` through the same resolver as the comment and
 * post a byte-identical body), and its pointer only references artifacts the
 * leg actually posted (the honest-stub rule: the legacy reject stub claimed
 * "See PR comments for details" even when nothing resolved and no comment
 * existed).
 *
 * Pure module — no dmtools globals; the posting action feeds it the resolved
 * census and the general-comment posting result. Keep it GraalJS-clean
 * (var + plain functions, JSON-safe data only).
 */
'use strict';

function censusCountOf(value) {
    return Number(value || 0) || 0;
}

/**
 * The thread census line: `blocking 0 · important 0 · suggestions 1 · digest 1`.
 * Missing/unknown tiers normalize to 0 (digest is a visibility count, never
 * an open-thread census — it rides the card for the reviewer's eyes only).
 */
function formalCensusLine(issueCounts) {
    var counts = issueCounts || {};
    return 'blocking ' + censusCountOf(counts.blocking) +
        ' · important ' + censusCountOf(counts.important) +
        ' · suggestions ' + censusCountOf(counts.suggestions) +
        ' · digest ' + censusCountOf(counts.digest);
}

/**
 * The card's pointer to the full review — only honest shapes:
 * - the posted comment's URL when the provider returned one
 *   (github_add_pr_comment returns the comment object; defensively unwrapped);
 * - an above-comment pointer ONLY when the comment actually posted
 *   (generalPost.posted) — never a fabricated link;
 * - no pointer at all when nothing was posted (nothing exists to point at).
 * generalPost: { posted: boolean, url: string|null } — the posting result of
 * the single general-comment resolution (gh-1510).
 */
function formalReviewPointerLine(generalPost) {
    if (generalPost && generalPost.url) return 'Full review: ' + generalPost.url;
    if (generalPost && generalPost.posted) return 'Full review: see the review summary comment above';
    return null;
}

function formalVerdictCard(verdict, issueCounts, generalPost) {
    var lines = ['## Automated Code Review — ' + verdict, formalCensusLine(issueCounts)];
    var pointer = formalReviewPointerLine(generalPost);
    if (pointer) lines.push(pointer);
    return lines.join('\n');
}

function formalApproveBody(issueCounts, generalPost) {
    return formalVerdictCard('APPROVE', issueCounts, generalPost);
}

function formalRejectBody(recommendation, issueCounts, generalPost) {
    // The reject verdict: BLOCK (the model's security/data-loss
    // classification) keeps its own headline; every other non-approve
    // verdict is a REQUEST_CHANGES review.
    return formalVerdictCard(recommendation === 'BLOCK' ? 'BLOCK' : 'REQUEST_CHANGES', issueCounts, generalPost);
}

function ownPrIdentitySuffix(prAuthor, reviewerLogins) {
    var parts = [];
    if (prAuthor) parts.push('PR author: ' + prAuthor);
    if (reviewerLogins) parts.push('reviewer: ' + reviewerLogins);
    return parts.length ? ' (' + parts.join(', ') + ')' : '';
}

/**
 * The own-PR rejection warning (gh-1510): GitHub/GitLab refuse approvals
 * from the PR/MR author. When the reviewing identity is the same login
 * that opened the PR, the label lifecycle stays the source of truth — the
 * warn names both identities honestly (the hedged "own-PR restriction?"
 * told the operator nothing) and never fails the leg.
 */
function ownPrApprovalWarning(prAuthor, reviewerLogins, cause) {
    return 'formalGithubReview: formal APPROVE rejected — the reviewing identity is restricted from approving its own PR' +
        ownPrIdentitySuffix(prAuthor, reviewerLogins) + '. ' +
        'The pr_approved label lifecycle stays the source of truth. Cause: ' + (cause || 'unknown');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        censusCountOf: censusCountOf,
        formalCensusLine: formalCensusLine,
        formalReviewPointerLine: formalReviewPointerLine,
        formalVerdictCard: formalVerdictCard,
        formalApproveBody: formalApproveBody,
        formalRejectBody: formalRejectBody,
        ownPrIdentitySuffix: ownPrIdentitySuffix,
        ownPrApprovalWarning: ownPrApprovalWarning
    };
}
