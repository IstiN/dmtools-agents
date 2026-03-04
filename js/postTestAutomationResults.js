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

const { GIT_CONFIG, STATUSES, LABELS } = require('./config.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
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

function performGitOperations(branchName, commitMessage) {
    try {
        // Diagnostic: list testing/ folder before staging
        try {
            var lsOutput = cli_execute_command({ command: 'find testing/tests/ -type f 2>/dev/null | head -20' }) || '';
            console.log('Files in testing/tests/:', cleanCommandOutput(lsOutput) || '(empty)');
        } catch (e) {
            console.warn('Could not list testing/tests/:', e);
        }

        // Stage testing/ and outputs/ folders
        console.log('Staging testing/ and outputs/ folders...');
        cli_execute_command({ command: 'git add testing/ outputs/' });

        var rawStatus = cli_execute_command({ command: 'git status --porcelain' }) || '';
        console.log('Raw git status length:', rawStatus.length);
        var statusOutput = cleanCommandOutput(rawStatus);
        console.log('Cleaned git status:', statusOutput || '(empty)');

        if (!statusOutput || !statusOutput.trim()) {
            console.warn('No new changes to commit in testing/ (files may already exist on main)');
            // Check if branch exists on remote — we can still create PR from it
            var remoteBranchCheck = cleanCommandOutput(
                cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || ''
            );
            if (remoteBranchCheck.trim()) {
                console.log('Branch exists on remote, will try to create PR from existing branch');
                return { success: true, branchName: branchName, noNewCommit: true };
            }
            // No remote branch either — push current branch so PR can be created
            console.log('No remote branch found, pushing current branch state...');
            try {
                cli_execute_command({ command: 'git push -u origin ' + branchName + ' --force' });
                return { success: true, branchName: branchName, noNewCommit: true };
            } catch (pushErr) {
                console.warn('Failed to push branch:', pushErr);
                return { success: false, error: 'No test files were written and could not push branch' };
            }
        }

        console.log('Committing...');
        cli_execute_command({
            command: 'git commit -m "' + commitMessage.replace(/"/g, '\\"') + '"'
        });

        console.log('Pushing to remote...');
        try {
            cli_execute_command({ command: 'git push -u origin ' + branchName });
        } catch (e) {
            console.log('Normal push failed, force pushing...');
            cli_execute_command({ command: 'git push -u origin ' + branchName + ' --force' });
        }

        const remoteBranch = cleanCommandOutput(
            cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || ''
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

function createPullRequest(title, branchName) {
    try {
        console.log('Creating Pull Request...');
        const escapedTitle = title.replace(/"/g, '\\"').replace(/\n/g, ' ');

        // Use pr_body.md (GitHub MD) if present, fallback to response.md
        const prBodyFile = readFile('outputs/pr_body.md')
            ? 'outputs/pr_body.md'
            : 'outputs/response.md';
        console.log('Using PR body file:', prBodyFile);

        const output = cleanCommandOutput(
            cli_execute_command({
                command: 'gh pr create --title "' + escapedTitle + '" --body-file "' + prBodyFile + '" --base ' + GIT_CONFIG.DEFAULT_BASE_BRANCH + ' --head ' + branchName
            }) || ''
        );

        let prUrl = null;
        const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
        if (urlMatch) {
            prUrl = urlMatch[0];
        }

        if (!prUrl) {
            const prNumberMatch = output.match(/#(\d+)/);
            if (prNumberMatch) {
                try {
                    const remoteUrl = cleanCommandOutput(
                        cli_execute_command({ command: 'git config --get remote.origin.url' }) || ''
                    );
                    const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
                    if (repoMatch) {
                        prUrl = 'https://github.com/' + repoMatch[1].replace('.git', '') + '/pull/' + prNumberMatch[1];
                    }
                } catch (e) {}
            }
        }

        if (!prUrl) {
            try {
                const listOutput = cleanCommandOutput(
                    cli_execute_command({ command: 'gh pr list --head ' + branchName + ' --json url --jq ".[0].url"' }) || ''
                );
                if (listOutput && listOutput.startsWith('https://')) prUrl = listOutput;
            } catch (e) {}
        }

        console.log('✅ PR created:', prUrl || '(URL not found)');
        return { success: true, prUrl: prUrl };

    } catch (error) {
        console.error('Failed to create PR:', error);
        return { success: false, error: error.toString() };
    }
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const ticketSummary = params.ticket.fields ? params.ticket.fields.summary : ticketKey;
        const projectKey = ticketKey.split('-')[0];
        const jiraComment = params.response || '';

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
            cli_execute_command({ command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"' });
            cli_execute_command({ command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"' });
        } catch (e) {
            console.warn('Failed to configure git author:', e);
        }

        // Step 3: Read current branch (set by preCliTestAutomationSetup)
        var rawBranch = cli_execute_command({ command: 'git branch --show-current' }) || '';
        console.log('Raw branch output length:', rawBranch.length, 'content:', JSON.stringify(rawBranch.substring(0, 200)));
        const branchName = cleanCommandOutput(rawBranch);
        console.log('Cleaned branch name:', JSON.stringify(branchName));
        if (!branchName) {
            console.warn('Could not determine current branch — skipping git operations');
        }

        // Step 4: Commit + push + create PR
        let prUrl = null;
        if (branchName) {
            const commitMessage = ticketKey + ' test: automate ' + ticketSummary;
            const gitResult = performGitOperations(branchName, commitMessage);

            if (gitResult.success) {
                const prTitle = ticketKey + ' ' + ticketSummary;
                const prResult = createPullRequest(prTitle, branchName);
                prUrl = prResult.prUrl;
            } else {
                console.warn('Git operations failed:', gitResult.error);
            }
        }

        // Step 5: Post Jira comment
        try {
            let comment = jiraComment || '';
            if (prUrl) {
                comment += '\n\n*Test Branch PR*: ' + prUrl;
            }
            if (comment) {
                jira_post_comment({ key: ticketKey, comment: comment });
                console.log('✅ Posted test result comment to Jira');
            }
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 6: Handle outcome
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
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REVIEW_PASSED });
                console.log('✅ Passed — moved', ticketKey, 'to', STATUSES.IN_REVIEW_PASSED);
            } catch (e) {
                console.warn('Failed to move to In Review - Passed:', e);
            }
        } else {
            // Bug creation is handled by the bug_creation agent when TC reaches Failed status
            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REVIEW_FAILED });
                console.log('✅ Failed — moved', ticketKey, 'to', STATUSES.IN_REVIEW_FAILED);
            } catch (e) {
                console.warn('Failed to move to In Review - Failed:', e);
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
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
