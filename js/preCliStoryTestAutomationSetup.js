/**
 * Pre-CLI Story Test Automation Setup Action
 * 1. Fetches all linked Test Cases for the Story.
 * 2. Writes input/{STORY_KEY}/linked_test_cases.json and .md.
 * 3. Checks out test/{STORY_KEY} branch and keeps it synced with origin/main:
 *    - if the branch was already merged → delete it and recreate from fresh main;
 *    - if it has unmerged test work → merge origin/main into it;
 *    - on merge conflicts → write merge_conflicts.md + pr_diff.txt so the agent can resolve them.
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var scmModule = require('./common/scm.js');
var gh = require('./common/githubHelpers.js');
const { STATUSES, resolveStatuses } = require('./config.js');
var trackersModule = require('./common/trackers.js');

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
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

function alignBranchWithBase(storyKey, branchName, baseBranch, workingDir, inputFolder) {
    // Make sure remote refs are fresh before any merge/ancestor decision —
    // targeted: just this branch and its base (owner rule 2026-10-03).
    try {
        var targetedFetch = prHelper.buildTargetedOriginFetchCommand([branchName, baseBranch]);
        if (targetedFetch) runGit(targetedFetch, workingDir);
    } catch (e) {
        console.warn('Could not fetch remote branches during align:', e);
    }

    var localExists = cleanCommandOutput(
        runGit('git branch --list "' + branchName + '"', workingDir) || ''
    ).trim() !== '';
    var remoteExists = false;
    try {
        // gh-912: decide on a real refs/heads/<branch> ref line — a
        // warning-only capture (central-mode insteadOf origin, git ≥ 2.54)
        // must classify as "branch absent".
        remoteExists = prHelper.remoteBranchExists(runGit, workingDir, branchName);
    } catch (e) {
        console.warn('Error checking remote branches:', e);
    }

    if (!localExists && !remoteExists) {
        console.log('Creating new test branch from', baseBranch + ':', branchName);
        runGit('git checkout ' + baseBranch, workingDir);
        runGit('git pull origin ' + baseBranch, workingDir);
        runGit('git checkout -b ' + branchName, workingDir);
        return;
    }

    if (!localExists && remoteExists) {
        console.log('Checking out remote test branch:', branchName);
        runGit('git checkout -b ' + branchName + ' origin/' + branchName, workingDir);
    } else {
        console.log('Switching to existing local test branch:', branchName);
        runGit('git checkout ' + branchName, workingDir);
    }

    // Case 1: the test branch has already been merged into main.
    // Drop the stale branch (local + remote) and create a fresh one from main.
    if (isAncestorRef('HEAD', 'origin/' + baseBranch, workingDir)) {
        console.log('Test branch ' + branchName + ' is already merged into origin/' + baseBranch + '; recreating from fresh ' + baseBranch);
        runGit('git checkout ' + baseBranch, workingDir);
        try {
            runGit('git branch -D ' + branchName, workingDir);
        } catch (e) {
            console.warn('Could not delete local test branch:', e);
        }
        try {
            runGit('git push origin --delete ' + branchName, workingDir);
        } catch (e) {
            console.warn('Could not delete remote test branch:', e);
        }
        runGit('git pull origin ' + baseBranch, workingDir);
        runGit('git checkout -b ' + branchName, workingDir);
        return;
    }

    // Case 2: branch has unmerged test work — always pull main into it.
    console.log('Merging origin/' + baseBranch + ' into test branch ' + branchName);
    var conflictFiles = gh.detectMergeConflicts(baseBranch, inputFolder, workingDir);
    if (conflictFiles.length > 0) {
        console.warn('⚠️ Merge conflicts detected after pulling origin/' + baseBranch + ':', conflictFiles.join(', '));
        try {
            var diff = gh.getPRDiff(baseBranch, branchName, workingDir);
            if (diff) {
                file_write({
                    path: inputFolder + '/pr_diff.txt',
                    content: gh.trimLargeTextForInput(diff, 'PR Diff', 12000)
                });
                console.log('✅ Wrote pr_diff.txt for conflict resolution');
            }
        } catch (e) {
            console.warn('Could not write pr_diff.txt:', e);
        }
        writeBranchConflictGuidance(
            storyKey,
            branchName,
            baseBranch,
            'Merge conflicts after pulling origin/' + baseBranch + ' into ' + branchName + ':\n\n' +
            conflictFiles.map(function(f) { return '* ' + f; }).join('\n') + '\n\n' +
            'Resolve conflicts, stage the files, and continue. The post-action will commit and push the resolved test code.'
        );
    } else {
        console.log('✅ Merged origin/' + baseBranch + ' cleanly into test branch ' + branchName);
    }
}

function checkoutBranch(storyKey, config, inputFolder) {
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
        var setupFetch = prHelper.buildTargetedOriginFetchCommand([branchName, config.git.baseBranch]);
        if (setupFetch) runGit(setupFetch, workingDir);
    } catch (e) {
        console.warn('Could not fetch remote branches:', e);
    }

    alignBranchWithBase(storyKey, branchName, config.git.baseBranch, workingDir, inputFolder);

    console.log('✅ Branch ready:', branchName);
}

function fetchLinkedTestCases(storyKey, testCaseType, tracker) {
    var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = "' + testCaseType + '"';
    console.log('Fetching linked Test Cases with JQL:', jql);
    try {
        // JQL text: provider-specific query (WIQL on ado)
        var results = tracker.searchIssues(jql, { maxResults: 100, fields: ['key', 'summary', 'status'] });
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

// ── gh-930: writePrContext split into formatting helpers ────────────────────
// Every helper is source-agnostic: it only consumes the scm abstraction
// (getPrDiff / fetchDiscussions) and the PR object shape, so GitHub, GitLab
// and ADO PRs flow through the same code paths.

function prUserLogin(pr) {
    return pr.user && pr.user.login ? pr.user.login : '';
}

function prBranchPair(pr) {
    return '`' + (pr.head && pr.head.ref ? pr.head.ref : '') + '` → `' + (pr.base && pr.base.ref ? pr.base.ref : '') + '`';
}

function buildPrInfoMarkdown(pr) {
    return '# Pull Request Information\n' +
        '- **PR #**: ' + (pr.number || '') + '\n' +
        '- **URL**: ' + (pr.html_url || '') + '\n' +
        '- **Title**: ' + (pr.title || '') + '\n' +
        '- **Author**: ' + prUserLogin(pr) + '\n' +
        '- **Branch**: ' + prBranchPair(pr) + '\n' +
        '- **State**: ' + (pr.state || '') + '\n';
}

function writePrInfo(inputDir, pr) {
    try {
        file_write({ path: inputDir + '/pr_info.md', content: buildPrInfoMarkdown(pr) });
        console.log('✅ Wrote pr_info.md for PR #' + pr.number);
    } catch (e) {
        console.warn('Could not write pr_info.md:', e);
    }
}

function writePrDiff(inputDir, scm, pr) {
    try {
        var diff = scm.getPrDiff(pr.number);
        if (diff) {
            file_write({ path: inputDir + '/pr_diff.txt', content: diff });
            console.log('✅ Wrote pr_diff.txt (' + diff.length + ' chars)');
        }
    } catch (e) {
        console.warn('Could not write pr_diff.txt:', e);
    }
}

function writePrDiscussionsMarkdown(inputDir, discussions) {
    if (!discussions || !discussions.markdown) return;
    var trimmedMarkdown = trimDiscussionsMarkdown(discussions.markdown, MAX_DISCUSSION_THREADS);
    if (trimmedMarkdown !== discussions.markdown) {
        console.warn('⚠️ PR discussions markdown truncated from full history to last ' + MAX_DISCUSSION_THREADS + ' threads to keep agent context bounded');
    }
    file_write({ path: inputDir + '/pr_discussions.md', content: trimmedMarkdown });
    console.log('✅ Wrote pr_discussions.md');
}

function openThreadReplies(rawThreads) {
    var threads = rawThreads.threads;
    if (threads.length > MAX_DISCUSSION_THREADS) {
        console.warn('⚠️ PR discussions raw threads truncated from ' + threads.length + ' to last ' + MAX_DISCUSSION_THREADS + ' for review replies');
        threads = threads.slice(threads.length - MAX_DISCUSSION_THREADS);
    }
    return threads
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
}

function writeReviewReplies(replies) {
    if (replies.length > 0) {
        file_write({ path: 'outputs/review_replies.json', content: JSON.stringify({ replies: replies }, null, 2) });
        console.log('✅ Wrote outputs/review_replies.json with', replies.length, 'open review thread(s)');
    }
}

function writePrDiscussions(inputDir, discussions) {
    writePrDiscussionsMarkdown(inputDir, discussions);
    if (discussions && discussions.rawThreads && discussions.rawThreads.threads) {
        writeReviewReplies(openThreadReplies(discussions.rawThreads));
    }
}

function writePrContext(storyKey, scm, pr) {
    var inputDir = 'input/' + storyKey;
    writePrInfo(inputDir, pr);
    writePrDiff(inputDir, scm, pr);
    try {
        writePrDiscussions(inputDir, scm.fetchDiscussions(pr.number));
    } catch (e) {
        console.warn('Could not write PR discussions:', e);
    }
}

function getTestCaseDirectory(tcKey, testFilesPath) {
    var basePath = (testFilesPath || 'testing/').replace(/\/$/, '');
    return basePath + '/tests/' + tcKey;
}

// ── gh-1192: removeIrrelevantTestCode split into a per-TC helper ────────────

/**
 * Remove the tracked test code of ONE TC whose status marks it irrelevant.
 * Mutates `removed` (collected in list order); every failure is a warn that
 * skips just this TC.
 */
function removeTestCodeForIrrelevantTc(tc, workingDir, testFilesPath, irrelevantStatus, removed) {
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
}

function removeIrrelevantTestCode(testCases, workingDir, testFilesPath, irrelevantStatus) {
    var removed = [];
    testCases.forEach(function(tc) {
        removeTestCodeForIrrelevantTc(tc, workingDir, testFilesPath, irrelevantStatus, removed);
    });
    return removed;
}

// ── gh-1192: action() split into a context builder + per-step executors ─────

/** The Test Case issue type configured for the project (default 'Test Case'). */
function testCaseTypeOf(projectConfig) {
    return projectConfig.jira && projectConfig.jira.issueTypes && projectConfig.jira.issueTypes.TEST_CASE
        ? projectConfig.jira.issueTypes.TEST_CASE
        : 'Test Case';
}

/** Everything the setup steps need, resolved once, in the original order. */
function resolveSetupContext(params) {
    var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
    var folder = actualParams.inputFolderPath;
    var storyKey = folder.split('/').pop();
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var customParams = (params.jobParams || params).customParams || {};
    return {
        actualParams: actualParams,
        folder: folder,
        storyKey: storyKey,
        config: config,
        projectConfig: projectConfig,
        testCaseType: testCaseTypeOf(projectConfig),
        customParams: customParams,
        tracker: trackersModule.createTracker(projectConfig, customParams),
        statuses: resolveStatuses(customParams),
        testFilesPath: customParams.testFilesGlob || 'testing/'
    };
}

/** Step 1: fetch the linked Test Cases and write the input context files. */
function stepFetchLinkedTestCases(ctx) {
    var testCases = fetchLinkedTestCases(ctx.storyKey, ctx.testCaseType, ctx.tracker);
    console.log('Found', testCases.length, 'linked Test Case(s)');

    if (testCases.length === 0) {
        console.warn('No linked Test Cases found for Story', ctx.storyKey);
    }

    writeLinkedTestCases(ctx.storyKey, testCases);
    return testCases;
}

/** Step 2: checkout test/{STORY_KEY} synced with the base branch (non-fatal). */
function stepCheckoutTestBranch(ctx) {
    try {
        checkoutBranch(ctx.storyKey, ctx.config, ctx.folder);
    } catch (e) {
        console.error('Branch checkout failed (non-fatal):', e);
    }
}

/** Step 3: fetch PR context for rework when an open test PR exists (non-fatal). */
function stepWriteTestPrContext(ctx) {
    try {
        var scm = scmModule.createScm(ctx.projectConfig);
        var pr = findTestPr(scm, ctx.storyKey, ctx.config);
        if (pr && pr.number) {
            console.log('Open test PR found:', pr.number, '— fetching diff and discussions');
            writePrContext(ctx.storyKey, scm, pr);
        } else {
            console.log('No open test PR found for', ctx.storyKey);
        }
    } catch (e) {
        console.warn('Fetching PR context failed (non-fatal):', e);
    }
}

/** Step 4: remove test code for linked TCs marked Irrelevant (non-fatal). */
function stepRemoveIrrelevantTestCode(ctx, testCases) {
    try {
        var removed = removeIrrelevantTestCode(testCases, ctx.config.workingDir || null, ctx.testFilesPath, ctx.statuses.IRRELEVANT || 'Irrelevant');
        if (removed.length > 0) {
            console.log('Removed test code for irrelevant TCs:', removed.join(', '));
        }
    } catch (e) {
        console.warn('Removing irrelevant test code failed (non-fatal):', e);
    }
}

function action(params) {
    try {
        var ctx = resolveSetupContext(params);

        console.log('=== Story test automation setup for:', ctx.storyKey, '===');

        var testCases = stepFetchLinkedTestCases(ctx);
        stepCheckoutTestBranch(ctx);
        stepWriteTestPrContext(ctx);
        stepRemoveIrrelevantTestCode(ctx, testCases);

        console.log('✅ Story test automation setup complete for', ctx.storyKey);

    } catch (error) {
        console.error('❌ Error in preCliStoryTestAutomationSetup:', error);
        return { success: false, error: error.toString() };
    }

    return { success: true };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        // gh-1192: extracted setup/removal helpers (test surface)
        removeIrrelevantTestCode: removeIrrelevantTestCode,
        removeTestCodeForIrrelevantTc: removeTestCodeForIrrelevantTc,
        getTestCaseDirectory: getTestCaseDirectory,
        testCaseTypeOf: testCaseTypeOf
    };
}
