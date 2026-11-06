/**
 * githubReviewFetch.js — the GitHub review-discussion fetch/render blocks
 * shared by js/common/scm.js (github provider fetchDiscussions) and
 * js/common/githubHelpers.js (fetchDiscussionsAndRawData) (gh-1248 dedup).
 * Both paths ran byte-identical copies of:
 *
 *   machineBookkeepingBody — the gh-1387 L1 skip predicate for the
 *     general-comments renderer (both machine bookkeeping classes — hidden
 *     dmtools: markers AND visible harness notices — drop out of the
 *     agent-facing section; named so buildGeneralCommentsSection stays
 *     under the crap4js ratchet);
 *   authorOf — the comment-login lookup with the unknown-login fallback;
 *   fetchPrConversations / fetchPrReviewThreadsRaw — the dmtools-global
 *     fetch wrappers with their exact call order, log text and fallback
 *     semantics (a failed conversations export yields [], a failed GraphQL
 *     census yields null + the conversations-only fallback warning);
 *   logInventoryCounts — the 'Discussions: …' census log line;
 *   buildGeneralCommentsSection — the '## General PR Comments' markdown
 *     renderer (hidden dmtools machine markers AND visible machine-notice
 *     comments skipped — gh-1248 + the gh-808 finish line, see below).
 *
 * GraalJS-clean (var + plain functions). The github_* globals are
 * dmtools runtime globals, same contract as the former inline copies.
 */
'use strict';

var machineNotice = require('./machineNotice.js');
var reviewThreadInventory = require('./reviewThreadInventory.js');

// One skip predicate for the general-comments renderer (gh-1387 L1): both
// machine bookkeeping classes — hidden dmtools: markers AND visible
// harness notices — drop out of the agent-facing section. Named (and kept
// out of the renderer) so buildGeneralCommentsSection stays under the
// crap4js ratchet. NOTE: the directive prologue ends at the use-strict
// line above — every helper lives BELOW it (a function declaration above
// the directive would silently deactivate strict mode for the whole
// module, gh-1392 review).
function machineBookkeepingBody(body) {
    return machineNotice.isDmtoolsMarkerBody(body) || machineNotice.isMachineNoticeBody(body);
}

/** The comment's login, or 'unknown' when the payload shape is odd. */
function authorOf(comment) {
    return (comment && comment.user && comment.user.login) ? comment.user.login : 'unknown';
}

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
 * bodies trimmed, per-comment separator. Two skip classes (gh-1248 + gh-808
 * finish line, live PR dmtools-agents#1387 measured ~2 KB of arm/red
 * boilerplate per review/rework context build):
 *   1. hidden `<!-- dmtools:` machine-bookkeeping comments
 *      (machineNotice.isDmtoolsMarkerBody);
 *   2. visible harness notices — arming/red/park/conflict/rework reports
 *      (machineNotice.isMachineNoticeBody) — status updates, never review
 *      feedback; feeding them to the review/rework agent is exactly the
 *      gh-808 pathology (the agent answering the machine's own boilerplate).
 * Returns null when EVERY comment was skipped — the callers push the
 * section only when non-null, so a notices-only PR renders no empty
 * '## General PR Comments' header.
 */
function buildGeneralCommentsSection(comments) {
    var section = '## General PR Comments\n\n';
    var kept = 0;
    comments.forEach(function(comment) {
        var body = (comment && comment.body) || '';
        if (machineBookkeepingBody(body)) return;
        var date = comment.created_at ? comment.created_at.substring(0, 10) : '';
        section += '**' + authorOf(comment) + '** (' + date + '):\n\n';
        section += body.trim() + '\n\n---\n\n';
        kept++;
    });
    return kept > 0 ? section : null;
}

module.exports = {
    fetchPrConversations: fetchPrConversations,
    fetchPrReviewThreadsRaw: fetchPrReviewThreadsRaw,
    logInventoryCounts: logInventoryCounts,
    buildGeneralCommentsSection: buildGeneralCommentsSection
};
