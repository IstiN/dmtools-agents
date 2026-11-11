/**
 * Post Bug Creation Action (postJSAction for bug_creation agent)
 *
 * Reads outputs/bug_decision.json written by the AI:
 *   { "action": "link", "existingKey": "PROJ-XXX" }
 *   { "action": "create", "summary": "...", "description": "outputs/bug_description.md" }
 *   { "action": "none", "reason": "..." }
 *
 * For link/create: links/creates bug, moves TC to "Bug To Fix", removes trigger labels.
 * For none:        posts comment, moves TC to In Rework, removes trigger labels.
 *
 * Link direction: Bug "blocks" TC (TC is blocked by the Bug until it's fixed).
 */

const { LABELS } = require('./config.js');
const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const trackersModule = require('./common/trackers.js');

var MISSING_DECISION_COMMENT = 'h3. ⚠️ Bug Creation Error\n\nCould not read bug_decision.json. Check workflow logs.';
var MISSING_SUMMARY_COMMENT = 'h3. ⚠️ Bug Creation Skipped\n\nNo summary provided in bug_decision.json.';
var CREATED_NO_KEY_COMMENT = 'h3. ⚠️ Bug Created (key not extracted)\n\nBug was created but key could not be parsed from result.';
var TESTS_PASSED_DEFAULT_REASON = 'All tests passed in the most recent run — the underlying issue has been fixed.';
var NO_BUG_DEFAULT_REASON = 'AI determined no bug creation or linking is required.';

function readFile(path) {
    try {
        var content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        return null;
    }
}

function readDecisionJson() {
    try {
        var raw = readFile('outputs/bug_decision.json');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse bug_decision.json:', e);
        return null;
    }
}

function extractKeyFromResult(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        // jira_create_ticket_basic returns a JSON string: {"id":"...","key":"PROJ-123",...}
        try {
            var parsed = JSON.parse(result);
            if (parsed && parsed.key) return parsed.key;
        } catch (e) {}
        // fallback: try /browse/ URL pattern
        var urlMatch = result.match(/\/browse\/([A-Z]+-\d+)/);
        if (urlMatch) return urlMatch[1];
        // tracker.createTicket already returns the bare key (e.g. PROJ-123 or an ADO id)
        return /^[A-Za-z0-9_.#\/-]+$/.test(result.trim()) ? result.trim() : null;
    }
    return result.key || null;
}

function linkBugToTC(tracker, ticketKey, bugKey) {
    // Bug "blocks" TC: sourceKey=TC, anotherKey=Bug, relationship='Blocks'
    // → Bug is the blocker, TC is blocked (TC cannot pass until bug is fixed)
    tracker.linkIssues(ticketKey, bugKey, 'Blocks');
    console.log('✅ Linked:', bugKey, 'blocks', ticketKey);
}

function moveFailedTcToRework(tracker, ticketKey, jiraConfig) {
    tracker.moveToStatus(ticketKey, jiraConfig.statuses.IN_REWORK);
    console.log('🔧 Moved', ticketKey, 'to', jiraConfig.statuses.IN_REWORK);
    try {
        tracker.removeLabel(ticketKey, 'sm_test_automation_triggered');
        console.log('✅ Removed sm_test_automation_triggered');
    } catch (e) {}
}

// ── Comment builders (pure) ────────────────────────────────────────────────

function buildLinkedComment(bugKey, reason) {
    return 'h3. 🔗 Existing Bug Linked\n\n' +
        'Found matching bug: *' + bugKey + '*\n\n' +
        (reason ? '_' + reason + '_' : '');
}

function buildLinkFailedComment(bugKey, error) {
    return 'h3. ⚠️ Bug Link Failed\n\n' +
        'Found matching bug *' + bugKey + '* but could not create link: ' + error;
}

function buildCreatedComment(bugKey, summary, reason) {
    return 'h3. 🐛 New Bug Created\n\n' +
        'Created: *' + bugKey + '*\n' +
        '*Summary*: ' + summary + '\n\n' +
        (reason ? '_' + reason + '_' : '');
}

function buildCreateFailedComment(error) {
    return 'h3. ❌ Bug Creation Failed\n\n{code}' + error.toString() + '{code}';
}

function buildTestsPassComment(reason) {
    var text = reason || TESTS_PASSED_DEFAULT_REASON;
    return 'h3. ✅ Tests Passing — Moving to Passed\n\n' + text +
        '\n\n_Ticket status was stale. TC automatically moved to *Passed*._';
}

function buildNoBugComment(reason) {
    var text = reason || NO_BUG_DEFAULT_REASON;
    return 'h3. ℹ️ No Bug Created\n\n' + text +
        '\n\n_TC moved to *In Rework* so the test automation can be fixed instead of staying in *Failed*._';
}

function buildActionErrorComment(error) {
    return 'h3. ❌ Bug Creation Error\n\n{code}' + error.toString() + '{code}';
}

// ── Run context ────────────────────────────────────────────────────────────

function resolveWipLabel(metadata) {
    if (metadata && metadata.contextId) {
        return metadata.contextId + '_wip';
    }
    return 'bug_creation_wip';
}

function buildActionContext(params) {
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var tracker = trackersModule.createTracker(projectConfig, (params.jobParams && params.jobParams.customParams) || params.customParams || {});
    var customParams = params.jobParams && params.jobParams.customParams;
    return {
        params: params,
        ticketKey: params.ticket.key,
        jiraConfig: projectConfig.jira,
        tracker: tracker,
        smTriggerLabel: customParams && customParams.removeLabel,
        wipLabel: resolveWipLabel(params.metadata)
    };
}

// ── Small tracker wrappers (failure-tolerant, matching the original flow) ──

function tryPostComment(ctx, comment) {
    try {
        ctx.tracker.postComment(ctx.ticketKey, comment);
    } catch (e) {
        console.warn('Failed to post Jira comment:', e);
    }
}

function removeLabelQuietly(tracker, ticketKey, label) {
    try {
        tracker.removeLabel(ticketKey, label);
    } catch (e) {}
}

function removeSmTriggerLabel(ctx) {
    if (!ctx.smTriggerLabel) return;
    try {
        ctx.tracker.removeLabel(ctx.ticketKey, ctx.smTriggerLabel);
        console.log('✅ Removed SM trigger label:', ctx.smTriggerLabel);
    } catch (e) {}
}

function tryLinkBugToTc(ctx, bugKey) {
    try {
        linkBugToTC(ctx.tracker, ctx.ticketKey, bugKey);
        return { ok: true, error: null };
    } catch (e) {
        console.warn('Failed to link existing bug:', e);
        return { ok: false, error: e };
    }
}

function moveTcToBugToFix(ctx, bugLinked) {
    if (!bugLinked) return;
    try {
        // gh-916: BUG_TO_FIX can be tag-only (restricted ADO workflows) — stage-label fallback.
        var b2fMove = ctx.tracker.moveToStatusOrMark(ctx.ticketKey, ctx.jiraConfig.statuses.BUG_TO_FIX, 'BUG_TO_FIX');
        if (b2fMove.moved || b2fMove.marked) {
            console.log('✅ Moved', ctx.ticketKey, 'to', ctx.jiraConfig.statuses.BUG_TO_FIX);
        }
    } catch (e) {
        console.warn('Failed to move to Bug To Fix:', e);
    }
}

function moveBugToReady(ctx, bugKey, bugLinked) {
    if (!bugLinked || !bugKey) return;
    try {
        ctx.tracker.moveToStatus(bugKey, ctx.jiraConfig.statuses.READY_FOR_DEVELOPMENT);
        console.log('✅ Moved bug', bugKey, 'to', ctx.jiraConfig.statuses.READY_FOR_DEVELOPMENT);
    } catch (e) {
        console.warn('Failed to move bug to Ready For Development:', e);
    }
}

function moveTcToPassed(ctx) {
    try {
        // gh-916: PASSED can be tag-only (restricted ADO workflows) — stage-label fallback.
        var passMove = ctx.tracker.moveToStatusOrMark(ctx.ticketKey, ctx.jiraConfig.statuses.PASSED, 'PASSED');
        if (passMove.moved || passMove.marked) {
            console.log('✅ Tests pass — moved', ctx.ticketKey, 'to', ctx.jiraConfig.statuses.PASSED);
        }
    } catch (e) {
        console.warn('Failed to move to Passed:', e);
    }
}

function postTokenUsage(ctx) {
    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run.
    try {
        tokenUsageComment.postTokenUsageComments(ctx.ticketKey, { initiator: ctx.params.initiator, customParams: tokenUsageComment.customParamsOf(ctx.params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

// ── Shared tail for link/create outcomes ───────────────────────────────────

function finishLinkedOutcome(ctx, outcome) {
    tryPostComment(ctx, outcome.comment);
    moveTcToBugToFix(ctx, outcome.bugLinked);
    moveBugToReady(ctx, outcome.bugKey, outcome.bugLinked);
    removeLabelQuietly(ctx.tracker, ctx.ticketKey, ctx.wipLabel);
    removeSmTriggerLabel(ctx);
    // Always remove sm_test_automation_triggered when TC reaches Bug To Fix.
    // The test automation agent leaves this label on Failed TCs — it must be
    // cleaned up here so the TC can be re-triggered after the bug is fixed.
    removeLabelQuietly(ctx.tracker, ctx.ticketKey, 'sm_test_automation_triggered');
    console.log('✅ Bug creation workflow complete for', ctx.ticketKey, '— bugKey:', outcome.bugKey || 'none');
    postTokenUsage(ctx);
    return { success: true, ticketKey: ctx.ticketKey, bugKey: outcome.bugKey, action: outcome.action };
}

// ── Decision handlers ──────────────────────────────────────────────────────

function reportMissingDecision(ctx) {
    ctx.tracker.postComment(ctx.ticketKey, MISSING_DECISION_COMMENT);
    removeLabelQuietly(ctx.tracker, ctx.ticketKey, ctx.wipLabel);
    // KEEP sm_bug_creation_triggered label — TC stays in Failed, removing
    // the label would cause SM to re-trigger in an infinite loop.
    return { success: false, error: 'No bug_decision.json' };
}

function reportMissingSummary(ctx) {
    ctx.tracker.postComment(ctx.ticketKey, MISSING_SUMMARY_COMMENT);
    removeLabelQuietly(ctx.tracker, ctx.ticketKey, ctx.wipLabel);
    // KEEP sm_bug_creation_triggered — TC stays Failed, prevent re-fire loop.
    return { success: false, error: 'No bug summary' };
}

function resolveBugDescription(decision) {
    var fromFile = decision.description ? readFile(decision.description) : null;
    return fromFile || decision.descriptionText || decision.summary;
}

function tryCreateBug(ctx, decision) {
    var projectKey = ctx.ticketKey.split('-')[0];
    var description = resolveBugDescription(decision);
    try {
        var result = ctx.tracker.createTicket(projectKey, 'Bug', decision.summary, description);
        return { ok: true, bugKey: extractKeyFromResult(result) };
    } catch (e) {
        console.error('Failed to create bug:', e);
        return { ok: false, error: e };
    }
}

function outcomeForCreatedKey(ctx, decision, bugKey) {
    if (!bugKey) {
        return { bugKey: null, bugLinked: false, comment: CREATED_NO_KEY_COMMENT, action: 'create' };
    }
    var link = tryLinkBugToTc(ctx, bugKey);
    var comment = link.ok
        ? buildCreatedComment(bugKey, decision.summary, decision.reason)
        : buildCreateFailedComment(link.error);
    // Keep the extracted key in the result even when linking failed — the bug exists.
    return { bugKey: bugKey, bugLinked: link.ok, comment: comment, action: 'create' };
}

function buildCreateOutcome(ctx, decision, attempt) {
    if (!attempt.ok) {
        return { bugKey: null, bugLinked: false, comment: buildCreateFailedComment(attempt.error), action: 'create' };
    }
    return outcomeForCreatedKey(ctx, decision, attempt.bugKey);
}

function handleLinkDecision(ctx, decision) {
    var link = tryLinkBugToTc(ctx, decision.existingKey);
    var comment = link.ok
        ? buildLinkedComment(decision.existingKey, decision.reason)
        : buildLinkFailedComment(decision.existingKey, link.error);
    return finishLinkedOutcome(ctx, {
        bugKey: decision.existingKey,
        bugLinked: link.ok,
        comment: comment,
        action: 'link'
    });
}

function handleCreateDecision(ctx, decision) {
    if (!decision.summary) {
        return reportMissingSummary(ctx);
    }
    var attempt = tryCreateBug(ctx, decision);
    return finishLinkedOutcome(ctx, buildCreateOutcome(ctx, decision, attempt));
}

function handleTestsPassDecision(ctx, decision) {
    tryPostComment(ctx, buildTestsPassComment(decision.reason));
    moveTcToPassed(ctx);
    removeLabelQuietly(ctx.tracker, ctx.ticketKey, ctx.wipLabel);
    removeSmTriggerLabel(ctx);
    return { success: true, ticketKey: ctx.ticketKey, bugKey: null, action: 'tests_pass' };
}

function handleNoneDecision(ctx, decision) {
    // action: none — test code issue, not an app bug
    tryPostComment(ctx, buildNoBugComment(decision.reason));
    moveFailedTcToRework(ctx.tracker, ctx.ticketKey, ctx.jiraConfig);
    removeLabelQuietly(ctx.tracker, ctx.ticketKey, ctx.wipLabel);
    removeSmTriggerLabel(ctx);
    console.log('ℹ️ No product bug for', ctx.ticketKey, '— moved to In Rework for test automation fixes');
    return { success: true, ticketKey: ctx.ticketKey, bugKey: null, action: 'none' };
}

function dispatchDecision(ctx, decision) {
    if (decision.action === 'link' && decision.existingKey) {
        return handleLinkDecision(ctx, decision);
    }
    if (decision.action === 'create') {
        return handleCreateDecision(ctx, decision);
    }
    if (decision.action === 'tests_pass') {
        return handleTestsPassDecision(ctx, decision);
    }
    return handleNoneDecision(ctx, decision);
}

function reportActionFailure(params, error, ctx) {
    console.error('❌ Error in postBugCreation:', error);
    var tracker = ctx ? ctx.tracker : null;
    if (tracker) {
        try {
            tracker.postComment(params.ticket.key, buildActionErrorComment(error));
        } catch (e) {}
    }
    // Release SM trigger label so SM can retry next cycle
    var customParamsOnErr = params.jobParams && params.jobParams.customParams;
    var smLabelOnErr = customParamsOnErr && customParamsOnErr.removeLabel;
    if (smLabelOnErr) {
        try {
            tracker.removeLabel(params.ticket.key, smLabelOnErr);
        } catch (e) {}
    }
    return { success: false, error: error.toString() };
}

function action(params) {
    var ctx = null;
    try {
        ctx = buildActionContext(params);
        console.log('=== Processing bug creation decision for', ctx.ticketKey, '===');

        var decision = readDecisionJson();
        if (!decision) {
            return reportMissingDecision(ctx);
        }

        console.log('Decision:', decision.action, decision.existingKey || decision.summary || '');

        return dispatchDecision(ctx, decision);
    } catch (error) {
        return reportActionFailure(params, error, ctx);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
