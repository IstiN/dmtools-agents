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

var DEFAULT_REPLIES_FILE = 'outputs/confluence_replies.json';
var COMMENTS_BASE_NAME = 'confluence_output_comments';

// ── Config resolution ────────────────────────────────────────────────────────

function mergeObjects(base, override) {
    var result = {};
    var key;
    for (key in (base || {})) {
        if (Object.prototype.hasOwnProperty.call(base, key)) result[key] = base[key];
    }
    for (key in (override || {})) {
        // undefined means "not set" — it must not shadow a base/default value
        if (Object.prototype.hasOwnProperty.call(override, key) && override[key] !== undefined) {
            result[key] = override[key];
        }
    }
    return result;
}

function resolveConfig(params, defaults) {
    var customParams = (params && params.customParams) ||
        (params && params.jobParams && params.jobParams.customParams) || {};
    var fromCustom = customParams.contentOutput || {};

    var fromProject = {};
    try {
        var loader = configLoader || require('../configLoader.js');
        var projectConfig = loader.loadProjectConfig((params && params.jobParams) || params || {});
        fromProject = (projectConfig && projectConfig.contentOutput) || {};
    } catch (e) {
        // config loading is best-effort here; callers usually pass jobParams
    }

    // Priority (low → high): built-in defaults < caller defaults < project config < customParams
    var cfg = {
        target: 'jira_field',
        operationType: 'replace',
        updateTrackerField: true,
        space: '',
        parentPageId: '',
        pageTitleSuffix: '',
        deleteOrphans: false,
        includeInlineComments: true
    };
    cfg = mergeObjects(cfg, defaults);
    cfg = mergeObjects(cfg, fromProject);
    cfg = mergeObjects(cfg, fromCustom);
    return cfg;
}

function isConfluenceTarget(cfg) {
    return cfg.target === 'confluence' || cfg.target === 'both';
}

function isJiraFieldTarget(cfg) {
    return cfg.target === 'jira_field' || cfg.target === 'both';
}

// ── Jira field write ─────────────────────────────────────────────────────────

/**
 * Write content to a tracker field. Supports replace (default) and append
 * modes. Append reads the current field value; ADF values (Jira v3) cannot be
 * merged with wiki markup and fall back to replace.
 */
function writeToTrackerField(ticketKey, field, content, operationType) {
    var valueToWrite = content;
    if (operationType === 'append') {
        var existing = '';
        try {
            var freshTicket = jira_get_ticket({ key: ticketKey, fields: [field] });
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
    jira_update_field({ key: ticketKey, field: field, value: valueToWrite });
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

function resolvePageUrl(page) {
    var direct = buildPageUrl(page);
    if (direct) return direct;
    try {
        var fresh = confluence_content_by_id({ contentId: page.id });
        return buildPageUrl(fresh);
    } catch (e) {
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

    // Publish the Markdown body through the sync tool (proper storage conversion)
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

// ── Inline comments ──────────────────────────────────────────────────────────

function extractCommentBody(comment) {
    if (!comment) return '';
    var body = comment.body;
    if (typeof body === 'string') return body;
    if (body && body.storage && typeof body.storage.value === 'string') return body.storage.value;
    if (body && body.atlas_doc_format && typeof body.atlas_doc_format.value === 'string') return body.atlas_doc_format.value;
    if (body && body.view && typeof body.view.value === 'string') return body.view.value;
    return JSON.stringify(body);
}

function fetchPageInlineComments(pageId, pageTitle, limit) {
    var comments = [];
    try {
        var raw = confluence_get_page_inline_comments({ pageId: String(pageId), limit: limit || 100 });
        var parsed = JSON.parse(raw || '{}');
        var results = parsed.results || parsed.comments || (Array.isArray(parsed) ? parsed : []);
        for (var i = 0; i < results.length; i++) {
            var c = results[i];
            comments.push({
                pageId: String(pageId),
                pageTitle: pageTitle || 'untitled',
                commentId: c.id || null,
                parentCommentId: c.parentCommentId || c.parentId || null,
                author: (c.author && (c.author.displayName || c.author.emailAddress)) || 'Unknown',
                created: c.createdDate || (c.version && c.version.createdAt) || c.created || '',
                resolved: c.resolutionStatus === 'resolved' || c.resolutionStatus === 'closed' ||
                    !!(c.resolvedDate || c.resolved || c.status === 'resolved' || c.status === 'closed'),
                body: extractCommentBody(c)
            });
        }
    } catch (e) {
        console.warn('contentOutput: failed to fetch inline comments for page ' + pageId + ':', e);
    }
    return comments;
}

function writeCommentsFiles(folder, comments, baseName) {
    var name = baseName || COMMENTS_BASE_NAME;
    try {
        file_write(folder + '/' + name + '.json', JSON.stringify({ comments: comments }, null, 2));
    } catch (e) {
        console.warn('contentOutput: failed to write ' + name + '.json:', e);
    }
    try {
        var lines = ['# Inline comments\n'];
        if (!comments || comments.length === 0) {
            lines.push('\n_No inline comments found._');
        } else {
            lines.push('\nTotal comments: ' + comments.length + '\n');
            for (var i = 0; i < comments.length; i++) {
                var c = comments[i];
                lines.push('## Comment ' + (c.commentId || 'unknown') + ' on page "' + (c.pageTitle || 'untitled') + '" (pageId: ' + (c.pageId || 'unknown') + ')');
                lines.push('- **Author:** ' + (c.author || 'Unknown'));
                lines.push('- **Created:** ' + (c.created || ''));
                lines.push('- **Resolved:** ' + (c.resolved ? 'yes' : 'no'));
                if (c.parentCommentId) lines.push('- **Parent comment:** ' + c.parentCommentId);
                lines.push('\n' + (c.body || ''));
                lines.push('\n---\n');
            }
        }
        file_write(folder + '/' + name + '.md', lines.join('\n'));
    } catch (e) {
        console.warn('contentOutput: failed to write ' + name + '.md:', e);
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
        var raw = file_read(repliesFilePath || DEFAULT_REPLIES_FILE);
        if (raw && raw.trim()) {
            var parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) replies = parsed;
            else if (parsed && Array.isArray(parsed.replies)) replies = parsed.replies;
        }
    } catch (e) {
        return { posted: 0, failed: 0 };
    }
    for (var i = 0; i < replies.length; i++) {
        var r = replies[i];
        if (!r || !r.pageId || !r.commentId || !r.body) {
            failed += 1;
            continue;
        }
        try {
            confluence_reply_to_inline_comment({
                pageId: String(r.pageId),
                commentId: String(r.commentId),
                body: String(r.body)
            });
            posted += 1;
        } catch (e) {
            failed += 1;
            console.warn('contentOutput: failed to reply to comment ' + r.commentId + ':', e);
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
        resolvePageUrl: resolvePageUrl,
        sanitizeFileName: sanitizeFileName,
        fetchPageInlineComments: fetchPageInlineComments,
        writeCommentsFiles: writeCommentsFiles,
        publishCommentReplies: publishCommentReplies,
        extractCommentBody: extractCommentBody,
        COMMENTS_BASE_NAME: COMMENTS_BASE_NAME,
        DEFAULT_REPLIES_FILE: DEFAULT_REPLIES_FILE
    };
}
