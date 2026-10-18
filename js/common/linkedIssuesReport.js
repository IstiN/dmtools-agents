/**
 * Shared pure helpers for the linked-issue fetchers (fetchLinkedTestsToInput.js,
 * fetchLinkedBugsToInput.js) — gh-1038. Extracted so both fetchers build the
 * linked-issue query, resolve the input folder and render the recent-comments
 * block from one implementation.
 *
 * All functions are pure: no tracker/SCM/file calls, no globals.
 */

/**
 * Resolve the input folder context from the action params. Accepts both the
 * direct shape ({ inputFolderPath }) and the jobParams-wrapped shape
 * ({ jobParams: { inputFolderPath } }) the JSRunner passes to pre-actions.
 * @returns {{actualParams: Object, folder: string, ticketKey: string}}
 */
function resolveInputContext(params) {
    var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
    var folder = actualParams.inputFolderPath;
    return {
        actualParams: actualParams,
        folder: folder,
        ticketKey: folder.split('/').pop()
    };
}

/**
 * Build the provider query (JQL on Jira, pasthrough WIQL on ADO) for issues
 * linked to a ticket, filtered to the caller's issue-type/status clause.
 */
function buildLinkedQuery(ticketKey, typeFilter) {
    return 'issue in linkedIssues("' + ticketKey + '") AND ' + typeFilter;
}

/**
 * Render the most recent comments (up to 5) as markdown lines, matching the
 * fetchers' historical report layout.
 * @param {Array} comments - comment objects with author.displayName / body
 * @param {string} headerPrefix - e.g. '**Test Run Comments' or '**Comments'
 * @returns {Array} markdown lines; empty array when there are no comments
 */
function buildRecentCommentLines(comments, headerPrefix) {
    var lines = [];
    if (!comments || comments.length === 0) {
        return lines;
    }
    var startIdx = Math.max(0, comments.length - 5);
    lines.push(headerPrefix + ' (' + (comments.length - startIdx) + ' most recent)**:\n');
    for (var j = startIdx; j < comments.length; j++) {
        var c = comments[j];
        var author = (c.author && c.author.displayName) || 'Unknown';
        var body = (c.body || '').substring(0, 2000);
        lines.push('**[' + author + ']**:');
        lines.push(body);
        lines.push('');
    }
    return lines;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        resolveInputContext: resolveInputContext,
        buildLinkedQuery: buildLinkedQuery,
        buildRecentCommentLines: buildRecentCommentLines
    };
}
