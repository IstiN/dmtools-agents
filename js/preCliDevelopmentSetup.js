/**
 * Pre-CLI Development Setup Action
 * Combined preCliJSAction for development agents:
 * 1. Moves ticket to In Development status
 * 2. Checks out the feature branch (creating if needed) — ai/<TICKET-KEY>
 * 3. Fetches existing question subtasks with answers into the input folder
 *
 * Used by: story_development.json, test_case_automation.json
 */

var configLoader = require('./configLoader.js');
const { GIT_CONFIG, STATUSES, resolveStatuses } = require('./config.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
const fetchLinkedTestsToInput = require('./fetchLinkedTestsToInput.js');
const fetchParentContextToInput = require('./fetchParentContextToInput.js');

// Universal working-directory-aware wrapper for cli_execute_command.
// When config.workingDir is set (via customParams.targetRepository.workingDir),
// all git/shell commands are executed inside that directory.
var _workingDir = null;
function runCmd(args) {
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

/**
 * Clean command output from script wrapper artifacts
 * @param {string} output - Raw command output
 * @returns {string} Cleaned output
 */
function cleanCommandOutput(output) {
    if (!output) {
        return '';
    }
    const lines = output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    });
    return lines.join('\n').trim();
}

function checkoutBranch(ticketKey, config, ticket) {
    ticket = ticket || { key: ticketKey, fields: {} };
    _workingDir = config.workingDir || null;
    var branchName = configLoader.resolveBranchName(config, ticket, 'development');
    var rebaseBase = configLoader.resolvePRTargetBranch(config, ticket);
    console.log('Setting up branch:', branchName);

    try {
        runCmd({ command: 'git config user.name "' + config.git.authorName + '"' });
        runCmd({ command: 'git config user.email "' + config.git.authorEmail + '"' });
    } catch (e) {
        console.warn('Failed to configure git author:', e);
    }

    try {
        runCmd({ command: 'git fetch origin --prune' });
    } catch (e) {
        console.warn('Could not fetch remote branches:', e);
    }

    var localBranches = '';
    try {
        var rawLocal = runCmd({ command: 'git branch --list "' + branchName + '"' }) || '';
        localBranches = cleanCommandOutput(rawLocal);
    } catch (e) {
        console.warn('Error checking local branches:', e);
    }

    if (localBranches.trim()) {
        console.log('Branch exists locally, rebasing from main:', branchName);
        runCmd({ command: 'git checkout ' + branchName });
        try {
            var rebaseOutput = cleanCommandOutput(
                runCmd({ command: 'git rebase origin/' + rebaseBase }) || ''
            );
            if (rebaseOutput.indexOf('CONFLICT') !== -1) {
                throw new Error('Rebase conflict detected: ' + rebaseOutput.substring(0, 200));
            }
        } catch (rebaseErr) {
            console.warn('Rebase failed, resetting to main:', rebaseErr);
            try { runCmd({ command: 'git rebase --abort' }); } catch (_) {}
            runCmd({ command: 'git reset --hard origin/' + rebaseBase });
        }
    } else {
        var remoteBranches = '';
        try {
            var rawRemote = runCmd({ command: 'git ls-remote --heads origin ' + branchName }) || '';
            remoteBranches = cleanCommandOutput(rawRemote);
        } catch (e) {
            console.warn('Error checking remote branches:', e);
        }

        if (remoteBranches.trim()) {
            console.log('Branch exists on remote, fetching and checking out:', branchName);
            // Explicitly fetch the branch so origin/<branch> tracking ref is available locally.
            // git fetch origin --prune may not populate it if the repo is sparse/shallow.
            try {
                runCmd({ command: 'git fetch origin ' + branchName + ':' + branchName });
                runCmd({ command: 'git checkout ' + branchName });
            } catch (fetchCheckoutErr) {
                console.warn('fetch+checkout failed, falling back to -b from origin:', fetchCheckoutErr);
                runCmd({ command: 'git fetch origin ' + branchName });
                runCmd({ command: 'git checkout -b ' + branchName + ' origin/' + branchName });
            }
            try {
                var rebaseOutput2 = cleanCommandOutput(
                    runCmd({ command: 'git rebase origin/' + rebaseBase }) || ''
                );
                if (rebaseOutput2.indexOf('CONFLICT') !== -1) {
                    throw new Error('Rebase conflict detected: ' + rebaseOutput2.substring(0, 200));
                }
            } catch (rebaseErr) {
                console.warn('Rebase failed, resetting to main:', rebaseErr);
                try { runCmd({ command: 'git rebase --abort' }); } catch (_) {}
                runCmd({ command: 'git reset --hard origin/' + rebaseBase });
            }
        } else {
            // New branch: in two-branch mode, ensure feature branch exists first
            var branchBase = config.git.baseBranch;
            if (config.git.featureBranch && config.git.featureBranch.enabled) {
                var featureBranchName = configLoader.resolveBranchName(config, ticket, 'feature');
                var featureLocal = '';
                try {
                    featureLocal = cleanCommandOutput(runCmd({ command: 'git branch --list "' + featureBranchName + '"' }) || '');
                } catch (e) {}
                var featureRemote = '';
                try {
                    featureRemote = cleanCommandOutput(runCmd({ command: 'git ls-remote --heads origin ' + featureBranchName }) || '');
                } catch (e) {}
                if (!featureLocal.trim() && !featureRemote.trim()) {
                    console.log('Two-branch mode: creating feature branch from', config.git.baseBranch + ':', featureBranchName);
                    runCmd({ command: 'git checkout ' + config.git.baseBranch });
                    runCmd({ command: 'git pull origin ' + config.git.baseBranch });
                    runCmd({ command: 'git checkout -b ' + featureBranchName });
                    runCmd({ command: 'git push -u origin ' + featureBranchName });
                } else if (featureRemote.trim() && !featureLocal.trim()) {
                    runCmd({ command: 'git checkout -b ' + featureBranchName + ' origin/' + featureBranchName });
                } else {
                    runCmd({ command: 'git checkout ' + featureBranchName });
                }
                branchBase = featureBranchName;
                console.log('Two-branch mode: dev branch will be created from feature branch:', featureBranchName);
            }
            console.log('Creating new branch from', branchBase + ':', branchName);
            runCmd({ command: 'git checkout ' + branchBase });
            runCmd({ command: 'git pull origin ' + branchBase });
            runCmd({ command: 'git checkout -b ' + branchName });
        }
    }

    console.log('Branch ready:', branchName);
}

function postSetupErrorToJira(ticketKey, stage, errorMessage) {
    try {
        jira_post_comment({
            key: ticketKey,
            comment: 'h3. *Development Setup Error*\n\n' +
                '*Stage:* ' + stage + '\n' +
                '*Error:* {code}' + errorMessage + '{code}\n\n' +
                'Development was stopped before code generation because the target git branch could not be prepared.'
        });
    } catch (commentError) {
        console.warn('Failed to post setup error comment:', commentError);
    }
}

function action(params) {
    try {
        // Handle both Teammate workflow and standalone dmtools execution
        // - Teammate workflow: params.inputFolderPath exists directly
        // - Standalone dmtools (JSRunner): params.jobParams.inputFolderPath
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
        var statuses = resolveStatuses(customParams);

        var folder = actualParams.inputFolderPath;
        var ticketKey = folder.split('/').pop();

        // 1. Move ticket to In Development
        try {
            jira_move_to_status({ key: ticketKey, statusName: statuses.IN_DEVELOPMENT });
            console.log('Moved ' + ticketKey + ' to ' + statuses.IN_DEVELOPMENT);
        } catch (e) {
            console.warn('Failed to move ticket to In Development:', e);
        }

        // 2. Checkout or create feature branch
        try {
            var ticket = params.ticket || actualParams.ticket || { key: ticketKey, fields: {} };
            checkoutBranch(ticketKey, config, ticket);
        } catch (e) {
            var branchError = e && e.toString ? e.toString() : String(e);
            console.error('Branch checkout failed:', branchError);
            postSetupErrorToJira(ticketKey, 'Git Branch Setup', branchError);
            throw new Error('Git branch setup failed: ' + branchError);
        }

        // 3. Fetch questions with answers into input folder
        fetchQuestionsToInput.action(actualParams);

        // 4. Fetch linked test cases (with failure comments) into input folder
        // Gives the bug agent context about what the test asserts and why it's failing
        try {
            fetchLinkedTestsToInput.action(actualParams);
        } catch (e) {
            console.warn('fetchLinkedTestsToInput failed (non-fatal):', e);
        }

        // 5. Fetch [BA]/[SA]/[VD] context from parent siblings into input folder
        try {
            fetchParentContextToInput.action(actualParams);
        } catch (e) {
            console.warn('fetchParentContextToInput failed (non-fatal):', e);
        }

    } catch (error) {
        console.error('Error in preCliDevelopmentSetup:', error);
        throw error;
    }
}
