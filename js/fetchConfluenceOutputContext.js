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
 * On every Confluence-targeted run (including the first one, when no page
 * exists yet) it also writes input/confluence_output_target.json — a marker
 * the CLI agent uses to know the output is headed to a Confluence page and
 * must be written as Markdown rather than tracker markup.
 *
 * No-op when the target is jira_field or Confluence is not configured.
 * All errors are non-fatal.
 */

var contentOutput = require('./common/contentOutput.js');

var CURRENT_CONTENT_FILE = 'confluence_output_current.md';
var TARGET_MARKER_FILE = 'confluence_output_target.json';

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

        // Always write the target marker so the CLI agent knows the output is
        // headed to Confluence (Markdown, not tracker markup) — even on the
        // first run when no page exists yet.
        var pageTitle = contentOutput.buildPageTitle(cfg, ticketKey,
            (ticket.fields && ticket.fields.summary) || '');
        if (folder) {
            try {
                file_write(folder + '/' + TARGET_MARKER_FILE, JSON.stringify({
                    target: cfg.target,
                    format: 'markdown',
                    pageTitle: pageTitle,
                    space: cfg.space,
                    parentPageId: cfg.parentPageId
                }, null, 2));
            } catch (markerError) {
                console.warn('fetchConfluenceOutputContext: failed to write target marker:', markerError);
            }
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
            return { success: true, action: 'first_run', pageTitle: pageTitle };
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
                // Preserve inline comment anchors: storage bodies carry them as
                // <ac:inline-comment-marker> elements which the Markdown conversion
                // strips. Re-expose them as [[ic:REF]]...[[/ic]] placeholders so the
                // agent can keep the anchors in its output (publishPage converts them
                // back after the sync).
                try {
                    var storage = confluence_content_by_id({ contentId: existing.id });
                    var storageBody = storage && storage.body && storage.body.storage && storage.body.storage.value;
                    var anchors = contentOutput.extractInlineCommentMarkers(storageBody);
                    if (anchors.length > 0) {
                        var injected = contentOutput.injectCommentPlaceholders(body, anchors);
                        body = injected.content;
                        console.log('fetchConfluenceOutputContext: injected ' + injected.injected.length +
                            ' inline comment placeholder(s)' +
                            (injected.missed.length > 0 ? ', ' + injected.missed.length + ' anchor text(s) not found in Markdown' : ''));
                    }
                } catch (markerError) {
                    console.warn('fetchConfluenceOutputContext: marker extraction failed (non-fatal):', markerError);
                }
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
    module.exports = { action: action, CURRENT_CONTENT_FILE: CURRENT_CONTENT_FILE, TARGET_MARKER_FILE: TARGET_MARKER_FILE };
}
