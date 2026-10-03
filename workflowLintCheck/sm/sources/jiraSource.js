/**
 * Jira state source for the SM rule engine.
 *
 * The classic sm behavior, extracted from smAgent's processRule: a rule
 * with no `source` (or source: 'jira') queries Jira by interpolated JQL
 * and returns the matching tickets as state items.
 *
 * Item shape (the SM contract, forge-agnostic):
 *   { key: 'PROJ-1', labels: [...], pr: null, issueNumber: null, prNumber: null }
 */
'use strict';

/**
 * Queries Jira by the rule's JQL.
 * @param {Object} rule - the SM rule (uses rule.jql, interpolated upstream)
 * @param {Object} ctx  - { config, repoInfo } (unused by the Jira source;
 *                        JQL interpolation happens in the rule processor)
 * @returns {Array<Object>} state items
 */
function query(rule, ctx) {
    // ctx.jql carries the interpolated JQL from the rule processor
    // ({jiraProject}/{parentTicket} placeholders already resolved).
    var jql = (ctx && ctx.jql) || rule.jql;
    var tickets = jira_search_by_jql({ jql: jql, fields: ['key', 'labels'] }) || [];
    return (Array.isArray(tickets) ? tickets : []).map(function (t) {
        return {
            key: t.key,
            labels: t.labels || [],
            pr: null,
            issueNumber: null,
            prNumber: null
        };
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { query: query };
}
