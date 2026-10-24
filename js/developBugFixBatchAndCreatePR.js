/**
 * Post-CLI Bug-fix Batch Development Action
 *
 * Runs after the bug_fix_batch_development CLI agent finishes.
 * 1. Ensures a PR exists for the batch branch.
 * 2. Moves the Epic and all linked batch bugs to In Review.
 * 3. Adds the ai_developed label to the Epic and all linked batch bugs.
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var batchContext = require('./prepareBugFixBatchContext.js');
const { LABELS, STATUSES, resolveStatuses } = require('./config.js');
var bugFixBatchCtx = require('./common/bugFixBatchContext.js');

function findExistingPR(branchName) {
    try {
        var output = bugFixBatchCtx.cleanCommandOutput(
            bugFixBatchCtx.runCmd('gh pr list --head ' + branchName + ' --json url --jq ".[0].url"') || ''
        );
        if (output && output.startsWith('https://')) {
            return output;
        }
    } catch (e) {
        console.warn('Could not list PR for branch ' + branchName + ':', e);
    }
    return null;
}

function pushEpicSection(lines, epic, epicFields) {
    lines.push('## Epic');
    lines.push('');
    lines.push('**' + epic.key + '**: ' + (epicFields.summary || ''));
    if (epicFields.description) {
        lines.push('');
        lines.push(epicFields.description);
    }
}

function pushBugLine(lines, bug) {
    var f = bug.fields || {};
    lines.push('- **' + bug.key + '** — ' + (f.summary || '(no summary)'));
}

function pushBugsSection(lines, bugs) {
    lines.push('## Bugs fixed in this batch');
    lines.push('');
    if (!bugs || bugs.length === 0) {
        lines.push('_No bugs listed._');
        return;
    }
    for (var i = 0; i < bugs.length; i++) {
        pushBugLine(lines, bugs[i]);
    }
}

function buildPRBody(epic, bugs) {
    var epicFields = epic.fields || {};
    var lines = [];
    pushEpicSection(lines, epic, epicFields);
    pushBugsSection(lines, bugs);
    lines.push('');
    lines.push('---');
    lines.push('_Automated bug-fix batch PR._');
    return lines.join('\n');

}

function ensurePRExists(branchName, epic, config, bugs) {
    var existing = findExistingPR(branchName);
    if (existing) {
        console.log('PR already exists for branch ' + branchName + ': ' + existing);
        return { success: true, prUrl: existing, alreadyExisted: true };
    }

    var epicFields = epic.fields || {};
    var summary = epicFields.summary || '';
    var title = configLoader.formatTemplate(config.formats.prTitle.development, {
        ticketKey: epic.key,
        ticketSummary: summary
    }) || (epic.key + ' ' + summary);

    var body = buildPRBody(epic, bugs);

    return prHelper.createPullRequest({
        branchName: branchName,
        baseBranch: configLoader.resolvePRTargetBranch(config, epic),
        title: title,
        // gh-737: merge bot links approved issues via 'Closes #N' — the batch
        // PR closes the epic, so its key drives the canonical line.
        ticketKey: epic.key,
        bodyContent: body,
        workingDir: config.workingDir || null,
        tempBodyFile: 'pr_body_tmp_batch.md'
    });
}

function transitionTickets(keys, statusName, tracker) {
    for (var i = 0; i < keys.length; i++) {
        try {
            tracker.moveToStatus(keys[i], statusName);
            console.log('Moved ' + keys[i] + ' to ' + statusName);
        } catch (e) {
            console.warn('Failed to move ' + keys[i] + ' to ' + statusName + ':', e);
        }
    }
}

function addLabels(keys, label, tracker) {
    for (var i = 0; i < keys.length; i++) {
        try {
            tracker.addLabel(keys[i], label);
            console.log('Added label ' + label + ' to ' + keys[i]);
        } catch (e) {
            console.warn('Failed to add label ' + label + ' to ' + keys[i] + ':', e);
        }
    }
}

function collectKeysToUpdate(epicKey, bugs) {
    var keysToUpdate = [epicKey];
    for (var i = 0; i < bugs.length; i++) {
        keysToUpdate.push(bugs[i].key);
    }
    return keysToUpdate;
}

function warnIfPRFailed(prResult) {
    if (!prResult || !prResult.success) {
        console.warn('Could not ensure PR exists:', prResult && prResult.error);
    }
}

function postPRCommentIfPossible(tracker, epicKey, prResult, bugs) {
    if (!prResult || !prResult.prUrl) {
        return;
    }
    try {
        tracker.postComment(epicKey, 'h3. *Bug-fix Batch PR Created/Updated*\n\n' +
            'PR: ' + prResult.prUrl + '\n\n' +
            'Linked bugs: ' + bugs.map(function(b) { return b.key; }).join(', '));
    } catch (e) {
        console.warn('Failed to post PR comment on Epic (non-fatal):', e);
    }
}

function action(params) {
    try {
        var ctx = bugFixBatchCtx.resolveBatchActionContext(params);
        var actualParams = ctx.actualParams;
        var config = ctx.config;
        var tracker = ctx.tracker;
        var epicKey = ctx.epicKey;
        var epic = ctx.epic;

        var customParams = actualParams.customParams || {};
        var statuses = resolveStatuses(customParams);

        var branchName = configLoader.resolveBranchName(config, epic, 'development');
        console.log('Batch development branch:', branchName);

        var bugs = batchContext.findBugsInEpic(epicKey);
        console.log('Found', bugs.length, 'bug(s) in batch Epic', epicKey);

        // Make sure a PR exists. The CLI agent should have created it, but this
        // action is idempotent and will create one if missing.
        var prResult = ensurePRExists(branchName, epic, config, bugs);
        warnIfPRFailed(prResult);

        var keysToUpdate = collectKeysToUpdate(epicKey, bugs);

        transitionTickets(keysToUpdate, statuses.IN_REVIEW, tracker);
        addLabels(keysToUpdate, LABELS.AI_DEVELOPED, tracker);

        postPRCommentIfPossible(tracker, epicKey, prResult, bugs);

    } catch (error) {
        console.error('Error in developBugFixBatchAndCreatePR:', error);
        throw error;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, buildPRBody, ensurePRExists };
}
