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
 *  4. Post replies to any inline comments the CLI agent directly addressed
 *     (outputs/confluence_replies.json — same mechanism as
 *     story_solution/story_description, see contentOutput.js), using
 *     confluence_reply_to_inline_comment via
 *     contentOutput.publishCommentReplies().
 *  5. Post a Jira comment linking to the page, plus the usual token-usage
 *     comment.
 */

var configLoader = require('./configLoader.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackersModule = require('./common/trackers.js');
var contentOutput = require('./common/contentOutput.js');
var feedbackLoop = require('./common/feedbackLoop.js');

var DISCOVERY_OUTPUT_DIR = 'outputs/discovery';
var RESPONSE_FILE = 'outputs/response.md';

/**
 * On a very long/near-budget-limit discovery run, the CLI agent can do all the
 * substantive work (address every inline comment, update every page) and still
 * skip its last, cheapest steps: writing outputs/response.md and/or
 * outputs/confluence_replies.json (see instructions/discovery/output_rules.md's
 * "Before you finish" checklist). A missing outputs/response.md is a strong,
 * low-noise signal for this specific failure mode — after the prompt fix above,
 * a well-behaved run always writes it, so its absence is not a normal "nothing
 * to report" outcome. Give the agent one more chance to finish those steps by
 * resuming the SAME session (feedbackLoop.resumeAgent()) rather than publishing
 * whatever partial bookkeeping exists and moving on.
 */

// ── Pure helpers (gh-1043 CRAP split): string building and parsing extracted
// from action(); posted strings must stay byte-identical to the originals.

function buildPageTitle(ticketKey, ticketSummary) {
    return ticketSummary ? (ticketKey + ' ' + ticketSummary) : ticketKey;
}

function buildNotConfiguredMessage() {
    return 'Discovery output was generated in `' + DISCOVERY_OUTPUT_DIR + '` but not published to Confluence: ' +
        '`discovery.space` / `discovery.parentPageId` are not configured for this project. ' +
        'Set them in `.dmtools/config.js` to enable publishing.';
}

function parseSyncSummary(syncSummaryRaw) {
    try {
        return JSON.parse(syncSummaryRaw);
    } catch (e) {
        return { raw: syncSummaryRaw };
    }
}

function buildDiscoveryPublishedComment(pageUrl, syncedCount, replyResult) {
    return 'h3. 📚 Discovery published to Confluence\n\n' +
        (pageUrl ? 'Page: ' + pageUrl + '\n\n' : '') +
        'Synced *' + syncedCount + '* page(s) from `' + DISCOVERY_OUTPUT_DIR + '`.' +
        (replyResult.posted > 0 ? '\n\nReplied to *' + replyResult.posted + '* inline comment(s).' : '') +
        (replyResult.failed > 0 ? ' (' + replyResult.failed + ' reply attempt(s) failed — see job log.)' : '');
}

/**
 * Storage body to carry across a page-title rename; '<p></p>' when the
 * children-list entry carries no body (same fallback as the original inline
 * expression).
 */
function buildRenameBody(page) {
    return (page.body && page.body.storage && page.body.storage.value) || '<p></p>';
}

function isResponseFileMissing() {
    try {
        var raw = file_read({ path: RESPONSE_FILE });
        return !raw || !raw.trim();
    } catch (e) {
        return true;
    }
}

function tryResumeForMissingFinalOutput(params, ticketKey, customParams) {
    try {
        return feedbackLoop.resumeAgent({
            ticketKey: ticketKey,
            customParams: customParams,
            section: 'postAction',
            stage: 'discovery_final_output',
            error: '`' + RESPONSE_FILE + '` is missing or empty after the CLI run finished. ' +
                'This usually means the run ran out of turns/budget right before its last steps.',
            promptOverride: [
                'Your previous discovery run for ' + ticketKey + ' finished without writing two required bookkeeping files.',
                '',
                'Do the following now, in the SAME repository/session, before anything else:',
                '1. Write `' + RESPONSE_FILE + '` — a short (a few sentences) summary of what you did last run ' +
                    '(which mode(s) ran, the headline recommendation, whether any inline comments were addressed).',
                '2. If you addressed (or explicitly declined to address) any unresolved inline comment last run, ' +
                    'make sure `outputs/confluence_replies.json` lists a reply for it — see ' +
                    'instructions/discovery/confluence_comments.md for the exact format. If nothing needs a reply, ' +
                    'it is fine to omit this file or leave it as an empty array `[]`.',
                '3. Do not redo work that is already correctly reflected in `outputs/discovery/` — only fill in the ' +
                    'missing bookkeeping above.',
                '',
                'Do not push or run any git commands; this is a documentation-only publishing step with no repository changes to commit.'
            ].join('\n')
        }).attempted;
    } catch (resumeError) {
        console.error('tryResumeForMissingFinalOutput: feedbackLoop.resumeAgent failed unexpectedly — publishing with whatever output exists:', resumeError);
        return false;
    }
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

// ── Extracted step helpers (gh-1187 CRAP split): same tracker/Confluence
// calls in the same order, same log lines; posted strings byte-identical.

function ticketSummaryOf(params) {
    return (params.ticket.fields && params.ticket.fields.summary) || '';
}

// Config + tracker of one publish run (createTracker runs before the
// space/parentPageId check, exactly like the original inline flow).
function loadDiscoveryContext(params) {
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var discoveryConfig = projectConfig.discovery || {};
    return {
        tracker: trackersModule.createTracker(projectConfig, (params.jobParams && params.jobParams.customParams) || params.customParams || {}),
        space: discoveryConfig.space,
        parentPageId: discoveryConfig.parentPageId,
        deleteOrphans: !!discoveryConfig.deleteOrphans
    };
}

function isUnconfiguredDiscovery(ctx) {
    return !ctx.space || !ctx.parentPageId;
}

function warnNotConfigured(ctx, ticketKey) {
    var msg = buildNotConfiguredMessage();
    console.warn(msg);
    try {
        ctx.tracker.postComment(ticketKey, 'h3. ⚠️ Discovery drafted, not published\n\n' + msg);
    } catch (commentError) {
        console.warn('Failed to post not-configured comment:', commentError);
    }
}

function fetchParentChildren(parentPageId) {
    try {
        return { children: confluence_get_children_by_id({ contentId: parentPageId, format: 'md' }) };
    } catch (e) {
        console.error('Failed to list children of parentPageId', parentPageId, ':', e);
        return { error: e.toString() };
    }
}

// Find-or-create the ticket's own page, renaming when the summary changed.
function ensureTicketPage(ctx, children, ticketKey, pageTitle) {
    var page = findTicketPage(children, ticketKey);
    if (!page) {
        console.log('No existing discovery page for ' + ticketKey + ' — creating one titled "' + pageTitle + '"');
        return confluence_create_page({
            title: pageTitle,
            parentId: ctx.parentPageId,
            body: '<p>Discovery in progress — content is synced from ' + DISCOVERY_OUTPUT_DIR + '.</p>',
            space: ctx.space
        });
    }
    if (page.title !== pageTitle) {
        console.log('Ticket summary changed — updating page title from "' + page.title + '" to "' + pageTitle + '"');
        return confluence_update_page({
            contentId: page.id,
            title: pageTitle,
            parentId: ctx.parentPageId,
            body: buildRenameBody(page),
            space: ctx.space
        });
    }
    return page;
}

function syncDiscoveryDirectory(ctx, page) {
    return parseSyncSummary(confluence_sync_markdown_directory({
        directory: DISCOVERY_OUTPUT_DIR,
        parentId: page.id,
        space: ctx.space,
        deleteOrphans: ctx.deleteOrphans
    }));
}

function collectReplyResult() {
    var replyResult = { posted: 0, failed: 0 };
    try {
        replyResult = contentOutput.publishCommentReplies();
    } catch (replyError) {
        console.warn('Failed to publish inline comment replies:', replyError);
    }
    return replyResult;
}

function syncedCountOf(syncSummary) {
    return (syncSummary.syncedPages && syncSummary.syncedPages.length) || 0;
}

// Missing final-output resume check. Returns true when the CLI session was
// resumed — the caller then re-runs the whole post-action (recursive retry).
function resumeIfFinalOutputMissing(params, ticketKey) {
    if (!isResponseFileMissing()) {
        return false;
    }
    var _customParams = (params.jobParams && params.jobParams.customParams) || params.customParams;
    console.warn('publishDiscoveryToConfluence: ' + RESPONSE_FILE + ' is missing/empty for ' + ticketKey +
        ' — attempting to resume the CLI session to finish the run\'s final bookkeeping steps.');
    if (tryResumeForMissingFinalOutput(params, ticketKey, _customParams)) {
        return true;
    }
    console.warn('publishDiscoveryToConfluence: resume not attempted/available (disabled, exhausted, or non-recoverable) — publishing with whatever output exists.');
    return false;
}

function buildPublishedResult(ticketKey, page, pageUrl, syncedCount, replyResult) {
    console.log('✅ Published discovery for ' + ticketKey + ' to Confluence page ' + page.id +
        (replyResult.posted > 0 ? ' (' + replyResult.posted + ' comment repl(y/ies) posted)' : ''));
    return {
        success: true,
        action: 'published',
        ticketKey: ticketKey,
        pageId: page.id,
        pageUrl: pageUrl,
        syncedPages: syncedCount,
        commentRepliesPosted: replyResult.posted,
        commentRepliesFailed: replyResult.failed
    };
}

function postPublishedCommentQuietly(ctx, ticketKey, comment) {
    try {
        ctx.tracker.postComment(ticketKey, comment);
    } catch (commentError) {
        console.warn('Failed to post discovery-published comment:', commentError);
    }
}

function postTokenUsageQuietly(tracker, ticketKey, params) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, tracker: tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function postFailureCommentQuietly(tracker, ticketKey, error) {
    try {
        tracker.postComment(ticketKey, 'h3. ⚠️ Discovery publish failed\n\n' + (error.message || error.toString()));
    } catch (commentError) {
        console.warn('Failed to post failure comment:', commentError);
    }
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        console.error('No ticket key provided');
        return { success: false, action: 'missing_ticket' };
    }
    var pageTitle = buildPageTitle(ticketKey, ticketSummaryOf(params));
    var result = { success: false, action: 'not_configured', ticketKey: ticketKey };
    var tracker = null;

    try {
        var ctx = loadDiscoveryContext(params);
        tracker = ctx.tracker;

        if (isUnconfiguredDiscovery(ctx)) {
            warnNotConfigured(ctx, ticketKey);
            return result;
        }

        var fetched = fetchParentChildren(ctx.parentPageId);
        if (fetched.error) {
            result.action = 'children_lookup_failed';
            result.error = fetched.error;
            return result;
        }

        var page = ensureTicketPage(ctx, fetched.children, ticketKey, pageTitle);
        var syncSummary = syncDiscoveryDirectory(ctx, page);
        var pageUrl = resolvePageUrl(page);
        var syncedCount = syncedCountOf(syncSummary);
        var replyResult = collectReplyResult();

        if (resumeIfFinalOutputMissing(params, ticketKey)) {
            // Resumed successfully — the agent should now have written the missing
            // file(s). Re-run this whole post-action from the top so the freshly
            // written outputs/discovery/ and outputs/confluence_replies.json get
            // (re-)synced/posted, same recursive-retry pattern as
            // developTicketAndCreatePR.js's resumeDevelopmentAgent() call sites.
            return action(params);
        }

        postPublishedCommentQuietly(ctx, ticketKey, buildDiscoveryPublishedComment(pageUrl, syncedCount, replyResult));
        postTokenUsageQuietly(tracker, ticketKey, params);
        return buildPublishedResult(ticketKey, page, pageUrl, syncedCount, replyResult);
    } catch (error) {
        console.error('Error in publishDiscoveryToConfluence:', error);
        postFailureCommentQuietly(tracker, ticketKey, error);
        return { success: false, action: 'error', ticketKey: ticketKey, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        findTicketPage: findTicketPage,
        buildPageUrl: buildPageUrl,
        resolvePageUrl: resolvePageUrl,
        ticketSummaryOf: ticketSummaryOf,
        loadDiscoveryContext: loadDiscoveryContext,
        isUnconfiguredDiscovery: isUnconfiguredDiscovery,
        warnNotConfigured: warnNotConfigured,
        fetchParentChildren: fetchParentChildren,
        ensureTicketPage: ensureTicketPage,
        syncDiscoveryDirectory: syncDiscoveryDirectory,
        collectReplyResult: collectReplyResult,
        syncedCountOf: syncedCountOf,
        resumeIfFinalOutputMissing: resumeIfFinalOutputMissing,
        buildPublishedResult: buildPublishedResult,
        postPublishedCommentQuietly: postPublishedCommentQuietly,
        postTokenUsageQuietly: postTokenUsageQuietly,
        postFailureCommentQuietly: postFailureCommentQuietly
    };
}

function buildPageUrl(page) {
    if (!page || !page._links) return null;
    var webui = page._links.webui;
    if (!webui) return null;
    var base = page._links.base;
    if (!base) return null;
    return base + webui;
}

/**
 * Resolve a page's fully-qualified view URL. `page` objects returned by
 * confluence_get_children_by_id (used to find an already-existing ticket page)
 * omit `_links.base` — only a single-item GET (confluence_content_by_id)
 * reliably includes it. Do one lightweight follow-up GET to get an
 * authoritative, always-populated `_links.base` rather than depending on env
 * var access from within the JS sandbox.
 */
function resolvePageUrl(page) {
    var direct = buildPageUrl(page);
    if (direct) return direct;
    try {
        var fresh = confluence_content_by_id({ contentId: page.id });
        return buildPageUrl(fresh);
    } catch (e) {
        console.warn('resolvePageUrl: follow-up confluence_content_by_id lookup failed:', e);
        return null;
    }
}

