/**
 * Create Planned Sub-Issues Post-Action (issue_planning)
 *
 * Materializes the plan the CLI agent wrote to outputs/plan.json
 * (contract: js/common/issuePlan.js):
 *
 *   split:false → the issue stays whole: add the dev label so the dev leg
 *                 starts, and say why in a comment.
 *   split:true  → create each child, in plan order, as a child of the issue
 *                 (a sub-issue on GitHub), add the planned label to the parent
 *                 and post the ordered list. The SM rule plan-advance then
 *                 starts the children one at a time.
 *
 * Idempotent: a parent that already carries the planned label is left alone,
 * so a re-run never duplicates children. A plan that cannot be read, or a
 * child that cannot be created, ends the run with a comment and WITHOUT the
 * planned label — nothing is sequenced from a broken or partial plan.
 *
 * Knobs: customParams.issuePlanning / .dmtools/config.js issuePlanning
 * (devLabel, plannedLabel, maxChildren, planFile).
 */

const { ISSUE_TYPES } = require('./config.js');
const configLoader = require('./configLoader.js');
const trackersModule = require('./common/trackers.js');
const issuePlan = require('./common/issuePlan.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

function readText(path) {
    try {
        return file_read(path) || '';
    } catch (e) {
        try {
            return file_read({ path: path }) || '';
        } catch (e2) {
            return '';
        }
    }
}

function ticketLabels(ticket) {
    if (!ticket) return [];
    if (ticket.fields && Array.isArray(ticket.fields.labels)) return ticket.fields.labels;
    return Array.isArray(ticket.labels) ? ticket.labels : [];
}

function safeComment(tracker, key, text) {
    try {
        tracker.postComment(key, text);
    } catch (e) {
        console.warn('createPlannedSubIssues: could not comment on ' + key + ': ' + e);
    }
}

function removeWipLabel(tracker, key, params) {
    var contextId = params.metadata && params.metadata.contextId;
    if (!contextId) return;
    try {
        tracker.removeLabel(key, contextId + '_wip');
    } catch (e) {
        // The label is usually absent; nothing to clean up.
    }
}

function postTokenUsage(tracker, key, params) {
    // Token usage summary comments (e.g. [issue_planning]: {...}) if the provider
    // wrote outputs/*_usage.json during the agent run.
    try {
        tokenUsageComment.postTokenUsageComments(key, { initiator: params.initiator, tracker: tracker });
    } catch (e) {
        console.warn('createPlannedSubIssues: could not post token usage comments: ' + e);
    }
}

// Everything one run needs: the ticket key, the planning config, the tracker, the project config.
function runContext(params) {
    var jobParams = params.jobParams || params;
    var customParams = jobParams.customParams || params.customParams || {};
    var projectConfig = configLoader.loadProjectConfig(jobParams) || {};
    return {
        key: params.ticket.key,
        cfg: issuePlan.resolvePlanningConfig(projectConfig, customParams),
        tracker: trackersModule.createTracker(projectConfig, customParams),
        projectKey: (projectConfig.jira || {}).project || null
    };
}

function action(params) {
    if (!params.ticket || !params.ticket.key) {
        return { success: false, error: 'No ticket in params' };
    }
    try {
        var ctx = runContext(params);
        removeWipLabel(ctx.tracker, ctx.key, params);
        var result = applyPlan(params.ticket, ctx);
        postTokenUsage(ctx.tracker, ctx.key, params);
        return result;
    } catch (error) {
        console.error('Error in createPlannedSubIssues:', error);
        return { success: false, error: error.toString() };
    }
}

function applyPlan(ticket, ctx) {
    if (ticketLabels(ticket).indexOf(ctx.cfg.plannedLabel) !== -1) {
        console.log('createPlannedSubIssues: ' + ctx.key + ' already carries "' + ctx.cfg.plannedLabel +
            '" — its children exist, nothing to create');
        return { success: true, skipped: true, message: ctx.key + ' is already planned' };
    }
    var plan = issuePlan.parsePlan(readText(ctx.cfg.planFile), readText, ctx.cfg);
    if (!plan.ok) return rejectPlan(ctx, plan.error);
    return plan.split ? splitIssue(ctx, plan) : keepWhole(ctx, plan);
}

function rejectPlan(ctx, error) {
    safeComment(ctx.tracker, ctx.key, 'Planning produced no usable plan: ' + error +
        '. Nothing was created. Fix the plan or start development directly with the label `' +
        ctx.cfg.devLabel + '`.');
    return { success: false, error: error };
}

function keepWhole(ctx, plan) {
    ctx.tracker.addLabel(ctx.key, ctx.cfg.devLabel);
    safeComment(ctx.tracker, ctx.key, 'No split needed' + (plan.reason ? ': ' + plan.reason : '.') +
        '\n\nStarting development (label `' + ctx.cfg.devLabel + '`).');
    console.log('createPlannedSubIssues: ' + ctx.key + ' kept whole, dev label added');
    return { success: true, split: false, message: ctx.key + ' kept whole' };
}

// Create step `index` (0-based) as a child of the issue; returns the child's key or throws.
function createStep(ctx, plan, index) {
    var child = plan.children[index];
    var childKey = ctx.tracker.createTicketWithParent(
        ctx.projectKey,
        ISSUE_TYPES.STORY,
        child.title,
        issuePlan.renderChildBody(ctx.key, index + 1, plan.children.length, child.body),
        ctx.key
    );
    if (!childKey) throw new Error('the tracker returned no key');
    console.log('createPlannedSubIssues: created ' + childKey + ' (step ' + (index + 1) + ') — ' + child.title);
    return childKey;
}

function stoppedMessage(ctx, plan, index, error, created) {
    var msg = 'Planning stopped: step ' + (index + 1) + ' of ' + plan.children.length +
        ' ("' + plan.children[index].title + '") could not be created: ' + (error.message || error) + '.';
    if (created.length) {
        msg += ' Already created: ' + created.map(issuePlan.displayRef).join(', ') + '.';
    }
    return msg + ' This issue was not marked as planned, so no step starts. Finish the plan by hand' +
        ' (create the missing steps as sub-issues and add the label `' + ctx.cfg.plannedLabel + '`)' +
        ' or remove the created steps and plan again.';
}

function splitIssue(ctx, plan) {
    var created = [];
    for (var i = 0; i < plan.children.length; i++) {
        try {
            created.push(createStep(ctx, plan, i));
        } catch (e) {
            var msg = stoppedMessage(ctx, plan, i, e, created);
            safeComment(ctx.tracker, ctx.key, msg);
            return { success: false, error: msg, created: created };
        }
    }
    ctx.tracker.addLabel(ctx.key, ctx.cfg.plannedLabel);
    safeComment(ctx.tracker, ctx.key, issuePlan.renderPlanComment(created, plan.reason, ctx.cfg));
    console.log('createPlannedSubIssues: ' + ctx.key + ' planned into ' + created.length + ' steps');
    return { success: true, split: true, created: created, message: ctx.key + ' planned into ' + created.length + ' steps' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
