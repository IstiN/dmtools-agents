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
// Tracker-agnostic ticket ops; (re)created inside action() so no tracker exists at module load.
var tracker = null;

function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function readFile(path) {
    return outputFiles.readOutputFile(path, {});
}

function readOutputFile(relativePath, workingDir, ticketKey) {
    return outputFiles.readOutputFile(relativePath, {
        workingDir: workingDir,
        ticketKey: ticketKey
    });
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
    if (!markdown) return '';

    var text = String(markdown);

    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, function(_, language, code) {
        return '{code' + (language ? ':' + language : '') + '}\n' + code.trim() + '\n{code}';
    });

    text = text
        .replace(/^####\s+(.+)$/gm, 'h4. $1')
        .replace(/^###\s+(.+)$/gm, 'h3. $1')
        .replace(/^##\s+(.+)$/gm, 'h2. $1')
        .replace(/^#\s+(.+)$/gm, 'h1. $1')
        .replace(/^\s*-\s+/gm, '* ')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/`([^`\n]+)`/g, '{{$1}}')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '[$1|$2]');

    return text.trim();
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

function runInRepo(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function fetchRemoteBranch(branchName, workingDir) {
    try {
        runInRepo('git fetch origin ' + branchName, workingDir);
        return true;
    } catch (e) {
        console.warn('Could not fetch remote branch origin/' + branchName + ':', e);
        return false;
    }
}

function revParse(ref, workingDir) {
    try {
        return cleanCommandOutput(runInRepo('git rev-parse ' + ref, workingDir) || '').trim();
    } catch (e) {
        return '';
    }
}

function findMergeBase(left, right, workingDir) {
    try {
        return cleanCommandOutput(runInRepo('git merge-base ' + left + ' ' + right, workingDir) || '').trim();
    } catch (e) {
        return '';
    }
}

function publishExistingBranch(branchName, workingDir) {
    // Ensure the local remote-tracking ref is fresh before any push decision.
    fetchRemoteBranch(branchName, workingDir);

    var localSha = revParse('HEAD', workingDir);
    var remoteSha = revParse('origin/' + branchName, workingDir);

    // The identical check must stay BEFORE the merge-base call: when the
    // branch is already in sync no `git merge-base` command may run.
    var strategy;
    if (localSha && remoteSha && localSha === remoteSha) {
        strategy = 'identical';
    } else {
        var mergeBase = (localSha && remoteSha) ? findMergeBase('HEAD', 'origin/' + branchName, workingDir) : '';
        // gh-1043: pure decision extracted (and unit-tested) in postHelpers —
        // the strategies below keep the original command order and log lines.
        strategy = postHelpers.decidePublishStrategy(localSha, remoteSha, mergeBase);
    }

    if (strategy === 'identical') {
        console.log('Local branch already matches origin/' + branchName + '; no push needed');
        return { success: true, noNewCommit: true };
    }

    if (strategy === 'ahead') {
        // Local is strictly ahead of remote (fast-forward).
        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
            return { success: true, noNewCommit: true };
        } catch (e) {
            console.warn('Fast-forward push failed:', e);
        }
    } else if (strategy === 'behind') {
        // Remote moved ahead while we had no local changes to keep. Adopt remote state.
        console.log('Remote ' + branchName + ' is ahead of local branch; resetting to origin/' + branchName);
        runInRepo('git reset --hard origin/' + branchName, workingDir);
        return { success: true, noNewCommit: true };
    }

    // Branches diverged or no remote yet; fall back to push with refreshed lease.
    try {
        runInRepo('git push -u origin ' + branchName, workingDir);
        return { success: true, noNewCommit: true };
    } catch (pushErr) {
        console.log('Normal push failed, retrying with --force-with-lease...');
        try {
            runInRepo('git push -u origin ' + branchName + ' --force-with-lease', workingDir);
            return { success: true, noNewCommit: true };
        } catch (forcePushErr) {
            console.warn('Failed to publish existing branch:', forcePushErr);
            return { success: false, error: 'No test files were written and the synced branch could not be pushed' };
        }
    }
}

function performGitOperations(branchName, commitMessage, workingDir, testFilesPath) {
    var addPath = testFilesPath || 'testing/';
    var inspectPath = addPath.replace(/\/$/, '') || '.';
    try {
        // Diagnostic: list test files before staging
        try {
            var lsOutput = runInRepo('git status --short -- ' + inspectPath, workingDir) || '';
            console.log('Git status for ' + inspectPath + ':', cleanCommandOutput(lsOutput) || '(empty)');
        } catch (e) {
            console.warn('Could not list ' + inspectPath + ':', e);
        }

        // Stage the configured test path only (outputs/ is gitignored — test artifacts should not be committed)
        console.log('Staging test path:', addPath);
        runInRepo('git add ' + addPath, workingDir);

        // Check for STAGED changes only (git status --porcelain also includes dirty submodule etc.)
        var stagedOutput = cleanCommandOutput(runInRepo('git diff --cached --stat', workingDir) || '');
        console.log('Staged changes:', stagedOutput || '(none)');

        if (!stagedOutput || !stagedOutput.trim()) {
            console.warn('No new staged changes in ' + addPath + ' (files may already exist on branch)');
            // Ensure the branch is pushed to remote so we can create/find a PR.
            // preCliTestAutomationSetup may have rebased/merged origin/main into
            // an existing test branch without changing test files. In that case
            // there are no staged changes here, but the branch tip still needs to
            // be published; otherwise the remote test/<KEY> branch stays stale.
            var remoteBranchExists = false;
            try {
                // gh-912: decide on a real refs/heads/<branch> ref line — a
                // warning-only capture (central-mode insteadOf origin, git
                // ≥ 2.54) must classify as "branch absent" so the push runs.
                remoteBranchExists = prHelper.remoteBranchExists(runInRepo, workingDir, branchName);
            } catch (lsRemoteErr) {
                console.warn('Error checking remote branches:', lsRemoteErr);
            }
            if (!remoteBranchExists) {
                console.log('No remote branch found, pushing current branch state...');
                try {
                    runInRepo('git push -u origin ' + branchName, workingDir);
                } catch (pushErr) {
                    console.warn('Failed to push branch:', pushErr);
                    return { success: false, error: 'No test files were written and could not push branch' };
                }
            } else {
                var publishResult = publishExistingBranch(branchName, workingDir);
                if (!publishResult.success) {
                    return publishResult;
                }
            }
            return { success: true, branchName: branchName, noNewCommit: true };
        }

        console.log('Committing...');
        runInRepo('git commit -m "' + prHelper.sanitizeCommitMessage(commitMessage) + '"', workingDir);

        console.log('Pushing to remote...');
        fetchRemoteBranch(branchName, workingDir);
        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
        } catch (e) {
            console.log('Normal push failed, retrying with --force-with-lease...');
            try {
                runInRepo('git push -u origin ' + branchName + ' --force-with-lease', workingDir);
            } catch (leaseErr) {
                console.log('Force-with-lease push failed, force pushing...');
                runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
            }
        }

        var remoteBranchExists = false;
        try {
            // gh-912: verify the push produced a real refs/heads/<branch> ref
            // line — stderr noise never counts as the branch existing.
            remoteBranchExists = prHelper.remoteBranchExists(runInRepo, workingDir, branchName);
        } catch (lsRemoteErr) {
            console.warn('Error checking remote branches:', lsRemoteErr);
        }
        if (!remoteBranchExists) {
            throw new Error('Branch not found on remote after push');
        }

        console.log('✅ Git operations completed');
        return { success: true, branchName: branchName };

    } catch (error) {
        console.error('Git operations failed:', error);
        return { success: false, error: error.toString() };
    }
}

function createPullRequest(title, branchName, baseBranch, workingDir, scm, ticketKey) {
    console.log('Creating Pull Request...');
    return prHelper.createPullRequest({
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        scm: scm,
        // gh-737: merge bot links approved issues via 'Closes #N' — emit it
        // by construction on every test-automation PR.
        ticketKey: ticketKey,
        bodyFileCandidates: ['outputs/pr_body.md', 'outputs/response.md'],
        defaultBody: 'Automated test automation changes.',
        runCommand: runInRepo,
        readFile: readFile
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
    if (!customParams || !customParams.autoStartReview || !customParams.autoStartReviewConfigFile) {
        return false;
    }

    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: ticketKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartReviewConfigFile,
            label: 'pr_test_automation_review',
            stripKeys: [
                'removeLabel',
                'autoStartReview',
                'autoStartReviewConfigFile'
            ]
        });
    } catch (e) {
        console.warn('⚠️ autoStartReview trigger failed:', e.message || e);
        return false;
    }
}

function action(params) {
    var jobParams = params.jobParams || params;
    var customParams = jobParams.customParams || {};
    // Early tracker so the catch-path can still comment if config loading fails
    tracker = trackersModule.createTracker(null, customParams);
    try {
        const ticketKey = params.ticket.key;
        const ticketSummary = params.ticket.fields ? params.ticket.fields.summary : ticketKey;
        const projectKey = ticketKey.split('-')[0];
        var config = configLoader.loadProjectConfig(jobParams);
        tracker = trackersModule.createTracker(config, customParams);
        var jiraConfig = config.jira;
        var scm = configLoader.createScm(config);
        var workingDir = config.workingDir || null;
        var testFilesPath = customParams.testFilesGlob || 'testing/';
        const jiraComment = readJiraComment(params, workingDir, ticketKey);

        console.log('=== Processing test automation results for', ticketKey, '===');

        // Step 1: Read structured result
        const result = readResultJson(workingDir, ticketKey);
        if (!result) {
            return handleMissingResult(params, config, ticketKey, ticketSummary, workingDir, testFilesPath, jiraConfig);
        }

        const outcome = postHelpers.parseOutcome(result);
        const passed = outcome.passed;
        const blockedByHuman = outcome.blockedByHuman;

        // Step 2: Configure git author
        try {
            runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
            runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
        } catch (e) {
            console.warn('Failed to configure git author:', e);
        }

        // Step 3: Read current branch (set by preCliTestAutomationSetup)
        var rawBranch = runInRepo('git branch --show-current', workingDir) || '';
        console.log('Raw branch output length:', rawBranch.length, 'content:', JSON.stringify(rawBranch.substring(0, 200)));
        const branchName = cleanCommandOutput(rawBranch);
        console.log('Cleaned branch name:', JSON.stringify(branchName));
        if (!branchName) {
            console.warn('Could not determine current branch — skipping git operations');
        }

        // Step 4: Commit + push + create PR
        let prUrl = null;
        let noCodeChanges = false;
        if (branchName) {
            const commitMessage = configLoader.formatTemplate(config.formats.commitMessage.testAutomation, {ticketKey: ticketKey, ticketSummary: ticketSummary});
            const gitResult = performGitOperations(branchName, commitMessage, workingDir, testFilesPath);

            if (gitResult.success && !gitResult.noNewCommit) {
                const prTitle = configLoader.formatTemplate(config.formats.prTitle.testAutomation, {ticketKey: ticketKey, ticketSummary: ticketSummary});
                const prResult = createPullRequest(prTitle, branchName, config.git.baseBranch, workingDir, scm, ticketKey);
                prUrl = prResult.prUrl;
                if (!prResult.success || !prUrl) {
                    return resetToBacklogAfterPrFailure(ticketKey, branchName, prResult, jiraConfig, params);
                }

                if (hasBranchConflictGuidance(ticketKey, workingDir)) {
                    var mergeable = getPrMergeability(prUrl, workingDir);
                    console.log('PR mergeability after branch conflict guidance:', mergeable || '(unknown)');
                    if (mergeable === 'CONFLICTING') {
                        return handleConflictingPr(ticketKey, branchName, config.git.baseBranch, prUrl, jiraConfig, params);
                    }
                }
            } else if (gitResult.noNewCommit) {
                noCodeChanges = true;
                console.log('ℹ️ No test code changes — skipping PR review, moving ticket directly');
            } else {
                return resetToBacklogAfterGitFailure(ticketKey, gitResult, jiraConfig);
            }
        }

        // Step 5: Post Jira comment
        try {
            let comment = postHelpers.buildFinalComment(jiraComment, prUrl, noCodeChanges);
            if (comment) {
                tracker.postComment(ticketKey, comment);
                console.log('✅ Posted test result comment to Jira');
            }
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 6: Handle outcome
        // When no code changes, skip "In Review" and move directly to final status
        // (test code was already reviewed in a previous run)
        if (blockedByHuman) {
            return handleBlockedByHuman(ticketKey, result, prUrl, jiraConfig, params);
        }

        if (passed) {
            moveToOutcomeStatus(true, noCodeChanges, ticketKey, jiraConfig);
        } else {
            // Bug creation is handled by the bug_creation agent when TC reaches Failed status
            moveToOutcomeStatus(false, noCodeChanges, ticketKey, jiraConfig);
        }

        if (!blockedByHuman) {
            if (!autoStartTestReview(ticketKey, config, customParams, noCodeChanges)) {
                autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
            }
        }

        finalizeTicketLabels(ticketKey, params);

        console.log('✅ Test automation workflow complete:', passed ? 'PASSED' : 'FAILED');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            status: result.status,
            ticketKey: ticketKey,
            prUrl: prUrl
        };

    } catch (error) {
        console.error('❌ Error in postTestAutomationResults:', error);
        try {
            tracker.postComment(params.ticket.key, postHelpers.buildErrorComment(error));
        } catch (e) {}
        try {
            const smTriggerLabel = postHelpers.decideSmTriggerLabel(params);
            if (smTriggerLabel) {
                tracker.removeLabel(params.ticket.key, smTriggerLabel);
                console.log('✅ Removed SM trigger label on error:', smTriggerLabel);
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
