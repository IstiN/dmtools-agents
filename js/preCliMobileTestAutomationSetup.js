/**
 * Pre-CLI Mobile Test Automation Setup (generic preCliJSAction)
 *
 * Designed for story/bug trigger tickets that have linked Test Case tickets
 * via "is tested by" relationship. Prepares the test automation repository
 * for the AI agent to write and run mobile tests.
 *
 * Steps:
 * 1. Move trigger ticket to In Development
 * 2. Fetch ALL linked Test Case tickets ("is tested by" relationship)
 * 3. Write linked test case details to input/{KEY}/linked_test_cases.md
 * 4. Create / checkout test/{KEY} branch in the target test automation repo
 *
 * Used by: project-specific test automation agent configs
 * Requires: customParams.targetRepository.workingDir pointing to the
 *           checked-out test automation repository.
 */

var configLoader = require('./configLoader.js');
const { STATUSES } = require('./config.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

/** Run a git / shell command inside the test automation repo working directory. */
function runInRepo(command, workingDir) {
    return cli_execute_command({ command: command, workingDirectory: workingDir });
}

/**
 * Checkout (or create) test/{ticketKey} branch in the automation repo.
 * Syncs existing branch from origin/<baseBranch> via rebase, falling back to merge.
 */
function checkoutAutomationBranch(ticketKey, config) {
    var workingDir = config.workingDir;
    var baseBranch = (config.git && config.git.baseBranch) || 'main';
    var branchName = 'test/' + ticketKey;

    console.log('Setting up automation repo branch:', branchName, 'in', workingDir);

    try {
        runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
        runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
    } catch (e) {
        console.warn('Failed to configure git author:', e);
    }

    try {
        runInRepo('git fetch origin --prune', workingDir);
    } catch (e) {
        console.warn('Could not fetch remote branches:', e);
    }

    var localBranches = cleanCommandOutput(
        runInRepo('git branch --list "' + branchName + '"', workingDir) || ''
    );

    function syncWithBase() {
        try {
            runInRepo('git rebase origin/' + baseBranch, workingDir);
            console.log('✅ Rebase succeeded');
        } catch (rebaseErr) {
            console.warn('Rebase failed, falling back to merge:', rebaseErr);
            try { runInRepo('git rebase --abort', workingDir); } catch (_) {}
            try {
                runInRepo('git merge origin/' + baseBranch + ' --no-edit', workingDir);
                console.log('✅ Merged base into branch');
            } catch (mergeErr) {
                console.warn('Merge also failed:', mergeErr);
                try { runInRepo('git merge --abort', workingDir); } catch (_) {}
            }
        }
    }

    if (localBranches.trim()) {
        console.log('Branch exists locally, syncing from', baseBranch + ':', branchName);
        runInRepo('git checkout ' + branchName, workingDir);
        syncWithBase();
    } else {
        var remoteBranches = cleanCommandOutput(
            runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || ''
        );

        if (remoteBranches.trim()) {
            console.log('Branch exists on remote, checking out:', branchName);
            runInRepo('git checkout -b ' + branchName + ' origin/' + branchName, workingDir);
            syncWithBase();
        } else {
            console.log('Creating new branch from', baseBranch + ':', branchName);
            runInRepo('git checkout ' + baseBranch, workingDir);
            runInRepo('git pull origin ' + baseBranch, workingDir);
            runInRepo('git checkout -b ' + branchName, workingDir);
        }
    }

    console.log('✅ Automation branch ready:', branchName);
}

/** Fetch all Test Cases linked via "is tested by" and write to input folder. */
function fetchLinkedTestCases(ticketKey, folder) {
    var linkedTCs = [];

    // Primary: "is tested by" relationship
    try {
        linkedTCs = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '", "is tested by") AND issuetype = "Test Case"',
            fields: ['key', 'summary', 'status', 'description', 'priority', 'labels', 'comment'],
            maxResults: 30
        });
    } catch (e) {
        console.warn('Primary JQL failed, trying fallback:', e);
    }

    // Fallback: any linked test cases (broader search)
    if (!linkedTCs || linkedTCs.length === 0) {
        try {
            linkedTCs = jira_search_by_jql({
                jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "Test Case"',
                fields: ['key', 'summary', 'status', 'description', 'priority', 'labels', 'comment'],
                maxResults: 30
            });
        } catch (e2) {
            console.warn('Fallback JQL also failed:', e2);
        }
    }

    if (!linkedTCs || linkedTCs.length === 0) {
        console.log('No linked test cases found for', ticketKey);
        file_write(folder + '/linked_test_cases.md',
            '# Linked Test Cases\n\nNo linked Test Case tickets found for ' + ticketKey + '.\n');
        return 0;
    }

    console.log('Found', linkedTCs.length, 'linked test case(s)');

    var lines = [];
    lines.push('# Linked Test Cases for ' + ticketKey + '\n');
    lines.push('> Automate EVERY test case listed here.\n');

    for (var i = 0; i < linkedTCs.length; i++) {
        var tc = linkedTCs[i];
        var f = tc.fields || {};
        var status = (f.status && f.status.name) || 'Unknown';
        var priority = (f.priority && f.priority.name) || 'Unknown';

        lines.push('---\n');
        lines.push('## ' + tc.key + ': ' + (f.summary || '(no summary)'));
        lines.push('**Status**: ' + status + '  **Priority**: ' + priority + '\n');

        if (f.description) {
            lines.push('**Description / Test Steps**:\n\n' + f.description + '\n');
        }

        // Fetch full ticket for comments (run history, prior failures)
        try {
            var tcDetails = jira_get_ticket({ key: tc.key });
            var tcFields = tcDetails && tcDetails.fields || {};
            var commentBlock = tcFields.comment;
            var comments = commentBlock && commentBlock.comments || [];

            if (comments.length > 0) {
                var startIdx = Math.max(0, comments.length - 5);
                lines.push('**Recent Test Run Comments** (' + (comments.length - startIdx) + ' of ' + comments.length + '):\n');
                for (var j = startIdx; j < comments.length; j++) {
                    var c = comments[j];
                    var author = (c.author && c.author.displayName) || 'Unknown';
                    var body = (c.body || '').substring(0, 2000);
                    lines.push('**[' + author + ']**:\n' + body + '\n');
                }
            }
        } catch (ce) {
            console.warn('Could not fetch comments for', tc.key + ':', ce);
        }
    }

    file_write(folder + '/linked_test_cases.md', lines.join('\n'));
    console.log('✅ Written linked_test_cases.md (' + linkedTCs.length + ' TCs)');
    return linkedTCs.length;
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var folder = actualParams.inputFolderPath;
        var ticketKey = folder.split('/').pop();
        var config = configLoader.loadProjectConfig(params.jobParams || params);

        console.log('=== Mobile test automation setup for:', ticketKey, '===');

        // Step 1: Move trigger ticket to In Development
        try {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_DEVELOPMENT });
            console.log('✅ Moved', ticketKey, 'to In Development');
        } catch (e) {
            console.warn('Failed to move ticket to In Development:', e);
        }

        // Step 2: Fetch linked Test Cases and write to input folder
        try {
            fetchLinkedTestCases(ticketKey, folder);
        } catch (e) {
            console.error('Failed to fetch linked test cases:', e);
        }

        // Step 3: Checkout test/{KEY} branch in automation repo
        if (config.workingDir) {
            try {
                checkoutAutomationBranch(ticketKey, config);
            } catch (e) {
                console.error('Branch checkout failed (non-fatal):', e);
            }
        } else {
            console.warn('No workingDir configured — skipping branch checkout');
        }

        console.log('✅ Mobile test automation setup complete for', ticketKey);

    } catch (error) {
        console.error('❌ Error in preCliMobileTestAutomationSetup:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
