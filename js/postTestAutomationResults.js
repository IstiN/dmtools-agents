/**
 * Post Test Automation Results Action (postJSAction for test_case_automation)
 * 1. Reads outputs/test_automation_result.json
 * 2. Stages testing/ folder, commits, pushes, creates PR to main
 * 3. Posts tracker comment from outputs/tracker_comment.md (fallback: comment.md, jira_comment.md)
 * 4. If passed:          moves ticket to In Review - Passed
 * 5. If failed:          moves Test Case to In Review - Failed (bug created by bug_creation agent on Failed)
 * 6. If blocked_by_human: moves ticket to Blocked, posts what credentials/data are needed,
 *                         removes SM trigger label so ticket is re-processed after human fix
 * 7. Removes WIP label
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var autoStart = require('./common/autoStart.js');
const { GIT_CONFIG, LABELS } = require('./config.js');
var outputFiles = require('./common/outputFiles.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackersModule = require('./common/trackers.js');
var postHelpers = require('./postTestAutomationResultsHelpers.js');
var shared = require('./postStoryTestAutomationShared.js');
// Tracker-agnostic ticket ops; (re)created inside action() so no tracker exists at module load.
var tracker = null;

var gitOps = shared.createGitOps(prHelper);
var runInRepo = shared.runInRepo;
var outputReaders = shared.makeOutputFileReaders(outputFiles);
var readFile = outputReaders.readFile;
var readOutputFile = outputReaders.readOutputFile;

function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function resultBelongsToTicket(parsed, ticketKey) {
    if (!parsed || typeof parsed !== 'object') return true;
    var keys = [parsed.ticketKey, parsed.storyKey, parsed.testCaseKey, parsed.issueKey];
    for (var i = 0; i < keys.length; i++) {
        if (keys[i] && keys[i] !== ticketKey) {
            console.warn('outputs/test_automation_result.json belongs to ' + keys[i] + ', not ' + ticketKey + ' — treating as stale');
            return false;
        }
    }
    return true;
}

function readResultJson(workingDir, ticketKey) {
    try {
        const raw = readOutputFile('test_automation_result.json', workingDir, ticketKey);
        if (!raw) {
            console.warn('outputs/test_automation_result.json is empty or missing');
            return null;
        }
        const parsed = JSON.parse(raw);
        if (!resultBelongsToTicket(parsed, ticketKey)) {
            return null;
        }
        console.log('Test result status:', parsed.status);
        return parsed;
    } catch (e) {
        console.error('Failed to parse test_automation_result.json:', e);
        return null;
    }
}

function markdownToJiraWiki(markdown) {
    // Canonical copy lives in postStoryTestAutomationShared.js (gh-1246).
    return shared.markdownToJiraWiki(markdown);
}

function readJiraComment(params, workingDir, ticketKey) {
    var jiraComment = readOutputFile('tracker_comment.md', workingDir, ticketKey);
    if (jiraComment) return jiraComment;

    jiraComment = readOutputFile('comment.md', workingDir, ticketKey);
    if (jiraComment) return jiraComment;

    jiraComment = readOutputFile('jira_comment.md', workingDir, ticketKey);
    if (jiraComment) return jiraComment;

    return markdownToJiraWiki(params.response || readOutputFile('response.md', workingDir, ticketKey) || '');
}

// ── gh-1190: performGitOperations seam split ────────────────────────────────────────────────────
// The git machinery is canonical in postStoryTestAutomationShared.js
// (gh-1246); these thin wrappers keep the exported test surface pinned by
// test_postTestAutomationResults.js. Same probes/pushes in the same order,
// same log lines, same return shapes.

/** Diagnostic: list test files under `inspectPath` before staging (best-effort). */
function logStagingDiagnostics(inspectPath, workingDir) {
    return gitOps.logStagingDiagnostics(inspectPath, workingDir);
}

/**
 * Nothing-staged publish path: ensure the branch tip is on remote so a PR can
 * still be created/found. preCliTestAutomationSetup may have rebased/merged
 * origin/main into an existing test branch without changing test files — in
 * that case there are no staged changes here, but the branch tip still needs
 * to be published; otherwise the remote test/<KEY> branch stays stale.
 */
function publishNoStagedChanges(branchName, addPath, workingDir) {
    return gitOps.handleNoStagedChanges(addPath, branchName, workingDir);
}

/**
 * Commit the staged test changes and push — with the force-with-lease and
 * plain-force retry chain for repos where the branch has diverged.
 */
function commitAndPushTestChanges(branchName, commitMessage, workingDir) {
    console.log('Committing...');
    runInRepo('git commit -m "' + prHelper.sanitizeCommitMessage(commitMessage) + '"', workingDir);
    gitOps.pushWithEscalation(branchName, workingDir);
}

/** Post-push verification: the branch must be a real ref on origin (gh-912). */
function verifyBranchOnRemoteAfterPush(branchName, workingDir) {
    return gitOps.verifyRemoteBranchPresent(branchName, workingDir);
}

function performGitOperations(branchName, commitMessage, workingDir, testFilesPath) {
    return gitOps.performGitOperations(branchName, commitMessage, workingDir, testFilesPath);
}

function createPullRequest(title, branchName, baseBranch, workingDir, scm, ticketKey) {
    // gh-737: merge bot links approved issues via 'Closes #N' — emitted by
    // construction on every test-automation PR; the defaultBody fallback is
    // posted verbatim.
    return shared.createTestPullRequest(prHelper, runInRepo, readFile, {
        defaultBody: 'Automated test automation changes.',
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        scm: scm,
        ticketKey: ticketKey
    });
}

function hasBranchConflictGuidance(ticketKey, workingDir) {
    var relativePath = 'input/' + ticketKey + '/merge_conflicts.md';
    if (readFile(relativePath)) return true;
    if (workingDir && readFile(workingDir + '/' + relativePath)) return true;
    return false;
}

function getPrMergeability(prUrl, workingDir) {
    try {
        var raw = cleanCommandOutput(runInRepo('gh pr view ' + prUrl + ' --json mergeable', workingDir) || '');
        if (!raw) return '';
        var parsed = JSON.parse(raw);
        return parsed && parsed.mergeable ? String(parsed.mergeable) : '';
    } catch (e) {
        console.warn('Could not read PR mergeability:', e);
        return '';
    }
}

function removeAutomationLabels(ticketKey, params) {
    try {
        tracker.removeLabel(ticketKey, postHelpers.decideWipLabel(params.metadata));
    } catch (e) {}

    try {
        const smTriggerLabel = postHelpers.decideSmTriggerLabel(params);
        if (smTriggerLabel) {
            tracker.removeLabel(ticketKey, smTriggerLabel);
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        }
    } catch (e) {}
}

// ── Outcome handlers (gh-961): small side-effecting branch clusters
// extracted from action() so the orchestration function stays below the
// CRAP threshold. Log lines and tracker call order are unchanged.

// CLI failed (e.g. rate limit) but may have written partial code — push it.
function pushPartialWorkIfPossible(config, ticketKey, ticketSummary, workingDir, testFilesPath) {
    var partialPushed = false;
    try {
        var rawBranchMissing = runInRepo('git branch --show-current', workingDir) || '';
        var branchMissing = cleanCommandOutput(rawBranchMissing);
        if (branchMissing) {
            runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
            runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
            var partialCommitMsg = postHelpers.buildPartialCommitMessage(
                configLoader.formatTemplate(
                    config.formats.commitMessage.testAutomation,
                    {ticketKey: ticketKey, ticketSummary: ticketSummary}
                )
            );
            var gitResult = performGitOperations(branchMissing, partialCommitMsg, workingDir, testFilesPath);
            if (gitResult.success && !gitResult.noNewCommit) {
                partialPushed = true;
                console.log('✅ Pushed partial work on branch', branchMissing);
            }
        }
    } catch (e) {
        console.warn('Could not push partial work:', e);
    }
    return partialPushed;
}

function notifyMissingResult(ticketKey, partialPushed, jiraConfig) {
    tracker.postComment(ticketKey, postHelpers.buildMissingResultComment(partialPushed));
    try {
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.BACKLOG);
        console.log('✅ Missing result — moved', ticketKey, 'to', jiraConfig.statuses.BACKLOG);
    } catch (e) {
        console.warn('Failed to move missing-result ticket to Backlog:', e);
    }
}

function removeLabelsAfterMissingResult(ticketKey, params) {
    try {
        const smTriggerLabel = postHelpers.decideSmTriggerLabel(params);
        if (smTriggerLabel) {
            tracker.removeLabel(ticketKey, smTriggerLabel);
            console.log('✅ Removed SM trigger label after missing result:', smTriggerLabel);
        }
    } catch (e) {
        console.warn('Failed to remove SM trigger label after missing result:', e);
    }
    try {
        tracker.removeLabel(ticketKey, postHelpers.decideWipLabel(params.metadata));
    } catch (e) {
        console.warn('Failed to remove WIP label after missing result:', e);
    }
}

function handleMissingResult(params, config, ticketKey, ticketSummary, workingDir, testFilesPath, jiraConfig) {
    var partialPushed = pushPartialWorkIfPossible(config, ticketKey, ticketSummary, workingDir, testFilesPath);
    notifyMissingResult(ticketKey, partialPushed, jiraConfig);
    removeLabelsAfterMissingResult(ticketKey, params);
    return { success: false, error: 'No test result JSON found', partialPushed: partialPushed };
}

// PR creation failed — branch has code but no PR; post comment and reset to Backlog for retry.
function resetToBacklogAfterPrFailure(ticketKey, branchName, prResult, jiraConfig, params) {
    console.error('PR creation failed — resetting ticket to Backlog for retry');
    try {
        tracker.postComment(ticketKey, postHelpers.buildPrFailureComment(branchName, prResult.error));
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.BACKLOG);
    } catch (e) { console.warn('Could not reset to Backlog:', e); }
    try {
        const smTriggerLabel = postHelpers.decideSmTriggerLabel(params);
        if (smTriggerLabel) {
            tracker.removeLabel(ticketKey, smTriggerLabel);
            console.log('✅ Removed SM trigger label on PR failure:', smTriggerLabel);
        }
    } catch (e) { console.warn('Could not remove SM trigger label:', e); }
    return { success: false, error: 'PR creation failed: ' + (prResult.error || 'no URL returned') };
}

function handleConflictingPr(ticketKey, branchName, baseBranch, prUrl, jiraConfig, params) {
    try { tracker.postComment(ticketKey, postHelpers.buildConflictComment(branchName, baseBranch, prUrl)); } catch (e) {}
    try {
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.BLOCKED);
        console.log('✅ Conflicting PR — moved', ticketKey, 'to', jiraConfig.statuses.BLOCKED);
    } catch (e) {
        console.warn('Failed to move conflicting PR ticket to Blocked:', e);
    }
    removeAutomationLabels(ticketKey, params);
    return {
        success: true,
        status: 'blocked_by_human',
        ticketKey: ticketKey,
        prUrl: prUrl,
        blockedReason: 'pr_conflicts_with_main'
    };
}

// Git operations failed — reset to Backlog for retry.
function resetToBacklogAfterGitFailure(ticketKey, gitResult, jiraConfig) {
    console.warn('Git operations failed:', gitResult.error);
    try {
        tracker.postComment(ticketKey, postHelpers.buildGitFailureComment(gitResult.error));
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.BACKLOG);
    } catch (e) { console.warn('Could not reset to Backlog:', e); }
    try {
        tracker.removeLabel(ticketKey, 'sm_test_automation_triggered');
    } catch (e) {}
    return { success: false, error: 'Git operations failed: ' + gitResult.error };
}

function handleBlockedByHuman(ticketKey, result, prUrl, jiraConfig, params) {
    try {
        tracker.postComment(ticketKey, postHelpers.buildBlockedComment(result, prUrl));
        console.log('✅ Posted blocked comment to Jira');
    } catch (e) {
        console.warn('Failed to post blocked comment:', e);
    }

    try {
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.BLOCKED);
        console.log('✅ Blocked — moved', ticketKey, 'to', jiraConfig.statuses.BLOCKED);
    } catch (e) {
        console.warn('Failed to move to Blocked:', e);
    }

    // Remove WIP label
    try { tracker.removeLabel(ticketKey, postHelpers.decideWipLabel(params.metadata)); } catch (e) {}

    // Remove SM trigger label so the ticket is re-processed after human fixes the issue
    const smTriggerLabel = postHelpers.decideSmTriggerLabel(params);
    if (smTriggerLabel) {
        try {
            tracker.removeLabel(ticketKey, smTriggerLabel);
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        } catch (e) {}
    }

    console.log('🚫 Test', ticketKey, 'blocked by human — awaiting credentials/data');
    return { success: true, status: 'blocked_by_human', ticketKey: ticketKey, prUrl: prUrl };
}

// gh-916: Passed / Failed can be tag-only (restricted ADO workflows) — stage-label fallback.
function moveToOutcomeStatus(passed, noCodeChanges, ticketKey, jiraConfig) {
    var outcomeName = passed ? 'Passed' : 'Failed';
    try {
        var target = postHelpers.decideTargetStatus(passed, noCodeChanges, jiraConfig.statuses);
        var move = tracker.moveToStatusOrMark(ticketKey, target.statusName, target.stage);
        if (move.moved || move.marked) {
            console.log('✅ ' + outcomeName + ' — moved', ticketKey, 'to', target.statusName);
        }
    } catch (e) {
        console.warn('Failed to move to ' + outcomeName + ':', e);
    }
}

// Step 7-9: add AI label, remove WIP label, always remove SM trigger label
// so the TC can be re-triggered by adding the label again.
function finalizeTicketLabels(ticketKey, params) {
    try {
        tracker.addLabel(ticketKey, LABELS.AI_TEST_AUTOMATION);
    } catch (e) {
        console.warn('Failed to add label:', e);
    }

    try {
        tracker.removeLabel(ticketKey, postHelpers.decideWipLabel(params.metadata));
    } catch (e) {
        console.warn('Failed to remove WIP label:', e);
    }

    const smTriggerLabel = postHelpers.decideSmTriggerLabel(params);
    if (smTriggerLabel) {
        try {
            tracker.removeLabel(ticketKey, smTriggerLabel);
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        } catch (e) {}
    }
}

function autoStartTestReview(ticketKey, config, customParams, noCodeChanges) {
    if (noCodeChanges) {
        console.log('ℹ️ autoStartReview: skipped — no test code changes to review');
        return false;
    }
    return shared.triggerAutoStartReviewWorkflow(autoStart, ticketKey, customParams, config, 'pr_test_automation_review');
}

// ── gh-1083: action() split — thin executors, same calls in the same order ──

/** Steps 2+3: configure the git author and read the current branch. */
function resolveCurrentBranch(config, workingDir) {
    // gh-1246: canonical author config in postStoryTestAutomationShared.js
    // (same commands, same warn line).
    shared.configureGitAuthor(runInRepo, config, workingDir);

    var rawBranch = runInRepo('git branch --show-current', workingDir) || '';
    console.log('Raw branch output length:', rawBranch.length, 'content:', JSON.stringify(rawBranch.substring(0, 200)));
    var branchName = cleanCommandOutput(rawBranch);
    console.log('Cleaned branch name:', JSON.stringify(branchName));
    if (!branchName) {
        console.warn('Could not determine current branch — skipping git operations');
    }
    return branchName;
}

/** create-pr route: PR creation, then the conflict-guidance check (gh-1083). */
function createPrAndCheckConflicts(branchName, ticketKey, ticketSummary, workingDir, config, scm, jiraConfig, params) {
    var prTitle = configLoader.formatTemplate(config.formats.prTitle.testAutomation, {ticketKey: ticketKey, ticketSummary: ticketSummary});
    var prResult = createPullRequest(prTitle, branchName, config.git.baseBranch, workingDir, scm, ticketKey);
    var prUrl = prResult.prUrl;
    if (!prResult.success || !prUrl) {
        return { prUrl: prUrl, terminal: resetToBacklogAfterPrFailure(ticketKey, branchName, prResult, jiraConfig, params) };
    }

    if (hasBranchConflictGuidance(ticketKey, workingDir)) {
        var mergeable = getPrMergeability(prUrl, workingDir);
        console.log('PR mergeability after branch conflict guidance:', mergeable || '(unknown)');
        if (mergeable === 'CONFLICTING') {
            return {
                prUrl: prUrl,
                terminal: handleConflictingPr(ticketKey, branchName, config.git.baseBranch, prUrl, jiraConfig, params)
            };
        }
    }

    return { prUrl: prUrl, terminal: null };
}

/**
 * Step 4: commit + push + create PR for the resolved branch. Returns
 * { prUrl, noCodeChanges, terminal } — terminal is the pre-built early-exit
 * result (PR failure, conflicting PR, git failure); the caller returns it
 * unchanged, before any further tracker call.
 */
function runBranchStage(branchName, ticketKey, ticketSummary, workingDir, testFilesPath, config, scm, jiraConfig, params) {
    if (!branchName) {
        return { prUrl: null, noCodeChanges: false, terminal: null };
    }

    var commitMessage = configLoader.formatTemplate(config.formats.commitMessage.testAutomation, {ticketKey: ticketKey, ticketSummary: ticketSummary});
    var gitResult = performGitOperations(branchName, commitMessage, workingDir, testFilesPath);
    var route = postHelpers.decideGitStageRoute(gitResult);

    if (route === 'no-new-commit') {
        console.log('ℹ️ No test code changes — skipping PR review, moving ticket directly');
        return { prUrl: null, noCodeChanges: true, terminal: null };
    }
    if (route === 'git-failure') {
        return { prUrl: null, noCodeChanges: false, terminal: resetToBacklogAfterGitFailure(ticketKey, gitResult, jiraConfig) };
    }

    var pr = createPrAndCheckConflicts(branchName, ticketKey, ticketSummary, workingDir, config, scm, jiraConfig, params);
    return { prUrl: pr.prUrl, noCodeChanges: false, terminal: pr.terminal };
}

/** Step 5: post the final tracker comment (failures are non-fatal warns). */
function postFinalOutcomeComment(ticketKey, jiraComment, prUrl, noCodeChanges) {
    try {
        var comment = postHelpers.buildFinalComment(jiraComment, prUrl, noCodeChanges);
        if (comment) {
            tracker.postComment(ticketKey, comment);
            console.log('✅ Posted test result comment to Jira');
        }
    } catch (e) {
        console.warn('Failed to post Jira comment:', e);
    }
}

/** Step 6b: trigger the configured review workflow, else the SM idle trigger. */
function triggerReviewOrIdle(ticketKey, config, customParams, noCodeChanges) {
    if (!autoStartTestReview(ticketKey, config, customParams, noCodeChanges)) {
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
    }
}

/** Token usage summary comments (outputs/*_usage.json); failures are non-fatal. */
function postUsageSummaryComments(ticketKey, params) {
    // Canonical guarded wrapper in common/tokenUsageComment.js (gh-1246).
    tokenUsageComment.postUsageSummariesSafely(ticketKey, params);
}

/** Outer-catch side effects: error comment + SM trigger label removal (best-effort). */
function handleActionError(trackerRef, params, error) {
    try {
        trackerRef.postComment(params.ticket.key, postHelpers.buildErrorComment(error));
    } catch (e) {}
    try {
        var smTriggerLabel = postHelpers.decideSmTriggerLabel(params);
        if (smTriggerLabel) {
            trackerRef.removeLabel(params.ticket.key, smTriggerLabel);
            console.log('✅ Removed SM trigger label on error:', smTriggerLabel);
        }
    } catch (e) {}
}

function loadConfigSafe(jobParams) {
    try { return configLoader.loadProjectConfig(jobParams); } catch (e) { return null; }
}

function action(params) {
    var jobParams = postHelpers.resolveJobParams(params);
    var customParams = jobParams.customParams || {};
    // Early tracker so the catch-path can still comment if config loading fails
    tracker = trackersModule.createTracker(loadConfigSafe(jobParams), customParams);
    try {
        var identity = postHelpers.resolveTicketIdentity(params);
        const ticketKey = identity.ticketKey;
        var config = configLoader.loadProjectConfig(jobParams);
        tracker = trackersModule.createTracker(config, customParams);
        var jiraConfig = config.jira;
        var scm = configLoader.createScm(config);
        var paths = postHelpers.resolveRunPaths(config, customParams);
        var workingDir = paths.workingDir;
        var testFilesPath = paths.testFilesPath;
        const jiraComment = readJiraComment(params, workingDir, ticketKey);

        console.log('=== Processing test automation results for', ticketKey, '===');

        // Step 1: Read structured result
        const result = readResultJson(workingDir, ticketKey);
        if (!result) {
            return handleMissingResult(params, config, ticketKey, identity.ticketSummary, workingDir, testFilesPath, jiraConfig);
        }

        const outcome = postHelpers.parseOutcome(result);
        const passed = outcome.passed;
        const blockedByHuman = outcome.blockedByHuman;

        // Steps 2-4: git author, current branch, commit/push + PR creation
        var branchName = resolveCurrentBranch(config, workingDir);
        var stage = runBranchStage(branchName, ticketKey, identity.ticketSummary, workingDir, testFilesPath, config, scm, jiraConfig, params);
        if (stage.terminal) {
            return stage.terminal;
        }
        var prUrl = stage.prUrl;
        var noCodeChanges = stage.noCodeChanges;

        // Step 5: Post Jira comment
        postFinalOutcomeComment(ticketKey, jiraComment, prUrl, noCodeChanges);

        // Step 6: Handle outcome
        // When no code changes, skip "In Review" and move directly to final status
        // (test code was already reviewed in a previous run)
        if (blockedByHuman) {
            return handleBlockedByHuman(ticketKey, result, prUrl, jiraConfig, params);
        }

        // Bug creation is handled by the bug_creation agent when TC reaches Failed status
        moveToOutcomeStatus(passed, noCodeChanges, ticketKey, jiraConfig);

        // blocked_by_human returned above — review workflow, else the SM idle trigger
        triggerReviewOrIdle(ticketKey, config, customParams, noCodeChanges);

        finalizeTicketLabels(ticketKey, params);

        console.log('✅ Test automation workflow complete:', postHelpers.decideOutcomeWord(passed));

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        postUsageSummaryComments(ticketKey, params);

        return {
            success: true,
            status: result.status,
            ticketKey: ticketKey,
            prUrl: prUrl
        };

    } catch (error) {
        console.error('❌ Error in postTestAutomationResults:', error);
        handleActionError(tracker, params, error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        // gh-1190: performGitOperations seam clusters exported for direct
        // characterization tests (same calls/log lines/order as the inline
        // original — pinned by test_postTestAutomationResults.js).
        performGitOperations: performGitOperations,
        logStagingDiagnostics: logStagingDiagnostics,
        publishNoStagedChanges: publishNoStagedChanges,
        commitAndPushTestChanges: commitAndPushTestChanges,
        verifyBranchOnRemoteAfterPush: verifyBranchOnRemoteAfterPush
    };
}
