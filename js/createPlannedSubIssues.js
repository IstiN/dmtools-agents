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

function action(params) {
    try {
        var ticket = params.ticket;
        if (!ticket || !ticket.key) {
            return { success: false, error: 'No ticket in params' };
        }
        var key = ticket.key;
        var jobParams = params.jobParams || params;
        var customParams = jobParams.customParams || params.customParams || {};
        var projectConfig = configLoader.loadProjectConfig(jobParams) || {};
        var cfg = issuePlan.resolvePlanningConfig(projectConfig, customParams);
        var tracker = trackersModule.createTracker(projectConfig, customParams);

        removeWipLabel(tracker, key, params);
        var result = applyPlan(ticket, cfg, tracker, projectConfig);
        postTokenUsage(tracker, key, params);
        return result;

    } catch (error) {
        console.error('Error in createPlannedSubIssues:', error);
        return { success: false, error: error.toString() };
    }
}

function applyPlan(ticket, cfg, tracker, projectConfig) {
    var key = ticket.key;

    if (ticketLabels(ticket).indexOf(cfg.plannedLabel) !== -1) {
        console.log('createPlannedSubIssues: ' + key + ' already carries "' + cfg.plannedLabel +
            '" — its children exist, nothing to create');
        return { success: true, skipped: true, message: key + ' is already planned' };
    }

    var plan = issuePlan.parsePlan(readText(cfg.planFile), readText, cfg);
    if (!plan.ok) {
        safeComment(tracker, key, 'Planning produced no usable plan: ' + plan.error +
            '. Nothing was created. Fix the plan or start development directly with the label `' +
            cfg.devLabel + '`.');
        return { success: false, error: plan.error };
    }

    if (!plan.split) {
        tracker.addLabel(key, cfg.devLabel);
        safeComment(tracker, key, 'No split needed' + (plan.reason ? ': ' + plan.reason : '.') +
            '\n\nStarting development (label `' + cfg.devLabel + '`).');
        console.log('createPlannedSubIssues: ' + key + ' kept whole, dev label added');
        return { success: true, split: false, message: key + ' kept whole' };
    }

    var jira = projectConfig.jira || {};
    var projectKey = jira.project || null;
    var created = [];
    for (var i = 0; i < plan.children.length; i++) {
        var child = plan.children[i];
        try {
            var childKey = tracker.createTicketWithParent(
                projectKey,
                ISSUE_TYPES.STORY,
                child.title,
                issuePlan.renderChildBody(key, i + 1, plan.children.length, child.body),
                key
            );
            if (!childKey) throw new Error('the tracker returned no key');
            created.push(childKey);
            console.log('createPlannedSubIssues: created ' + childKey + ' (step ' + (i + 1) + ') — ' + child.title);
        } catch (e) {
            var msg = 'Planning stopped: step ' + (i + 1) + ' of ' + plan.children.length +
                ' ("' + child.title + '") could not be created: ' + (e.message || e) + '.';
            if (created.length) {
                msg += ' Already created: ' + created.map(issuePlan.displayRef).join(', ') + '.';
            }
            msg += ' This issue was not marked as planned, so no step starts. Finish the plan by hand' +
                ' (create the missing steps as sub-issues and add the label `' + cfg.plannedLabel + '`)' +
                ' or remove the created steps and plan again.';
            safeComment(tracker, key, msg);
            return { success: false, error: msg, created: created };
        }
    }

    tracker.addLabel(key, cfg.plannedLabel);
    safeComment(tracker, key, issuePlan.renderPlanComment(created, plan.reason, cfg));
    console.log('createPlannedSubIssues: ' + key + ' planned into ' + created.length + ' steps');
    return { success: true, split: true, created: created, message: key + ' planned into ' + created.length + ' steps' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
