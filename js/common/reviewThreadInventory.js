/**
 * reviewThreadInventory.js — the review-thread inventory for rework/review
 * leg input prep (gh-957).
 *
 * Live pathology (dart PR #424 / gh-957, 2026-10-17 08:00–10:55Z): the SM's
 * arm rule counts unresolved threads via GraphQL reviewThreads
 * (github_get_pr_review_threads — isResolved === false) and counted 64.
 * The rework leg's input was built from github_get_pr_conversations, which
 * surfaced only 2 threads (both machine notices) — the leg concluded
 * 'Review decision is NONE, nothing to fix', resolved nothing, and the
 * unresolved-threads armer re-armed rework 7 times in 2 hours, starving the
 * whole machine queue. The two sides of the arm condition NEVER agreed.
 *
 * This module is the single inventory builder both collection paths
 * (js/common/scm.js fetchDiscussions and js/common/githubHelpers.js
 * fetchDiscussionsAndRawData) delegate to:
 *
 *   GraphQL-first — when the reviewThreads fetch succeeds with at least one
 *   node, the inventory is ENUMERATED from the GraphQL nodes (the exact same
 *   census the SM arm rule counts), enriched per-thread from the matching
 *   conversation (body/author/path/line/replies the GraphQL payload may not
 *   carry). Threads the conversations export missed entirely (the dart #424
 *   shape) still land in the inventory with their resolve id (threadId) and
 *   reply anchor (rootCommentId).
 *
 *   Legacy fallback — when the GraphQL fetch fails or returns zero nodes,
 *   the inventory is built from conversations exactly as before (REST
 *   resolved/isResolved flags enriched with GraphQL ids when available).
 *
 * The gh-808 machine-notice doctrine is preserved on BOTH paths: notice
 * threads never appear in rawThreads or the markdown (AC1); conversation-only
 * notices are still counted for the exclusion summary note.
 *
 * Pure module — no dmtools globals; the callers fetch conversations and the
 * GraphQL payload and pass them in. GraalJS-clean (var + plain functions,
 * JSON-safe data only).
 */
'use strict';

var machineNotice = require('./machineNotice.js');

/**
 * Normalize the github_get_pr_review_threads return (JSON string | node
 * array | full envelope | {nodes:[...]} short envelope) into a node array.
 */
function parseGraphQLNodes(raw) {
    if (!raw) return [];
    var data = raw;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return []; }
    }
    if (Array.isArray(data)) return data;
    var rt = data && data.data && data.data.repository &&
             data.data.repository.pullRequest &&
             data.data.repository.pullRequest.reviewThreads;
    if (rt && Array.isArray(rt.nodes)) return rt.nodes;
    if (data && Array.isArray(data.nodes)) return data.nodes;
    return [];
}

/**
 * REST conversation root comment id (id || databaseId) — the join key
 * between the conversations export and the GraphQL first-comment databaseId.
 */
function conversationRootId(thread) {
    var root = (thread && (thread.rootComment || thread)) || {};
    return root.id || root.databaseId || null;
}

function indexConversations(conversations) {
    var byId = {};
    (conversations || []).forEach(function(c) {
        var id = conversationRootId(c);
        if (id !== null && id !== undefined) byId[String(id)] = c;
    });
    return byId;
}

/**
 * Map one GraphQL reviewThread node to the enriched internal thread shape
 * ({rootCommentId, threadId, path, line, resolved, bot, body, author, date,
 * replies}), filling body/author/path/line/replies from the matched
 * conversation when the node's first comment does not carry them (the
 * dmtools export may omit fields). The RESOLVED flag is GraphQL truth only —
 * the arm rule counts isResolved, so the inventory must never disagree.
 */
function threadFromGraphQLNode(node, conversation) {
    var first = (node.comments && node.comments.nodes && node.comments.nodes[0]) || {};
    var convRoot = conversation ? (conversation.rootComment || conversation) : {};
    var author = (first.author && (first.author.login || first.author.name)) || '';
    if (!author) {
        author = convRoot.user ? (convRoot.user.login || '') :
            (convRoot.author ? (convRoot.author.login || convRoot.author.name || '') : '');
    }
    var body = String(first.body || convRoot.body || '').trim();
    var path = node.path || (conversation && conversation.path) || null;
    var line = (node.line === 0 || node.line) ? node.line
        : (conversation ? (conversation.line || conversation.original_line || null) : null);
    return {
        rootCommentId: first.databaseId || null,
        threadId: node.id || null,
        path: path,
        line: line,
        resolved: node.isResolved === true,
        bot: machineNotice.isBotAuthor(author),
        body: body,
        author: author || 'unknown',
        date: convRoot.created_at ? String(convRoot.created_at).substring(0, 10) : '',
        replies: (conversation && Array.isArray(conversation.replies)) ? conversation.replies : []
    };
}

/**
 * GraphQL-first inventory (gh-957): enumerate the SAME census the SM arm
 * rule counts. Notice threads (enriched body matches a harness marker) are
 * dropped and counted. Conversation-only notices — the gh-808 corpus shape —
 * are counted for the exclusion note but never enumerated (they are not
 * GraphQL review threads; the arm rule does not count them either).
 */
function buildFromGraphQL(nodes, conversations) {
    var convById = indexConversations(conversations);
    var enriched = [];
    var noticeCount = 0;
    var matchedConvIds = {};
    nodes.forEach(function(node) {
        if (!node) return;
        var first = (node.comments && node.comments.nodes && node.comments.nodes[0]) || {};
        var conv = null;
        if (first.databaseId !== null && first.databaseId !== undefined) {
            conv = convById[String(first.databaseId)] || null;
            if (conv) matchedConvIds[String(first.databaseId)] = true;
        }
        var t = threadFromGraphQLNode(node, conv);
        if (machineNotice.isMachineNoticeBody(t.body)) {
            noticeCount++;
            return;
        }
        enriched.push(t);
    });
    (conversations || []).forEach(function(c) {
        var id = conversationRootId(c);
        if (id !== null && id !== undefined && matchedConvIds[String(id)]) return;
        var root = c.rootComment || c;
        if (machineNotice.isMachineNoticeBody(String(root.body || '').trim())) noticeCount++;
    });
    var unresolved = 0;
    nodes.forEach(function(n) { if (n && n.isResolved !== true) unresolved++; });
    return {
        enriched: enriched,
        noticeCount: noticeCount,
        source: 'graphql',
        graphqlTotal: nodes.length,
        graphqlUnresolved: unresolved
    };
}

/**
 * Legacy conversation-first inventory (pre-gh-957 behavior, preserved for
 * the fallback path): enumerate the conversations export, resolve status
 * from REST flags enriched with GraphQL isResolved, threadId from the
 * GraphQL node id matched by first-comment databaseId.
 */
function buildFromConversations(conversations, nodes) {
    var threadIdByCommentId = {};
    var resolvedByCommentId = {};
    (nodes || []).forEach(function(rt) {
        if (rt && rt.id && rt.comments && rt.comments.nodes && rt.comments.nodes.length > 0) {
            var dbId = rt.comments.nodes[0].databaseId;
            if (dbId !== null && dbId !== undefined) {
                threadIdByCommentId[String(dbId)] = rt.id;
                resolvedByCommentId[String(dbId)] = rt.isResolved === true;
            }
        }
    });
    var enriched = [];
    var noticeCount = 0;
    (conversations || []).forEach(function(thread) {
        var root = thread.rootComment || thread;
        var body = String(root.body || '').trim();
        if (machineNotice.isMachineNoticeBody(body)) {
            noticeCount++;
            return;
        }
        var rootId = conversationRootId(thread);
        var author = root.user ? (root.user.login || '') :
            (root.author ? (root.author.login || '') : '');
        var graphqlResolved = rootId !== null && rootId !== undefined
            ? resolvedByCommentId[String(rootId)] : false;
        enriched.push({
            rootCommentId: rootId,
            threadId: rootId !== null && rootId !== undefined
                ? (threadIdByCommentId[String(rootId)] || null) : null,
            path: thread.path || null,
            line: thread.line || thread.original_line || null,
            resolved: thread.resolved === true || thread.isResolved === true || graphqlResolved,
            bot: machineNotice.isBotAuthor(author),
            body: body,
            author: author || 'unknown',
            date: root.created_at ? String(root.created_at).substring(0, 10) : '',
            replies: Array.isArray(thread.replies) ? thread.replies : []
        });
    });
    return {
        enriched: enriched,
        noticeCount: noticeCount,
        source: 'conversations',
        graphqlTotal: nodes.length,
        graphqlUnresolved: null
    };
}

/**
 * Render the '## Review Threads (Inline Comments)' markdown section from
 * the enriched inventory: every open non-bot thread with body and replies,
 * prefixed by the exclusion summary note (gh-808). Resolved/bot threads are
 * excluded from the readable section but counted in the note.
 */
function renderThreadsMarkdown(enriched, noticeCount) {
    var section = '## Review Threads (Inline Comments)\n\n';
    enriched.forEach(function(t, idx) {
        if (t.resolved || t.bot) return;
        section += '### Thread ' + (idx + 1);
        if (t.path) {
            section += ' — `' + t.path + '`';
            if (t.line) section += ' line ' + t.line;
        }
        section += '\n\n';
        if (t.body) {
            section += '**' + t.author + '** (' + t.date + '):\n' + t.body + '\n\n';
        } else {
            section += '_[No comment body]_\n\n';
        }
        (t.replies || []).forEach(function(reply) {
            var rAuthor = reply.user ? reply.user.login : 'unknown';
            var rDate = reply.created_at ? reply.created_at.substring(0, 10) : '';
            section += '> **' + rAuthor + '** (' + rDate + '): ' + String(reply.body || '').trim() + '\n\n';
        });
        section += '---\n\n';
    });
    var resolvedCount = enriched.filter(function(t) { return t.resolved; }).length;
    var botCount = enriched.filter(function(t) { return !t.resolved && t.bot; }).length;
    var openCount = enriched.length - resolvedCount - botCount;
    var infoLines = [];
    if (resolvedCount > 0) infoLines.push(resolvedCount + ' resolved thread(s) excluded');
    if (botCount > 0) infoLines.push(botCount + ' bot-generated thread(s) excluded (informational only)');
    if (noticeCount > 0) infoLines.push(noticeCount + ' machine notice(s) excluded (arming/status boilerplate — never reply targets)');
    if (infoLines.length > 0) {
        section = '> ℹ️ **' + infoLines.join('; ') + '.**\n\n' + section;
    }
    return {
        markdown: section,
        counts: {
            total: enriched.length,
            open: openCount,
            resolved: resolvedCount,
            bot: botCount,
            notices: noticeCount
        }
    };
}

/**
 * The pinned rawThreads element shape (gh-799 contract — consumed from
 * pr_discussions_raw.json): rootCommentId is kept ONLY for threads with a
 * file path — the inline reply anchor is meaningless on pathless top-level
 * review comments (the resolve id still allows resolution).
 */
function toRawThread(t, index) {
    return {
        index: index + 1,
        rootCommentId: t.path ? t.rootCommentId : null,
        threadId: t.threadId,
        path: t.path,
        line: t.line,
        resolved: t.resolved,
        bot: t.bot,
        body: t.body
    };
}

/**
 * Build the full thread inventory. conversations: the REST conversations
 * export (array, may be empty). graphqlRaw: the RAW
 * github_get_pr_review_threads return (string|array|envelope) — already
 * fetched by the caller (callers keep their own fetch/warn logging).
 *
 * Returns:
 *   threads         — rawThread-shaped list (legacy field set, see above)
 *   enriched        — internal enriched list (author/date/replies), same order
 *   markdownSection — the '## Review Threads' section incl. exclusion note
 *   counts          — {total, open, resolved, bot, notices}
 *   census          — {source: 'graphql'|'conversations', graphqlTotal,
 *                     graphqlUnresolved} — graphqlUnresolved is the number
 *                     the SM arm rule counts (null on the legacy path)
 */
function collectThreadInventory(conversations, graphqlRaw) {
    var convs = Array.isArray(conversations) ? conversations : [];
    var nodes = parseGraphQLNodes(graphqlRaw);
    var inv = (nodes.length > 0)
        ? buildFromGraphQL(nodes, convs)
        : buildFromConversations(convs, nodes);
    var rendered = renderThreadsMarkdown(inv.enriched, inv.noticeCount);
    return {
        threads: inv.enriched.map(toRawThread),
        enriched: inv.enriched,
        markdownSection: rendered.markdown,
        counts: rendered.counts,
        census: {
            source: inv.source,
            graphqlTotal: inv.graphqlTotal,
            graphqlUnresolved: inv.graphqlUnresolved
        }
    };
}

module.exports = {
    parseGraphQLNodes: parseGraphQLNodes,
    conversationRootId: conversationRootId,
    buildFromGraphQL: buildFromGraphQL,
    buildFromConversations: buildFromConversations,
    renderThreadsMarkdown: renderThreadsMarkdown,
    collectThreadInventory: collectThreadInventory
};
