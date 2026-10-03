/**
 * Write Content Output — unified post-action for content-generating agents
 * (story_description, story_acceptance_criteria, …).
 *
 * Reads outputs/response.md and routes it according to
 * customParams.contentOutput (see js/common/contentOutput.js):
 *
 *   target: 'jira_field'  → write to the tracker field (default; replaces the
 *                           former outputType: 'field' behavior 1:1)
 *   target: 'confluence'  → publish to a Confluence page under
 *                           contentOutput.parentPageId; optionally writes a
 *                           link into the tracker field (updateTrackerField)
 *   target: 'both'        → tracker field AND Confluence page
 *
 * With Confluence targets, replies from outputs/confluence_replies.json are
 * posted back to inline comments via confluence_reply_to_inline_comment.
 *
 * After writing, follow-up behavior:
 *   - contentOutput.thenAction — path to another JS action (e.g.
 *     'assignForSolutionArchitecture.js') invoked with the same params after
 *     a successful write. Use it to keep existing assign/transition/autoStart
 *     flows unchanged.
 *   - otherwise, when contentOutput.assignForReview is not false, the ticket
 *     is assigned for review (same behavior as the former assignForReview
 *     post-action). Target review status can be overridden via
 *     contentOutput.reviewStatus (default: STATUSES.IN_REVIEW).
 */

var contentOutput = require('./common/contentOutput.js');
var outputFiles = require('./common/outputFiles.js');
var jiraHelpers = require('./common/jiraHelpers.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var config = require('./config.js');

function action(params) {
    var ticket = params.ticket || {};
    var ticketKey = ticket.key;
    if (!ticketKey) {
        console.error('writeContentOutput: no ticket key');
        return { success: false, error: 'missing ticket key' };
    }
    var summary = (ticket.fields && ticket.fields.summary) || '';
    var initiatorId = params.initiator;
    var wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : null;

    var cfg = contentOutput.resolveConfig(params);
    console.log('writeContentOutput for ' + ticketKey + ': target=' + cfg.target +
        ', field=' + (cfg.field || '(none)') + ', confluence=' + (cfg.space || '?') + '/' + (cfg.parentPageId || '?'));

    var projectConfig = null;
    try {
        projectConfig = require('./configLoader.js').loadProjectConfig(params.jobParams || params);
    } catch (e) { /* optional */ }

    var content = outputFiles.readOutputFile('response.md', {
        ticketKey: ticketKey,
        workingDir: (projectConfig && projectConfig.workingDir) || null
    });
    if (!content || !content.trim()) {
        console.error('outputs/response.md not found or empty');
        return { success: false, error: 'outputs/response.md is empty' };
    }
    content = content.trim();

    var result = { success: true, ticketKey: ticketKey, target: cfg.target };

    // 1. Jira field (default behavior)
    if (contentOutput.isJiraFieldTarget(cfg)) {
        if (!cfg.field) {
            return { success: false, error: 'contentOutput.field is required for jira_field target' };
        }
        try {
            contentOutput.writeToTrackerField(ticketKey, cfg.field, content, cfg.operationType || 'replace');
            console.log('Updated "' + cfg.field + '" field for ' + ticketKey);
            result.field = cfg.field;
        } catch (e) {
            console.error('Failed to update field "' + cfg.field + '":', e);
            return { success: false, error: 'Field update failed: ' + e.toString() };
        }
    }

    // 2. Confluence page
    if (contentOutput.isConfluenceTarget(cfg)) {
        try {
            // Post replies to inline comments BEFORE the page body is replaced —
            // while the comment anchors are still alive on the old content.
            var replies = contentOutput.publishCommentReplies(contentOutput.DEFAULT_REPLIES_FILE);
            result.replies = replies;
            if (replies.posted > 0 || replies.failed > 0) {
                console.log('Replied to ' + replies.posted + ' inline comment(s)' +
                    (replies.failed > 0 ? ', ' + replies.failed + ' failed' : ''));
            }

            var published = contentOutput.publishPage(cfg, ticketKey, summary, content);
            result.pageId = published.page && published.page.id;
            result.pageUrl = published.url;
            result.pageCreated = published.created;
            console.log('Published content to Confluence page ' + result.pageId + ' (' + (result.pageUrl || 'url unknown') + ')');

            if (cfg.updateTrackerField !== false && cfg.target === 'confluence') {
                var linkText = result.pageUrl
                    ? 'Published to Confluence: ' + result.pageUrl
                    : 'Published to Confluence page ' + result.pageId;
                try {
                    contentOutput.writeToTrackerField(ticketKey, cfg.field || 'Description', linkText, 'replace');
                } catch (e) {
                    console.warn('Failed to write Confluence link to tracker field:', e);
                }
            }

            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. 📄 Content published to Confluence\n\n' +
                        (result.pageUrl ? 'Page: ' + result.pageUrl : 'Page id: ' + result.pageId)
                });
            } catch (e) {
                console.warn('Failed to post Confluence link comment:', e);
            }
        } catch (e) {
            console.error('Failed to publish to Confluence:', e);
            return { success: false, error: 'Confluence publish failed: ' + e.toString() };
        }
    }

    // 3. Follow-up action: chained script or built-in assign-for-review
    if (cfg.thenAction) {
        try {
            var normalized = String(cfg.thenAction)
                .replace(/^agents\//, '')
                .replace(/^js\//, '');
            var chained = require('./' + normalized);
            if (chained && typeof chained.action === 'function') {
                var chainedResult = chained.action(params);
                result.thenAction = cfg.thenAction;
                result.thenActionResult = chainedResult;
            } else {
                console.warn('thenAction "' + cfg.thenAction + '" has no exported action() — skipped');
            }
        } catch (e) {
            console.error('thenAction "' + cfg.thenAction + '" failed:', e);
            return { success: false, error: 'thenAction failed: ' + e.toString() };
        }
    } else if (cfg.assignForReview !== false) {
        try {
            jiraHelpers.assignForReview(ticketKey, initiatorId, wipLabel, cfg.reviewStatus || config.STATUSES.IN_REVIEW);
        } catch (e) {
            console.warn('assignForReview failed (non-fatal):', e);
        }
    }

    // 4. Token usage comments
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: initiatorId });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }

    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
