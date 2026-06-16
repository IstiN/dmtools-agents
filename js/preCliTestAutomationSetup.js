/**
 * Pre-CLI Test Automation Setup Action (preCliJSAction for test_case_automation)
 * 1. Moves ticket to In Development
 * 2. Creates/checks out test/{TICKET-KEY} branch from main
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
const { GIT_CONFIG, STATUSES } = require('./config.js');
const fetchLinkedBugsToInput = require('./fetchLinkedBugsToInput.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function runGit(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function writeBranchConflictGuidance(ticketKey, branchName, baseBranch, details) {
    try {
        file_write({
            path: 'input/' + ticketKey + '/merge_conflicts.md',
            content: '# Branch Conflict Guidance\n\n' +
                'Branch `' + branchName + '` has test automation work that is not already merged into `origin/' + baseBranch + '`, ' +
                'and `origin/' + baseBranch + '` is not an ancestor of this branch.\n\n' +
                'Before editing tests, sync the branch deliberately with `origin/' + baseBranch + '`. ' +
                'In most cases, prefer `origin/' + baseBranch + '` for repository setup, generated workflow/config files, ' +
                'and shared infrastructure, then re-apply only the ticket-specific test automation that is still relevant.\n\n' +
                'Do not discard test files that are still needed for this ticket. Do not keep stale bootstrap/setup files just because they exist on the old branch.\n\n' +
                'Details:\n\n```\n' + (details || '(not available)') + '\n```\n'
        });
    } catch (e) {
        console.warn('Could not write branch conflict guidance:', e);
    }
}

function branchHasUniquePatches(baseBranch, workingDir) {
    try {
        var cherry = cleanCommandOutput(runGit('git cherry origin/' + baseBranch + ' HEAD', workingDir) || '');
        if (!cherry.trim()) return false;
        var lines = cherry.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim().indexOf('+') === 0) return true;
        }
        return false;
    } catch (e) {
        console.warn('Could not inspect unique test branch patches:', e);
        return true;
    }
}

function isAncestorRef(ancestor, descendant, workingDir) {
    try {
        var output = cleanCommandOutput(
            runGit('git rev-list -1 ' + ancestor + ' --not ' + descendant, workingDir) || ''
        );
        return output.trim() === '';
    } catch (e) {
        console.warn('Could not inspect branch ancestry for ' + ancestor + ' -> ' + descendant + ':', e);
        return false;
    }
}

function findMergeBase(left, right, workingDir) {
    try {
        return cleanCommandOutput(runGit('bash agents/scripts/git-merge-base-or-empty.sh ' + left + ' ' + right, workingDir) || '');
    } catch (e) {
        return '';
    }
}

function alignBranchWithBase(ticketKey, branchName, baseBranch, workingDir) {
    if (isAncestorRef('HEAD', 'origin/' + baseBranch, workingDir)) {
        console.log('Test branch changes are already included in origin/' + baseBranch + ', resetting local branch:', branchName);
        runGit('git reset --hard origin/' + baseBranch, workingDir);
        return;
    }

    if (!branchHasUniquePatches(baseBranch, workingDir)) {
        console.log('Test branch has no unique patches versus origin/' + baseBranch + ', resetting local branch:', branchName);
        runGit('git reset --hard origin/' + baseBranch, workingDir);
        return;
    }

    if (isAncestorRef('origin/' + baseBranch, 'HEAD', workingDir)) {
        console.log('Test branch already contains origin/' + baseBranch + ':', branchName);
        return;
    }

    console.warn('Test branch does not contain origin/' + baseBranch + ':', branchName);
    var details = '';
    try {
        var mergeBase = findMergeBase('HEAD', 'origin/' + baseBranch, workingDir);
        if (mergeBase) {
            details = cleanCommandOutput(runGit('git merge-tree ' + mergeBase + ' HEAD origin/' + baseBranch, workingDir) || '');
        } else {
            details = 'No merge base found between HEAD and origin/' + baseBranch + '. The branch history may be unrelated to the current base or too shallow.';
        }
    } catch (mergeTreeError) {
        details = mergeTreeError && mergeTreeError.toString ? mergeTreeError.toString() : String(mergeTreeError);
    }
    writeBranchConflictGuidance(ticketKey, branchName, baseBranch, details.substring(0, 6000));
    console.warn('Keeping divergent test branch ' + branchName + '; conflict guidance written for the agent.');
}

function checkoutBranch(ticketKey, config) {
    var branchName = configLoader.formatBranchName(config.git.branchPrefix.test, ticketKey);
    var workingDir = config.workingDir || null;
    console.log('Setting up branch:', branchName);

    try {
        runGit('git config user.name "' + config.git.authorName + '"', workingDir);
        runGit('git config user.email "' + config.git.authorEmail + '"', workingDir);
    } catch (e) {
        console.warn('Failed to configure git author:', e);
    }

    try {
        runGit(prHelper.buildOriginFetchCommand('--prune'), workingDir);
    } catch (e) {
        console.warn('Could not fetch remote branches:', e);
    }

    var localBranches = cleanCommandOutput(
        runGit('git branch --list "' + branchName + '"', workingDir) || ''
    );

    if (localBranches.trim()) {
        console.log('Branch exists locally, aligning with base:', branchName);
        runGit('git checkout ' + branchName, workingDir);
        alignBranchWithBase(ticketKey, branchName, config.git.baseBranch, workingDir);
    } else {
        var remoteBranches = cleanCommandOutput(
            runGit('git ls-remote --heads origin ' + branchName, workingDir) || ''
        );

        if (remoteBranches.trim()) {
            console.log('Branch exists on remote, checking out and aligning with base:', branchName);
            runGit('git checkout -b ' + branchName + ' origin/' + branchName, workingDir);
            alignBranchWithBase(ticketKey, branchName, config.git.baseBranch, workingDir);
        } else {
            console.log('Creating new branch from', config.git.baseBranch + ':', branchName);
            runGit('git checkout ' + config.git.baseBranch, workingDir);
            runGit('git pull origin ' + config.git.baseBranch, workingDir);
            runGit('git checkout -b ' + branchName, workingDir);
        }
    }

    console.log('✅ Branch ready:', branchName);
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var folder = actualParams.inputFolderPath;
        var ticketKey = folder.split('/').pop();
        var config = configLoader.loadProjectConfig(params.jobParams || params);

        console.log('=== Test automation setup for:', ticketKey, '===');

        // Step 1: Move ticket to In Development
        try {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_DEVELOPMENT });
            console.log('✅ Moved ' + ticketKey + ' to ' + STATUSES.IN_DEVELOPMENT);
        } catch (e) {
            console.warn('Failed to move ticket to In Development:', e);
        }

        // Step 2: Create/checkout test/{KEY} branch from main
        try {
            checkoutBranch(ticketKey, config);
        } catch (e) {
            console.error('Branch checkout failed (non-fatal):', e);
        }

        // Step 2b: Clear stale output files from previous runs so the post-action
        // does not accidentally read a result JSON belonging to a different ticket.
        try {
            runGit('bash -c "rm -f outputs/test_automation_result.json outputs/story_test_automation_result.json outputs/tracker_comment.md outputs/comment.md outputs/jira_comment.md outputs/response.md outputs/pr_body.md outputs/bug_description.md outputs/failed_description_*.md"', config.workingDir || null);
            console.log('✅ Cleared stale output files');
        } catch (e) {
            console.warn('Could not clear stale output files (non-fatal):', e);
        }

        // Step 3: Fetch linked bugs (with fix comments) into input folder
        // This gives the test agent context about HOW bugs were fixed (timing, delays, etc.)
        try {
            fetchLinkedBugsToInput.action(actualParams);
        } catch (e) {
            console.warn('fetchLinkedBugsToInput failed (non-fatal):', e);
        }

        console.log('✅ Test automation setup complete for', ticketKey);

    } catch (error) {
        console.error('❌ Error in preCliTestAutomationSetup:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
