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
 *  3. Writes input/discovery_meta.json with the resolved space/parentPageId
 *     and the existing page id (if found) — read by the matching postJSAction
 *     (publishDiscoveryToConfluence.js) so both steps agree on where to publish
 *     without re-resolving config or re-querying Confluence twice.
 *  4. Same principle as the story_solution/story_description agents' Confluence
 *     output flow (see js/common/contentOutput.js): while snapshotting each page
 *     in the tree, also (a) re-expose that page's inline comment anchors as
 *     [[ic:REF]]...[[/ic]] placeholders directly inside its snapshotted
 *     Markdown file, and (b) collect that page's inline comments into a single
 *     input/<ticket>/discovery_comments.md + .json across the WHOLE tree (not
 *     just the ticket's own root page) — the discovery agent instructions
 *     (instructions/discovery/confluence_comments.md) tell the CLI agent to
 *     treat these as review feedback and reply via
 *     outputs/confluence_replies.json, which publishDiscoveryToConfluence.js
 *     then posts back with contentOutput.publishCommentReplies() after sync.
 */

var configLoader = require('./configLoader.js');
var contentOutput = require('./common/contentOutput.js');

var DISCOVERY_OUTPUT_DIR = 'outputs/discovery';
var COMMENTS_BASE_NAME = 'discovery_comments';

function sanitizeFileName(title) {
    return String(title || 'untitled').replace(/[\\/:*?"<>|]/g, '-').trim();
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
 * Re-expose a page's inline comment anchors as [[ic:REF]]...[[/ic]]
 * placeholders inside its Markdown body (same mechanism as
 * fetchConfluenceOutputContext.js for story_solution/story_description — see
 * contentOutput.js's "Inline comment anchors" section). Storage-format markers
 * are stripped by the Markdown conversion, so this re-derives them from a
 * separate storage-format fetch. Non-fatal: returns the body unchanged on any
 * failure (e.g. page has no comments, or the lookup itself fails).
 */
function injectCommentAnchors(pageId, body) {
    try {
        var storage = confluence_content_by_id({ contentId: pageId });
        var storageBody = storage && storage.body && storage.body.storage && storage.body.storage.value;
        var anchors = contentOutput.extractInlineCommentMarkers(storageBody);
        if (anchors.length === 0) return body;
        var injected = contentOutput.injectCommentPlaceholders(body, anchors);
        return injected.content;
    } catch (e) {
        console.warn('prepareDiscoveryContext: inline comment anchor extraction failed for page ' + pageId + ' (non-fatal):', e);
        return body;
    }
}

/**
 * Fetch a page's inline comments and append them to the shared accumulator
 * (see snapshotPageTree). Non-fatal: logs and leaves the accumulator
 * untouched on failure.
 */
function collectPageComments(pageId, pageTitle, allComments) {
    try {
        var comments = contentOutput.fetchPageInlineComments(pageId, pageTitle, 100);
        Array.prototype.push.apply(allComments, comments);
    } catch (e) {
        console.warn('prepareDiscoveryContext: failed to fetch inline comments for page ' + pageId + ' (non-fatal):', e);
    }
}

/** Pull the storage-format body out of a confluence content payload ('' when absent). */
function pageStorageBody(content) {
    return (content && content.body && content.body.storage && content.body.storage.value) || '';
}

/** Write one page body as index.md (root of its tree level). */
function writePageIndex(targetDir, body) {
    file_write(targetDir + '/index.md', body || '_(existing page had no body)_');
}

/** List a page's children; a failed lookup degrades to "no children". */
function fetchChildrenSafe(contentId) {
    try {
        return confluence_get_children_by_id({ contentId: contentId, format: 'md' }) || [];
    } catch (e) {
        return [];
    }
}

/** Snapshot a leaf child as a single Markdown file named after its title. */
function snapshotLeafChild(child, targetDir, allComments) {
    var childBody = pageStorageBody(child);
    childBody = injectCommentAnchors(child.id, childBody);
    file_write(targetDir + '/' + sanitizeFileName(child.title) + '.md', childBody || '_(existing page had no body)_');
    collectPageComments(child.id, child.title, allComments);
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
 * Also, for every page visited (root + every descendant, any depth): injects
 * [[ic:REF]]...[[/ic]] inline comment anchor placeholders into its snapshotted
 * body, and appends its inline comments to allComments — see module docstring
 * point 4 and instructions/discovery/confluence_comments.md.
 *
 * @param {Object} page - Confluence content object (needs .id)
 * @param {string} targetDir - local directory to write this page's own
 *     index.md into (its children go into named subfolders/files here)
 * @param {Array} allComments - shared accumulator; every visited page's
 *     inline comments are appended here (pageId/pageTitle-tagged, see
 *     contentOutput.fetchPageInlineComments)
 * @returns {number} total number of descendant pages snapshotted (all depths)
 */
function snapshotPageTree(page, targetDir, allComments) {
    var total = 0;
    try {
        var rootBody = pageStorageBody(confluence_content_by_id({ contentId: page.id, format: 'md' }));
        rootBody = injectCommentAnchors(page.id, rootBody);
        writePageIndex(targetDir, rootBody);
        collectPageComments(page.id, page.title, allComments);

        var children = confluence_get_children_by_id({ contentId: page.id, format: 'md' }) || [];
        children.forEach(function(child) {
            total += 1;
            var fileName = sanitizeFileName(child.title);
            var grandchildren = fetchChildrenSafe(child.id);

            if (grandchildren.length > 0) {
                // This child has its own descendants — recurse into a subfolder
                // named after it, matching the sync tool's folder-with-index.md
                // convention for a page that itself has children.
                total += snapshotPageTree(child, targetDir + '/' + fileName, allComments);
            } else {
                // Leaf page — a single Markdown file is enough.
                snapshotLeafChild(child, targetDir, allComments);
            }
        });

        return total;
    } catch (e) {
        console.warn('prepareDiscoveryContext: failed to snapshot existing page tree at ' + targetDir + ':', e);
        return total;
    }
}

// ── Extracted step helpers (gh-1187 CRAP split): each helper is small, pure
// where possible, and fully covered by js/unit-tests/test_prepareDiscoveryContext.js.

/** Ticket key from params.ticket.key, falling back to the inputFolderPath tail. */
function resolveTicketKey(params, folder) {
    return (params.ticket && params.ticket.key) || (folder ? folder.split('/').pop() : null);
}

/** Write input/<ticket>/discovery_meta.json (same payload the postJSAction reads). */
function writeDiscoveryMeta(folder, meta) {
    file_write(folder + '/discovery_meta.json', JSON.stringify(meta, null, 2));
}

/** writeDiscoveryMeta for the error path — a failed write is logged, not thrown. */
function writeDiscoveryMetaQuietly(folder, meta) {
    try {
        writeDiscoveryMeta(folder, meta);
    } catch (writeError) {
        console.error('Also failed to write discovery_meta.json:', writeError);
    }
}

/**
 * Merge discovery.space/parentPageId from project config into meta.
 * Returns true when the project is NOT configured (caller should short-circuit).
 */
function applyDiscoveryConfig(meta, params) {
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var discoveryConfig = projectConfig.discovery || {};
    meta.space = discoveryConfig.space || null;
    meta.parentPageId = discoveryConfig.parentPageId || null;
    return !meta.space || !meta.parentPageId;
}

/** List the parent page's children; an error marker replaces a thrown lookup. */
function fetchParentChildren(parentPageId) {
    try {
        return { children: confluence_get_children_by_id({ contentId: parentPageId, format: 'md' }) };
    } catch (e) {
        console.warn('prepareDiscoveryContext: failed to list children of parentPageId', parentPageId, ':', e);
        return { error: e.toString() };
    }
}

/** Persist the collected inline comments (discovery_comments.md/json) when any. */
function writeCollectedComments(folder, allComments, ticketKey, snapshotted) {
    if (!folder || allComments.length === 0) {
        return;
    }
    contentOutput.writeCommentsFiles(folder, allComments, COMMENTS_BASE_NAME);
    console.log('Collected ' + allComments.length + ' inline comment(s) across the discovery page tree (' +
        (snapshotted + 1) + ' page(s)) into input/' + ticketKey + '/' + COMMENTS_BASE_NAME + '.md');
}

/** Snapshot the existing page tree into outputs/discovery/ and report the result. */
function seedExistingPageTree(folder, ticketKey, meta, existing) {
    meta.existingPageId = existing.id;
    console.log('Found existing discovery page for ' + ticketKey + ': ' + existing.id + ' ("' + existing.title + '") — seeding ' + DISCOVERY_OUTPUT_DIR + ' with its current content (full tree, recursively) for in-place editing.');
    var allComments = [];
    var snapshotted = snapshotPageTree(existing, DISCOVERY_OUTPUT_DIR, allComments);
    writeDiscoveryMeta(folder, meta);
    writeCollectedComments(folder, allComments, ticketKey, snapshotted);
    return {
        success: true,
        action: 'iteration',
        ticketKey: ticketKey,
        existingPageId: existing.id,
        snapshottedPages: snapshotted,
        commentsCount: allComments.length
    };
}

function action(params) {
    var folder = params.inputFolderPath;
    var ticketKey = resolveTicketKey(params, folder);

    var meta = {
        ticketKey: ticketKey,
        space: null,
        parentPageId: null,
        existingPageId: null
    };

    try {
        if (applyDiscoveryConfig(meta, params)) {
            console.warn('discovery.space / discovery.parentPageId are not configured — set them in this project\'s .dmtools/config.js before discovery pages can be published to Confluence. Continuing without prior-state seeding.');
            writeDiscoveryMeta(folder, meta);
            return { success: true, action: 'not_configured', ticketKey: ticketKey };
        }

        var fetched = fetchParentChildren(meta.parentPageId);
        if (fetched.error) {
            writeDiscoveryMeta(folder, meta);
            return { success: false, action: 'children_lookup_failed', ticketKey: ticketKey, error: fetched.error };
        }

        var existing = findTicketPage(fetched.children, ticketKey);
        if (!existing) {
            console.log('No existing discovery page found for ' + ticketKey + ' — this will be a first-time discovery run.');
            writeDiscoveryMeta(folder, meta);
            return { success: true, action: 'first_run', ticketKey: ticketKey };
        }

        return seedExistingPageTree(folder, ticketKey, meta, existing);
    } catch (error) {
        console.error('Error in prepareDiscoveryContext:', error);
        writeDiscoveryMetaQuietly(folder, meta);
        return { success: false, action: 'error', ticketKey: ticketKey, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, findTicketPage, sanitizeFileName, snapshotPageTree, injectCommentAnchors, collectPageComments, resolveTicketKey, applyDiscoveryConfig, fetchParentChildren, writeCollectedComments, writeDiscoveryMeta, writeDiscoveryMetaQuietly, seedExistingPageTree, pageStorageBody, fetchChildrenSafe, snapshotLeafChild, DISCOVERY_OUTPUT_DIR, COMMENTS_BASE_NAME };
}
