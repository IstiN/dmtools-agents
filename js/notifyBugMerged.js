/**
 * Notify Bug Merged Post-Action
 * postJSAction for bug_merged agent.
 *
 * Called when a Bug PR is merged and the ticket reaches "Merged" status.
 * 1. Generates RCA + prevention summary and writes it to the Solution field.
 * 2. Posts a Jira comment.
 * 3. Removes SM idempotency label.
 * Status transition to "Ready For Testing" is handled by the SM targetStatus rule.
 */

const { loadProjectConfig } = require('./configLoader.js');
const { aiChat } = require('./common/aiChat.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}

/**
 * Find the bug fix development comment from Jira comments.
 * The bug_development agent posts a comment that contains "Bug Fix Summary"
 * or "Root Cause" sections from outputs/response.md.
 */
function findDevSummaryComment(comments) {
    if (!comments || !Array.isArray(comments)) return '';
    const markers = ['Bug Fix Summary', 'Root Cause', 'rca.md', 'Fix Applied'];
    const found = comments.filter(function(c) {
        const body = c.body || '';
        return markers.some(function(m) { return body.indexOf(m) !== -1; });
    });
    // Use the most recent matching comment
    return found.length > 0 ? found[found.length - 1].body : '';
}

function resolveProjectConfig(params) {
    return loadProjectConfig(params && params.jobParams ? params.jobParams : params);
}

function _configuredBugSolutionField(fields) {
    if (!fields) return 'Solution';
    return fields.bugSolution || fields.solution || 'Solution';
}

/**
 * Use AI to generate a Solution field value from the bug description + dev summary.
 * Writes the result to the Jira "Solution" field so the TestCasesGenerator
 * has RCA context when generating regression and prevention test cases.
 */
function resolveBugSolutionField(params) {
    const config = resolveProjectConfig(params);
    return _configuredBugSolutionField(config && config.jira && config.jira.fields);
}

function updateSolutionField(ticketKey, ticketDescription, comments, params) {
    try {
        const devSummary = findDevSummaryComment(comments);
        const solutionField = resolveBugSolutionField(params);
        if (!solutionField) {
            console.warn('Bug Solution field is not configured — skipping Solution field update');
            return;
        }

        const prompt =
            'You are writing the *Solution* field for a Jira Bug ticket.\n' +
            'The field must be in Jira Markup and cover three sections:\n\n' +
            'h4. Root Cause\n' +
            '1-3 sentences: the exact technical cause of the bug (file / function / condition if known).\n\n' +
            'h4. Fix Applied\n' +
            '1-3 sentences: what was changed and why.\n\n' +
            'h4. Prevention\n' +
            '1-3 bullet points: what tests, patterns, or guards prevent this class of bug from recurring.\n\n' +
            'Bug Description:\n' +
            (ticketDescription || '(not available)') + '\n\n' +
            'Bug Fix Summary (from development agent):\n' +
            (devSummary || '(not available)') + '\n\n' +
            'Write ONLY the field content — no preamble, no markdown fences.';

        const solution = aiChat(prompt);
        if (!solution || solution.trim() === '') {
            console.warn('AI returned empty solution — skipping Solution field update');
            return;
        }

        getTracker().updateField(ticketKey, solutionField, solution.trim());
        console.log('✅ Updated ' + solutionField + ' field with RCA + prevention summary');
    } catch (e) {
        console.warn('Failed to update Solution field:', e.message || e);
    }
}

/**
 * gh-1188: pure input resolution extracted from action — jobParams win,
 * then the bare params' own customParams, then an empty object.
 */
function resolveActionCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

function resolveTicketDescription(ticket) {
    return ticket && ticket.fields && ticket.fields.description
        ? ticket.fields.description : '';
}

/**
 * gh-1188: merge-notification body extracted from action so the wording is a
 * pure, unit-testable constant.
 */
function buildMergeNotificationComment() {
    return 'h3. ✅ Bug Fix Merged — Ready for Testing\n\n' +
        'The bug fix PR has been merged and the ticket has been moved to *Ready For Testing*.\n\n' +
        'The *Solution* field has been updated with the Root Cause Analysis and prevention notes for use by the test case generator.';
}

/**
 * gh-1188: comment fetch step extracted from action — a tracker read failure
 * degrades to no comments (as before), never a throw.
 */
function fetchCommentsForRca(ticketKey) {
    try {
        const comments = getTracker().getComments(ticketKey) || [];
        console.log('Fetched', comments.length, 'comments for RCA extraction');
        return comments;
    } catch (e) {
        console.warn('Could not fetch comments:', e);
        return [];
    }
}

function postMergeNotification(ticketKey) {
    try {
        getTracker().postComment(ticketKey, buildMergeNotificationComment());
        console.log('✅ Posted merge notification to Jira');
    } catch (e) {
        console.warn('Failed to post Jira comment:', e);
    }
}

function resolveWipLabel(params) {
    return params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip' : null;
}

function resolveSmRemoveLabel(params) {
    const customParams = params.jobParams && params.jobParams.customParams;
    return customParams && customParams.removeLabel;
}

function removeWipLabel(ticketKey, params) {
    const wipLabel = resolveWipLabel(params);
    if (wipLabel) {
        try { getTracker().removeLabel(ticketKey, wipLabel); } catch (e) {}
    }
}

function removeSmLabel(ticketKey, params) {
    const removeLabel = resolveSmRemoveLabel(params);
    if (removeLabel) {
        try {
            getTracker().removeLabel(ticketKey, removeLabel);
            console.log('✅ Removed SM label:', removeLabel);
        } catch (e) {}
    }
}

/**
 * gh-1188: token-usage summary step extracted from action — a provider
 * failure here must never fail the merge notification.
 */
function postTokenUsageSafely(ticketKey, projectConfig, params) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, config: projectConfig, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const projectConfig = resolveProjectConfig(params);
        initTracker(projectConfig, resolveActionCustomParams(params));
        const ticketDescription = resolveTicketDescription(params.ticket);
        console.log('=== Bug merged notification for', ticketKey, '===');

        // Step 1: Fetch ticket comments for RCA extraction
        const comments = fetchCommentsForRca(ticketKey);

        // Step 2: Update Solution field with AI-generated RCA + prevention
        updateSolutionField(ticketKey, ticketDescription, comments, params);

        // Step 3: Post merge notification
        postMergeNotification(ticketKey);

        // Step 4: Remove WIP label
        removeWipLabel(ticketKey, params);

        // Step 5: Remove SM idempotency label
        removeSmLabel(ticketKey, params);

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        postTokenUsageSafely(ticketKey, projectConfig, params);

        return { success: true, ticketKey };

    } catch (error) {
        console.error('❌ Error in notifyBugMerged:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        // gh-1188: step helpers extracted from action — exported for direct
        // characterization tests.
        resolveActionCustomParams,
        resolveTicketDescription,
        buildMergeNotificationComment,
        fetchCommentsForRca,
        postMergeNotification,
        resolveWipLabel,
        resolveSmRemoveLabel,
        removeWipLabel,
        removeSmLabel,
        postTokenUsageSafely,
        updateSolutionField,
        findDevSummaryComment
    };
}
