/**
 * Prepare Discovery Context — preCliJSAction for the discovery agent.
 *
 * Before the CLI agent runs PM discovery for a Jira ticket, this:
 *  1. Resolves the Confluence space/parent page this ticket's discovery pages
 *     should live under. Project-specific — must be set via .dmtools/config.js
 *     under `discovery.space` / `discovery.parentPageId` (see js/configLoader.js
 *     DEFAULTS.discovery). Left blank by default so this agent stays generic;
 *     no project specifics live in this file.
 *  2. If a Confluence page for this ticket already exists under that parent
 *     (title starting with the ticket key), snapshots its ENTIRE current page
 *     tree — recursively, to any depth, not just direct children — as Markdown
 *     files/folders directly into outputs/discovery/ (the SAME folder the CLI
 *     agent is instructed to write its final output into — see
 *     instructions/discovery/output_rules.md). This means a second/iteration
 *     run starts with the previously published state already sitting in
 *     outputs/discovery/, so the CLI agent edits those files in place instead
 *     of relying on it to notice and copy prior content from a separate
 *     "context" location — the sync step then only ever sees the merged
 *     result, never a stale, half-copied intermediate state.
 *     Recursion matters: a mature discovery tree commonly grows nested
 *     sub-trees (e.g. a topic page that itself has several detail sub-pages)
 *     — seeding only one level would silently drop those nested pages from
 *     the CLI agent's view on the next iteration, and a project with
 *     deleteOrphans enabled would then delete them from Confluence entirely
 *     on publish, even though nothing about them changed.
 *  3. Collects inline comments (annotations) from every page in the existing
 *     discovery tree and writes them to input/discovery_inline_comments.json
 *     and input/discovery_inline_comments.md. The CLI agent can read these
 *     comments as feedback and produce outputs/discovery_replies.json, which
 *     publishDiscoveryToConfluence.js posts back to Confluence.
 *  4. Writes input/discovery_meta.json with the resolved space/parentPageId
 *     and the existing page id (if found) — read by the matching postJSAction
 *     (publishDiscoveryToConfluence.js) so both steps agree on where to publish
 *     without re-resolving config or re-querying Confluence twice.
 */

var configLoader = require('./configLoader.js');

var DISCOVERY_OUTPUT_DIR = 'outputs/discovery';
var COMMENTS_FILE_NAME = 'discovery_inline_comments';
var DEFAULT_COMMENTS_LIMIT = 100;

function sanitizeFileName(title) {
    return String(title || 'untitled').replace(/[\\/:*?"<>|]/g, '-').trim();
}

function mergeObjects(base, override) {
    var result = {};
    var key;
    for (key in (base || {})) {
        if (Object.prototype.hasOwnProperty.call(base, key)) result[key] = base[key];
    }
    for (key in (override || {})) {
        if (Object.prototype.hasOwnProperty.call(override, key)) result[key] = override[key];
    }
    return result;
}

/**
 * Extract a readable string from a comment body returned by Confluence.
 * Handles storage format, atlas_doc_format, plain strings, and fallbacks.
 */
function extractCommentBody(comment) {
    if (!comment) return '';
    var body = comment.body;
    if (typeof body === 'string') return body;
    if (body && body.storage && typeof body.storage.value === 'string') return body.storage.value;
    if (body && body.atlas_doc_format && typeof body.atlas_doc_format.value === 'string') return body.atlas_doc_format.value;
    if (body && body.view && typeof body.view.value === 'string') return body.view.value;
    return JSON.stringify(body);
}

/**
 * Fetch inline comments for every page in pageInfos. Errors are non-fatal.
 */
function fetchInlineComments(pageInfos, folder) {
    var allComments = [];
    var limit = DEFAULT_COMMENTS_LIMIT;
    for (var i = 0; i < pageInfos.length; i++) {
        var info = pageInfos[i];
        try {
            var raw = confluence_get_page_inline_comments({ pageId: String(info.id), limit: limit });
            var parsed = JSON.parse(raw || '{}');
            var comments = parsed.results || parsed.comments || (Array.isArray(parsed) ? parsed : []);
            if (comments.length >= limit) {
                console.warn('prepareDiscoveryContext: inline comments for page ' + info.id + ' may be truncated (limit ' + limit + ')');
            }
            for (var j = 0; j < comments.length; j++) {
                var c = comments[j];
                allComments.push({
                    pageId: info.id,
                    pageTitle: info.title || 'untitled',
                    commentId: c.id || null,
                    parentCommentId: c.parentCommentId || c.parentId || null,
                    author: (c.author && (c.author.displayName || c.author.emailAddress)) || 'Unknown',
                    created: c.createdDate || c.created || '',
                    resolved: !!(c.resolvedDate || c.resolved || c.status === 'resolved' || c.status === 'closed'),
                    body: extractCommentBody(c)
                });
            }
        } catch (e) {
            console.warn('prepareDiscoveryContext: failed to fetch inline comments for page ' + info.id + ':', e);
        }
    }
    return allComments;
}

/**
 * Write collected inline comments to both JSON (machine-readable) and Markdown
 * (human/AI-readable) forms in the input folder.
 */
function writeCommentsFiles(folder, comments) {
    try {
        file_write(folder + '/' + COMMENTS_FILE_NAME + '.json', JSON.stringify({ comments: comments }, null, 2));
    } catch (e) {
        console.warn('prepareDiscoveryContext: failed to write ' + COMMENTS_FILE_NAME + '.json:', e);
    }
    try {
        var lines = ['# Inline comments on discovery pages\n'];
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
        file_write(folder + '/' + COMMENTS_FILE_NAME + '.md', lines.join('\n'));
    } catch (e) {
        console.warn('prepareDiscoveryContext: failed to write ' + COMMENTS_FILE_NAME + '.md:', e);
    }
}

/**
 * Find the child page whose title starts with the ticket key (tickets may be
 * retitled with the summary changing, but the ticket-key prefix stays stable).
 */
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

/**
 * Recursively snapshot an existing discovery page + all of its descendants
 * (any depth) as Markdown files directly into outputs/discovery/ (see module
 * docstring): index.md for a page's own body at each level, one file (or, if
 * it has its own children, one subfolder) per child page named after its
 * title — mirroring exactly the tree shape confluence_sync_markdown_directory
 * itself produces when publishing (see output_rules.md), so a round-trip
 * (publish → seed next run → publish again) is lossless.
 *
 * @param {Object} page - Confluence content object (needs .id)
 * @param {string} targetDir - local directory to write this page's own
 *     index.md into (its children go into named subfolders/files here)
 * @returns {number} total number of descendant pages snapshotted (all depths)
 */
function snapshotPageTree(page, targetDir, pageInfos) {
    var total = 0;
    try {
        var rootMd = confluence_content_by_id({ contentId: page.id, format: 'md' });
        var rootBody = (rootMd && rootMd.body && rootMd.body.storage && rootMd.body.storage.value) || '';
        file_write(targetDir + '/index.md', rootBody || '_(existing page had no body)_');
        if (pageInfos) {
            pageInfos.push({ id: page.id, title: page.title || 'untitled' });
        }

        var children = confluence_get_children_by_id({ contentId: page.id, format: 'md' }) || [];
        children.forEach(function(child) {
            total += 1;
            if (pageInfos) {
                pageInfos.push({ id: child.id, title: child.title || 'untitled' });
            }
            var fileName = sanitizeFileName(child.title);

            var grandchildren;
            try {
                grandchildren = confluence_get_children_by_id({ contentId: child.id, format: 'md' }) || [];
            } catch (e) {
                grandchildren = [];
            }

            if (grandchildren.length > 0) {
                // This child has its own descendants — recurse into a subfolder
                // named after it, matching the sync tool's folder-with-index.md
                // convention for a page that itself has children.
                total += snapshotPageTree(child, targetDir + '/' + fileName, pageInfos);
            } else {
                // Leaf page — a single Markdown file is enough.
                var childBody = (child.body && child.body.storage && child.body.storage.value) || '';
                file_write(targetDir + '/' + fileName + '.md', childBody || '_(existing page had no body)_');
            }
        });

        return total;
    } catch (e) {
        console.warn('prepareDiscoveryContext: failed to snapshot existing page tree at ' + targetDir + ':', e);
        return total;
    }
}

function action(params) {
    var folder = params.inputFolderPath;
    var ticketKey = (params.ticket && params.ticket.key) || (folder ? folder.split('/').pop() : null);

    var meta = {
        ticketKey: ticketKey,
        space: null,
        parentPageId: null,
        existingPageId: null
    };

    try {
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var discoveryConfig = mergeObjects(
            projectConfig.discovery || {},
            (projectConfig.customParams && projectConfig.customParams.discovery) || {}
        );
        meta.space = discoveryConfig.space || null;
        meta.parentPageId = discoveryConfig.parentPageId || null;

        if (!meta.space || !meta.parentPageId) {
            console.warn('discovery.space / discovery.parentPageId are not configured — set them in this project\'s .dmtools/config.js before discovery pages can be published to Confluence. Continuing without prior-state seeding.');
            file_write(folder + '/discovery_meta.json', JSON.stringify(meta, null, 2));
            return { success: true, action: 'not_configured', ticketKey: ticketKey };
        }

        var children;
        try {
            children = confluence_get_children_by_id({ contentId: meta.parentPageId, format: 'md' });
        } catch (e) {
            console.warn('prepareDiscoveryContext: failed to list children of parentPageId', meta.parentPageId, ':', e);
            file_write(folder + '/discovery_meta.json', JSON.stringify(meta, null, 2));
            return { success: false, action: 'children_lookup_failed', ticketKey: ticketKey, error: e.toString() };
        }

        var existing = findTicketPage(children, ticketKey);
        if (!existing) {
            console.log('No existing discovery page found for ' + ticketKey + ' — this will be a first-time discovery run.');
            file_write(folder + '/discovery_meta.json', JSON.stringify(meta, null, 2));
            return { success: true, action: 'first_run', ticketKey: ticketKey };
        }

        meta.existingPageId = existing.id;
        var includeComments = discoveryConfig.includeConfluenceComments !== false;
        console.log('Found existing discovery page for ' + ticketKey + ': ' + existing.id + ' ("' + existing.title + '") — seeding ' + DISCOVERY_OUTPUT_DIR + ' with its current content (full tree, recursively) for in-place editing. Inline comments enabled: ' + includeComments);
        var pageInfos = [];
        var snapshotted = snapshotPageTree(existing, DISCOVERY_OUTPUT_DIR, pageInfos);

        if (includeComments && pageInfos.length > 0) {
            var comments = fetchInlineComments(pageInfos, folder);
            writeCommentsFiles(folder, comments);
            meta.inlineCommentsCount = comments.length;
            console.log('Collected ' + comments.length + ' inline comment(s) from ' + pageInfos.length + ' page(s)');
        }

        file_write(folder + '/discovery_meta.json', JSON.stringify(meta, null, 2));

        return { success: true, action: 'iteration', ticketKey: ticketKey, existingPageId: existing.id, snapshottedPages: snapshotted, inlineCommentsCount: meta.inlineCommentsCount || 0 };
    } catch (error) {
        console.error('Error in prepareDiscoveryContext:', error);
        try {
            file_write(folder + '/discovery_meta.json', JSON.stringify(meta, null, 2));
        } catch (writeError) {
            console.error('Also failed to write discovery_meta.json:', writeError);
        }
        return { success: false, action: 'error', ticketKey: ticketKey, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        findTicketPage,
        sanitizeFileName,
        snapshotPageTree,
        fetchInlineComments,
        writeCommentsFiles,
        extractCommentBody,
        DISCOVERY_OUTPUT_DIR,
        COMMENTS_FILE_NAME,
        DEFAULT_COMMENTS_LIMIT
    };
}
