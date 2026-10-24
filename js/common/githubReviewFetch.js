/**
 * githubReviewFetch.js — the GitHub review-discussion fetch/render blocks
 * shared by js/common/scm.js (github provider fetchDiscussions) and
 * js/common/githubHelpers.js (fetchDiscussionsAndRawData) (gh-1248 dedup).
 * Both paths ran byte-identical copies of:
 *
 *   fetchPrConversations / fetchPrReviewThreadsRaw — the dmtools-global
 *     fetch wrappers with their exact call order, log text and fallback
 *     semantics (a failed conversations export yields [], a failed GraphQL
 *     census yields null + the conversations-only fallback warning);
 *   logInventoryCounts — the 'Discussions: …' census log line;
 *   buildGeneralCommentsSection — the '## General PR Comments' markdown
 *     renderer (hidden dmtools machine markers skipped).
 *
 * GraalJS-clean (var + plain functions). The github_* globals are
 * dmtools runtime globals, same contract as the former inline copies.
 */
'use strict';

var machineNotice = require('./machineNotice.js');
var reviewThreadInventory = require('./reviewThreadInventory.js');

/**
 * The conversations export for a PR; a failed fetch yields [] (warning
 * logged), never a throw.
 */
function fetchPrConversations(workspace, repository, prIdStr) {
    var conversations = [];
    try {
        conversations = github_get_pr_conversations({
            workspace: workspace,
            repository: repository,
            pullRequestId: prIdStr
        }) || [];
    } catch (e) {
        console.warn('github_get_pr_conversations failed:', e.message || e);
    }
    return conversations;
}

/**
 * The GraphQL reviewThreads census for a PR (raw payload); a failed fetch
 * yields null and logs the conversations-only fallback warning.
 */
function fetchPrReviewThreadsRaw(workspace, repository, prIdStr) {
    var graphqlRaw = null;
    try {
        graphqlRaw = github_get_pr_review_threads({
            workspace: workspace,
            repository: repository,
            pullRequestId: prIdStr
        });
        console.log('Got', reviewThreadInventory.parseGraphQLNodes(graphqlRaw).length, 'review threads for GraphQL IDs');
    } catch (e) {
        console.warn('github_get_pr_review_threads failed (falling back to conversations-only inventory):', e.message || e);
    }
    return graphqlRaw;
}

/**
 * The 'Discussions: …' census log line, verbatim from both former
 * closures (thread counts + reply/resolve id counts + the arm-rule
 * GraphQL census suffix when present).
 */
function logInventoryCounts(inv, rawThreads) {
    var c = inv.counts;
    console.log('Discussions: ' + c.total + ' threads (' + c.open + ' open, ' + c.resolved + ' resolved, ' + c.bot + ' bot, ' + c.notices + ' machine notices),',
        rawThreads.filter(function(t) { return t.rootCommentId; }).length + ' reply IDs,',
        rawThreads.filter(function(t) { return t.threadId; }).length + ' resolve IDs' +
        (inv.census.graphqlUnresolved !== null
            ? ' — GraphQL census: ' + inv.census.graphqlUnresolved + ' unresolved (arm-rule count)'
            : ''));
}

/**
 * Pure renderer for the '## General PR Comments' section (verbatim shape):
 * hidden `<!-- dmtools:` machine-bookkeeping comments skipped, bodies
 * trimmed, per-comment separator.
 */
function buildGeneralCommentsSection(comments) {
    var section = '## General PR Comments\n\n';
    comments.forEach(function(comment) {
        if (machineNotice.isDmtoolsMarkerBody((comment && comment.body) || '')) return;
        var author = (comment.user && comment.user.login) ? comment.user.login : 'unknown';
        var date = comment.created_at ? comment.created_at.substring(0, 10) : '';
        section += '**' + author + '** (' + date + '):\n\n';
        section += (comment.body || '').trim() + '\n\n---\n\n';
    });
    return section;
}

module.exports = {
    fetchPrConversations: fetchPrConversations,
    fetchPrReviewThreadsRaw: fetchPrReviewThreadsRaw,
    logInventoryCounts: logInventoryCounts,
    buildGeneralCommentsSection: buildGeneralCommentsSection
};
