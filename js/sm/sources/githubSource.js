/**
 * GitHub state source for the SM rule engine.
 *
 * On GitHub the tracker IS the state machine: issue labels carry the
 * machine-loop state (agent:dev / ai_developed / pr_approved / …) and PR
 * facts carry CI/merge observations. Two carrier modes, mirroring how the
 * loop actually spawns work:
 *
 *   query: { type: 'issue', labels, notLabels, assignee, prChecks, … }
 *     The issue is the state carrier; the linked PR (branch
 *     <branchPrefix><n> or a "#n" reference in the PR body) ENRICHES the
 *     observation (guards on prChecks / prMergeState apply only when a PR
 *     is linked — the Jira-era shape).
 *
 *   query: { type: 'pr', labels, notLabels, checks, mergeState, … }
 *     The PR itself is the state carrier — covers PRs born without an
 *     issue. Guards read PR labels + checks + merge state directly.
 *
 * All I/O goes through common/smProvider.js (bridge tools; gitlab twin
 * speaks the same contract), so this source is forge-portable as-is.
 *
 * Item shape:
 *   { key: 'gh-125' | 'pr-127', labels, pr: {number,state,checks,mergeState,
 *     mergeable} | null, issueNumber, prNumber }
 */
'use strict';

var smProviderModule = require('../../common/smProvider.js');

function parseMcp(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

function asList(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.items)) return parsed.items; // github_search_issues shape
    return [];
}

function issueLabels(it) {
    return (it.labels || []).map(function (l) { return l.name || l; });
}

function prLabels(p) {
    return (p.labels || []).map(function (l) { return (l && l.name) || l; });
}

function matchesGuards(item, rule) {
    var q = rule.query || {};
    var labels = item.labels || [];
    if (q.notLabels && q.notLabels.some(function (l) { return labels.indexOf(l) !== -1; })) {
        return false;
    }
    if (q.prChecks && (!item.pr || item.pr.checks !== q.prChecks)) return false;
    if (q.prMergeState && (!item.pr || item.pr.mergeState !== q.prMergeState)) return false;
    if (q.mergeState && (!item.pr || item.pr.mergeState !== q.mergeState)) return false;
    if (q.mergeable === true && (!item.pr || item.pr.mergeable !== true)) return false;
    if (q.prState && (!item.pr || item.pr.state !== q.prState)) return false;
    return true;
}

/**
 * Queries GitHub state for the rule.
 * @param {Object} rule - SM rule with rule.query (see module doc)
 * @param {Object} ctx  - { config, repoInfo: {owner, repo}, provider? }
 * @returns {Array<Object>} state items
 */
function query(rule, ctx) {
    var q = rule.query || {};
    var repoInfo = ctx.repoInfo || {};
    var provider = ctx.provider || smProviderModule.createSmProvider({
        scm: { provider: 'github' },
        repository: repoInfo
    });
    var branchPrefix = rule.branchPrefix || 'ai/gh-';
    var limit = rule.limit || 50;

    if (q.type === 'pr') {
        return queryPrs(rule, provider, repoInfo, limit);
    }
    return queryIssues(rule, provider, repoInfo, branchPrefix, limit);
}

function queryIssues(rule, provider, repoInfo, branchPrefix, limit) {
    var q = rule.query || {};
    var full = repoInfo.owner + '/' + repoInfo.repo;
    var seen = {};
    var items = [];

    // Per-label OR search (GitHub ANDs multi-label queries).
    (q.labels || []).forEach(function (ml) {
        if (Object.keys(seen).length >= limit) return;
        var res = parseMcp(github_search_issues({
            query: 'repo:' + full + ' is:issue is:open label:"' + ml + '"'
        }));
        asList(res).forEach(function (it) {
            if (seen[it.number]) return;
            seen[it.number] = true;
            items.push({
                key: 'gh-' + it.number,
                labels: issueLabels(it),
                pr: null,
                issueNumber: it.number,
                prNumber: null,
                _raw: it
            });
        });
    });
    if (q.assignee) {
        var extra = parseMcp(github_search_issues({
            query: 'repo:' + full + ' is:issue is:open assignee:' + q.assignee
        }));
        asList(extra).forEach(function (it) {
            if (seen[it.number]) return;
            seen[it.number] = true;
            items.push({
                key: 'gh-' + it.number,
                labels: issueLabels(it),
                pr: null,
                issueNumber: it.number,
                prNumber: null
            });
        });
    }

    // Linked-PR enrichment: the issue carries the state, the PR carries
    // the CI/merge observation.
    var enriched = items.map(function (item) {
        var prRef = provider.findPr(item.issueNumber, branchPrefix);
        if (prRef && prRef.state === 'OPEN') {
            item.pr = provider.prStatus(prRef.number);
            item.prNumber = prRef.number;
        } else if (prRef) {
            item.pr = { number: prRef.number, state: prRef.state,
                        checks: 'none', mergeState: 'UNKNOWN', mergeable: null };
            item.prNumber = prRef.number;
        }
        return item;
    });

    return enriched.filter(function (item) { return matchesGuards(item, rule); });
}

function queryPrs(rule, provider, repoInfo, limit) {
    var q = rule.query || {};
    var prs = asList(parseMcp(github_list_prs({
        workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open'
    })));

    var items = prs.map(function (p) {
        return {
            key: 'pr-' + p.number,
            labels: prLabels(p),
            pr: null,
            issueNumber: null,
            prNumber: p.number,
            draft: !!p.draft,
            branch: (p.head && p.head.ref) || p.headRefName || ''
        };
    });

    // PR guards that need per-PR facts (checks/merge state) resolve lazily:
    // only when the rule actually filters on them.
    var needsStatus = q.checks || q.mergeState || q.mergeable !== undefined || q.prChecks;
    if (needsStatus) {
        items = items.map(function (item) {
            item.pr = provider.prStatus(item.prNumber);
            return item;
        });
    }

    var matched = items.filter(function (item) {
        var labels = item.labels;
        var q2 = rule.query || {};
        if (q2.labels && !q2.labels.some(function (l) { return labels.indexOf(l) !== -1; })) return false;
        if (q2.notLabels && q2.notLabels.some(function (l) { return labels.indexOf(l) !== -1; })) return false;
        if (q2.draft === false && item.draft) return false;
        if (q2.branchPrefix && String(item.branch || '').indexOf(q2.branchPrefix) !== 0) return false;
        return matchesGuards(item, rule);
    });

    // FIFO: oldest PR first. github_list_prs returns newest-first (API
    // default), which would starve older approved PRs under limit:1 merge
    // rules — the queue drains oldest-to-newest. Blocked candidates
    // (conflicts, red/pending checks) never reach here: guards already
    // filtered them, so the head of this list is the oldest mergeable PR.
    matched.sort(function (a, b) { return (a.prNumber || 0) - (b.prNumber || 0); });

    return matched.slice(0, limit);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { query: query, matchesGuards: matchesGuards };
}
