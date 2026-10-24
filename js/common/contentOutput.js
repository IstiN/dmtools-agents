/**
 * Content Output — shared library for routing agent-generated content
 * (solution / description / acceptance criteria) to a Jira field and/or a
 * Confluence page, with Confluence inline-comment support.
 *
 * Used by:
 *   - js/writeContentOutput.js            (post-action for story_description,
 *                                          story_acceptance_criteria, …)
 *   - js/fetchConfluenceOutputContext.js  (pre-action: snapshot existing page
 *                                          + inline comments into input/)
 *   - js/writeSolutionAndDiagrams.js      (story_solution; Confluence target)
 *
 * Configuration (customParams.contentOutput in the agent JSON, or
 * projectConfig.contentOutput in .dmtools/config.js; customParams win):
 *
 *   contentOutput: {
 *     target: 'jira_field',     // 'jira_field' (default) | 'confluence' | 'both'
 *     field: 'Description',     // tracker field for jira_field target
 *     operationType: 'replace', // 'replace' (default) | 'append'
 *     updateTrackerField: true, // for confluence/both: write a link (or the
 *                               // content) into the tracker field too
 *     space: '',                // Confluence space key (required for confluence target)
 *     parentPageId: '',         // parent page the ticket page nests under
 *     pageTitleSuffix: '',      // e.g. 'Solution Design' → page title
 *                               // '{ticketKey} {summary} — Solution Design'
 *     deleteOrphans: false,     // passed to confluence_sync_markdown_directory
 *     includeInlineComments: true
 *   }
 */

var configLoader = null;
try { configLoader = require('../configLoader.js'); } catch (e) { /* unit tests inject their own */ }

// gh-823: load-time require — a deferred (in-function) require resolves
// against the pack's js/ root only at runtime ("Failed to require module:
// ./trackers.js"); load-time requires resolve file-relative and dmtools
// compile discovers them for the pack closure.
var trackersModule = require('./trackers.js');
var mergeObjectsShared = require('./mergeObjects.js');

var DEFAULT_REPLIES_FILE = 'outputs/confluence_replies.json';
var COMMENTS_BASE_NAME = 'confluence_output_comments';

// ── Config resolution ────────────────────────────────────────────────────────

// gh-1250: single shared copy of the shallow-merge loop (was duplicated in
// fetchParentContextToInput.js). Here an explicit `undefined` override value
// must not shadow a base/default value.
function mergeObjects(base, override) {
    return mergeObjectsShared.mergeObjects(base, override, true);
}

// ── gh-1224: resolveConfig decomposed into small pure helpers ────────────────

/** customParams of a params bag: top-level first, then jobParams.customParams. */
function customParamsOf(params) {
    return (params && params.customParams) ||
        (params && params.jobParams && params.jobParams.customParams) || {};
}

/** The contentOutput section of the params' customParams ({} when absent). */
function contentOutputCustomParams(params) {
    return customParamsOf(params).contentOutput || {};
}

/**
 * The project-config contentOutput section. Config loading is best-effort
 * here; callers usually pass jobParams.
 */
function projectContentOutput(params) {
    try {
        var loader = configLoader;
        var projectConfig = loader.loadProjectConfig((params && params.jobParams) || params || {});
        return (projectConfig && projectConfig.contentOutput) || {};
    } catch (e) {
        return {};
    }
}

/** Built-in contentOutput defaults (lowest priority layer). */
function builtInContentOutputConfig() {
    return {
        target: 'jira_field',
        operationType: 'replace',
        updateTrackerField: true,
        space: '',
        parentPageId: '',
        pageTitleSuffix: '',
        deleteOrphans: false,
        includeInlineComments: true
    };
}

function resolveConfig(params, defaults) {
    // Priority (low → high): built-in defaults < caller defaults < project config < customParams
    var cfg = mergeObjects(builtInContentOutputConfig(), defaults);
    cfg = mergeObjects(cfg, projectContentOutput(params));
    cfg = mergeObjects(cfg, contentOutputCustomParams(params));
    return cfg;
}

// gh-1112: 'wiki' is a provider-neutral alias of 'confluence' (a future wiki
// backend behind publishPage keeps child agent configs stable) and
// 'tracker_field' is the neutral alias of 'jira_field'. 'both' keeps meaning
// "field AND page" regardless of the aliases used.
function isConfluenceTarget(cfg) {
    return cfg.target === 'confluence' || cfg.target === 'wiki' || cfg.target === 'both';
}

function isJiraFieldTarget(cfg) {
    return cfg.target === 'jira_field' || cfg.target === 'tracker_field' || cfg.target === 'both';
}

// ── Jira field write ─────────────────────────────────────────────────────────

function _loadOutputConfig() {
    return configLoader ? configLoader.loadProjectConfig({}) : null;
}

function resolveTrackerConfig(config) {
    return config || _loadOutputConfig();
}

/**
 * Write content to a tracker field. Supports replace (default) and append
 * modes. Append reads the current field value; ADF values (Jira v3) cannot be
 * merged with wiki markup and fall back to replace.
 */
function writeToTrackerField(ticketKey, field, content, operationType, tracker, config) {
    var valueToWrite = content;
    if (!tracker) tracker = trackersModule.createTracker(resolveTrackerConfig(config), {});
    if (operationType === 'append') {
        var existing = '';
        try {
            var freshTicket = tracker.getIssue(ticketKey, [field]);
            var freshFields = (freshTicket && freshTicket.fields) ? freshTicket.fields : freshTicket;
            var rawValue = freshFields ? freshFields[field] : null;
            if (rawValue && typeof rawValue === 'object') {
                console.warn('Existing value of "' + field + '" is in ADF format. Cannot merge — falling back to replace.');
                rawValue = '';
            }
            existing = (rawValue || '').toString().trim();
        } catch (e) {
            console.warn('Could not read existing value of "' + field + '", appending without prefix:', e);
        }
        valueToWrite = existing ? existing + '\n\n----\n\n' + content : content;
    }
    tracker.updateField(ticketKey, field, valueToWrite);
    return { field: field, operationType: operationType, length: valueToWrite.length };
}

// ── Confluence publish ───────────────────────────────────────────────────────

function sanitizeFileName(title) {
    return String(title || 'untitled').replace(/[\\/:*?"<>|]/g, '-').trim();
}

function findTicketPage(children, ticketKey) {
    if (!children || !Array.isArray(children)) return null;
    for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c && c.title && c.title.indexOf(ticketKey) === 0) {
            return c;
        }
    }
    return null;
}

function buildPageTitle(cfg, ticketKey, summary) {
    var base = summary ? (ticketKey + ' ' + summary) : ticketKey;
    return cfg.pageTitleSuffix ? base + ' — ' + cfg.pageTitleSuffix : base;
}

function buildPageUrl(page) {
    if (!page || !page._links) return null;
    var webui = page._links.webui;
    if (!webui) return null;
    var base = page._links.base;
    if (!base) return null;
    return base + webui;
}

function resolvePageUrl(page, options) {
    var direct = buildPageUrl(page);
    if (direct) return direct;
    try {
        var fresh = confluence_content_by_id({ contentId: page.id });
        return buildPageUrl(fresh);
    } catch (e) {
        // gh-1250: publishDiscoveryToConfluence passes { warnOnFailure: true }
        // to keep its historical console.warn here; other callers stay silent.
        if (options && options.warnOnFailure) {
            console.warn('resolvePageUrl: follow-up confluence_content_by_id lookup failed:', e);
        }
        return null;
    }
}

/**
 * Find-or-create the ticket's page under cfg.parentPageId and publish
 * `content` (Markdown) as the page body via confluence_sync_markdown_directory,
 * so Markdown is properly converted to Confluence storage format.
 * Returns { page, url, created }.
 */
function publishPage(cfg, ticketKey, summary, content) {
    if (!cfg.space || !cfg.parentPageId) {
        throw new Error('contentOutput.space / contentOutput.parentPageId are not configured');
    }
    var pageTitle = buildPageTitle(cfg, ticketKey, summary);

    var children = confluence_get_children_by_id({ contentId: cfg.parentPageId, format: 'md' });
    var page = findTicketPage(children, ticketKey);
    var created = false;

    if (!page) {
        console.log('No existing page for ' + ticketKey + ' — creating "' + pageTitle + '"');
        page = confluence_create_page({
            title: pageTitle,
            parentId: cfg.parentPageId,
            body: '<p>Content is synced from the agent output.</p>',
            space: cfg.space
        });
        created = true;
    } else if (page.title !== pageTitle) {
        page = confluence_update_page({
            contentId: page.id,
            title: pageTitle,
            parentId: cfg.parentPageId,
            body: (page.body && page.body.storage && page.body.storage.value) || '<p></p>',
            space: cfg.space
        });
    }

    // Publish the Markdown body through the sync tool (proper storage conversion).
    // Since dmtools v1.7.249 the sync preserves inline comment anchors natively:
    // [[ic:REF]]...[[/ic]] placeholders in the Markdown become real
    // ac:inline-comment-marker elements, and anchors present in the old page body
    // are re-applied by anchored-text match (preserveInlineComments, default true).
    var syncDir = 'outputs/confluence_sync_' + ticketKey;
    file_write(syncDir + '/index.md', content);
    confluence_sync_markdown_directory({
        directory: syncDir,
        parentId: String(page.id),
        space: cfg.space,
        deleteOrphans: false
    });

    return { page: page, url: resolvePageUrl(page), created: created };
}

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── Inline comment anchors ───────────────────────────────────────────────────
//
// Inline comments anchor to page text via <ac:inline-comment-marker ac:ref="GUID">
// elements in the storage body. Any body update that drops these elements orphans
// the comments (they stay in the API but disappear from the page UI).
//
// Preservation strategy:
//   1. Pre-CLI (fetchConfluenceOutputContext) rewrites markers found in the current
//      page into `[[ic:GUID]]anchor text[[/ic]]` placeholders inside
//      input/confluence_output_current.md, and the agent is instructed
//      (instructions/common/confluence_comments.md) to keep them around the same or
//      equivalent text in its Markdown output.
//   2. The dmtools Confluence Markdown sync (preserveInlineComments, default true
//      since dmtools v1.7.249) converts placeholders back into real markers and
//      additionally re-applies old markers by anchored-text match when the
//      placeholder was lost.
//
// extractInlineCommentMarkers / injectCommentPlaceholders below are shared with the
// pre-CLI side; the post-sync conversion lives in the dmtools CLI.

var IC_OPEN_TAG = '[[ic:';
var IC_CLOSE_TAG = '[[/ic]]';

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract inline comment anchors from a Confluence storage-format body.
 * Returns [{ ref: '<marker guid>', text: '<anchored text>' }].
 */
function extractInlineCommentMarkers(storageBody) {
    var anchors = [];
    if (!storageBody) return anchors;
    var re = /<ac:inline-comment-marker\s+ac:ref="([^"]+)"[^>]*>([\s\S]*?)<\/ac:inline-comment-marker>/g;
    var m;
    while ((m = re.exec(storageBody)) !== null) {
        // Strip any nested tags from the anchored text — anchors are plain text
        var text = m[2].replace(/<[^>]+>/g, '');
        if (m[1] && text.trim()) {
            anchors.push({ ref: m[1], text: text });
        }
    }
    return anchors;
}

/**
 * Wrap the first occurrence of each anchor's text in the Markdown content with
 * [[ic:REF]]...[[/ic]] placeholders. Anchors already present as placeholders are
 * skipped. Anchors whose text is not found are skipped (reported in .missed).
 * Returns { content, injected: [refs], missed: [refs] }.
 */
function injectCommentPlaceholders(markdown, anchors) {
    var result = { content: markdown || '', injected: [], missed: [] };
    (anchors || []).forEach(function(anchor) {
        if (!anchor || !anchor.ref || !anchor.text) return;
        if (result.content.indexOf(IC_OPEN_TAG + anchor.ref + ']]') !== -1) return;
        var idx = result.content.indexOf(anchor.text);
        if (idx === -1) {
            result.missed.push(anchor.ref);
            return;
        }
        result.content = result.content.substring(0, idx) +
            IC_OPEN_TAG + anchor.ref + ']]' + anchor.text + IC_CLOSE_TAG +
            result.content.substring(idx + anchor.text.length);
        result.injected.push(anchor.ref);
    });
    return result;
}



/**
 * Fetch a page's storage-format body (confluence_content_by_id) and re-expose
 * its inline comment anchors as [[ic:REF]]...[[/ic]] placeholders inside
 * `body` — the shared core of fetchConfluenceOutputContext.js's and
 * prepareDiscoveryContext.js's anchor re-injection (gh-1250). Throws when the
 * storage lookup fails (callers wrap); returns null when the page carries no
 * anchors (callers keep the body unchanged), otherwise the
 * injectCommentPlaceholders result.
 */
function injectPageCommentAnchors(body, pageId) {
    var storage = confluence_content_by_id({ contentId: pageId });
    var storageBody = storage && storage.body && storage.body.storage && storage.body.storage.value;
    var anchors = extractInlineCommentMarkers(storageBody);
    if (anchors.length === 0) return null;
    return injectCommentPlaceholders(body, anchors);
}

// Inline comment body representations, checked in order: v2 storage, ADR
// document, v1 view. The first representation carrying a string value wins.
var COMMENT_BODY_REPRESENTATIONS = ['storage', 'atlas_doc_format', 'view'];

/**
 * First structured string body among the known representations, or null.
 * Pure helper (gh-1086 extraction from extractCommentBody).
 */
function extractStructuredCommentBody(body) {
    if (!body) return null;
    for (var i = 0; i < COMMENT_BODY_REPRESENTATIONS.length; i++) {
        var repr = body[COMMENT_BODY_REPRESENTATIONS[i]];
        if (repr && typeof repr.value === 'string') return repr.value;
    }
    return null;
}

function extractCommentBody(comment) {
    if (!comment) return '';
    var body = comment.body;
    if (typeof body === 'string') return body;
    var structured = extractStructuredCommentBody(body);
    if (structured !== null) return structured;
    return JSON.stringify(body);
}

// Pure mappers for one inline comment payload entry (gh-1086 extraction from
// fetchPageInlineComments).

function parseInlineCommentResults(parsed) {
    return parsed.results || parsed.comments || (Array.isArray(parsed) ? parsed : []);
}

function inlineCommentAuthor(c) {
    return (c.author && (c.author.displayName || c.author.emailAddress)) || 'Unknown';
}

function inlineCommentCreated(c) {
    return c.createdDate || (c.version && c.version.createdAt) || c.created || '';
}

function inlineCommentResolved(c) {
    var statusActive = c.resolutionStatus === 'resolved' || c.resolutionStatus === 'closed';
    var markerPresent = !!(c.resolvedDate || c.resolved || c.status === 'resolved' || c.status === 'closed');
    return statusActive || markerPresent;
}

function inlineMarkerRef(props, inlineProps) {
    return props.inlineMarkerRef || props['inline-marker-ref'] || inlineProps.markerRef || null;
}

function inlineOriginalSelection(props, inlineProps) {
    return props.inlineOriginalSelection || props['inline-original-selection'] || inlineProps.originalSelection || null;
}

function mapInlineComment(pageId, pageTitle, c) {
    var props = c.properties || {};
    // Anchor info for inline comment preservation across page rewrites.
    // v2 API exposes it under properties (camelCase and dash-case variants),
    // v1 under extensions.inlineProperties.
    var inlineProps = (c.extensions && c.extensions.inlineProperties) || {};
    return {
        pageId: String(pageId),
        pageTitle: pageTitle || 'untitled',
        commentId: c.id || null,
        parentCommentId: c.parentCommentId || c.parentId || null,
        author: inlineCommentAuthor(c),
        created: inlineCommentCreated(c),
        resolved: inlineCommentResolved(c),
        markerRef: inlineMarkerRef(props, inlineProps),
        originalSelection: inlineOriginalSelection(props, inlineProps),
        body: extractCommentBody(c)
    };
}

function fetchPageInlineComments(pageId, pageTitle, limit) {
    var comments = [];
    try {
        var raw = confluence_get_page_inline_comments({ pageId: String(pageId), limit: limit || 100 });
        var parsed = JSON.parse(raw || '{}');
        var results = parseInlineCommentResults(parsed);
        for (var i = 0; i < results.length; i++) {
            comments.push(mapInlineComment(pageId, pageTitle, results[i]));
        }
    } catch (e) {
        console.warn('contentOutput: failed to fetch inline comments for page ' + pageId + ':', e);
    }
    return comments;
}

// ── gh-1224: writeCommentsFiles decomposed into small pure helpers ───────────

/** Markdown fallback for a missing comment field ('' renders as the falsy arm). */
function orMd(value, fallback) {
    return value || fallback;
}

/** The `## Comment ...` heading of one inline comment entry. */
function commentMdHeading(c) {
    return '## Comment ' + orMd(c.commentId, 'unknown') +
        ' on page "' + orMd(c.pageTitle, 'untitled') +
        '" (pageId: ' + orMd(c.pageId, 'unknown') + ')';
}

/** Markdown lines of one inline comment entry (heading, fields, body, separator). */
function commentMdLines(c) {
    var lines = [
        commentMdHeading(c),
        '- **Author:** ' + orMd(c.author, 'Unknown'),
        '- **Created:** ' + orMd(c.created, ''),
        '- **Resolved:** ' + (c.resolved ? 'yes' : 'no')
    ];
    if (c.parentCommentId) lines.push('- **Parent comment:** ' + c.parentCommentId);
    lines.push('\n' + orMd(c.body, ''));
    lines.push('\n---\n');
    return lines;
}

/** The full markdown digest of the inline comments (placeholder when empty). */
function buildInlineCommentsMd(comments) {
    var lines = ['# Inline comments\n'];
    if (!comments || comments.length === 0) {
        lines.push('\n_No inline comments found._');
    } else {
        lines.push('\nTotal comments: ' + comments.length + '\n');
        for (var i = 0; i < comments.length; i++) {
            lines = lines.concat(commentMdLines(comments[i]));
        }
    }
    return lines.join('\n');
}

function writeCommentsFiles(folder, comments, baseName) {
    var name = baseName || COMMENTS_BASE_NAME;
    try {
        file_write(folder + '/' + name + '.json', JSON.stringify({ comments: comments }, null, 2));
    } catch (e) {
        console.warn('contentOutput: failed to write ' + name + '.json:', e);
    }
    try {
        file_write(folder + '/' + name + '.md', buildInlineCommentsMd(comments));
    } catch (e) {
        console.warn('contentOutput: failed to write ' + name + '.md:', e);
    }
}

// ── gh-1224: publishCommentReplies decomposed into small pure helpers ────────

/** Replies payload shapes: a bare array or a { replies: [...] } wrapper. */
function parseRepliesPayload(raw) {
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.replies)) return parsed.replies;
    return [];
}

/**
 * Read + parse the replies file; an absent/blank file yields an empty list.
 * Throws when the file is unreadable or the payload is not valid JSON.
 */
function readRepliesPayload(repliesFilePath) {
    var raw = file_read(repliesFilePath || DEFAULT_REPLIES_FILE);
    if (!raw || !raw.trim()) return [];
    return parseRepliesPayload(raw);
}

/** A reply is postable only with all three coordinates present. */
function isPostableReply(r) {
    return !!(r && r.pageId && r.commentId && r.body);
}

/** One Confluence reply post; failures are counted by the caller, never thrown. */
function postReplyToInlineComment(r) {
    try {
        confluence_reply_to_inline_comment({
            pageId: String(r.pageId),
            commentId: String(r.commentId),
            body: String(r.body)
        });
        return true;
    } catch (e) {
        console.warn('contentOutput: failed to reply to comment ' + r.commentId + ':', e);
        return false;
    }
}

/**
 * Read the replies file the CLI agent may have produced and post each reply.
 * Shape: [ { pageId, commentId, body } ] or { replies: [...] }.
 */
function publishCommentReplies(repliesFilePath) {
    var posted = 0;
    var failed = 0;
    var replies = [];
    try {
        replies = readRepliesPayload(repliesFilePath);
    } catch (e) {
        return { posted: 0, failed: 0 };
    }
    for (var i = 0; i < replies.length; i++) {
        if (!isPostableReply(replies[i])) {
            failed += 1;
            continue;
        }
        if (postReplyToInlineComment(replies[i])) {
            posted += 1;
        } else {
            failed += 1;
        }
    }
    return { posted: posted, failed: failed };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        resolveConfig: resolveConfig,
        isConfluenceTarget: isConfluenceTarget,
        isJiraFieldTarget: isJiraFieldTarget,
        writeToTrackerField: writeToTrackerField,
        publishPage: publishPage,
        findTicketPage: findTicketPage,
        buildPageTitle: buildPageTitle,
        buildPageUrl: buildPageUrl,
        resolvePageUrl: resolvePageUrl,
        sanitizeFileName: sanitizeFileName,
        fetchPageInlineComments: fetchPageInlineComments,
        writeCommentsFiles: writeCommentsFiles,
        publishCommentReplies: publishCommentReplies,
        extractCommentBody: extractCommentBody,
        extractStructuredCommentBody: extractStructuredCommentBody,
        parseInlineCommentResults: parseInlineCommentResults,
        mapInlineComment: mapInlineComment,
        extractInlineCommentMarkers: extractInlineCommentMarkers,
        injectCommentPlaceholders: injectCommentPlaceholders,
        injectPageCommentAnchors: injectPageCommentAnchors,
        COMMENTS_BASE_NAME: COMMENTS_BASE_NAME,
        DEFAULT_REPLIES_FILE: DEFAULT_REPLIES_FILE,
        // gh-1224: config / comments-digest / replies pure helpers (test surface)
        customParamsOf: customParamsOf,
        contentOutputCustomParams: contentOutputCustomParams,
        projectContentOutput: projectContentOutput,
        builtInContentOutputConfig: builtInContentOutputConfig,
        orMd: orMd,
        commentMdHeading: commentMdHeading,
        commentMdLines: commentMdLines,
        buildInlineCommentsMd: buildInlineCommentsMd,
        parseRepliesPayload: parseRepliesPayload,
        readRepliesPayload: readRepliesPayload,
        isPostableReply: isPostableReply,
        postReplyToInlineComment: postReplyToInlineComment
    };
}
