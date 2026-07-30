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
 *     (title starting with the ticket key), snapshots its current page tree as
 *     Markdown into input/discovery-context/ so the CLI agent treats prior
 *     discovery output as the living context pack to iterate on, instead of
 *     starting from scratch every run.
 *  3. Writes input/discovery_meta.json with the resolved space/parentPageId
 *     and the existing page id (if found) — read by the matching postJSAction
 *     (publishDiscoveryToConfluence.js) so both steps agree on where to publish
 *     without re-resolving config or re-querying Confluence twice.
 */

var configLoader = require('./configLoader.js');

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
 * Snapshot an existing discovery page + its direct children as Markdown files
 * under targetDir, mirroring the same file-per-page convention the CLI agent
 * is instructed to write under outputs/discovery/ (see instructions/discovery/
 * output_rules.md), so it can read prior published state the same way it will
 * write new state.
 */
function snapshotPageTree(page, targetDir) {
    try {
        var rootMd = confluence_content_by_id({ contentId: page.id, format: 'md' });
        var rootBody = (rootMd && rootMd.body && rootMd.body.storage && rootMd.body.storage.value) || '';
        file_write(targetDir + '/index.md', rootBody || '_(existing page had no body)_');

        var children = confluence_get_children_by_id({ contentId: page.id, format: 'md' }) || [];
        children.forEach(function(child) {
            var childBody = (child.body && child.body.storage && child.body.storage.value) || '';
            var fileName = sanitizeFileName(child.title) + '.md';
            file_write(targetDir + '/' + fileName, childBody || '_(existing page had no body)_');
        });

        return children.length;
    } catch (e) {
        console.warn('prepareDiscoveryContext: failed to snapshot existing page tree:', e);
        return 0;
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
            console.warn('discovery.space / discovery.parentPageId are not configured — set them in this project\'s .dmtools/config.js before discovery pages can be published to Confluence. Continuing without prior-context lookup.');
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
        console.log('Found existing discovery page for ' + ticketKey + ': ' + existing.id + ' ("' + existing.title + '")');
        var snapshotted = snapshotPageTree(existing, folder + '/discovery-context');
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
    module.exports = { action, findTicketPage, sanitizeFileName };
}
