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
var prHelper = require('./common/pullRequest.js');
const { GIT_CONFIG, STATUSES, resolveStatuses } = require('./config.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
const fetchLinkedTestsToInput = require('./fetchLinkedTestsToInput.js');
const fetchParentContextToInput = require('./fetchParentContextToInput.js');
var restoreFromReleases = require('./restoreFromReleases.js');

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

function writeBranchConflictGuidance(ticketKey, branchName, baseBranch, details) {
    try {
        file_write({
            path: 'input/' + ticketKey + '/merge_conflicts.md',
            content: '# Branch Conflict Guidance\n\n' +
                'Branch `' + branchName + '` has work that is not already merged into `origin/' + baseBranch + '`, ' +
                'and `origin/' + baseBranch + '` is not an ancestor of this branch.\n\n' +
                'Do not discard the branch work automatically. If a merge conflict appears while syncing with `origin/' + baseBranch + '`, ' +
                'resolve it deliberately. In most cases, prefer `origin/' + baseBranch + '` for repository setup, generated workflow/config files, ' +
                'and shared infrastructure, then re-apply only the ticket-specific implementation that is still relevant.\n\n' +
                'Details:\n\n```\n' + (details || '(not available)') + '\n```\n'
        });
    } catch (e) {
        console.warn('Could not write branch conflict guidance:', e);
    }
}

function branchHasUniquePatches(baseBranch) {
    try {
        var cherry = cleanCommandOutput(runCmd({ command: 'git cherry origin/' + baseBranch + ' HEAD' }) || '');
        if (!cherry.trim()) return false;
        var lines = cherry.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim().indexOf('+') === 0) return true;
        }
        return false;
    } catch (e) {
        console.warn('Could not inspect unique branch patches:', e);
        return true;
    }
}

function isAncestorRef(ancestor, descendant) {
    try {
        runCmd({ command: 'git merge-base --is-ancestor ' + ancestor + ' ' + descendant });
        return true;
    } catch (e) {
        return false;
    }
}

function findMergeBase(left, right) {
    try {
        return cleanCommandOutput(runCmd({ command: 'bash agents/scripts/git-merge-base-or-empty.sh ' + left + ' ' + right }) || '');
    } catch (e) {
        return '';
    }
}

function alignBranchWithBase(ticketKey, branchName, baseBranch) {
    if (isAncestorRef('HEAD', 'origin/' + baseBranch)) {
        console.log('Branch changes are already included in origin/' + baseBranch + ', resetting local branch:', branchName);
        runCmd({ command: 'git reset --hard origin/' + baseBranch });
        return;
    }

    if (!branchHasUniquePatches(baseBranch)) {
        console.log('Branch has no unique patches versus origin/' + baseBranch + ', resetting local branch:', branchName);
        runCmd({ command: 'git reset --hard origin/' + baseBranch });
        return;
    }

    if (isAncestorRef('origin/' + baseBranch, 'HEAD')) {
        console.log('Branch already contains origin/' + baseBranch + ':', branchName);
        return;
    }
    console.warn('Branch does not contain origin/' + baseBranch + ':', branchName);

    var details = '';
    try {
        var mergeBase = findMergeBase('HEAD', 'origin/' + baseBranch);
        if (mergeBase) {
            details = cleanCommandOutput(runCmd({ command: 'git merge-tree ' + mergeBase + ' HEAD origin/' + baseBranch }) || '');
        } else {
            details = 'No merge base found between HEAD and origin/' + baseBranch + '. The local checkout is likely shallow or the branch history is unrelated to the current base.';
        }
    } catch (mergeTreeError) {
        details = mergeTreeError && mergeTreeError.toString ? mergeTreeError.toString() : String(mergeTreeError);
    }
    writeBranchConflictGuidance(ticketKey, branchName, baseBranch, details.substring(0, 6000));
    console.warn('Keeping divergent branch ' + branchName + '; conflict guidance written for the agent.');
}

function checkoutBranch(ticketKey, config, ticket) {
    ticket = ticket || { key: ticketKey, fields: {} };
    _workingDir = config.workingDir || null;
    // Write workingDir to a known file so CLI shell scripts (e.g. create_test_commit.sh)
    // can discover the correct dependency dir without duplicating resolution logic.
    if (_workingDir) {
        try { file_write({ path: '.dmtools-target-workingdir', content: _workingDir }); } catch (e) {}
    }
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
        runCmd({ command: prHelper.buildOriginFetchCommand('--prune') });
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
        console.log('Branch exists locally, aligning with base:', branchName);
        runCmd({ command: 'git checkout ' + branchName });
        alignBranchWithBase(ticketKey, branchName, rebaseBase);
    } else {
        var remoteBranches = '';
        try {
            var rawRemote = runCmd({ command: 'git ls-remote --heads origin ' + branchName }) || '';
            remoteBranches = cleanCommandOutput(rawRemote);
        } catch (e) {
            console.warn('Error checking remote branches:', e);
        }

        if (remoteBranches.trim()) {
            console.log('Branch exists on remote, fetching and aligning with base:', branchName);
            // Explicitly fetch the branch so origin/<branch> tracking ref is available locally.
            // git fetch origin --prune may not populate it if the repo is sparse/shallow.
            try {
                runCmd({ command: prHelper.buildOriginFetchCommand(branchName + ':' + branchName) });
                runCmd({ command: 'git checkout ' + branchName });
            } catch (fetchCheckoutErr) {
                console.warn('fetch+checkout failed, resetting local branch from origin:', fetchCheckoutErr);
                runCmd({ command: prHelper.buildOriginFetchCommand(branchName) });
                runCmd({ command: 'git checkout -B ' + branchName + ' origin/' + branchName });
            }
            alignBranchWithBase(ticketKey, branchName, rebaseBase);
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

        // Restore configured artefacts (e.g. cosmo test reports) from GitHub Release — non-fatal
        try { restoreFromReleases.action(params); } catch (e) { console.warn('⚠️ restoreFromReleases failed (non-fatal):', e); }

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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
