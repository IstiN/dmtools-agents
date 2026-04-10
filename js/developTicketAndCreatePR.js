/**
 * Develop Ticket and Create PR Action
 * Handles git operations, branch creation, commit, push, and PR creation after cursor agent development
 */

// Import common helper functions
const { extractTicketKey } = require('./common/jiraHelpers.js');
var configLoader = require('./configLoader.js');
const { GIT_CONFIG, STATUSES, LABELS, resolveStatuses } = require('./config.js');

function deriveProjectKey(customParams) {
    if (!customParams) return '';
    if (customParams.projectKey) return customParams.projectKey;
    var cp = customParams.configPath || '';
    if (!cp) return '';
    var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
    return (base && base !== 'config') ? base : '';
}

function buildAutoStartEncodedConfig(ticketKey, customParams) {
    var p = { inputJql: 'key = ' + ticketKey };
    if (customParams) {
        // Pass the full customParams to the next agent so it has all config
        // (autoStartReworkConfigFile, customStatuses, targetRepository, etc.)
        // Strip fields that are only relevant to the current agent's execution.
        var nextCustomParams = Object.assign({}, customParams);
        delete nextCustomParams.removeLabel;   // SM idempotency label — per-agent, not inherited
        delete nextCustomParams.autoStartReview;             // dev → review trigger, not needed downstream
        delete nextCustomParams.autoStartReviewConfigFile;   // same
        p.customParams = nextCustomParams;
    }
    return encodeURIComponent(JSON.stringify({ params: p }));
}

function hasPrApprovedLabel(ticket) {
    var labels = (ticket && ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    return labels.indexOf(LABELS.PR_APPROVED) !== -1;
}

// Universal working-directory-aware wrapper for cli_execute_command.
// When config.workingDir is set (via customParams.targetRepository.workingDir),
// all git/shell commands are executed inside that directory.
var _workingDir = null;
function runCmd(args) {
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

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
            runCmd({
                command: 'git fetch origin --prune'
            });
        } catch (fetchError) {
            console.warn('Could not fetch remote branches:', fetchError);
        }

        // Check local branches
        const localBranches = runCmd({
            command: 'git branch --list "*' + baseBranchName + '*"'
        }) || '';

        // Check remote branches
        const remoteBranches = runCmd({
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
function configureGitAuthor(config) {
    try {
        runCmd({
            command: 'git config user.name "' + config.git.authorName + '"'
        });

        runCmd({
            command: 'git config user.email "' + config.git.authorEmail + '"'
        });

        console.log('✅ Configured git author as AI Teammate');
        return true;

    } catch (error) {
        console.error('Failed to configure git author:', error);
        return false;
    }
}

/**
 * Push already-committed changes to remote (used when CLI agent committed its own work).
 */
function performPushOnly(branchName) {
    console.log('Pushing pre-committed changes to remote...');
    var pushOutput = '';
    var pushThrewException = false;
    try {
        pushOutput = runCmd({ command: 'git push -u origin ' + branchName }) || '';
    } catch (pushErr) {
        pushOutput = String(pushErr);
        pushThrewException = true;
    }

    var pushFailed = pushThrewException ||
                     pushOutput.indexOf('remote rejected') !== -1 ||
                     pushOutput.indexOf('GH013') !== -1 ||
                     pushOutput.indexOf('error: failed to push') !== -1 ||
                     pushOutput.indexOf('push declined') !== -1 ||
                     pushOutput.indexOf('non-fast-forward') !== -1 ||
                     pushOutput.indexOf('rejected') !== -1;

    if (pushFailed) {
        // Try force push (branch may have diverged from a previous interrupted run)
        console.log('Push rejected — retrying with --force...');
        var forceOutput = '';
        try {
            forceOutput = runCmd({ command: 'git push -u origin ' + branchName + ' --force' }) || '';
        } catch (forceErr) {
            forceOutput = String(forceErr);
        }
        var forceFailed = forceOutput.indexOf('remote rejected') !== -1 ||
                          forceOutput.indexOf('GH013') !== -1 ||
                          forceOutput.indexOf('error: failed to push') !== -1 ||
                          forceOutput.indexOf('push declined') !== -1;
        if (forceFailed) {
            return { success: false, isPushFailure: true, error: 'Push still rejected after force: ' + forceOutput.substring(0, 300) };
        }
    }

    var lsRemote = runCmd({ command: 'git ls-remote --heads origin ' + branchName }) || '';
    if (lsRemote.indexOf('refs/heads/' + branchName) === -1) {
        return { success: false, isPushFailure: true, error: 'Branch not found on remote after push' };
    }

    console.log('✅ Push-only git operations completed successfully');
    return { success: true, branchName: branchName };
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
        runCmd({
            command: 'git add .'
        });

        // Check if there are changes to commit
        const rawStatusOutput = runCmd({
            command: 'git status --porcelain'
        });
        const statusOutput = cleanCommandOutput(rawStatusOutput);

        if (!statusOutput || !statusOutput.trim()) {
            // No uncommitted changes — but check if the agent already committed its work
            // (the CLI agent sometimes commits itself before postJSAction runs)
            var aheadOutput = '';
            try {
                aheadOutput = cleanCommandOutput(runCmd({ command: 'git rev-list --count origin/main..HEAD' }) || '');
            } catch (e) {
                console.warn('Could not check commits ahead of origin/main:', e);
            }
            var commitsAhead = parseInt(aheadOutput, 10) || 0;
            if (commitsAhead > 0) {
                console.log('No uncommitted changes, but branch is ' + commitsAhead + ' commit(s) ahead of origin/main — agent already committed. Skipping commit step.');
                // Jump straight to push
                return performPushOnly(branchName);
            }

            // Check if the remote branch already has commits not yet in origin/main
            // (e.g. agent pushed in a previous run but was interrupted before PR creation)
            var remoteAheadOutput = '';
            try {
                // Fetch remote refs so origin/<branchName> is up to date
                try { runCmd({ command: 'git fetch origin ' + branchName }); } catch (e) {}
                remoteAheadOutput = cleanCommandOutput(runCmd({ command: 'git rev-list --count origin/main..origin/' + branchName }) || '');
            } catch (e) {
                console.warn('Could not check remote branch commits:', e);
            }
            var remoteCommitsAhead = parseInt(remoteAheadOutput, 10) || 0;
            if (remoteCommitsAhead > 0) {
                console.log('Remote branch origin/' + branchName + ' is ' + remoteCommitsAhead + ' commit(s) ahead of origin/main — branch already pushed. Skipping push, proceeding to PR creation.');
                // No push needed — return success so the caller proceeds to PR creation
                return { success: true, branchName: branchName };
            }

            console.warn('No changes to commit');
            return {
                success: false,
                error: 'No changes were made by the development process'
            };
        }

        // Commit changes
        console.log('Committing changes...');
        runCmd({
            command: 'git commit -m "' + commitMessage.replace(/"/g, '\\"') + '"'
        });

        // Push to remote
        console.log('Pushing to remote...');
        var pushOutput = '';
        var pushThrewException = false;
        try {
            pushOutput = runCmd({
                command: 'git push -u origin ' + branchName
            }) || '';
        } catch (pushErr) {
            // git push exits with non-zero (e.g. non-fast-forward) — cli_execute_command throws
            pushOutput = String(pushErr);
            pushThrewException = true;
        }

        // Check output text for soft-rejected pushes (exit 0 but error text) AND
        // exception messages (exit non-zero) — covers both code paths.
        const pushFailed = pushThrewException ||
                           pushOutput.indexOf('remote rejected') !== -1 ||
                           pushOutput.indexOf('GH013') !== -1 ||
                           pushOutput.indexOf('error: failed to push') !== -1 ||
                           pushOutput.indexOf('push declined') !== -1 ||
                           pushOutput.indexOf('non-fast-forward') !== -1 ||
                           pushOutput.indexOf('rejected') !== -1;

        if (pushFailed) {
            return {
                success: false,
                isPushFailure: true,
                error: 'Push was rejected by remote: ' + pushOutput.substring(0, 500)
            };
        }

        // Verify branch is actually present on remote
        console.log('Verifying branch is pushed to remote...');
        const lsRemoteOutput = runCmd({
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
function createPullRequest(title, branchName, baseBranch) {
    try {
        console.log('Creating Pull Request...');

        // Check if a PR already exists for this branch before trying to create one
        try {
            var existingPrJson = cleanCommandOutput(runCmd({
                command: 'gh pr list --head ' + branchName + ' --json url,state --jq ".[0]"'
            }) || '');
            if (existingPrJson && existingPrJson.startsWith('{')) {
                var existingPr = null;
                try { existingPr = JSON.parse(existingPrJson); } catch (e) {}
                if (existingPr && existingPr.url) {
                    console.log('✅ PR already exists for branch ' + branchName + ':', existingPr.url, '— skipping creation.');
                    return { success: true, prUrl: existingPr.url, alreadyExisted: true };
                }
            }
        } catch (prCheckErr) {
            console.warn('Could not check for existing PR (non-fatal):', prCheckErr);
        }

        // Escape special characters in title
        const escapedTitle = title.replace(/"/g, '\\"').replace(/\n/g, ' ');

        // Resolve --body-file path for gh pr create.
        // gh runs in _workingDir (if set), so paths must be relative to it.
        // We probe two locations (workspace root first, then workingDir itself)
        // and use whichever exists.
        var bodyFilePath = 'outputs/response.md'; // default: same dir as gh's CWD
        if (_workingDir) {
            // Compute relative path from workingDir back to workspace root
            var depth = _workingDir.replace(/\/$/, '').split('/').length;
            var prefix = '';
            for (var i = 0; i < depth; i++) { prefix += '../'; }
            var rootRelativePath = prefix + 'outputs/response.md';

            // Probe workspace root via file_read (always resolves from workspace root)
            var foundAtRoot = false;
            try { file_read({ path: 'outputs/response.md' }); foundAtRoot = true; } catch (e) {}

            if (foundAtRoot) {
                bodyFilePath = rootRelativePath;
                console.log('outputs/response.md found at workspace root, using:', bodyFilePath);
            } else {
                // Fall back: file may be inside workingDir itself
                bodyFilePath = 'outputs/response.md';
                console.log('outputs/response.md not at workspace root, trying workingDir-relative path:', bodyFilePath);
            }
        }

        console.log('Using PR body file:', bodyFilePath);
        console.log('Using branch:', branchName);

        // Create PR using gh CLI with body-file
        // Explicitly specify --head to prevent interactive prompts in headless environment
        const output = runCmd({
            command: 'gh pr create --title "' + escapedTitle + '" --body-file "' + bodyFilePath + '" --base ' + baseBranch + ' --head ' + branchName
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
                    const remoteUrl = runCmd({
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
                const prListOutput = runCmd({
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
        const errMsg = error.toString();
        console.error('Failed to create Pull Request:', errMsg);

        // If PR already exists for this branch — find it and treat as success
        // (happens when development was interrupted after PR creation but before status move)
        if (errMsg.indexOf('already exists') !== -1 || errMsg.indexOf('pull request for branch') !== -1) {
            console.log('PR already exists for branch', branchName, '— looking up existing PR URL...');
            try {
                const existingPrUrl = runCmd({
                    command: 'gh pr list --head ' + branchName + ' --json url --jq ".[0].url"'
                }) || '';
                const cleanedExistingUrl = cleanCommandOutput(existingPrUrl);
                if (cleanedExistingUrl && cleanedExistingUrl.startsWith('https://')) {
                    console.log('✅ Found existing PR:', cleanedExistingUrl);
                    return { success: true, prUrl: cleanedExistingUrl, alreadyExisted: true };
                }
            } catch (lookupErr) {
                console.warn('Failed to look up existing PR URL:', lookupErr);
            }
        }

        return {
            success: false,
            error: errMsg
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
    var retryOutput = '';
    try {
        retryOutput = runCmd({ command: 'git push -u origin ' + branchName + ' --force' }) || '';
    } catch (forceErr) {
        retryOutput = String(forceErr);
    }
    var retryFailed = retryOutput.indexOf('remote rejected') !== -1 ||
                      retryOutput.indexOf('GH013') !== -1 ||
                      retryOutput.indexOf('error: failed to push') !== -1 ||
                      retryOutput.indexOf('push declined') !== -1;

    if (retryFailed) {
        return { success: false, error: 'Push still rejected after agent fix: ' + retryOutput.substring(0, 300) };
    }

    // Verify branch is on remote
    var lsOutput = runCmd({ command: 'git ls-remote --heads origin ' + branchName }) || '';
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
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        _workingDir = config.workingDir || null;

        const ticketKey = actualParams.ticket.key;
        const ticketSummary = actualParams.ticket.fields.summary;
        const ticketDescription = actualParams.ticket.fields.description || '';
        const developmentSummary = actualParams.response || '';

        // Resolve statuses — allows per-project overrides via customParams.customStatuses
        const _customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
        const statuses = resolveStatuses(_customParams);

        console.log('Processing development workflow for ticket:', ticketKey);
        console.log('Ticket summary:', ticketSummary);

        // ── Early exit: PR already open for this branch ──────────────────────
        // If a PR already exists, a previous run created it but failed to move
        // the ticket to In Review. Move now and skip re-development.
        const expectedBranch = configLoader.resolveBranchName(config, params.ticket || actualParams.ticket, 'development');
        try {
            const existingPrJson = runCmd({
                command: 'gh pr list --head ' + expectedBranch + ' --state open --json url,number --jq ".[0]"'
            }) || '';
            const cleanedPrJson = existingPrJson.split('\n').filter(function(l) {
                return l.trim() && l.indexOf('Script started') === -1 && l.indexOf('Script done') === -1;
            }).join('').trim();
            if (cleanedPrJson && cleanedPrJson !== 'null') {
                let existingPr = null;
                try { existingPr = JSON.parse(cleanedPrJson); } catch (e) {}
                if (existingPr && existingPr.url) {
                    console.log('⚠️  PR already open for', ticketKey, ':', existingPr.url, '— skipping re-development');
                    try {
                        jira_post_comment({
                            key: ticketKey,
                            comment: 'h3. ℹ️ PR Already Open\n\n' +
                                'A pull request already exists for this ticket: ' + existingPr.url + '\n\n' +
                                'Moved ticket to *In Review* for review.'
                        });
                    } catch (e) {}
                    try {
                        jira_move_to_status({ key: ticketKey, statusName: statuses.IN_REVIEW });
                        console.log('✅ Moved', ticketKey, 'to In Review');
                    } catch (e) { console.warn('Failed to move to In Review:', e); }
                    return { success: true, path: 'pr_already_open', ticketKey };
                }
            }
        } catch (prCheckErr) {
            console.warn('Could not check existing PRs (non-fatal):', prCheckErr);
        }

        // Configure git author
        if (!configureGitAuthor(config)) {
            const error = 'Failed to configure git author';
            postErrorCommentToJira(ticketKey, 'Git Configuration', error);
            return {
                success: false,
                error: error
            };
        }

        // Always use the expected branch (ai/<ticketKey>), computed from ticket key.
        // Do NOT trust git branch --show-current — the CLI agent may have switched branches.
        // Force checkout to the expected branch before committing to prevent pushing to develop/main.
        // Note: expectedBranch is already declared above for the early-exit PR check — reuse it here.

        const rawBranchOutput = runCmd({ command: 'git branch --show-current' }) || '';
        const currentBranch = cleanCommandOutput(rawBranchOutput);
        console.log('Current branch in workingDir:', currentBranch);

        var branchName = expectedBranch;
        if (currentBranch !== expectedBranch) {
            console.warn('⚠️  Branch mismatch: expected "' + expectedBranch + '" but found "' + currentBranch + '". Forcing checkout to expected branch.');
            try {
                // Try to checkout expected branch (should already exist from preCliJSAction)
                runCmd({ command: 'git checkout ' + expectedBranch });
                console.log('✅ Switched to expected branch:', expectedBranch);
            } catch (checkoutErr) {
                console.warn('Expected branch not found, creating it:', checkoutErr);
                try {
                    runCmd({ command: 'git checkout -b ' + expectedBranch });
                    console.log('✅ Created and switched to branch:', expectedBranch);
                } catch (createErr) {
                    const error = 'Could not checkout expected branch "' + expectedBranch + '": ' + createErr;
                    postErrorCommentToJira(ticketKey, 'Git Branch Checkout', error);
                    return { success: false, error: error };
                }
            }
        }
        console.log('Using branch:', branchName);

        // Prepare commit message
        const commitMessage = configLoader.formatTemplate(config.formats.commitMessage.development, {ticketKey: ticketKey, ticketSummary: ticketSummary});

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
            } else if (gitResult.error && gitResult.error.indexOf('No changes were made') !== -1) {
                // CLI agent was interrupted before making any code changes (e.g. rate limit hit
                // during analysis). Reset ticket to Ready For Development for automatic retry.
                console.log('No git changes detected — CLI agent was interrupted. Resetting ticket for retry.');
                try {
                    jira_post_comment({
                        key: ticketKey,
                        comment: 'h3. ⏸️ Development Interrupted\n\nThe AI agent was interrupted (likely hit a rate limit) before completing the implementation. The ticket has been reset to *Ready For Development* and will be automatically retried.'
                    });
                } catch (e) {}
                try {
                    jira_move_to_status({ key: ticketKey, statusName: statuses.READY_FOR_DEVELOPMENT });
                    console.log('✅ Moved', ticketKey, 'to Ready For Development for retry');
                } catch (e) {
                    console.warn('Failed to move ticket to Ready For Development:', e);
                }
                const wipLabel = actualParams.metadata && actualParams.metadata.contextId
                    ? actualParams.metadata.contextId + '_wip' : null;
                if (wipLabel) {
                    try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
                }
                return { success: true, path: 'interrupted', ticketKey: ticketKey };
            } else {
                postErrorCommentToJira(ticketKey, 'Git Operations', gitResult.error);
                return { success: false, error: 'Git operations failed: ' + gitResult.error };
            }
        }

        // Verify outputs/response.md exists (must be created by cursor-agent or workflow)
        let responseContent;
        try {
            responseContent = file_read({ path: 'outputs/response.md' });
        } catch (e) {
            responseContent = null;
        }
        if (!responseContent || !responseContent.trim()) {
            // Agent was interrupted after committing partial work (e.g. outputs/rca.md) but
            // before writing response.md. Reset ticket for retry rather than posting an error.
            console.log('outputs/response.md missing after commit — CLI agent was interrupted mid-way. Resetting for retry.');
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ⏸️ Development Interrupted\n\nThe AI agent was interrupted before completing the implementation (partial work was pushed to branch *' + branchName + '*). The ticket has been reset to *Ready For Development* and will be automatically retried.\n\nThe agent can resume from the existing branch.'
                });
            } catch (e) {}
            try {
                jira_move_to_status({ key: ticketKey, statusName: statuses.READY_FOR_DEVELOPMENT });
                console.log('✅ Moved', ticketKey, 'to Ready For Development for retry');
            } catch (e) {
                console.warn('Failed to move ticket to Ready For Development:', e);
            }
            const wipLabel2 = actualParams.metadata && actualParams.metadata.contextId
                ? actualParams.metadata.contextId + '_wip' : null;
            if (wipLabel2) {
                try { jira_remove_label({ key: ticketKey, label: wipLabel2 }); } catch (e) {}
            }
            return { success: true, path: 'interrupted', ticketKey: ticketKey };
        }
        console.log('Using outputs/response.md as PR body (' + responseContent.length + ' characters)');

        // Create Pull Request
        const prTitle = configLoader.formatTemplate(config.formats.prTitle.development, {ticketKey: ticketKey, ticketSummary: ticketSummary});
        const prTarget = configLoader.resolvePRTargetBranch(config, params.ticket || actualParams.ticket);
        const prResult = createPullRequest(prTitle, branchName, prTarget);

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
                statusName: statuses.IN_REVIEW
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

        // Auto-start pr_review after PR is created and ticket moved to In Review (opt-in)
        const customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
        const autoStartReview = customParams && customParams.autoStartReview;
        const reviewConfigFile = customParams && customParams.autoStartReviewConfigFile;
        if (autoStartReview && reviewConfigFile) {
            if (hasPrApprovedLabel(actualParams.ticket)) {
                console.log('ℹ️ autoStartReview: skipped — ticket has pr_approved label');
            } else {
                try {
                    // Use customParams.aiRepository if set (avoids targetRepository override in configLoader)
                    const aiRepoCfg = customParams && customParams.aiRepository;
                    const aiOwner = (aiRepoCfg && aiRepoCfg.owner) || (config.repository && config.repository.owner);
                    const aiRepo  = (aiRepoCfg && aiRepoCfg.repo)  || (config.repository && config.repository.repo);
                    const projectKey = deriveProjectKey(customParams);
                    const encodedCfg = buildAutoStartEncodedConfig(ticketKey, customParams);
                    if (aiOwner && aiRepo) {
                        github_trigger_workflow(
                            aiOwner, aiRepo, 'ai-teammate.yml',
                            JSON.stringify({
                                concurrency_key: ticketKey,
                                config_file:     reviewConfigFile,
                                encoded_config:  encodedCfg,
                                project_key:     projectKey || ''
                            }),
                            'main'
                        );
                        console.log('✅ Auto-started pr_review for', ticketKey,
                            '[config=' + reviewConfigFile + (projectKey ? ', project=' + projectKey : '') + ']');
                    } else {
                        console.warn('⚠️ autoStartReview: config.repository.owner/repo not set — skipping');
                    }
                } catch (e) {
                    console.warn('⚠️ autoStartReview trigger failed:', e.message || e);
                }
            }
        }

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

        // Always remove SM idempotency label on failure to prevent permanent lock
        try {
            const actualParams = params.jobParams || params;
            const customParams = actualParams && actualParams.customParams;
            const removeLabel = customParams && customParams.removeLabel;
            if (removeLabel && actualParams.ticket && actualParams.ticket.key) {
                jira_remove_label({ key: actualParams.ticket.key, label: removeLabel });
                console.log('✅ Removed SM label on failure:', removeLabel);
            }
        } catch (e) {}

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
