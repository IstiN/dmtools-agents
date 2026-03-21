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
        var branchName = configLoader.formatBranchName(config.git.branchPrefix.development, ticketKey);

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
                // New branch — start from base branch
                console.log('Creating new branch from', config.git.baseBranch + ':', branchName);
                cli_execute_command({ command: 'git checkout ' + config.git.baseBranch });
                cli_execute_command({ command: 'git pull origin ' + config.git.baseBranch });
                cli_execute_command({ command: 'git checkout -b ' + branchName });
            }
        }

        console.log('Branch ready:', branchName);

    } catch (error) {
        console.error('Error in checkoutBranch:', error);
        // Non-fatal: log but do not block CLI execution
    }
}
