/**
 * Shared Bitrise-trigger helpers (gh-1250).
 *
 * Extracted from triggerBitriseIosBuild.js and triggerBitriseTestAutomation.js,
 * which carried token-identical copies of:
 *
 *   - JQL ticket-key parsing (parseJqlTicketKey)
 *   - issue-list payload normalization (parseIssueList)
 *   - feature-PR matching (prHeadRef / prViewUrl / prMatchesTicket)
 *
 * findMatchingPr is the shared scan core behind each action's feature-PR
 * lookup; callers keep their own log lines and result shapes.
 *
 * IMPORTANT: this module runs inside the DMTools GraalJS bridge — keep
 * requires load-time (gh-823) and data structures JSON-safe. It requires
 * nothing, so it packs cleanly everywhere.
 */

/** Extract "PROJ-123" from a JQL fragment like "key = PROJ-123" (case-insensitive). */
function parseJqlTicketKey(jql) {
    var keyMatch = (jql || '').match(/key\s*=\s*([A-Z]+-\d+)/i);
    return keyMatch ? keyMatch[1].toUpperCase() : '';
}

/** Normalize a tracker search payload (JSON string, {issues:[...]}, bare array). */
function parseIssueList(results) {
    var parsed = (typeof results === 'string') ? JSON.parse(results) : results;
    return (parsed && parsed.issues) ? parsed.issues : (Array.isArray(parsed) ? parsed : []);
}

/** Head branch ref of a PR, or ''. */
function prHeadRef(pr) {
    return (pr && pr.head && pr.head.ref) || '';
}

/** Public URL of a PR (prefers html_url), or ''. */
function prViewUrl(pr) {
    return (pr && (pr.html_url || pr.url)) || '';
}

/** A PR belongs to a ticket when its title or head branch contains the key. */
function prMatchesTicket(pr, ticketKey) {
    var prBranch = prHeadRef(pr);
    return ((pr && pr.title) || '').indexOf(ticketKey) !== -1 || prBranch.indexOf(ticketKey) !== -1;
}

/** First open PR matching the ticket key, or null (tolerates a null list). */
function findMatchingPr(prs, ticketKey) {
    for (var i = 0; i < (prs || []).length; i++) {
        if (prMatchesTicket(prs[i], ticketKey)) return prs[i];
    }
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseJqlTicketKey: parseJqlTicketKey,
        parseIssueList: parseIssueList,
        prHeadRef: prHeadRef,
        prViewUrl: prViewUrl,
        prMatchesTicket: prMatchesTicket,
        findMatchingPr: findMatchingPr
    };
}
