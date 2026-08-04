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
 */

var configLoader = require('./configLoader.js');

var DISCOVERY_OUTPUT_DIR = 'outputs/discovery';

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
function snapshotPageTree(page, targetDir) {
    var total = 0;
    try {
        var rootMd = confluence_content_by_id({ contentId: page.id, format: 'md' });
        var rootBody = (rootMd && rootMd.body && rootMd.body.storage && rootMd.body.storage.value) || '';
        file_write(targetDir + '/index.md', rootBody || '_(existing page had no body)_');

        var children = confluence_get_children_by_id({ contentId: page.id, format: 'md' }) || [];
        children.forEach(function(child) {
            total += 1;
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
                total += snapshotPageTree(child, targetDir + '/' + fileName);
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
        var discoveryConfig = projectConfig.discovery || {};
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
        console.log('Found existing discovery page for ' + ticketKey + ': ' + existing.id + ' ("' + existing.title + '") — seeding ' + DISCOVERY_OUTPUT_DIR + ' with its current content (full tree, recursively) for in-place editing.');
        var snapshotted = snapshotPageTree(existing, DISCOVERY_OUTPUT_DIR);
        file_write(folder + '/discovery_meta.json', JSON.stringify(meta, null, 2));

        return { success: true, action: 'iteration', ticketKey: ticketKey, existingPageId: existing.id, snapshottedPages: snapshotted };
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
    module.exports = { action, findTicketPage, sanitizeFileName, snapshotPageTree, DISCOVERY_OUTPUT_DIR };
}
