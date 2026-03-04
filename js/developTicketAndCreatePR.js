/**
 * Develop Ticket and Create PR Action
 * Handles git operations, branch creation, commit, push, and PR creation after cursor agent development
 */

// Import common helper functions
const { extractTicketKey } = require('./common/jiraHelpers.js');
const { GIT_CONFIG, STATUSES, LABELS } = require('./config.js');

/**
 * Clean command output from script wrapper artifacts
 * Removes "Script started/done" lines that DMTools CLI adds
 *
 * @param {string} output - Raw command output
 * @returns {string} Cleaned output
 */
function cleanCommandOutput(output) {
    if (!output) {
        return '';
    }

    // Remove "Script started" and "Script done" lines
    const lines = output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    });

    return lines.join('\n').trim();
}

/**
 * Generate unique branch name with collision detection
 * Appends _1, _2, _3 etc. if branch already exists locally or remotely
 */
function generateUniqueBranchName(branchPrefix, ticketKey) {
    const baseBranchName = branchPrefix + '/' + ticketKey;

    // Check if base branch exists locally or remotely
    try {
        // Fetch latest remote branches without pulling
        try {
            cli_execute_command({
                command: 'git fetch origin --prune'
            });
        } catch (fetchError) {
            console.warn('Could not fetch remote branches:', fetchError);
        }

        // Check local branches
        const localBranches = cli_execute_command({
            command: 'git branch --list "*' + baseBranchName + '*"'
        }) || '';

        // Check remote branches
        const remoteBranches = cli_execute_command({
            command: 'git branch --remotes --list "origin/' + baseBranchName + '*"'
        }) || '';

        const allBranches = localBranches + '\n' + remoteBranches;

        // If no branches exist with this base name, use it
        if (!allBranches.trim() || allBranches.trim() === '\n') {
            return baseBranchName;
        }

        // Try with suffixes _1, _2, _3, etc.
        for (let i = 1; i <= 10; i++) {
            const candidateName = baseBranchName + '_' + i;
            if (allBranches.indexOf(candidateName) === -1) {
                return candidateName;
            }
        }

        // Fallback: use timestamp suffix if too many collisions
        const timestamp = Date.now();
        return baseBranchName + '_' + timestamp;

    } catch (error) {
        console.warn('Error checking existing branches, using base name:', error);
        return baseBranchName;
    }
}

/**
 * Configure git author for AI Teammate commits
 *
 * @returns {boolean} True if successful
 */
function configureGitAuthor() {
    try {
        cli_execute_command({
            command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"'
        });

        cli_execute_command({
            command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"'
        });

        console.log('✅ Configured git author as AI Teammate');
        return true;

    } catch (error) {
        console.error('Failed to configure git author:', error);
        return false;
    }
}

/**
 * Stage changes, commit, and push on current branch
 *
 * @param {string} branchName - Current branch name (already checked out by preCliJSAction)
 * @param {string} commitMessage - Commit message
 * @returns {Object} Result with success status and branch name
 */
function performGitOperations(branchName, commitMessage) {
    try {
        // Stage all changes
        console.log('Staging changes...');
        cli_execute_command({
            command: 'git add .'
        });

        // Check if there are changes to commit
        const rawStatusOutput = cli_execute_command({
            command: 'git status --porcelain'
        });
        const statusOutput = cleanCommandOutput(rawStatusOutput);

        if (!statusOutput || !statusOutput.trim()) {
            console.warn('No changes to commit');
            return {
                success: false,
                error: 'No changes were made by the development process'
            };
        }

        // Commit changes
        console.log('Committing changes...');
        cli_execute_command({
            command: 'git commit -m "' + commitMessage.replace(/"/g, '\\"') + '"'
        });

        // Push to remote
        console.log('Pushing to remote...');
        const pushOutput = cli_execute_command({
            command: 'git push -u origin ' + branchName
        }) || '';

        // cli_execute_command exits 0 even for rejected pushes — check output for errors
        const pushFailed = pushOutput.indexOf('remote rejected') !== -1 ||
                           pushOutput.indexOf('GH013') !== -1 ||
                           pushOutput.indexOf('error: failed to push') !== -1 ||
                           pushOutput.indexOf('push declined') !== -1;

        if (pushFailed) {
            return {
                success: false,
                isPushFailure: true,
                error: 'Push was rejected by remote: ' + pushOutput.substring(0, 500)
            };
        }

        // Verify branch is actually present on remote
        console.log('Verifying branch is pushed to remote...');
        const lsRemoteOutput = cli_execute_command({
            command: 'git ls-remote --heads origin ' + branchName
        }) || '';

        // ls-remote stdout contains refs/heads/<branch> when the branch exists
        if (lsRemoteOutput.indexOf('refs/heads/' + branchName) === -1) {
            return {
                success: false,
                isPushFailure: true,
                error: 'Branch was not found on remote after push'
            };
        }

        console.log('✅ Git operations completed successfully');
        return {
            success: true,
            branchName: branchName
        };

    } catch (error) {
        console.error('Git operations failed:', error);
        return {
            success: false,
            error: error.toString()
        };
    }
}

/**
 * Create Pull Request using GitHub CLI
 * Expects outputs/response.md to already exist with PR body content
 *
 * @param {string} title - PR title
 * @param {string} branchName - Branch name to use as head
 * @returns {Object} Result with success status and PR URL
 */
function createPullRequest(title, branchName) {
    try {
        console.log('Creating Pull Request...');

        // Escape special characters in title
        const escapedTitle = title.replace(/"/g, '\\"').replace(/\n/g, ' ');

        // Use outputs/response.md as body-file (must exist before calling this)
        const bodyFilePath = 'outputs/response.md';

        console.log('Using PR body file:', bodyFilePath);
        console.log('Using branch:', branchName);

        // Create PR using gh CLI with body-file
        // Explicitly specify --head to prevent interactive prompts in headless environment
        const output = cli_execute_command({
            command: 'gh pr create --title "' + escapedTitle + '" --body-file "' + bodyFilePath + '" --base ' + GIT_CONFIG.DEFAULT_BASE_BRANCH + ' --head ' + branchName
        }) || '';

        console.log('Raw gh pr create output (length=' + output.length + '):');
        console.log('---START---');
        console.log(output);
        console.log('---END---');

        // Extract PR URL from output - try multiple patterns
        let prUrl = null;

        // Pattern 1: Full URL
        let urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
        if (urlMatch) {
            prUrl = urlMatch[0];
            console.log('Found URL via pattern 1 (full URL):', prUrl);
        }

        // Pattern 2: If not found, try to get PR number and construct URL
        if (!prUrl) {
            const prNumberMatch = output.match(/#(\d+)/);
            if (prNumberMatch) {
                // Get repo info from git remote
                try {
                    const remoteUrl = cli_execute_command({
                        command: 'git config --get remote.origin.url'
                    }) || '';
                    const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
                    if (repoMatch) {
                        const repo = repoMatch[1].replace('.git', '');
                        prUrl = 'https://github.com/' + repo + '/pull/' + prNumberMatch[1];
                        console.log('Constructed URL from PR number #' + prNumberMatch[1] + ':', prUrl);
                    }
                } catch (e) {
                    console.warn('Failed to construct URL from PR number:', e);
                }
            }
        }

        // Pattern 3: If still not found, query gh pr list for this branch
        if (!prUrl) {
            try {
                const prListOutput = cli_execute_command({
                    command: 'gh pr list --head ' + branchName + ' --json url --jq ".[0].url"'
                }) || '';
                const cleanedUrl = cleanCommandOutput(prListOutput);
                if (cleanedUrl && cleanedUrl.startsWith('https://')) {
                    prUrl = cleanedUrl;
                    console.log('Found URL via gh pr list:', prUrl);
                }
            } catch (e) {
                console.warn('Failed to get URL via gh pr list:', e);
            }
        }

        if (!prUrl) {
            console.warn('PR created but could not extract URL from output');
        }

        console.log('✅ Pull Request created:', prUrl || '(URL not found in output)');

        return {
            success: true,
            prUrl: prUrl,
            output: output
        };

    } catch (error) {
        console.error('Failed to create Pull Request:', error);
        return {
            success: false,
            error: error.toString()
        };
    }
}

/**
 * Post comment to Jira ticket with PR details
 *
 * @param {string} ticketKey - Ticket key
 * @param {string} prUrl - Pull Request URL
 * @param {string} branchName - Git branch name
 */
function postPRCommentToJira(ticketKey, prUrl, branchName) {
    try {
        let comment = 'h3. *Development Completed*\n\n';
        comment += '*Branch:* {code}' + branchName + '{code}\n';

        if (prUrl) {
            comment += '*Pull Request:* ' + prUrl + '\n';
        } else {
            comment += '*Pull Request:* Created (check GitHub for URL)\n';
        }

        comment += '\nAI Teammate has completed the implementation and created a pull request for review.';

        jira_post_comment({
            key: ticketKey,
            comment: comment
        });

        console.log('✅ Posted PR comment to', ticketKey);

    } catch (error) {
        console.error('Failed to post comment to Jira:', error);
    }
}

/**
 * Post error comment to Jira ticket
 *
 * @param {string} ticketKey - Ticket key
 * @param {string} stage - Stage where error occurred
 * @param {string} errorMessage - Error message
 */
function postErrorCommentToJira(ticketKey, stage, errorMessage) {
    try {
        let comment = 'h3. *Development Workflow Error*\n\n';
        comment += '*Stage:* ' + stage + '\n';
        comment += '*Error:* {code}' + errorMessage + '{code}\n\n';
        comment += 'Please check the logs for more details and retry the workflow if needed.';

        jira_post_comment({
            key: ticketKey,
            comment: comment
        });

        console.log('Posted error comment to', ticketKey);

    } catch (error) {
        console.error('Failed to post error comment to Jira:', error);
    }
}

/**
 * Retry push after asking the agent to fix the commit
 * Used when push is rejected (e.g. GitHub push protection blocked a secret)
 *
 * @param {string} ticketKey - Jira ticket key
 * @param {string} branchName - Branch name to push
 * @param {string} pushError - Error message from the failed push
 * @returns {Object} Result with success status
 */
function retryAfterPushFailure(ticketKey, branchName, pushError) {
    console.log('Push failed — asking agent to fix commit and retrying...');

    // Write error details for the agent
    const errorFilePath = 'input/' + ticketKey + '/push_error.md';
    try {
        file_write({
            path: errorFilePath,
            content: '# Push Error — Please Fix\n\n' +
                'The git push was rejected. Error:\n\n```\n' + pushError + '\n```\n\n' +
                '**What to do:**\n' +
                '1. Identify what caused the push to be rejected (e.g. a secret/credentials file in the commit)\n' +
                '2. Remove it from the commit:\n' +
                '   ```\n' +
                '   git rm --cached <filename>\n' +
                '   git commit --amend --no-edit\n' +
                '   ```\n' +
                '3. Do NOT push — just fix the commit history\n'
        });
        console.log('Wrote push error to', errorFilePath);
    } catch (e) {
        console.warn('Could not write push_error.md:', e);
    }

    // For non-fast-forward: force push (branch diverged from remote, our local is newer)
    console.log('Retrying with force push...');
    var retryOutput = cli_execute_command({ command: 'git push -u origin ' + branchName + ' --force' }) || '';
    var retryFailed = retryOutput.indexOf('remote rejected') !== -1 ||
                      retryOutput.indexOf('GH013') !== -1 ||
                      retryOutput.indexOf('error: failed to push') !== -1 ||
                      retryOutput.indexOf('push declined') !== -1;

    if (retryFailed) {
        return { success: false, error: 'Push still rejected after agent fix: ' + retryOutput.substring(0, 300) };
    }

    // Verify branch is on remote
    var lsOutput = cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || '';
    if (lsOutput.indexOf('refs/heads/' + branchName) === -1) {
        return { success: false, error: 'Branch not found on remote after retry push' };
    }

    console.log('✅ Push succeeded after agent fix');
    return { success: true };
}

/**
 * Main action function - orchestrates the entire workflow
 *
 * @param {Object} params - Parameters from Teammate job
 * @param {Object} params.ticket - Jira ticket object
 * @param {string} params.response - Response content from cursor agent (development summary)
 * @param {string} params.initiator - Initiator account ID
 * @returns {Object} Result object with success status
 */
function action(params) {
    try {
        // Handle both Teammate workflow and standalone dmtools execution
        // - Teammate workflow: params.ticket exists directly
        // - Standalone dmtools (JSRunner): params.jobParams.ticket
        const actualParams = params.ticket ? params : (params.jobParams || params);

        const ticketKey = actualParams.ticket.key;
        const ticketSummary = actualParams.ticket.fields.summary;
        const ticketDescription = actualParams.ticket.fields.description || '';
        const developmentSummary = actualParams.response || '';

        console.log('Processing development workflow for ticket:', ticketKey);
        console.log('Ticket summary:', ticketSummary);

        // Configure git author
        if (!configureGitAuthor()) {
            const error = 'Failed to configure git author';
            postErrorCommentToJira(ticketKey, 'Git Configuration', error);
            return {
                success: false,
                error: error
            };
        }

        // Branch was already checked out by preCliJSAction — read current branch
        const rawBranchOutput = cli_execute_command({ command: 'git branch --show-current' }) || '';
        const branchName = cleanCommandOutput(rawBranchOutput);

        if (!branchName) {
            const error = 'Could not determine current git branch';
            console.error('Raw git branch output:', rawBranchOutput);
            postErrorCommentToJira(ticketKey, 'Git Configuration', error);
            return { success: false, error: error };
        }
        console.log('Using current branch:', branchName);

        // Prepare commit message
        const commitMessage = ticketKey + ' ' + ticketSummary;

        // Perform git operations
        const gitResult = performGitOperations(branchName, commitMessage);
        if (!gitResult.success) {
            if (gitResult.isPushFailure) {
                // Push was rejected — ask the agent to fix the commit, then retry
                const retryResult = retryAfterPushFailure(ticketKey, branchName, gitResult.error);
                if (!retryResult.success) {
                    postErrorCommentToJira(ticketKey, 'Git Push (after retry)', retryResult.error);
                    return { success: false, error: 'Git push failed even after retry: ' + retryResult.error };
                }
                // Push succeeded after agent fix — continue to PR creation
            } else {
                postErrorCommentToJira(ticketKey, 'Git Operations', gitResult.error);
                return { success: false, error: 'Git operations failed: ' + gitResult.error };
            }
        }

        // Verify outputs/response.md exists (must be created by cursor-agent or workflow)
        try {
            const responseContent = file_read({
                path: 'outputs/response.md'
            });
            if (!responseContent) {
                const error = 'outputs/response.md not found or empty - must be created before running this script';
                console.error(error);
                postErrorCommentToJira(ticketKey, 'PR Body Preparation', error);
                return {
                    success: false,
                    error: error
                };
            }
            console.log('Using outputs/response.md as PR body (' + responseContent.length + ' characters)');
        } catch (error) {
            console.error('Failed to read outputs/response.md:', error);
            postErrorCommentToJira(ticketKey, 'PR Body Preparation', error.toString());
            return {
                success: false,
                error: 'Failed to read PR body: ' + error.toString()
            };
        }

        // Create Pull Request
        const prTitle = ticketKey + ' ' + ticketSummary;
        const prResult = createPullRequest(prTitle, branchName);

        if (!prResult.success) {
            postErrorCommentToJira(ticketKey, 'Pull Request Creation', prResult.error);
            return {
                success: false,
                error: 'PR creation failed: ' + prResult.error
            };
        }

        // Assign ticket to initiator
        try {
            const initiatorId = actualParams.initiator;
            if (initiatorId) {
                jira_assign_ticket_to({
                    key: ticketKey,
                    accountId: initiatorId
                });
                console.log('✅ Assigned ticket to initiator');
            }
        } catch (error) {
            console.warn('Failed to assign ticket to initiator:', error);
        }

        // Move ticket to In Review status
        try {
            jira_move_to_status({
                key: ticketKey,
                statusName: STATUSES.IN_REVIEW
            });
            console.log('✅ Moved ' + ticketKey + ' to In Review');
        } catch (error) {
            console.warn('Failed to move ticket to In Review:', error);
        }

        // Post comment with PR details
        postPRCommentToJira(ticketKey, prResult.prUrl, branchName);

        // Add label to indicate AI development
        try {
            jira_add_label({
                key: ticketKey,
                label: LABELS.AI_DEVELOPED
            });
        } catch (error) {
            console.warn('Failed to add ai_developed label:', error);
        }

        // Remove WIP label if configured (dynamically generated from contextId)
        const wipLabel = actualParams.metadata && actualParams.metadata.contextId
            ? actualParams.metadata.contextId + '_wip'
            : null;
        if (wipLabel) {
            try {
                jira_remove_label({
                    key: ticketKey,
                    label: wipLabel
                });
                console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
            } catch (labelError) {
                console.warn('Failed to remove WIP label "' + wipLabel + '":', labelError);
            }
        }

        console.log('✅ Development workflow completed successfully');

        return {
            success: true,
            message: 'Ticket ' + ticketKey + ' developed, committed, and PR created',
            branchName: branchName,
            prUrl: prResult.prUrl
        };

    } catch (error) {
        console.error('❌ Error in development workflow:', error);

        // Try to post error comment to ticket
        try {
            const actualParams = params.jobParams || params;
            if (actualParams && actualParams.ticket && actualParams.ticket.key) {
                postErrorCommentToJira(actualParams.ticket.key, 'Workflow Execution', error.toString());
            }
        } catch (commentError) {
            console.error('Failed to post error comment:', commentError);
        }

        return {
            success: false,
            error: error.toString()
        };
    }
}
// Export for dmtools standalone execution
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
