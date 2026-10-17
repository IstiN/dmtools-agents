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
 * Walk a fixed key path down a (possibly nested) envelope; null-safe at
 * every level. Returns the node's array when the holder carries one.
 */
function envelopeNodesAt(path, data) {
    var cur = data;
    for (var i = 0; i < path.length; i++) {
        cur = cur ? cur[path[i]] : null;
    }
    if (Array.isArray(cur)) return cur;
    return cur && Array.isArray(cur.nodes) ? cur.nodes : null;
}

/**
 * The two accepted envelope shapes: the full GraphQL response
 * (data.repository.pullRequest.reviewThreads.nodes) and the short
 * ({nodes:[...]}) envelope.
 */
function envelopeReviewThreads(data) {
    return envelopeNodesAt(['data', 'repository', 'pullRequest', 'reviewThreads'], data) ||
        envelopeNodesAt(['nodes'], data) || [];
}

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
    return envelopeReviewThreads(data);
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
 * REST conversation root author login: user.login (GitHub export) or
 * author.login/name (other exports) — '' when the conversation names no one.
 */
function conversationAuthorLogin(convRoot) {
    var u = convRoot.user || convRoot.author || null;
    return u ? (u.login || u.name || '') : '';
}

/**
 * The author of a GraphQL thread: the first comment's author wins; the
 * matched conversation root is the fallback (the dmtools export may omit
 * fields on the GraphQL payload).
 */
function nodeAuthor(first, convRoot) {
    if (first.author && (first.author.login || first.author.name)) {
        return first.author.login || first.author.name;
    }
    return conversationAuthorLogin(convRoot);
}

/**
 * The diff position: the node's own line wins (0 is a valid position);
 * the conversation's line/original_line is the fallback; null when neither
 * side carries one.
 */
function resolveNodeLine(node, conversation) {
    if (node.line === 0 || node.line) return node.line;
    if (!conversation) return null;
    return conversation.line || conversation.original_line || null;
}

/**
 * The identity fields of an internal thread straight from the GraphQL node
 * (ids, path, resolved). The RESOLVED flag is GraphQL truth only — the arm
 * rule counts isResolved, so the inventory must never disagree.
 */
function threadIdentityFromNode(node, conversation) {
    var first = (node.comments && node.comments.nodes && node.comments.nodes[0]) || {};
    return {
        rootCommentId: first.databaseId || null,
        threadId: node.id || null,
        path: node.path || (conversation && conversation.path) || null,
        line: resolveNodeLine(node, conversation),
        resolved: node.isResolved === true
    };
}

/**
 * Fill the presentation fields (bot/body/author/date/replies) from the
 * GraphQL first comment and the matched conversation.
 */
function enrichThreadFromConversation(t, node, conversation) {
    var first = (node.comments && node.comments.nodes && node.comments.nodes[0]) || {};
    var convRoot = conversation ? (conversation.rootComment || conversation) : {};
    var author = nodeAuthor(first, convRoot);
    t.bot = machineNotice.isBotAuthor(author);
    t.body = String(first.body || convRoot.body || '').trim();
    t.author = author || 'unknown';
    t.date = convRoot.created_at ? String(convRoot.created_at).substring(0, 10) : '';
    t.replies = (conversation && Array.isArray(conversation.replies)) ? conversation.replies : [];
    return t;
}

/**
 * Map one GraphQL reviewThread node to the enriched internal thread shape
 * ({rootCommentId, threadId, path, line, resolved, bot, body, author, date,
 * replies}), filling body/author/path/line/replies from the matched
 * conversation when the node's first comment does not carry them.
 */
function threadFromGraphQLNode(node, conversation) {
    return enrichThreadFromConversation(
        threadIdentityFromNode(node, conversation), node, conversation);
}

/**
 * The conversation matching one GraphQL node: joined on the first comment's
 * databaseId. Returns {conv, dbId} (both null when the node carries no
 * databaseId — such threads keep their GraphQL-only shape).
 */
function matchConversationForNode(node, convById) {
    var first = (node.comments && node.comments.nodes && node.comments.nodes[0]) || {};
    if (first.databaseId === null || first.databaseId === undefined) {
        return { conv: null, dbId: null };
    }
    var dbId = String(first.databaseId);
    return { conv: convById[dbId] || null, dbId: dbId };
}

/**
 * Conversation-only machine notices — the gh-808 corpus shape: counted for
 * the exclusion note but never enumerated (they are not GraphQL review
 * threads; the arm rule does not count them either).
 */
function countConversationOnlyNotices(conversations, matchedConvIds) {
    var noticeCount = 0;
    (conversations || []).forEach(function(c) {
        var id = conversationRootId(c);
        if (id !== null && id !== undefined && matchedConvIds[String(id)]) return;
        var root = c.rootComment || c;
        if (machineNotice.isMachineNoticeBody(String(root.body || '').trim())) noticeCount++;
    });
    return noticeCount;
}

/**
 * The arm-rule census: how many GraphQL reviewThreads are unresolved — the
 * SAME number the SM arm rule counts.
 */
function countUnresolvedNodes(nodes) {
    var unresolved = 0;
    nodes.forEach(function(n) { if (n && n.isResolved !== true) unresolved++; });
    return unresolved;
}

/**
 * GraphQL-first inventory (gh-957): enumerate the SAME census the SM arm
 * rule counts. Notice threads (enriched body matches a harness marker) are
 * dropped and counted.
 */
function buildFromGraphQL(nodes, conversations) {
    var convById = indexConversations(conversations);
    var enriched = [];
    var noticeCount = 0;
    var matchedConvIds = {};
    nodes.forEach(function(node) {
        if (!node) return;
        var match = matchConversationForNode(node, convById);
        if (match.dbId !== null && match.conv) matchedConvIds[match.dbId] = true;
        var t = threadFromGraphQLNode(node, match.conv);
        if (machineNotice.isMachineNoticeBody(t.body)) {
            noticeCount++;
            return;
        }
        enriched.push(t);
    });
    noticeCount += countConversationOnlyNotices(conversations, matchedConvIds);
    return {
        enriched: enriched,
        noticeCount: noticeCount,
        source: 'graphql',
        graphqlTotal: nodes.length,
        graphqlUnresolved: countUnresolvedNodes(nodes)
    };
}

/**
 * Index the GraphQL nodes by first-comment databaseId — the join keys for
 * the legacy path's threadId/resolved enrichment.
 */
function indexGraphqlByCommentId(nodes) {
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
    return { threadIdByCommentId: threadIdByCommentId, resolvedByCommentId: resolvedByCommentId };
}

/**
 * The REST root author login (user.login or author.login) — '' when unnamed.
 */
function conversationAuthor(root) {
    if (root.user) return root.user.login || '';
    return root.author ? (root.author.login || '') : '';
}

/**
 * Map one REST conversation to the internal thread shape, enriching
 * threadId/resolved from the GraphQL index (matched by root comment id).
 */
function threadFromConversation(thread, idIndex) {
    var root = thread.rootComment || thread;
    var body = String(root.body || '').trim();
    var rootId = conversationRootId(thread);
    var hasRootId = rootId !== null && rootId !== undefined;
    var author = conversationAuthor(root);
    return {
        rootCommentId: rootId,
        threadId: hasRootId ? (idIndex.threadIdByCommentId[String(rootId)] || null) : null,
        path: thread.path || null,
        line: thread.line || thread.original_line || null,
        resolved: thread.resolved === true || thread.isResolved === true ||
            (hasRootId && idIndex.resolvedByCommentId[String(rootId)] === true),
        bot: machineNotice.isBotAuthor(author),
        body: body,
        author: author || 'unknown',
        date: root.created_at ? String(root.created_at).substring(0, 10) : '',
        replies: Array.isArray(thread.replies) ? thread.replies : []
    };
}

/**
 * Legacy conversation-first inventory (pre-gh-957 behavior, preserved for
 * the fallback path): enumerate the conversations export, resolve status
 * from REST flags enriched with GraphQL isResolved, threadId from the
 * GraphQL node id matched by first-comment databaseId.
 */
function buildFromConversations(conversations, nodes) {
    var idIndex = indexGraphqlByCommentId(nodes);
    var enriched = [];
    var noticeCount = 0;
    (conversations || []).forEach(function(thread) {
        var root = thread.rootComment || thread;
        if (machineNotice.isMachineNoticeBody(String(root.body || '').trim())) {
            noticeCount++;
            return;
        }
        enriched.push(threadFromConversation(thread, idIndex));
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
 * Render one reply line of a thread block ('> **author** (date): body').
 */
function renderReplyLine(reply) {
    var rAuthor = reply.user ? reply.user.login : 'unknown';
    var rDate = reply.created_at ? reply.created_at.substring(0, 10) : '';
    return '> **' + rAuthor + '** (' + rDate + '): ' + String(reply.body || '').trim() + '\n\n';
}

/**
 * Render one open thread block: heading with location, the root comment,
 * the replies, and the trailing rule.
 */
function renderThreadBlock(t, idx) {
    var section = '### Thread ' + (idx + 1);
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
        section += renderReplyLine(reply);
    });
    return section + '---\n\n';
}

/**
 * The exclusion summary note (gh-808): resolved/bot/notice counts that did
 * NOT make the readable section. Returns null when nothing was excluded.
 */
function buildExclusionNote(counts, noticeCount) {
    var infoLines = [];
    if (counts.resolved > 0) infoLines.push(counts.resolved + ' resolved thread(s) excluded');
    if (counts.bot > 0) infoLines.push(counts.bot + ' bot-generated thread(s) excluded (informational only)');
    if (noticeCount > 0) infoLines.push(noticeCount + ' machine notice(s) excluded (arming/status boilerplate — never reply targets)');
    if (infoLines.length === 0) return null;
    return '> ℹ️ **' + infoLines.join('; ') + '.**\n\n';
}

/**
 * Count the excluded categories of the enriched inventory: resolved threads,
 * bot-authored open threads, and the open actionable remainder.
 */
function countExcludedCategories(enriched) {
    var resolvedCount = 0;
    var botCount = 0;
    (enriched || []).forEach(function(t) {
        if (t.resolved) resolvedCount++;
        else if (t.bot) botCount++;
    });
    return { resolved: resolvedCount, bot: botCount };
}

/**
 * Render the '## Review Threads (Inline Comments)' markdown section from
 * the enriched inventory: every open non-bot thread with body and replies,
 * prefixed by the exclusion summary note (gh-808). Resolved/bot threads are
 * excluded from the readable section but counted in the note.
 */
function renderThreadsMarkdown(enriched, noticeCount) {
    var section = '## Review Threads (Inline Comments)\n\n';
    (enriched || []).forEach(function(t, idx) {
        if (t.resolved || t.bot) return;
        section += renderThreadBlock(t, idx);
    });
    var excluded = countExcludedCategories(enriched);
    var openCount = (enriched || []).length - excluded.resolved - excluded.bot;
    var note = buildExclusionNote(excluded, noticeCount);
    if (note) section = note + section;
    return {
        markdown: section,
        counts: {
            total: (enriched || []).length,
            open: openCount,
            resolved: excluded.resolved,
            bot: excluded.bot,
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
