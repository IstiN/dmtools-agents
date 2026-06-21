/**
 * Pre-CLI Story Test Automation Setup Action
 * 1. Fetches all linked Test Cases for the Story.
 * 2. Writes input/{STORY_KEY}/linked_test_cases.json and .md.
 * 3. Checks out test/{STORY_KEY} branch aligned with main.
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var scmModule = require('./common/scm.js');
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

var MAX_DISCUSSION_THREADS = 100;

function trimDiscussionsMarkdown(markdown, maxThreads) {
    if (!markdown || maxThreads <= 0) return markdown;
    var marker = '\n### Thread ';
    var idx = markdown.indexOf(marker);
    if (idx === -1) return markdown;
    var header = markdown.substring(0, idx);
    var rest = markdown.substring(idx + marker.length);
    var sections = rest.split(marker);
    if (sections.length <= maxThreads) return markdown;
    var kept = sections.slice(sections.length - maxThreads);
    return header + marker + kept.join(marker);
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
    var details = 'Branch is behind origin/' + baseBranch + '. The post-action will merge origin/main and auto-resolve conflicts inside the ticket test folder.';
    writeBranchConflictGuidance(storyKey, branchName, baseBranch, details);
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
        var results = jira_search_by_jql({ jql: jql, maxResults: 100, fields: ['key', 'summary', 'status'] });
        return Array.isArray(results) ? results : [];
    } catch (e) {
        console.warn('Failed to fetch linked Test Cases:', e);
        return [];
    }
}

function renderTestCase(tc) {
    var fields = tc.fields || {};
    var lines = [];
    lines.push('- ' + tc.key + ' — ' + (fields.summary || '(no summary)') +
               ' [' + (fields.status && fields.status.name ? fields.status.name : 'Unknown') + ']');
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
    md += '\n';

    try {
        file_write({
            path: inputDir + '/linked_test_cases.md',
            content: md
        });
    } catch (e) {
        console.warn('Could not write linked_test_cases.md:', e);
    }
}

function findTestPr(scm, storyKey, config) {
    try {
        var branchName = configLoader.formatBranchName(config.git.branchPrefix.test, storyKey);
        var openPRs = scm.listPrs('open') || [];
        return openPRs.find(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName;
        }) || null;
    } catch (e) {
        console.warn('Could not list open PRs for test branch:', e);
        return null;
    }
}

function writePrContext(storyKey, scm, pr) {
    var inputDir = 'input/' + storyKey;
    try {
        var prInfo = '# Pull Request Information\n\n' +
            '- **PR #**: ' + (pr.number || '') + '\n' +
            '- **URL**: ' + (pr.html_url || '') + '\n' +
            '- **Title**: ' + (pr.title || '') + '\n' +
            '- **Author**: ' + (pr.user && pr.user.login ? pr.user.login : '') + '\n' +
            '- **Branch**: `' + (pr.head && pr.head.ref ? pr.head.ref : '') + '` → `' + (pr.base && pr.base.ref ? pr.base.ref : '') + '`\n' +
            '- **State**: ' + (pr.state || '') + '\n';
        file_write({ path: inputDir + '/pr_info.md', content: prInfo });
        console.log('✅ Wrote pr_info.md for PR #' + pr.number);
    } catch (e) {
        console.warn('Could not write pr_info.md:', e);
    }

    try {
        var diff = scm.getPrDiff(pr.number);
        if (diff) {
            file_write({ path: inputDir + '/pr_diff.txt', content: diff });
            console.log('✅ Wrote pr_diff.txt (' + diff.length + ' chars)');
        }
    } catch (e) {
        console.warn('Could not write pr_diff.txt:', e);
    }

    try {
        var discussions = scm.fetchDiscussions(pr.number);
        if (discussions && discussions.markdown) {
            var trimmedMarkdown = trimDiscussionsMarkdown(discussions.markdown, MAX_DISCUSSION_THREADS);
            if (trimmedMarkdown !== discussions.markdown) {
                console.warn('⚠️ PR discussions markdown truncated from full history to last ' + MAX_DISCUSSION_THREADS + ' threads to keep agent context bounded');
            }
            file_write({ path: inputDir + '/pr_discussions.md', content: trimmedMarkdown });
            console.log('✅ Wrote pr_discussions.md');
        }
        if (discussions && discussions.rawThreads && discussions.rawThreads.threads) {
            var rawThreads = discussions.rawThreads.threads;
            if (rawThreads.length > MAX_DISCUSSION_THREADS) {
                console.warn('⚠️ PR discussions raw threads truncated from ' + rawThreads.length + ' to last ' + MAX_DISCUSSION_THREADS + ' for review replies');
                rawThreads = rawThreads.slice(rawThreads.length - MAX_DISCUSSION_THREADS);
            }
            var replies = rawThreads
                .filter(function(t) { return !t.resolved && t.body; })
                .map(function(t) {
                    return {
                        file: t.path,
                        line: t.line,
                        comment: t.body,
                        severity: 'important',
                        threadId: t.threadId || t.id || null,
                        inReplyToId: t.rootCommentId || t.id || null
                    };
                });
            if (replies.length > 0) {
                file_write({ path: 'outputs/review_replies.json', content: JSON.stringify({ replies: replies }, null, 2) });
                console.log('✅ Wrote outputs/review_replies.json with', replies.length, 'open review thread(s)');
            }
        }
    } catch (e) {
        console.warn('Could not write PR discussions:', e);
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

        // Step 3: Fetch PR context for rework when an open test PR exists
        try {
            var scm = scmModule.createScm(projectConfig);
            var pr = findTestPr(scm, storyKey, config);
            if (pr && pr.number) {
                console.log('Open test PR found:', pr.number, '— fetching diff and discussions');
                writePrContext(storyKey, scm, pr);
            } else {
                console.log('No open test PR found for', storyKey);
            }
        } catch (e) {
            console.warn('Fetching PR context failed (non-fatal):', e);
        }

        // Step 4: Remove test code for linked TCs that are marked Irrelevant
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
