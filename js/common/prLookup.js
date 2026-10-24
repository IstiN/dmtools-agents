/**
 * js/common/prLookup.js
 *
 * The PR↔ticket lookup family deduplicated by gh-1249:
 *
 *   - prMentionsTicket — the title/head-branch substring match that
 *     recoverMergedPRTicket.js (prMatchesTicket) and
 *     checkBugTestsPassedHelpers.js carried as verbatim copies. Null-safe
 *     by contract: a null entry previously aborted whole scans via the
 *     caller's catch; here it is a plain non-match.
 *   - findOpenPrForTicket — the scm.listPrs('open') + first-match scan
 *     recoverStuckDevelopment.js / recoverStuckTestCase.js /
 *     retryMergePR.js inlined identically (same 'Failed to list PRs:'
 *     failure line, same fail-closed null).
 *
 * Pure leaf module — no requires, no tool globals.
 */

/**
 * True when the PR title or head branch mentions the ticket key
 * (substring contract, strict boolean; null pr/key → false).
 */
function prMentionsTicket(pr, ticketKey) {
    if (!pr || !ticketKey) return false;
    var titleMatch = pr.title && pr.title.indexOf(ticketKey) !== -1;
    var branchMatch = pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1;
    return !!(titleMatch || branchMatch);
}

/**
 * First open PR whose title or head branch mentions the ticket key, or
 * null. A provider failure logs the shared 'Failed to list PRs:' line and
 * fails closed to null — every legacy caller's exact contract.
 */
function findOpenPrForTicket(scm, ticketKey) {
    try {
        var prList = scm.listPrs('open');
        var matched = (Array.isArray(prList) ? prList : []).find(function(pr) {
            return prMentionsTicket(pr, ticketKey);
        });
        return matched || null;
    } catch (e) {
        console.error('Failed to list PRs:', e);
        return null;
    }
}

module.exports = {
    prMentionsTicket: prMentionsTicket,
    findOpenPrForTicket: findOpenPrForTicket
};
