/**
 * Post Test Automation Results Action (postJSAction for test_case_automation)
 * 1. Reads outputs/test_automation_result.json
 * 2. Stages testing/ folder, commits, pushes, creates PR to main
 * 3. Posts Jira comment from outputs/response.md
 * 4. If passed:          moves ticket to In Review - Passed
 * 5. If failed:          moves Test Case to In Review - Failed (bug created by bug_creation agent on Failed)
 * 6. If blocked_by_human: moves ticket to Blocked, posts what credentials/data are needed,
 *                         removes SM trigger label so ticket is re-processed after human fix
 * 7. Removes WIP label
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
const { GIT_CONFIG, STATUSES, LABELS } = require('./config.js');

function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function readFile(path) {
    try {
        const content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        console.warn('Could not read file ' + path + ':', e);
        return null;
    }
}

function readResultJson() {
    try {
        const raw = readFile('outputs/test_automation_result.json');
        if (!raw) {
            console.warn('outputs/test_automation_result.json is empty or missing');
            return null;
        }
        const parsed = JSON.parse(raw);
        console.log('Test result status:', parsed.status);
        return parsed;
    } catch (e) {
        console.error('Failed to parse test_automation_result.json:', e);
        return null;
    }
}

function runInRepo(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function performGitOperations(branchName, commitMessage, workingDir, testFilesPath) {
    var addPath = testFilesPath || 'testing/';
    var inspectPath = addPath.replace(/\/$/, '') || '.';
    try {
        // Diagnostic: list test files before staging
        try {
            var lsOutput = runInRepo('find ' + inspectPath + ' -type f 2>/dev/null | head -20', workingDir) || '';
            console.log('Files in ' + inspectPath + ':', cleanCommandOutput(lsOutput) || '(empty)');
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
            // Ensure the branch is pushed to remote so we can create/find a PR
            var remoteBranchCheck = cleanCommandOutput(
                runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || ''
            );
            if (!remoteBranchCheck.trim()) {
                console.log('No remote branch found, pushing current branch state...');
                try {
                    runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
                } catch (pushErr) {
                    console.warn('Failed to push branch:', pushErr);
                    return { success: false, error: 'No test files were written and could not push branch' };
                }
            } else {
                console.log('Branch exists on remote — test files unchanged, will create/find PR from existing branch');
            }
            // Return with branch name; main flow will create/find the PR and go to In Review - Passed/Failed
            return { success: true, branchName: branchName };
        }

        console.log('Committing...');
        runInRepo('git commit -m "' + commitMessage.replace(/"/g, '\\"') + '"', workingDir);

        console.log('Pushing to remote...');
        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
        } catch (e) {
            console.log('Normal push failed, force pushing...');
            runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
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

function createPullRequest(title, branchName, baseBranch, workingDir) {
    console.log('Creating Pull Request...');
    return prHelper.createPullRequest({
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        bodyFileCandidates: ['outputs/pr_body.md', 'outputs/response.md'],
        defaultBody: 'Automated test automation changes.',
        runCommand: runInRepo,
        readFile: readFile
    });
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const ticketSummary = params.ticket.fields ? params.ticket.fields.summary : ticketKey;
        const projectKey = ticketKey.split('-')[0];
        const jiraComment = params.response || '';
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = (params.jobParams || params).customParams || {};
        var workingDir = config.workingDir || null;
        var testFilesPath = customParams.testFilesGlob || 'testing/';

        console.log('=== Processing test automation results for', ticketKey, '===');

        // Step 1: Read structured result
        const result = readResultJson();
        if (!result) {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ⚠️ Test Automation Error\n\nCould not read test result. Check workflow logs.'
            });
            return { success: false, error: 'No test result JSON found' };
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
                const prResult = createPullRequest(prTitle, branchName, config.git.baseBranch, workingDir);
                prUrl = prResult.prUrl;
                if (!prResult.success || !prUrl) {
                    // PR creation failed — branch has code but no PR; post comment and reset to Backlog for retry
                    console.error('PR creation failed — resetting ticket to Backlog for retry');
                    try {
                        jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ PR Creation Failed\n\nTest code was pushed to branch {code}' + branchName + '{code} but the Pull Request could not be created.\n\nTicket moved back to *Backlog* — will be re-processed automatically. The next run will detect the existing branch and create the PR.\n\nError: ' + (prResult.error || 'unknown') });
                        jira_move_to_status({ key: ticketKey, statusName: 'Backlog' });
                    } catch (e) { console.warn('Could not reset to Backlog:', e); }
                    try {
                        const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
                        if (smTriggerLabel) {
                            jira_remove_label({ key: ticketKey, label: smTriggerLabel });
                            console.log('✅ Removed SM trigger label on PR failure:', smTriggerLabel);
                        }
                    } catch (e) { console.warn('Could not remove SM trigger label:', e); }
                    return { success: false, error: 'PR creation failed: ' + (prResult.error || 'no URL returned') };
                }
            } else if (gitResult.noNewCommit) {
                noCodeChanges = true;
                console.log('ℹ️ No test code changes — skipping PR review, moving ticket directly');
            } else {
                // Git operations failed — reset to Backlog for retry
                console.warn('Git operations failed:', gitResult.error);
                try {
                    jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Git Operations Failed\n\nFailed to commit/push test code: ' + gitResult.error + '\n\nTicket moved back to *Backlog* — will be re-processed automatically.' });
                    jira_move_to_status({ key: ticketKey, statusName: STATUSES.BACKLOG });
                } catch (e) { console.warn('Could not reset to Backlog:', e); }
                try {
                    jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' });
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
                jira_post_comment({ key: ticketKey, comment: comment });
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
                jira_post_comment({ key: ticketKey, comment: blockedComment });
                console.log('✅ Posted blocked comment to Jira');
            } catch (e) {
                console.warn('Failed to post blocked comment:', e);
            }

            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.BLOCKED });
                console.log('✅ Blocked — moved', ticketKey, 'to', STATUSES.BLOCKED);
            } catch (e) {
                console.warn('Failed to move to Blocked:', e);
            }

            // Remove WIP label
            const wipLabelBlocked = params.metadata && params.metadata.contextId
                ? params.metadata.contextId + '_wip'
                : 'test_case_automation_wip';
            try { jira_remove_label({ key: ticketKey, label: wipLabelBlocked }); } catch (e) {}

            // Remove SM trigger label so the ticket is re-processed after human fixes the issue
            const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
            if (smTriggerLabel) {
                try {
                    jira_remove_label({ key: ticketKey, label: smTriggerLabel });
                    console.log('✅ Removed SM trigger label:', smTriggerLabel);
                } catch (e) {}
            }

            console.log('🚫 Test', ticketKey, 'blocked by human — awaiting credentials/data');
            return { success: true, status: 'blocked_by_human', ticketKey, prUrl };
        }

        if (passed) {
            try {
                var passedStatus = noCodeChanges ? STATUSES.PASSED : STATUSES.IN_REVIEW_PASSED;
                jira_move_to_status({ key: ticketKey, statusName: passedStatus });
                console.log('✅ Passed — moved', ticketKey, 'to', passedStatus);
            } catch (e) {
                console.warn('Failed to move to Passed:', e);
            }
        } else {
            // Bug creation is handled by the bug_creation agent when TC reaches Failed status
            try {
                var failedStatus = noCodeChanges ? STATUSES.FAILED : STATUSES.IN_REVIEW_FAILED;
                jira_move_to_status({ key: ticketKey, statusName: failedStatus });
                console.log('✅ Failed — moved', ticketKey, 'to', failedStatus);
            } catch (e) {
                console.warn('Failed to move to Failed:', e);
            }
        }

        // Step 7: Add label
        try {
            jira_add_label({ key: ticketKey, label: LABELS.AI_TEST_AUTOMATION });
        } catch (e) {
            console.warn('Failed to add label:', e);
        }

        // Step 8: Remove WIP label
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'test_case_automation_wip';
        try {
            jira_remove_label({ key: ticketKey, label: wipLabel });
        } catch (e) {
            console.warn('Failed to remove WIP label:', e);
        }

        // Step 9: Always remove SM trigger label so the TC can be re-triggered
        // by adding the label again (re-run after pass, re-run after fix, etc.)
        const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
        if (smTriggerLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: smTriggerLabel });
                console.log('✅ Removed SM trigger label:', smTriggerLabel);
            } catch (e) {}
        }

        console.log('✅ Test automation workflow complete:', passed ? 'PASSED' : 'FAILED');

        return {
            success: true,
            status: result.status,
            ticketKey: ticketKey,
            prUrl: prUrl
        };

    } catch (error) {
        console.error('❌ Error in postTestAutomationResults:', error);
        try {
            jira_post_comment({
                key: params.ticket.key,
                comment: 'h3. ❌ Test Automation Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        try {
            const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
            if (smTriggerLabel) {
                jira_remove_label({ key: params.ticket.key, label: smTriggerLabel });
                console.log('✅ Removed SM trigger label on error:', smTriggerLabel);
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
