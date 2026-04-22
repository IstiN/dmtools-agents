/**
 * Pre-CLI Test Automation Setup Action (preCliJSAction for test_case_automation)
 * 1. Moves ticket to In Development
 * 2. Creates/checks out test/{TICKET-KEY} branch from main
 */

var configLoader = require('./configLoader.js');
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
        runGit('git fetch origin --prune', workingDir);
    } catch (e) {
        console.warn('Could not fetch remote branches:', e);
    }

    var localBranches = cleanCommandOutput(
        runGit('git branch --list "' + branchName + '"', workingDir) || ''
    );

    /**
     * Bring the current branch up-to-date with main.
     * Strategy:
     *   1. Try rebase — if it fails only due to the 'agents' submodule pointer,
     *      auto-resolve it (main's version always wins for test branches) and continue.
     *   2. If rebase still fails for any other reason, abort and fall back to
     *      'git merge origin/main --no-edit' so we keep all existing test code.
     * NOTE: never do 'git reset --hard origin/main' on an existing branch — that
     *       diverges the local branch from its remote counterpart and breaks commits.
     */
    function syncWithMain() {
        var base = 'origin/' + config.git.baseBranch;
        try {
            runGit('git rebase ' + base, workingDir);
            console.log('✅ Rebase succeeded');
        } catch (rebaseErr) {
            console.warn('Rebase failed, attempting auto-resolve for agents submodule conflict:', rebaseErr);
            try {
                // Auto-resolve: take main's agents pointer (test branches never touch agents)
                runGit('git checkout --ours agents', workingDir);
                runGit('git add agents', workingDir);
                runGit('git rebase --continue', workingDir);
                console.log('✅ Rebase resumed after resolving agents submodule conflict');
            } catch (continueErr) {
                console.warn('Rebase --continue also failed, falling back to merge:', continueErr);
                try { runGit('git rebase --abort', workingDir); } catch (_) {}
                try {
                    runGit('git merge ' + base + ' --no-edit', workingDir);
                    console.log('✅ Merged main into branch instead of rebasing');
                } catch (mergeErr) {
                    console.warn('Merge also failed — branch may need manual attention:', mergeErr);
                    try { runGit('git merge --abort', workingDir); } catch (_) {}
                }
            }
        }
    }

    if (localBranches.trim()) {
        console.log('Branch exists locally, syncing from main:', branchName);
        runGit('git checkout ' + branchName, workingDir);
        syncWithMain();
    } else {
        var remoteBranches = cleanCommandOutput(
            runGit('git ls-remote --heads origin ' + branchName, workingDir) || ''
        );

        if (remoteBranches.trim()) {
            console.log('Branch exists on remote, checking out and syncing from main:', branchName);
            runGit('git checkout -b ' + branchName + ' origin/' + branchName, workingDir);
            syncWithMain();
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
