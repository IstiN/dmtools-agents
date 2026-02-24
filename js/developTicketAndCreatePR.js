/**
 * Develop Ticket and Create PR Action
 * Handles git operations, branch creation, commit, push, and PR creation after cursor agent development
 */

// Import common helper functions
const { extractTicketKey } = require('./common/jiraHelpers.js');
const { GIT_CONFIG, STATUSES, LABELS } = require('./config.js');

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
 * Create git branch, stage changes, commit, and push
 *
 * @param {string} branchName - Branch name to create
 * @param {string} commitMessage - Commit message
 * @returns {Object} Result with success status and branch name
 */
function performGitOperations(branchName, commitMessage) {
    try {
        // Check if branch already exists locally and delete it
        console.log('Checking if branch exists locally:', branchName);
        try {
            const localBranches = cli_execute_command({
                command: 'git branch --list "' + branchName + '"'
            }) || '';

            if (localBranches.trim()) {
                console.log('Branch exists locally, deleting it first...');
                // Switch to base branch first
                cli_execute_command({
                    command: 'git checkout ' + GIT_CONFIG.DEFAULT_BASE_BRANCH
                });
                // Delete local branch
                cli_execute_command({
                    command: 'git branch -D ' + branchName
                });
            }
        } catch (checkError) {
            console.warn('Error checking/deleting existing local branch:', checkError);
        }

        // Create and checkout new branch
        console.log('Creating branch:', branchName);
        cli_execute_command({
            command: 'git checkout -b ' + branchName
        });

        // Stage all changes
        console.log('Staging changes...');
        cli_execute_command({
            command: 'git add .'
        });

        // Check if there are changes to commit
        const statusOutput = cli_execute_command({
            command: 'git status --porcelain'
        });

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

        // Push to remote with force flag if branch exists
        // Using --force to handle the case where branch exists remotely
        console.log('Pushing to remote...');
        try {
            cli_execute_command({
                command: 'git push -u origin ' + branchName
            });
        } catch (pushError) {
            // If push fails, try with force (in case branch exists remotely)
            console.log('Normal push failed, attempting force push...');
            cli_execute_command({
                command: 'git push -u origin ' + branchName + ' --force'
            });
        }

        // Verify branch is pushed
        console.log('Verifying branch is pushed to remote...');
        const remoteBranches = cli_execute_command({
            command: 'git ls-remote --heads origin ' + branchName
        }) || '';

        if (!remoteBranches.trim()) {
            throw new Error('Branch was not successfully pushed to remote');
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

        // Extract PR URL from output
        const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
        const prUrl = urlMatch ? urlMatch[0] : null;

        if (!prUrl) {
            console.warn('PR created but could not extract URL from output:', output);
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
        const ticketKey = params.ticket.key;
        const ticketSummary = params.ticket.fields.summary;
        const ticketDescription = params.ticket.fields.description || '';
        const developmentSummary = params.response || '';

        console.log('Processing development workflow for ticket:', ticketKey);
        console.log('Ticket summary:', ticketSummary);

        // Use 'ai' prefix for all AI-generated branches
        const branchPrefix = 'ai';
        console.log('Using branch prefix:', branchPrefix);

        // Configure git author
        if (!configureGitAuthor()) {
            const error = 'Failed to configure git author';
            postErrorCommentToJira(ticketKey, 'Git Configuration', error);
            return {
                success: false,
                error: error
            };
        }

        // Generate unique branch name with 'ai' prefix
        const branchName = generateUniqueBranchName(branchPrefix, ticketKey);
        console.log('Using branch name:', branchName);

        // Prepare commit message
        const commitMessage = ticketKey + ' ' + ticketSummary;

        // Perform git operations
        const gitResult = performGitOperations(branchName, commitMessage);
        if (!gitResult.success) {
            postErrorCommentToJira(ticketKey, 'Git Operations', gitResult.error);
            return {
                success: false,
                error: 'Git operations failed: ' + gitResult.error
            };
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

        // Assign ticket to initiator and move to In Review status
        // Note: Many Jira workflows require assignment before status transition
        try {
            const initiatorId = params.initiator;
            if (initiatorId) {
                jira_assign_ticket_to({
                    key: ticketKey,
                    accountId: initiatorId
                });
                console.log('✅ Assigned ticket to initiator');
            }
            
            jira_move_to_status({
                key: ticketKey,
                statusName: STATUSES.IN_REVIEW
            });
            console.log('✅ Moved ticket to In Review status');
        } catch (error) {
            console.error('❌ Failed to assign and move ticket to In Review:', error);
            // Log the full error details for debugging
            console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            // Still continue with the workflow - don't fail the entire process
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
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
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
            if (params && params.ticket && params.ticket.key) {
                postErrorCommentToJira(params.ticket.key, 'Workflow Execution', error.toString());
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