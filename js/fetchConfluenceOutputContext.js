/**
 * Fetch Confluence Output Context — pre-CLI action for content-generating
 * agents (story_description, story_acceptance_criteria, story_solution).
 *
 * When customParams.contentOutput targets Confluence (target: 'confluence' or
 * 'both') and a page for this ticket already exists under
 * contentOutput.parentPageId, this:
 *   1. Writes the page's current body to input/confluence_output_current.md so
 *      the CLI agent iterates on prior content instead of rewriting blindly.
 *   2. If contentOutput.includeInlineComments is not false, fetches the page's
 *      inline comments into input/confluence_output_comments.json and .md so
 *      the agent can treat them as review feedback and answer them via
 *      outputs/confluence_replies.json (published by writeContentOutput.js).
 *
 * No-op when the target is jira_field, when Confluence is not configured, or
 * when no page exists yet (first run). All errors are non-fatal.
 */

var contentOutput = require('./common/contentOutput.js');

var CURRENT_CONTENT_FILE = 'confluence_output_current.md';

function action(params) {
    var folder = params.inputFolderPath;
    var ticket = params.ticket || {};
    var ticketKey = ticket.key || (folder ? folder.split('/').pop() : null);

    try {
        var cfg = contentOutput.resolveConfig(params);
        if (!contentOutput.isConfluenceTarget(cfg)) {
            return { success: true, action: 'skipped_not_confluence_target' };
        }
        if (!cfg.space || !cfg.parentPageId) {
            console.warn('contentOutput.space / contentOutput.parentPageId not configured — skipping Confluence context fetch');
            return { success: true, action: 'skipped_not_configured' };
        }

        var children;
        try {
            children = confluence_get_children_by_id({ contentId: cfg.parentPageId, format: 'md' });
        } catch (e) {
            console.warn('fetchConfluenceOutputContext: failed to list children of ' + cfg.parentPageId + ':', e);
            return { success: false, action: 'children_lookup_failed', error: e.toString() };
        }

        var existing = contentOutput.findTicketPage(children, ticketKey);
        if (!existing) {
            console.log('No existing Confluence page for ' + ticketKey + ' — first run, no context to fetch');
            return { success: true, action: 'first_run' };
        }

        var pageTitle = existing.title || ticketKey;

        // 1. Current page body
        try {
            var body = (existing.body && existing.body.storage && existing.body.storage.value) || '';
            if (!body) {
                var full = confluence_content_by_id({ contentId: existing.id, format: 'md' });
                body = (full && full.body && full.body.storage && full.body.storage.value) || '';
            }
            if (folder && body) {
                file_write(folder + '/' + CURRENT_CONTENT_FILE, body);
                console.log('Wrote current page content to input/' + CURRENT_CONTENT_FILE);
            }
        } catch (e) {
            console.warn('fetchConfluenceOutputContext: failed to fetch page body:', e);
        }

        // 2. Inline comments
        var commentsCount = 0;
        if (cfg.includeInlineComments !== false && folder) {
            var comments = contentOutput.fetchPageInlineComments(existing.id, pageTitle, 100);
            contentOutput.writeCommentsFiles(folder, comments, contentOutput.COMMENTS_BASE_NAME);
            commentsCount = comments.length;
            console.log('Collected ' + commentsCount + ' inline comment(s) from page ' + existing.id);
        }

        return {
            success: true,
            action: 'context_fetched',
            pageId: existing.id,
            commentsCount: commentsCount
        };
    } catch (error) {
        console.error('Error in fetchConfluenceOutputContext:', error);
        return { success: false, action: 'error', error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, CURRENT_CONTENT_FILE: CURRENT_CONTENT_FILE };
}
