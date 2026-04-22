/**
 * Checkout Branch Pre-CLI Action
 * Creates or checks out the feature branch for the ticket before the CLI agent runs.
 * Branch name format: ai/<TICKET-KEY>
 * If the branch already exists (locally or remotely), it is checked out directly.
 * postAction (developTicketAndCreatePR) then just commits and pushes the current branch.
 */

const { GIT_CONFIG } = require('./config.js');
var configLoader = require('./configLoader.js');

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

function action(params) {
    try {
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var ticketKey = params.ticket.key;
        var branchName = configLoader.resolveBranchName(config, params.ticket, 'development');

        console.log('Setting up branch for ticket:', ticketKey, '→', branchName);

        // Configure git author
        try {
            cli_execute_command({ command: 'git config user.name "' + config.git.authorName + '"' });
            cli_execute_command({ command: 'git config user.email "' + config.git.authorEmail + '"' });
            console.log('Configured git author');
        } catch (e) {
            console.warn('Failed to configure git author:', e);
        }

        // Fetch latest remote state
        try {
            cli_execute_command({ command: 'git fetch origin --prune' });
            console.log('Fetched remote');
        } catch (e) {
            console.warn('Could not fetch remote branches:', e);
        }

        // In two-branch mode, ensure feature branch exists before creating dev branch
        var branchBase = config.git.baseBranch;
        if (config.git.featureBranch && config.git.featureBranch.enabled) {
            var featureBranchName = configLoader.resolveBranchName(config, params.ticket, 'feature');
            var featureLocal = '';
            try {
                featureLocal = cleanCommandOutput(cli_execute_command({ command: 'git branch --list "' + featureBranchName + '"' }) || '');
            } catch (e) {}
            var featureRemote = '';
            try {
                featureRemote = cleanCommandOutput(cli_execute_command({ command: 'git ls-remote --heads origin ' + featureBranchName }) || '');
            } catch (e) {}
            if (!featureLocal.trim() && !featureRemote.trim()) {
                console.log('Two-branch mode: creating feature branch from', config.git.baseBranch + ':', featureBranchName);
                cli_execute_command({ command: 'git checkout ' + config.git.baseBranch });
                cli_execute_command({ command: 'git pull origin ' + config.git.baseBranch });
                cli_execute_command({ command: 'git checkout -b ' + featureBranchName });
                cli_execute_command({ command: 'git push -u origin ' + featureBranchName });
            } else if (featureRemote.trim() && !featureLocal.trim()) {
                cli_execute_command({ command: 'git checkout -b ' + featureBranchName + ' origin/' + featureBranchName });
            } else {
                cli_execute_command({ command: 'git checkout ' + featureBranchName });
            }
            branchBase = featureBranchName;
            console.log('Two-branch mode: dev branch will be created from feature branch:', featureBranchName);
        }

        // Check if branch exists locally
        var localBranches = '';
        try {
            var rawLocal = cli_execute_command({ command: 'git branch --list "' + branchName + '"' }) || '';
            localBranches = cleanCommandOutput(rawLocal);
        } catch (e) {
            console.warn('Error checking local branches:', e);
        }

        if (localBranches.trim()) {
            // Branch exists locally — check it out
            console.log('Branch exists locally, checking out:', branchName);
            cli_execute_command({ command: 'git checkout ' + branchName });
        } else {
            // Check if branch exists on remote
            var remoteBranches = '';
            try {
                var rawRemote = cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || '';
                remoteBranches = cleanCommandOutput(rawRemote);
            } catch (e) {
                console.warn('Error checking remote branches:', e);
            }

            if (remoteBranches.trim()) {
                // Exists on remote — checkout tracking remote
                console.log('Branch exists on remote, checking out with tracking:', branchName);
                cli_execute_command({ command: 'git checkout -b ' + branchName + ' origin/' + branchName });
            } else {
                // New branch — start from base branch (or feature branch in two-branch mode)
                console.log('Creating new branch from', branchBase + ':', branchName);
                cli_execute_command({ command: 'git checkout ' + branchBase });
                cli_execute_command({ command: 'git pull origin ' + branchBase });
                cli_execute_command({ command: 'git checkout -b ' + branchName });
            }
        }

        console.log('Branch ready:', branchName);

    } catch (error) {
        console.error('Error in checkoutBranch:', error);
        // Non-fatal: log but do not block CLI execution
    }
}
