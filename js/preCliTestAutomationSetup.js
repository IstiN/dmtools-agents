/**
 * Pre-CLI Test Automation Setup Action (preCliJSAction for test_case_automation)
 * 1. Moves ticket to In Development
 * 2. Creates/checks out test/{TICKET-KEY} branch from main
 */

const { GIT_CONFIG, STATUSES } = require('./config.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function checkoutBranch(ticketKey) {
    var branchName = 'test/' + ticketKey;
    console.log('Setting up branch:', branchName);

    try {
        cli_execute_command({ command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"' });
        cli_execute_command({ command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"' });
    } catch (e) {
        console.warn('Failed to configure git author:', e);
    }

    try {
        cli_execute_command({ command: 'git fetch origin --prune' });
    } catch (e) {
        console.warn('Could not fetch remote branches:', e);
    }

    var localBranches = cleanCommandOutput(
        cli_execute_command({ command: 'git branch --list "' + branchName + '"' }) || ''
    );

    if (localBranches.trim()) {
        console.log('Branch exists locally, checking out:', branchName);
        cli_execute_command({ command: 'git checkout ' + branchName });
        cli_execute_command({ command: 'git pull origin ' + branchName });
    } else {
        var remoteBranches = cleanCommandOutput(
            cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || ''
        );

        if (remoteBranches.trim()) {
            console.log('Branch exists on remote, checking out with tracking:', branchName);
            cli_execute_command({ command: 'git checkout -b ' + branchName + ' origin/' + branchName });
        } else {
            console.log('Creating new branch from', GIT_CONFIG.DEFAULT_BASE_BRANCH + ':', branchName);
            cli_execute_command({ command: 'git checkout ' + GIT_CONFIG.DEFAULT_BASE_BRANCH });
            cli_execute_command({ command: 'git pull origin ' + GIT_CONFIG.DEFAULT_BASE_BRANCH });
            cli_execute_command({ command: 'git checkout -b ' + branchName });
        }
    }

    console.log('✅ Branch ready:', branchName);
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var folder = actualParams.inputFolderPath;
        var ticketKey = folder.split('/').pop();

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
            checkoutBranch(ticketKey);
        } catch (e) {
            console.error('Branch checkout failed (non-fatal):', e);
        }

        console.log('✅ Test automation setup complete for', ticketKey);

    } catch (error) {
        console.error('❌ Error in preCliTestAutomationSetup:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
