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

// ── Pure helpers (gh-1043 CRAP split): storage-body extraction, anchor
// injection and marker building extracted from action(). The Confluence
// reads still happen in call order — only the decision logic moved.

function storageBodyOf(page) {
    return (page && page.body && page.body.storage && page.body.storage.value) || '';
}

/**
 * Body of the existing page: the children-list value when present, otherwise
 * a follow-up single-item GET (format 'md') — the list entry can be empty.
 */
function resolvePageBody(existing) {
    var body = storageBodyOf(existing);
    if (body) return body;
    var full = confluence_content_by_id({ contentId: existing.id, format: 'md' });
    return storageBodyOf(full);
}

/**
 * Re-expose inline comment anchors: storage bodies carry them as
 * <ac:inline-comment-marker> elements which the Markdown conversion strips;
 * re-inject them as [[ic:REF]]...[[/ic]] placeholders so the agent can keep
 * the anchors in its output. Returns the (possibly unchanged) body.
 */
function injectStoredCommentAnchors(body, pageId) {
    var storage = confluence_content_by_id({ contentId: pageId });
    var storageBody = storage && storage.body && storage.body.storage && storage.body.storage.value;
    var anchors = contentOutput.extractInlineCommentMarkers(storageBody);
    if (anchors.length === 0) return body;
    var injected = contentOutput.injectCommentPlaceholders(body, anchors);
    console.log('fetchConfluenceOutputContext: injected ' + injected.injected.length +
        ' inline comment placeholder(s)' +
        (injected.missed.length > 0 ? ', ' + injected.missed.length + ' anchor text(s) not found in Markdown' : ''));
    return injected.content;
}

function buildTargetMarker(cfg, pageTitle) {
    return {
        target: cfg.target,
        format: 'markdown',
        pageTitle: pageTitle,
        space: cfg.space,
        parentPageId: cfg.parentPageId
    };
}

function shouldFetchInlineComments(cfg, folder) {
    return cfg.includeInlineComments !== false && !!folder;
}

function shouldFetchInlineComments(cfg, folder) {
    return cfg.includeInlineComments !== false && !!folder;
}

/** Ticket key: ticket.key, else the basename of the input folder, else null. */
function resolveTicketKey(params) {
    var ticket = params.ticket || {};
    var folder = params.inputFolderPath;
    return ticket.key || (folder ? folder.split('/').pop() : null);
}

/** The ticket summary for the page title, '' when the ticket carries none. */
function ticketSummary(ticket) {
    return (ticket && ticket.fields && ticket.fields.summary) || '';
}

/** Page title of an EXISTING page: its Confluence title, else the ticket key. */
function existingPageTitle(existing, ticketKey) {
    return existing.title || ticketKey;
}

/**
 * The skip result for a Confluence-targeted run, or null when the fetch
 * should proceed: not a Confluence target, or space/parentPageId unconfigured.
 */
function confluenceSkipResult(cfg) {
    if (!contentOutput.isConfluenceTarget(cfg)) {
        return { success: true, action: 'skipped_not_confluence_target' };
    }
    if (!cfg.space || !cfg.parentPageId) {
        console.warn('contentOutput.space / contentOutput.parentPageId not configured — skipping Confluence context fetch');
        return { success: true, action: 'skipped_not_configured' };
    }
    return null;
}

/** Write the target marker into the input folder (non-fatal on failure). */
function writeTargetMarker(folder, cfg, pageTitle) {
    if (!folder) return;
    try {
        file_write(folder + '/' + TARGET_MARKER_FILE, JSON.stringify(buildTargetMarker(cfg, pageTitle), null, 2));
    } catch (markerError) {
        console.warn('fetchConfluenceOutputContext: failed to write target marker:', markerError);
    }
}

/**
 * The page's children listing, or { error } with the non-fatal failure result
 * when the Confluence lookup fails.
 */
function fetchChildrenOrError(cfg) {
    try {
        return { children: confluence_get_children_by_id({ contentId: cfg.parentPageId, format: 'md' }) };
    } catch (e) {
        console.warn('fetchConfluenceOutputContext: failed to list children of ' + cfg.parentPageId + ':', e);
        return { error: { success: false, action: 'children_lookup_failed', error: e.toString() } };
    }
}

/**
 * Step 1 of the fetch: write the page's current body into the input folder,
 * with the inline-comment anchors re-injected (both non-fatal).
 */
function writeCurrentPageBody(folder, existing) {
    try {
        var body = resolvePageBody(existing);
        if (folder && body) {
            try {
                body = injectStoredCommentAnchors(body, existing.id);
            } catch (markerError) {
                console.warn('fetchConfluenceOutputContext: marker extraction failed (non-fatal):', markerError);
            }
            file_write(folder + '/' + CURRENT_CONTENT_FILE, body);
            console.log('Wrote current page content to input/' + CURRENT_CONTENT_FILE);
        }
    } catch (e) {
        console.warn('fetchConfluenceOutputContext: failed to fetch page body:', e);
    }
}

/**
 * Step 2 of the fetch: collect the page's inline comments into the input
 * folder. Returns their count (0 when disabled or no input folder).
 */
function collectInlineComments(cfg, folder, existing, pageTitle) {
    var commentsCount = 0;
    if (shouldFetchInlineComments(cfg, folder)) {
        var comments = contentOutput.fetchPageInlineComments(existing.id, pageTitle, 100);
        contentOutput.writeCommentsFiles(folder, comments, contentOutput.COMMENTS_BASE_NAME);
        commentsCount = comments.length;
        console.log('Collected ' + commentsCount + ' inline comment(s) from page ' + existing.id);
    }
    return commentsCount;
}

function action(params) {
    var folder = params.inputFolderPath;
    var ticketKey = resolveTicketKey(params);

    try {
        var cfg = contentOutput.resolveConfig(params);
        var skip = confluenceSkipResult(cfg);
        if (skip) return skip;

        // Always write the target marker so the CLI agent knows the output is
        // headed to Confluence (Markdown, not tracker markup) — even on the
        // first run when no page exists yet.
        var markerTitle = contentOutput.buildPageTitle(cfg, ticketKey, ticketSummary(params.ticket || {}));
        writeTargetMarker(folder, cfg, markerTitle);

        var lookup = fetchChildrenOrError(cfg);
        if (lookup.error) return lookup.error;

        var existing = contentOutput.findTicketPage(lookup.children, ticketKey);
        if (!existing) {
            console.log('No existing Confluence page for ' + ticketKey + ' — first run, no context to fetch');
            return { success: true, action: 'first_run', pageTitle: markerTitle };
        }

        writeCurrentPageBody(folder, existing);

        var commentsCount = collectInlineComments(cfg, folder, existing, existingPageTitle(existing, ticketKey));

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
    module.exports = {
        action: action,
        CURRENT_CONTENT_FILE: CURRENT_CONTENT_FILE,
        TARGET_MARKER_FILE: TARGET_MARKER_FILE,
        resolveTicketKey: resolveTicketKey,
        ticketSummary: ticketSummary,
        existingPageTitle: existingPageTitle,
        buildTargetMarker: buildTargetMarker
    };
}
