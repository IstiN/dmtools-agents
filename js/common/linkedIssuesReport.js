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
 * Quote a string value as a WIQL single-quoted literal, escaping internal single quotes.
 */
function wiqlQuote(val) {
    return "'" + String(val == null ? '' : val).replace(/'/g, "''") + "'";
}

/**
 * Format a ticket key/id for WIQL: numeric IDs stay bare, string keys are quoted.
 */
function wiqlIdExpr(key) {
    var trimmed = String(key == null ? '' : key).trim();
    return /^\d+$/.test(trimmed) ? trimmed : wiqlQuote(key);
}

/**
 * Format an array of values as a comma-separated list of WIQL single-quoted literals.
 */
function wiqlList(items) {
    return (items || []).map(wiqlQuote).join(', ');
}

/**
 * Build the [Target].[System.WorkItemType] filter clause for WorkItemLinks WIQL.
 */
function adoTargetTypeClause(opts) {
    if (!opts) return '';
    if (Array.isArray(opts.issueTypes) && opts.issueTypes.length > 0) {
        return ' AND [Target].[System.WorkItemType] IN (' + wiqlList(opts.issueTypes) + ')';
    }
    return opts.issueType ? ' AND [Target].[System.WorkItemType] = ' + wiqlQuote(opts.issueType) : '';
}

/**
 * Build the [Target].[System.State] filter clause for WorkItemLinks WIQL.
 */
function adoTargetStatusClause(opts) {
    if (!opts) return '';
    if (opts.statusNotEquals) {
        return ' AND [Target].[System.State] <> ' + wiqlQuote(opts.statusNotEquals);
    }
    if (Array.isArray(opts.statusNotIn) && opts.statusNotIn.length > 0) {
        return ' AND [Target].[System.State] NOT IN (' + wiqlList(opts.statusNotIn) + ')';
    }
    return (Array.isArray(opts.statusIn) && opts.statusIn.length > 0)
        ? ' AND [Target].[System.State] IN (' + wiqlList(opts.statusIn) + ')'
        : '';
}

/**
 * Build an Azure DevOps WorkItemLinks WIQL query for issues linked to ticketKey.
 */
function buildAdoLinkedWiql(ticketKey, opts) {
    var idExpr = wiqlIdExpr(ticketKey);
    return 'SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = ' +
        idExpr + ' AND [Target].[System.Id] <> ' + idExpr +
        adoTargetTypeClause(opts) + adoTargetStatusClause(opts) + ' MODE (MustContain)';
}

/**
 * Build a provider-aware linked-issues query (JQL on Jira, WorkItemLinks WIQL on ADO).
 */
function buildLinkedIssuesQuery(provider, ticketKey, jqlSuffix, adoOpts) {
    if (String(provider || '').toLowerCase() === 'ado') {
        return buildAdoLinkedWiql(ticketKey, adoOpts || {});
    }
    return 'issue in linkedIssues("' + ticketKey + '") AND ' + jqlSuffix;
}

/**
 * Build the provider query (JQL on Jira, WorkItemLinks WIQL on ADO) for issues
 * linked to a ticket, filtered to the caller's issue-type/status clause.
 */
function buildLinkedQuery(ticketKey, typeFilter, provider, adoOpts) {
    if (String(provider || '').toLowerCase() === 'ado') {
        return buildAdoLinkedWiql(ticketKey, adoOpts || {});
    }
    return 'issue in linkedIssues("' + ticketKey + '") AND ' + typeFilter;
}

/**
 * Build a provider-aware child-issues query (JQL on Jira, WorkItems WIQL on ADO,
 * or passthrough when jqlQuery is already a SELECT WIQL query).
 */
function buildChildrenQuery(provider, parentKey, jqlQuery, issueType) {
    var raw = String(jqlQuery || '');
    if (/^\s*SELECT\b/i.test(raw)) {
        return raw.replace('{ticketKey}', parentKey);
    }
    if (String(provider || '').toLowerCase() === 'ado') {
        return 'SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = ' + wiqlIdExpr(parentKey) +
            (issueType ? ' AND [System.WorkItemType] = ' + wiqlQuote(issueType) : '');
    }
    return raw.replace('{ticketKey}', parentKey);
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
        wiqlQuote: wiqlQuote,
        wiqlIdExpr: wiqlIdExpr,
        wiqlList: wiqlList,
        adoTargetTypeClause: adoTargetTypeClause,
        adoTargetStatusClause: adoTargetStatusClause,
        buildAdoLinkedWiql: buildAdoLinkedWiql,
        buildLinkedIssuesQuery: buildLinkedIssuesQuery,
        buildLinkedQuery: buildLinkedQuery,
        buildChildrenQuery: buildChildrenQuery,
        buildRecentCommentLines: buildRecentCommentLines
    };
}
