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
 *
 * The action is split into small decide/build/step helpers (gh-1037 CRAP
 * refactor). Every helper preserves the original log lines, tracker/SCM
 * call order and return shapes — the orchestration in `action` alone decides
 * sequencing and early returns.
 */

var contentOutput = require('./common/contentOutput.js');
var outputFiles = require('./common/outputFiles.js');
var jiraHelpers = require('./common/jiraHelpers.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackersModule = require('./common/trackers.js');
var config = require('./config.js');
// Load-time require (gh-823): a deferred require would resolve against the
// pack js/ root only — hoist every require to the top of the module.
var configLoader = require('./configLoader.js');

// ---------------------------------------------------------------------------
// Parse/build helpers (pure)
// ---------------------------------------------------------------------------

/** 'ctx_wip' label from metadata.contextId, null when absent. */
function buildWipLabel(params) {
    return params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : null;
}

/** The target=..., field=..., confluence=... suffix of the startup log line. */
function describeTarget(cfg) {
    return 'target=' + cfg.target +
        ', field=' + (cfg.field || '(none)') +
        ', confluence=' + (cfg.space || '?') + '/' + (cfg.parentPageId || '?');
}

/** loadProjectConfig is optional — any failure leaves it null. */
function loadProjectConfigSafe(params) {
    try {
        return configLoader.loadProjectConfig(params.jobParams || params);
    } catch (e) { /* optional */ return null; }
}

function createTrackerFor(params, projectConfig) {
    return trackersModule.createTracker(projectConfig,
        (params.jobParams && params.jobParams.customParams) || params.customParams || {});
}

/** Trimmed outputs/response.md, or null (after logging) when missing/empty. */
function readResponseContent(ticketKey, workingDir) {
    var content = outputFiles.readOutputFile('response.md', {
        ticketKey: ticketKey,
        workingDir: workingDir
    });
    if (!content || !content.trim()) {
        console.error('outputs/response.md not found or empty');
        return null;
    }
    return content.trim();
}

// ---------------------------------------------------------------------------
// Step helpers — each preserves the original side effects, log lines and
// failure return shapes; they return `result` unchanged on success.
// ---------------------------------------------------------------------------

/** Step 1: Jira field (default behavior). */
function writeJiraFieldStep(result, cfg, ticketKey, content, tracker) {
    if (!contentOutput.isJiraFieldTarget(cfg)) return result;
    if (!cfg.field) {
        return { success: false, error: 'contentOutput.field is required for jira_field target' };
    }
    try {
        contentOutput.writeToTrackerField(ticketKey, cfg.field, content, cfg.operationType || 'replace', tracker);
        console.log('Updated "' + cfg.field + '" field for ' + ticketKey);
        result.field = cfg.field;
    } catch (e) {
        console.error('Failed to update field "' + cfg.field + '":', e);
        return { success: false, error: 'Field update failed: ' + e.toString() };
    }
    return result;
}

function logReplySummary(replies) {
    if (replies.posted > 0 || replies.failed > 0) {
        console.log('Replied to ' + replies.posted + ' inline comment(s)' +
            (replies.failed > 0 ? ', ' + replies.failed + ' failed' : ''));
    }
}

/** Tracker-field link line for a published Confluence page. */
function buildConfluenceLinkText(pageUrl, pageId) {
    return pageUrl
        ? 'Published to Confluence: ' + pageUrl
        : 'Published to Confluence page ' + pageId;
}

/** Tracker comment body for a published Confluence page. */
function buildConfluenceCommentText(pageUrl, pageId) {
    return 'h3. 📄 Content published to Confluence\n\n' +
        (pageUrl ? 'Page: ' + pageUrl : 'Page id: ' + pageId);
}

/** Wiki-only: write the page link into the tracker field (non-fatal). */
function writeConfluenceLinkToField(cfg, ticketKey, pageUrl, pageId, tracker) {
    // gh-1112: 'wiki' is a first-class alias of 'confluence' — the link write
    // applies to both. 'both' is excluded: the field already carries the full
    // content from the jira-field step.
    if (cfg.updateTrackerField !== false &&
        contentOutput.isConfluenceTarget(cfg) && !contentOutput.isJiraFieldTarget(cfg)) {
        try {
            contentOutput.writeToTrackerField(ticketKey, cfg.field || 'Description', buildConfluenceLinkText(pageUrl, pageId), 'replace', tracker);
        } catch (e) {
            console.warn('Failed to write Confluence link to tracker field:', e);
        }
    }
}

/** Post the "Content published" comment on the ticket (non-fatal). */
function postConfluenceLinkComment(tracker, ticketKey, pageUrl, pageId) {
    try {
        tracker.postComment(ticketKey, buildConfluenceCommentText(pageUrl, pageId));
    } catch (e) {
        console.warn('Failed to post Confluence link comment:', e);
    }
}

/** Step 2: Confluence page (replies first, then page body). */
function publishConfluenceStep(result, cfg, ticketKey, summary, content, tracker) {
    if (!contentOutput.isConfluenceTarget(cfg)) return result;
    try {
        // Post replies to inline comments BEFORE the page body is replaced —
        // while the comment anchors are still alive on the old content.
        var replies = contentOutput.publishCommentReplies(contentOutput.DEFAULT_REPLIES_FILE);
        result.replies = replies;
        logReplySummary(replies);

        var published = contentOutput.publishPage(cfg, ticketKey, summary, content);
        result.pageId = published.page && published.page.id;
        result.pageUrl = published.url;
        result.pageCreated = published.created;
        console.log('Published content to Confluence page ' + result.pageId + ' (' + (result.pageUrl || 'url unknown') + ')');

        writeConfluenceLinkToField(cfg, ticketKey, result.pageUrl, result.pageId, tracker);
        postConfluenceLinkComment(tracker, ticketKey, result.pageUrl, result.pageId);
    } catch (e) {
        console.error('Failed to publish to Confluence:', e);
        return { success: false, error: 'Confluence publish failed: ' + e.toString() };
    }
    return result;
}

function normalizeThenActionPath(thenAction) {
    return String(thenAction)
        .replace(/^agents\//, '')
        .replace(/^js\//, '');
}

function runThenAction(cfg, params, result) {
    var normalized = normalizeThenActionPath(cfg.thenAction);
    var chained = require('./' + normalized);
    if (chained && typeof chained.action === 'function') {
        var chainedResult = chained.action(params);
        result.thenAction = cfg.thenAction;
        result.thenActionResult = chainedResult;
    } else {
        console.warn('thenAction "' + cfg.thenAction + '" has no exported action() — skipped');
    }
    return result;
}

/** Step 3: follow-up action — chained script or built-in assign-for-review. */
function runFollowUpStep(params, cfg, ticketKey, initiatorId, wipLabel, result, tracker) {
    if (cfg.thenAction) {
        try {
            runThenAction(cfg, params, result);
        } catch (e) {
            console.error('thenAction "' + cfg.thenAction + '" failed:', e);
            return { success: false, error: 'thenAction failed: ' + e.toString() };
        }
    } else if (cfg.assignForReview !== false) {
        try {
            jiraHelpers.assignForReview(ticketKey, initiatorId, wipLabel, cfg.reviewStatus || config.STATUSES.IN_REVIEW, tracker);
        } catch (e) {
            console.warn('assignForReview failed (non-fatal):', e);
        }
    }
    return result;
}

/** Step 4: token usage comments (non-fatal). */
function postTokenUsageStep(ticketKey, initiatorId, tracker) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: initiatorId, tracker: tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

// ---------------------------------------------------------------------------
// Main action
// ---------------------------------------------------------------------------

function action(params) {
    var ticket = params.ticket || {};
    var ticketKey = ticket.key;
    if (!ticketKey) {
        console.error('writeContentOutput: no ticket key');
        return { success: false, error: 'missing ticket key' };
    }
    var summary = (ticket.fields && ticket.fields.summary) || '';
    var initiatorId = params.initiator;
    var wipLabel = buildWipLabel(params);

    var cfg = contentOutput.resolveConfig(params);
    console.log('writeContentOutput for ' + ticketKey + ': ' + describeTarget(cfg));

    var projectConfig = loadProjectConfigSafe(params);
    var tracker = createTrackerFor(params, projectConfig);

    var content = readResponseContent(ticketKey, (projectConfig && projectConfig.workingDir) || null);
    if (content === null) {
        return { success: false, error: 'outputs/response.md is empty' };
    }

    var result = { success: true, ticketKey: ticketKey, target: cfg.target };

    // 1. Jira field (default behavior)
    var stepResult = writeJiraFieldStep(result, cfg, ticketKey, content, tracker);
    if (stepResult !== result) return stepResult;

    // 2. Confluence page
    stepResult = publishConfluenceStep(result, cfg, ticketKey, summary, content, tracker);
    if (stepResult !== result) return stepResult;

    // 3. Follow-up action: chained script or built-in assign-for-review
    stepResult = runFollowUpStep(params, cfg, ticketKey, initiatorId, wipLabel, result, tracker);
    if (stepResult !== result) return stepResult;

    // 4. Token usage comments
    postTokenUsageStep(ticketKey, initiatorId, tracker);

    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        buildWipLabel: buildWipLabel,
        describeTarget: describeTarget,
        loadProjectConfigSafe: loadProjectConfigSafe,
        createTrackerFor: createTrackerFor,
        readResponseContent: readResponseContent,
        writeJiraFieldStep: writeJiraFieldStep,
        logReplySummary: logReplySummary,
        buildConfluenceLinkText: buildConfluenceLinkText,
        buildConfluenceCommentText: buildConfluenceCommentText,
        writeConfluenceLinkToField: writeConfluenceLinkToField,
        postConfluenceLinkComment: postConfluenceLinkComment,
        publishConfluenceStep: publishConfluenceStep,
        normalizeThenActionPath: normalizeThenActionPath,
        runThenAction: runThenAction,
        runFollowUpStep: runFollowUpStep,
        postTokenUsageStep: postTokenUsageStep
    };
}
