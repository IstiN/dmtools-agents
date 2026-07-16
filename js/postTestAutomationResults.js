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
var trackerHelper = require('./common/tracker.js');

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

    if (localSha && remoteSha && localSha === remoteSha) {
        console.log('Local branch already matches origin/' + branchName + '; no push needed');
        return { success: true, noNewCommit: true };
    }

    var mergeBase = (localSha && remoteSha) ? findMergeBase('HEAD', 'origin/' + branchName, workingDir) : '';

    if (mergeBase === remoteSha && mergeBase !== localSha) {
        // Local is strictly ahead of remote (fast-forward).
        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
            return { success: true, noNewCommit: true };
        } catch (e) {
            console.warn('Fast-forward push failed:', e);
        }
    } else if (mergeBase === localSha && mergeBase !== remoteSha) {
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
            var remoteBranchCheck = cleanCommandOutput(
                runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || ''
            );
            if (!remoteBranchCheck.trim()) {
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

        const remoteBranch = cleanCommandOutput(
            runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || ''
        );
        if (!remoteBranch.trim()) {
            throw new Error('Branch not found on remote after push');
        }

        console.log('✅ Git operations completed');
        return { success: true, branchName: branchName };

    } catch (error) {
        console.error('Git operations failed:', error);
        return { success: false, error: error.toString() };
    }
}

function createPullRequest(title, branchName, baseBranch, workingDir, scm) {
    console.log('Creating Pull Request...');
    return prHelper.createPullRequest({
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        scm: scm,
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
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'test_case_automation_wip';
        trackerHelper.removeLabel(ticketKey, wipLabel);
    } catch (e) {}

    try {
        const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
        if (smTriggerLabel) {
            trackerHelper.removeLabel(ticketKey, smTriggerLabel);
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        }
    } catch (e) {}
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
    try {
        const ticketKey = params.ticket.key;
        const ticketSummary = params.ticket.fields ? params.ticket.fields.summary : ticketKey;
        const projectKey = ticketKey.split('-')[0];
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var trackerConfig = config.tracker;
        var customParams = (params.jobParams || params).customParams || {};
        var scm = configLoader.createScm(config);
        var workingDir = config.workingDir || null;
        var testFilesPath = customParams.testFilesGlob || 'testing/';
        const jiraComment = readJiraComment(params, workingDir, ticketKey);

        console.log('=== Processing test automation results for', ticketKey, '===');

        // Step 1: Read structured result
        const result = readResultJson(workingDir, ticketKey);
        if (!result) {
            // CLI failed (e.g. rate limit) but may have written partial code — push it
            var partialPushed = false;
            try {
                var rawBranchMissing = runInRepo('git branch --show-current', workingDir) || '';
                var branchMissing = cleanCommandOutput(rawBranchMissing);
                if (branchMissing) {
                    runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
                    runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
                    var partialCommitMsg = configLoader.formatTemplate(
                        config.formats.commitMessage.testAutomation,
                        {ticketKey: ticketKey, ticketSummary: ticketSummary}
                    ) + ' (partial — CLI interrupted)';
                    var gitResult = performGitOperations(branchMissing, partialCommitMsg, workingDir, testFilesPath);
                    if (gitResult.success && !gitResult.noNewCommit) {
                        partialPushed = true;
                        console.log('✅ Pushed partial work on branch', branchMissing);
                    }
                }
            } catch (e) {
                console.warn('Could not push partial work:', e);
            }

            var commentMsg = 'h3. ⚠️ Test Automation Error\n\nCLI exited without producing result JSON (likely hit rate limit or crashed).\n';
            if (partialPushed) {
                commentMsg += 'Partial code was pushed to the branch — next retry will continue from there.\n';
            }
            commentMsg += 'Ticket moved back to *Backlog* so SM can retry.';

            tracker_post_comment({ key: ticketKey, comment: commentMsg });
            try {
                tracker_move_to_status({ key: ticketKey, statusName: trackerConfig.statuses.BACKLOG });
                console.log('✅ Missing result — moved', ticketKey, 'to', trackerConfig.statuses.BACKLOG);
            } catch (e) {
                console.warn('Failed to move missing-result ticket to Backlog:', e);
            }
            try {
                const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
                if (smTriggerLabel) {
                    trackerHelper.removeLabel(ticketKey, smTriggerLabel);
                    console.log('✅ Removed SM trigger label after missing result:', smTriggerLabel);
                }
            } catch (e) {
                console.warn('Failed to remove SM trigger label after missing result:', e);
            }
            try {
                const wipLabelMissingResult = params.metadata && params.metadata.contextId
                    ? params.metadata.contextId + '_wip'
                    : 'test_case_automation_wip';
                trackerHelper.removeLabel(ticketKey, wipLabelMissingResult);
            } catch (e) {
                console.warn('Failed to remove WIP label after missing result:', e);
            }
            return { success: false, error: 'No test result JSON found', partialPushed: partialPushed };
        }

        const status = (result.status || '').toLowerCase();
        const passed = status === 'passed';
        const blockedByHuman = status === 'blocked_by_human';

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
                const prResult = createPullRequest(prTitle, branchName, config.git.baseBranch, workingDir, scm);
                prUrl = prResult.prUrl;
                if (!prResult.success || !prUrl) {
                    // PR creation failed — branch has code but no PR; post comment and reset to Backlog for retry
                    console.error('PR creation failed — resetting ticket to Backlog for retry');
                    try {
                        tracker_post_comment({ key: ticketKey, comment: 'h3. ⚠️ PR Creation Failed\n\nTest code was pushed to branch {code}' + branchName + '{code} but the Pull Request could not be created.\n\nTicket moved back to *Backlog* — will be re-processed automatically. The next run will detect the existing branch and create the PR.\n\nError: ' + (prResult.error || 'unknown') });
                        tracker_move_to_status({ key: ticketKey, statusName: trackerConfig.statuses.BACKLOG });
                    } catch (e) { console.warn('Could not reset to Backlog:', e); }
                    try {
                        const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
                        if (smTriggerLabel) {
                            trackerHelper.removeLabel(ticketKey, smTriggerLabel);
                            console.log('✅ Removed SM trigger label on PR failure:', smTriggerLabel);
                        }
                    } catch (e) { console.warn('Could not remove SM trigger label:', e); }
                    return { success: false, error: 'PR creation failed: ' + (prResult.error || 'no URL returned') };
                }

                if (hasBranchConflictGuidance(ticketKey, workingDir)) {
                    var mergeable = getPrMergeability(prUrl, workingDir);
                    console.log('PR mergeability after branch conflict guidance:', mergeable || '(unknown)');
                    if (mergeable === 'CONFLICTING') {
                        var conflictComment = 'h3. 🚫 Test Automation Blocked — PR Conflicts With Main\n\n' +
                            'The test automation branch {code}' + branchName + '{code} still conflicts with {code}' + config.git.baseBranch + '{code} after the agent run.\n\n' +
                            '*Pull Request:* ' + prUrl + '\n\n' +
                            'A {code}merge_conflicts.md{code} guidance file was present for this run, which means the existing test branch could not be safely auto-aligned with {code}origin/' + config.git.baseBranch + '{code}. ' +
                            'Do not send this PR into automated review until the branch is deliberately synced with main and only ticket-specific test automation changes remain.\n\n' +
                            'Ticket moved to *Blocked* for human conflict resolution.';
                        try { tracker_post_comment({ key: ticketKey, comment: conflictComment }); } catch (e) {}
                        try {
                            tracker_move_to_status({ key: ticketKey, statusName: trackerConfig.statuses.BLOCKED });
                            console.log('✅ Conflicting PR — moved', ticketKey, 'to', trackerConfig.statuses.BLOCKED);
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
                }
            } else if (gitResult.noNewCommit) {
                noCodeChanges = true;
                console.log('ℹ️ No test code changes — skipping PR review, moving ticket directly');
            } else {
                // Git operations failed — reset to Backlog for retry
                console.warn('Git operations failed:', gitResult.error);
                try {
                    tracker_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Git Operations Failed\n\nFailed to commit/push test code: ' + gitResult.error + '\n\nTicket moved back to *Backlog* — will be re-processed automatically.' });
                    tracker_move_to_status({ key: ticketKey, statusName: trackerConfig.statuses.BACKLOG });
                } catch (e) { console.warn('Could not reset to Backlog:', e); }
                try {
                    trackerHelper.removeLabel(ticketKey, 'sm_test_automation_triggered');
                } catch (e) {}
                return { success: false, error: 'Git operations failed: ' + gitResult.error };
            }
        }

        // Step 5: Post Jira comment
        try {
            let comment = jiraComment || '';
            if (prUrl) {
                comment += '\n\n*Test Branch PR*: ' + prUrl;
            }
            if (noCodeChanges) {
                comment += '\n\nℹ️ _Test code unchanged from previous run — PR review step skipped._';
            }
            if (comment) {
                tracker_post_comment({ key: ticketKey, comment: comment });
                console.log('✅ Posted test result comment to Jira');
            }
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 6: Handle outcome
        // When no code changes, skip "In Review" and move directly to final status
        // (test code was already reviewed in a previous run)
        if (blockedByHuman) {
            // Build blocked comment
            var blockedComment = 'h3. 🚫 Test Automation Blocked — Awaiting Human Setup\n\n';
            if (result.blocked_reason) {
                blockedComment += result.blocked_reason + '\n\n';
            }
            if (result.missing && result.missing.length > 0) {
                blockedComment += 'h4. Required setup:\n\n';
                result.missing.forEach(function(item) {
                    blockedComment += '* *' + (item.name || '?') + '*';
                    if (item.description) blockedComment += ': ' + item.description;
                    blockedComment += '\n';
                    if (item.how_to_add) {
                        blockedComment += '{code:bash}' + item.how_to_add + '{code}\n';
                    }
                });
            }
            if (prUrl) {
                blockedComment += '\n*Test Branch PR* (test code is ready, skips without credentials): ' + prUrl;
            }
            blockedComment += '\n\nOnce setup is complete, move this ticket back to *Backlog* to trigger re-run.';

            try {
                tracker_post_comment({ key: ticketKey, comment: blockedComment });
                console.log('✅ Posted blocked comment to Jira');
            } catch (e) {
                console.warn('Failed to post blocked comment:', e);
            }

            try {
                tracker_move_to_status({ key: ticketKey, statusName: trackerConfig.statuses.BLOCKED });
                console.log('✅ Blocked — moved', ticketKey, 'to', trackerConfig.statuses.BLOCKED);
            } catch (e) {
                console.warn('Failed to move to Blocked:', e);
            }

            // Remove WIP label
            const wipLabelBlocked = params.metadata && params.metadata.contextId
                ? params.metadata.contextId + '_wip'
                : 'test_case_automation_wip';
            try { trackerHelper.removeLabel(ticketKey, wipLabelBlocked); } catch (e) {}

            // Remove SM trigger label so the ticket is re-processed after human fixes the issue
            const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
            if (smTriggerLabel) {
                try {
                    trackerHelper.removeLabel(ticketKey, smTriggerLabel);
                    console.log('✅ Removed SM trigger label:', smTriggerLabel);
                } catch (e) {}
            }

            console.log('🚫 Test', ticketKey, 'blocked by human — awaiting credentials/data');
            return { success: true, status: 'blocked_by_human', ticketKey, prUrl };
        }

        if (passed) {
            try {
                var passedStatus = noCodeChanges ? trackerConfig.statuses.PASSED : trackerConfig.statuses.IN_REVIEW_PASSED;
                tracker_move_to_status({ key: ticketKey, statusName: passedStatus });
                console.log('✅ Passed — moved', ticketKey, 'to', passedStatus);
            } catch (e) {
                console.warn('Failed to move to Passed:', e);
            }
        } else {
            // Bug creation is handled by the bug_creation agent when TC reaches Failed status
            try {
                var failedStatus = noCodeChanges ? trackerConfig.statuses.FAILED : trackerConfig.statuses.IN_REVIEW_FAILED;
                tracker_move_to_status({ key: ticketKey, statusName: failedStatus });
                console.log('✅ Failed — moved', ticketKey, 'to', failedStatus);
            } catch (e) {
                console.warn('Failed to move to Failed:', e);
            }
        }

        if (!blockedByHuman) {
            if (!autoStartTestReview(ticketKey, config, customParams, noCodeChanges)) {
                autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
            }
        }

        // Step 7: Add label
        try {
            trackerHelper.addLabel(ticketKey, LABELS.AI_TEST_AUTOMATION);
        } catch (e) {
            console.warn('Failed to add label:', e);
        }

        // Step 8: Remove WIP label
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'test_case_automation_wip';
        try {
            trackerHelper.removeLabel(ticketKey, wipLabel);
        } catch (e) {
            console.warn('Failed to remove WIP label:', e);
        }

        // Step 9: Always remove SM trigger label so the TC can be re-triggered
        // by adding the label again (re-run after pass, re-run after fix, etc.)
        const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
        if (smTriggerLabel) {
            try {
                trackerHelper.removeLabel(ticketKey, smTriggerLabel);
                console.log('✅ Removed SM trigger label:', smTriggerLabel);
            } catch (e) {}
        }

        console.log('✅ Test automation workflow complete:', passed ? 'PASSED' : 'FAILED');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
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
            tracker_post_comment({
                key: params.ticket.key,
                comment: 'h3. ❌ Test Automation Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        try {
            const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
            if (smTriggerLabel) {
                trackerHelper.removeLabel(params.ticket.key, smTriggerLabel);
                console.log('✅ Removed SM trigger label on error:', smTriggerLabel);
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
