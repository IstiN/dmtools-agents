/**
 * Publish Discovery To Confluence — postJSAction for the discovery agent.
 *
 * Reads outputs/discovery/ (a Markdown folder written by the CLI agent per
 * instructions/discovery/output_rules.md) and syncs it to a Confluence page
 * tree anchored under a per-project parent page:
 *
 *  1. Resolve discovery.space / discovery.parentPageId from project config
 *     (.dmtools/config.js — see js/configLoader.js DEFAULTS.discovery). If
 *     either is missing, skip publishing and post a Jira comment explaining
 *     what to configure — this keeps the agent itself fully generic.
 *  2. Find-or-create the ticket's own Confluence page (title
 *     "<ticketKey> <ticket summary>") as a child of parentPageId. Matched by
 *     ticket-key PREFIX (not exact title) so a later summary edit doesn't
 *     create a duplicate page.
 *  3. Sync outputs/discovery/ under that page via
 *     confluence_sync_markdown_directory (index.md becomes the page's own
 *     body; every other .md file becomes a child page).
 *  4. Post a Jira comment linking to the page, plus the usual token-usage
 *     comment.
 */

var configLoader = require('./configLoader.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

var DISCOVERY_OUTPUT_DIR = 'outputs/discovery';

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

function buildPageUrl(page) {
    if (!page || !page._links) return null;
    var webui = page._links.webui;
    if (!webui) return null;
    var base = page._links.base;
    if (!base) {
        try {
            base = java.lang.System.getenv('CONFLUENCE_BASE_PATH') || '';
        } catch (e) {
            base = '';
        }
    }
    return base + webui;
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        console.error('No ticket key provided');
        return { success: false, action: 'missing_ticket' };
    }
    var ticketSummary = (params.ticket.fields && params.ticket.fields.summary) || '';
    var pageTitle = ticketSummary ? (ticketKey + ' ' + ticketSummary) : ticketKey;

    var result = { success: false, action: 'not_configured', ticketKey: ticketKey };

    try {
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var discoveryConfig = projectConfig.discovery || {};
        var space = discoveryConfig.space;
        var parentPageId = discoveryConfig.parentPageId;
        var deleteOrphans = !!discoveryConfig.deleteOrphans;

        if (!space || !parentPageId) {
            var msg = 'Discovery output was generated in `' + DISCOVERY_OUTPUT_DIR + '` but not published to Confluence: ' +
                '`discovery.space` / `discovery.parentPageId` are not configured for this project. ' +
                'Set them in `.dmtools/config.js` to enable publishing.';
            console.warn(msg);
            try {
                jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Discovery drafted, not published\n\n' + msg });
            } catch (commentError) {
                console.warn('Failed to post not-configured comment:', commentError);
            }
            return result;
        }

        var children;
        try {
            children = confluence_get_children_by_id({ contentId: parentPageId, format: 'md' });
        } catch (e) {
            console.error('Failed to list children of parentPageId', parentPageId, ':', e);
            result.action = 'children_lookup_failed';
            result.error = e.toString();
            return result;
        }

        var page = findTicketPage(children, ticketKey);
        if (!page) {
            console.log('No existing discovery page for ' + ticketKey + ' — creating one titled "' + pageTitle + '"');
            page = confluence_create_page({
                title: pageTitle,
                parentId: parentPageId,
                body: '<p>Discovery in progress — content is synced from ' + DISCOVERY_OUTPUT_DIR + '.</p>',
                space: space
            });
        } else if (page.title !== pageTitle) {
            console.log('Ticket summary changed — updating page title from "' + page.title + '" to "' + pageTitle + '"');
            page = confluence_update_page({
                contentId: page.id,
                title: pageTitle,
                parentId: parentPageId,
                body: (page.body && page.body.storage && page.body.storage.value) || '<p></p>',
                space: space
            });
        }

        var syncSummaryRaw = confluence_sync_markdown_directory({
            directory: DISCOVERY_OUTPUT_DIR,
            parentId: page.id,
            space: space,
            deleteOrphans: deleteOrphans
        });

        var syncSummary;
        try {
            syncSummary = JSON.parse(syncSummaryRaw);
        } catch (e) {
            syncSummary = { raw: syncSummaryRaw };
        }

        var pageUrl = buildPageUrl(page);
        var syncedCount = (syncSummary.syncedPages && syncSummary.syncedPages.length) || 0;

        var comment = 'h3. 📚 Discovery published to Confluence\n\n' +
            (pageUrl ? 'Page: ' + pageUrl + '\n\n' : '') +
            'Synced *' + syncedCount + '* page(s) from `' + DISCOVERY_OUTPUT_DIR + '`.';
        try {
            jira_post_comment({ key: ticketKey, comment: comment });
        } catch (commentError) {
            console.warn('Failed to post discovery-published comment:', commentError);
        }

        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        console.log('✅ Published discovery for ' + ticketKey + ' to Confluence page ' + page.id);
        return {
            success: true,
            action: 'published',
            ticketKey: ticketKey,
            pageId: page.id,
            pageUrl: pageUrl,
            syncedPages: syncedCount
        };
    } catch (error) {
        console.error('Error in publishDiscoveryToConfluence:', error);
        try {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ⚠️ Discovery publish failed\n\n' + (error.message || error.toString())
            });
        } catch (commentError) {
            console.warn('Failed to post failure comment:', commentError);
        }
        return { success: false, action: 'error', ticketKey: ticketKey, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, findTicketPage, buildPageUrl };
}
