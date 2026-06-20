/**
 * Pre-CLI Story Test Automation Setup Action
 * 1. Fetches all linked Test Cases for the Story.
 * 2. Writes input/{STORY_KEY}/linked_test_cases.json and .md.
 * 3. Checks out test/{STORY_KEY} branch aligned with main.
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
const { STATUSES, resolveStatuses } = require('./config.js');

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

function writeBranchConflictGuidance(storyKey, branchName, baseBranch, details) {
    try {
        file_write({
            path: 'input/' + storyKey + '/merge_conflicts.md',
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

function alignBranchWithBase(storyKey, branchName, baseBranch, workingDir) {
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
    writeBranchConflictGuidance(storyKey, branchName, baseBranch, details.substring(0, 6000));
    console.warn('Keeping divergent test branch ' + branchName + '; conflict guidance written for the agent.');
}

function checkoutBranch(storyKey, config) {
    var branchName = configLoader.formatBranchName(config.git.branchPrefix.test, storyKey);
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
        alignBranchWithBase(storyKey, branchName, config.git.baseBranch, workingDir);
    } else {
        var remoteBranches = cleanCommandOutput(
            runGit('git ls-remote --heads origin ' + branchName, workingDir) || ''
        );

        if (remoteBranches.trim()) {
            console.log('Branch exists on remote, checking out and aligning with base:', branchName);
            runGit('git checkout -b ' + branchName + ' origin/' + branchName, workingDir);
            alignBranchWithBase(storyKey, branchName, config.git.baseBranch, workingDir);
        } else {
            console.log('Creating new branch from', config.git.baseBranch + ':', branchName);
            runGit('git checkout ' + config.git.baseBranch, workingDir);
            runGit('git pull origin ' + config.git.baseBranch, workingDir);
            runGit('git checkout -b ' + branchName, workingDir);
        }
    }

    console.log('✅ Branch ready:', branchName);
}

function fetchLinkedTestCases(storyKey, testCaseType) {
    var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = "' + testCaseType + '"';
    console.log('Fetching linked Test Cases with JQL:', jql);
    try {
        var results = jira_search_by_jql({ jql: jql, maxResults: 100, fields: ['key', 'summary', 'status', 'priority', 'description', 'Acceptance Criteria'] });
        return Array.isArray(results) ? results : [];
    } catch (e) {
        console.warn('Failed to fetch linked Test Cases:', e);
        return [];
    }
}

function renderTestCase(tc) {
    var fields = tc.fields || {};
    var lines = [];
    lines.push('## ' + tc.key + ' — ' + (fields.summary || '(no summary)'));
    lines.push('');
    lines.push('- **Status**: ' + (fields.status && fields.status.name ? fields.status.name : 'Unknown'));
    lines.push('- **Priority**: ' + (fields.priority && fields.priority.name ? fields.priority.name : 'Unknown'));
    lines.push('');
    lines.push('### Description');
    lines.push(fields.description || '(no description)');
    lines.push('');
    if (fields['Acceptance Criteria']) {
        lines.push('### Acceptance Criteria');
        lines.push(fields['Acceptance Criteria']);
        lines.push('');
    }
    return lines.join('\n');
}

function writeLinkedTestCases(storyKey, testCases) {
    var inputDir = 'input/' + storyKey;
    try {
        file_write({
            path: inputDir + '/linked_test_cases.json',
            content: JSON.stringify({ storyKey: storyKey, testCases: testCases }, null, 2)
        });
    } catch (e) {
        console.warn('Could not write linked_test_cases.json:', e);
    }

    var md = '# Linked Test Cases for ' + storyKey + '\n\n';
    md += 'Total: ' + testCases.length + '\n\n';
    testCases.forEach(function(tc) {
        md += renderTestCase(tc) + '\n';
    });

    try {
        file_write({
            path: inputDir + '/linked_test_cases.md',
            content: md
        });
    } catch (e) {
        console.warn('Could not write linked_test_cases.md:', e);
    }
}

function getTestCaseDirectory(tcKey, testFilesPath) {
    var basePath = (testFilesPath || 'testing/').replace(/\/$/, '');
    return basePath + '/tests/' + tcKey;
}

function removeIrrelevantTestCode(testCases, workingDir, testFilesPath, irrelevantStatus) {
    var removed = [];
    testCases.forEach(function(tc) {
        var status = tc.fields && tc.fields.status && tc.fields.status.name;
        if (status !== irrelevantStatus) return;
        var dir = getTestCaseDirectory(tc.key, testFilesPath);
        try {
            var lsOutput = cleanCommandOutput(runGit('git ls-files -- ' + dir, workingDir) || '');
            if (!lsOutput.trim()) {
                console.log('No tracked test code to remove for irrelevant TC:', tc.key);
                return;
            }
            console.log('Removing test code for irrelevant TC:', tc.key, '—', dir);
            runGit('git rm -r --ignore-unmatch -- ' + dir, workingDir);
            removed.push(tc.key);
        } catch (e) {
            console.warn('Failed to remove test code for irrelevant TC', tc.key, ':', e);
        }
    });
    return removed;
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var folder = actualParams.inputFolderPath;
        var storyKey = folder.split('/').pop();
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var testCaseType = projectConfig.jira && projectConfig.jira.issueTypes && projectConfig.jira.issueTypes.TEST_CASE
            ? projectConfig.jira.issueTypes.TEST_CASE
            : 'Test Case';
        var customParams = (params.jobParams || params).customParams || {};
        var statuses = resolveStatuses(customParams);
        var testFilesPath = customParams.testFilesGlob || 'testing/';

        console.log('=== Story test automation setup for:', storyKey, '===');

        // Step 1: Fetch linked test cases
        var testCases = fetchLinkedTestCases(storyKey, testCaseType);
        console.log('Found', testCases.length, 'linked Test Case(s)');

        if (testCases.length === 0) {
            console.warn('No linked Test Cases found for Story', storyKey);
        }

        writeLinkedTestCases(storyKey, testCases);

        // Step 2: Checkout test/{STORY_KEY} branch
        try {
            checkoutBranch(storyKey, config);
        } catch (e) {
            console.error('Branch checkout failed (non-fatal):', e);
        }

        // Step 3: Remove test code for linked TCs that are marked Irrelevant
        try {
            var removed = removeIrrelevantTestCode(testCases, config.workingDir || null, testFilesPath, statuses.IRRELEVANT || 'Irrelevant');
            if (removed.length > 0) {
                console.log('Removed test code for irrelevant TCs:', removed.join(', '));
            }
        } catch (e) {
            console.warn('Removing irrelevant test code failed (non-fatal):', e);
        }

        console.log('✅ Story test automation setup complete for', storyKey);

    } catch (error) {
        console.error('❌ Error in preCliStoryTestAutomationSetup:', error);
        return { success: false, error: error.toString() };
    }

    return { success: true };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
