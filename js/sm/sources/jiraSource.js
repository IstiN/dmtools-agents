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

var trackersModule = require('../../common/trackers.js');

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
    // The query is provider-specific text: JQL on Jira, WIQL on ADO (no translation). The tracker
    // picks the backend from the effective project config / DEFAULT_TRACKER and returns Jira-shaped
    // issues; labels live in fields.labels (the flat t.labels is kept as a fallback for old shapes).
    var tracker = trackersModule.createTracker((ctx && ctx.config) || {}, {});
    var tickets = tracker.searchIssues(jql, { fields: ['key', 'labels'] }) || [];
    var items = (Array.isArray(tickets) ? tickets : []).map(function (t) {
        return {
            key: t.key,
            labels: (t.fields && t.fields.labels) || t.labels || [],
            pr: null,
            issueNumber: null,
            prNumber: null
        };
    });
    // owner rule 2026-10-04: oldest first, always — the search API returns
    // newest-first (REST default), which starves the oldest ticket under
    // limit:1 rules. Jira key order == per-project creation order: sort by
    // (project prefix, numeric suffix) so multi-project JQL keeps
    // per-project FIFO. Same fairness fix as the GitHub source's
    // issue/PR-number sorts and mergeBot's ascending list sort.
    items.sort(function (a, b) {
        var ka = String(a.key || ''), kb = String(b.key || '');
        var pa = ka.replace(/\d+$/, ''), pb = kb.replace(/\d+$/, '');
        if (pa !== pb) return pa < pb ? -1 : 1;
        var na = parseInt((/(\d+)$/.exec(ka) || [0, '0'])[1], 10);
        var nb = parseInt((/(\d+)$/.exec(kb) || [0, '0'])[1], 10);
        return na - nb;
    });
    return items;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { query: query };
}
