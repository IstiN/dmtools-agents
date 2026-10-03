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

var _workingDir = null;
function runCmd(args) {
    if (typeof args === 'string') args = { command: args };
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function findExistingPR(branchName) {
    try {
        var output = cleanCommandOutput(
            runCmd('gh pr list --head ' + branchName + ' --json url --jq ".[0].url"') || ''
        );
        if (output && output.startsWith('https://')) {
            return output;
        }
    } catch (e) {
        console.warn('Could not list PR for branch ' + branchName + ':', e);
    }
    return null;
}

function buildPRBody(epic, bugs) {
    var epicFields = epic.fields || {};
    var lines = [];
    lines.push('## Epic');
    lines.push('');
    lines.push('**' + epic.key + '**: ' + (epicFields.summary || ''));
    if (epicFields.description) {
        lines.push('');
        lines.push(epicFields.description);
    }
    lines.push('');
    lines.push('## Bugs fixed in this batch');
    lines.push('');
    if (!bugs || bugs.length === 0) {
        lines.push('_No bugs listed._');
    } else {
        for (var i = 0; i < bugs.length; i++) {
            var bug = bugs[i];
            var f = bug.fields || {};
            lines.push('- **' + bug.key + '** — ' + (f.summary || '(no summary)'));
        }
    }
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
        bodyContent: body,
        workingDir: config.workingDir || null,
        tempBodyFile: 'pr_body_tmp_batch.md'
    });
}

function transitionTickets(keys, statusName) {
    for (var i = 0; i < keys.length; i++) {
        try {
            jira_move_to_status({ key: keys[i], statusName: statusName });
            console.log('Moved ' + keys[i] + ' to ' + statusName);
        } catch (e) {
            console.warn('Failed to move ' + keys[i] + ' to ' + statusName + ':', e);
        }
    }
}

function addLabels(keys, label) {
    for (var i = 0; i < keys.length; i++) {
        try {
            jira_add_label({ key: keys[i], label: label });
            console.log('Added label ' + label + ' to ' + keys[i]);
        } catch (e) {
            console.warn('Failed to add label ' + label + ' to ' + keys[i] + ':', e);
        }
    }
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var config = configLoader.loadProjectConfig(actualParams);
        _workingDir = config.workingDir || null;

        var epicFolder = actualParams.inputFolderPath;
        var epicKey = epicFolder.split('/').pop();
        var epic = actualParams.ticket || { key: epicKey, fields: {} };
        if (!epic.fields) {
            try {
                epic = jira_get_ticket({ key: epicKey, fields: ['summary', 'description', 'status', 'labels'] });
            } catch (e) {
                console.warn('Could not fetch Epic details (non-fatal):', e);
                epic = { key: epicKey, fields: {} };
            }
        }

        var customParams = actualParams.customParams || {};
        var statuses = resolveStatuses(customParams);

        var branchName = configLoader.resolveBranchName(config, epic, 'development');
        console.log('Batch development branch:', branchName);

        var bugs = batchContext.findBugsInEpic(epicKey);
        console.log('Found', bugs.length, 'bug(s) in batch Epic', epicKey);

        // Make sure a PR exists. The CLI agent should have created it, but this
        // action is idempotent and will create one if missing.
        var prResult = ensurePRExists(branchName, epic, config, bugs);
        if (!prResult || !prResult.success) {
            console.warn('Could not ensure PR exists:', prResult && prResult.error);
        }

        var keysToUpdate = [epicKey];
        for (var i = 0; i < bugs.length; i++) {
            keysToUpdate.push(bugs[i].key);
        }

        transitionTickets(keysToUpdate, statuses.IN_REVIEW);
        addLabels(keysToUpdate, LABELS.AI_DEVELOPED);

        if (prResult && prResult.prUrl) {
            try {
                jira_post_comment({
                    key: epicKey,
                    comment: 'h3. *Bug-fix Batch PR Created/Updated*\n\n' +
                        'PR: ' + prResult.prUrl + '\n\n' +
                        'Linked bugs: ' + bugs.map(function(b) { return b.key; }).join(', ')
                });
            } catch (e) {
                console.warn('Failed to post PR comment on Epic (non-fatal):', e);
            }
        }

    } catch (error) {
        console.error('Error in developBugFixBatchAndCreatePR:', error);
        throw error;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, buildPRBody, ensurePRExists };
}
