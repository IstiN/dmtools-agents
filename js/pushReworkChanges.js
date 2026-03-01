/**
 * Push Rework Changes Post-Action
 * postJSAction for pr_rework agent:
 * 1. Stages, commits, and force-pushes changes to the existing PR branch
 * 2. Posts the fix summary (outputs/response.md) as a PR comment
 * 3. Moves ticket to "In Review"
 * 4. Posts completion comment to Jira
 */

const { GIT_CONFIG, STATUSES } = require('./config.js');

function cleanCommandOutput(output) {
    if (!output) {
        return '';
    }
    const lines = output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    });
    return lines.join('\n').trim();
}

function getGitHubRepoInfo() {
    try {
        const remoteUrl = cleanCommandOutput(
            cli_execute_command({ command: 'git config --get remote.origin.url' }) || ''
        );
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        if (!match) {
            return null;
        }
        return { owner: match[1], repo: match[2].replace('.git', '') };
    } catch (error) {
        console.error('Failed to get GitHub repo info:', error);
        return null;
    }
}

function findPRForTicket(workspace, repository, ticketKey) {
    try {
        const openPRs = github_list_prs({
            workspace: workspace,
            repository: repository,
            state: 'open'
        });

        const matching = openPRs.filter(function(pr) {
            return (pr.title && pr.title.indexOf(ticketKey) !== -1) ||
                   (pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1);
        });

        if (matching.length > 0) {
            return matching[0];
        }

        console.warn('No open PR found for ticket', ticketKey);
        return null;
    } catch (error) {
        console.error('Failed to find PR:', error);
        return null;
    }
}

function configureGitAuthor() {
    try {
        cli_execute_command({ command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"' });
        cli_execute_command({ command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"' });
        return true;
    } catch (error) {
        console.error('Failed to configure git author:', error);
        return false;
    }
}

function commitAndPush(ticketKey) {
    const rawBranch = cli_execute_command({ command: 'git branch --show-current' }) || '';
    const branchName = cleanCommandOutput(rawBranch);

    if (!branchName) {
        throw new Error('Could not determine current git branch');
    }
    console.log('Current branch:', branchName);

    // Stage all changes
    cli_execute_command({ command: 'git add .' });

    // Check for actual changes
    const rawStatus = cli_execute_command({ command: 'git status --porcelain' }) || '';
    const status = cleanCommandOutput(rawStatus);

    if (status.trim()) {
        const commitMsg = ticketKey + ' Rework: address PR review comments';
        cli_execute_command({ command: 'git commit -m "' + commitMsg + '"' });
        console.log('✅ Committed rework changes');
    } else {
        console.warn('No file changes detected — pushing existing commits only');
    }

    // Force push to existing PR branch
    try {
        cli_execute_command({ command: 'git push -u origin ' + branchName });
    } catch (pushError) {
        console.log('Normal push failed, force pushing...');
        cli_execute_command({ command: 'git push -u origin ' + branchName + ' --force' });
    }

    // Verify
    const remoteCheck = cleanCommandOutput(
        cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || ''
    );
    if (!remoteCheck.trim()) {
        throw new Error('Branch was not successfully pushed to remote');
    }

    console.log('✅ Pushed to remote branch:', branchName);
    return branchName;
}

/**
 * Post replies to each review thread and resolve them.
 * Reads outputs/review_replies.json produced by the cursor agent.
 *
 * JSON format: { "replies": [{ "inReplyToId": 123, "threadId": "PRRT_...", "reply": "..." }] }
 */
function postThreadReplies(workspace, repository, pullRequestId) {
    let repliesJson;
    try {
        repliesJson = file_read({ path: 'outputs/review_replies.json' });
    } catch (e) {
        console.warn('outputs/review_replies.json not found — skipping thread replies');
        return 0;
    }

    let data;
    try {
        data = JSON.parse(repliesJson);
    } catch (e) {
        console.warn('Failed to parse review_replies.json:', e.message || e);
        return 0;
    }

    const replies = (data && data.replies) ? data.replies : [];
    if (replies.length === 0) {
        console.log('No thread replies to post');
        return 0;
    }

    let posted = 0;
    replies.forEach(function(item) {
        // Reply to the thread
        try {
            github_reply_to_pr_thread({
                workspace: workspace,
                repository: repository,
                pullRequestId: String(pullRequestId),
                inReplyToId: String(item.inReplyToId),
                text: item.reply || '✅ Addressed.'
            });
            console.log('✅ Replied to comment #' + item.inReplyToId);
            posted++;
        } catch (e) {
            console.warn('Failed to reply to comment #' + item.inReplyToId + ':', e.message || e);
        }

        // Resolve the thread
        if (item.threadId) {
            try {
                github_resolve_pr_thread({
                    workspace: workspace,
                    repository: repository,
                    pullRequestId: String(pullRequestId),
                    threadId: item.threadId
                });
                console.log('✅ Resolved thread', item.threadId);
            } catch (e) {
                console.warn('Failed to resolve thread', item.threadId + ':', e.message || e);
            }
        }
    });

    console.log('Posted ' + posted + '/' + replies.length + ' thread replies');
    return posted;
}

function postPRComment(workspace, repository, pullRequestId, fixSummary, ticketKey) {
    try {
        const commentText = '## 🔧 Rework Complete — ' + ticketKey + '\n\n' +
            'All PR review comments have been addressed. See fix summary below.\n\n' +
            '---\n\n' +
            fixSummary;

        github_add_pr_comment({
            workspace: workspace,
            repository: repository,
            pullRequestId: String(pullRequestId),
            text: commentText
        });

        console.log('✅ Posted fix summary to PR #' + pullRequestId);
        return true;
    } catch (error) {
        console.error('Failed to post PR comment:', error);
        return false;
    }
}

function postJiraComment(ticketKey, prUrl, branchName, prCommentPosted) {
    try {
        let comment = 'h3. ✅ Rework Completed\n\n';
        comment += '*Branch*: {code}' + branchName + '{code}\n';
        if (prUrl) {
            comment += '*Pull Request*: ' + prUrl + '\n';
        }
        comment += '\nAI Teammate has addressed all PR review comments and pushed the fixes.\n';
        if (prCommentPosted) {
            comment += 'A fix summary has been posted as a comment on the Pull Request.';
        }

        jira_post_comment({ key: ticketKey, comment: comment });
        console.log('✅ Posted completion comment to Jira:', ticketKey);
    } catch (error) {
        console.error('Failed to post Jira comment:', error);
    }
}

function action(params) {
    try {
        const actualParams = params.ticket ? params : (params.jobParams || params);
        const ticketKey = actualParams.ticket.key;
        const fixSummary = actualParams.response || '_(No fix summary generated)_';

        console.log('=== Push rework changes for:', ticketKey, '===');

        // Configure git
        configureGitAuthor();

        // Commit and push
        let branchName;
        try {
            branchName = commitAndPush(ticketKey);
        } catch (gitError) {
            console.error('Git operations failed:', gitError);
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ❌ Rework Push Failed\n\n{code}' + gitError.toString() + '{code}\n\nPlease check the logs and retry.'
                });
            } catch (e) {}
            return { success: false, error: gitError.toString() };
        }

        // Find PR to post comment
        const repoInfo = getGitHubRepoInfo();
        const pr = repoInfo ? findPRForTicket(repoInfo.owner, repoInfo.repo, ticketKey) : null;
        let prCommentPosted = false;

        if (pr && repoInfo) {
            // Reply to each review thread and resolve it
            const repliesPosted = postThreadReplies(repoInfo.owner, repoInfo.repo, pr.number);
            console.log('Thread replies posted:', repliesPosted);

            // Post general fix summary as a top-level PR comment
            prCommentPosted = postPRComment(repoInfo.owner, repoInfo.repo, pr.number, fixSummary, ticketKey);
        } else {
            console.warn('Could not find PR to post comment — skipping GitHub PR comment');
        }

        // Move ticket to In Review
        try {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REVIEW });
            console.log('✅ Moved', ticketKey, 'to In Review');
        } catch (statusError) {
            console.warn('Failed to move ticket to In Review:', statusError);
        }

        // Assign back to initiator (if provided)
        try {
            const initiatorId = actualParams.initiator;
            if (initiatorId) {
                jira_assign_ticket_to({ key: ticketKey, accountId: initiatorId });
                console.log('✅ Assigned ticket back to initiator');
            }
        } catch (e) {
            console.warn('Failed to assign ticket:', e);
        }

        // Post Jira completion comment
        const prUrl = pr ? pr.html_url : null;
        postJiraComment(ticketKey, prUrl, branchName, prCommentPosted);

        // Remove WIP label if present
        const wipLabel = actualParams.metadata && actualParams.metadata.contextId
            ? actualParams.metadata.contextId + '_wip'
            : null;
        if (wipLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: wipLabel });
                console.log('Removed WIP label:', wipLabel);
            } catch (e) {
                console.warn('Failed to remove WIP label:', e);
            }
        }

        // Remove SM idempotency label so the ticket can be re-triggered next cycle
        const customParams = params.jobParams && params.jobParams.customParams;
        const removeLabel = customParams && customParams.removeLabel;
        if (removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('✅ Removed SM label:', removeLabel);
            } catch (e) {}
        }

        console.log('✅ Rework workflow completed successfully');

        return {
            success: true,
            message: ticketKey + ' rework pushed, PR commented, moved to In Review',
            branchName: branchName,
            prUrl: prUrl,
            prCommentPosted: prCommentPosted
        };

    } catch (error) {
        console.error('❌ Error in pushReworkChanges:', error);
        try {
            const actualParams = params.jobParams || params;
            if (actualParams && actualParams.ticket && actualParams.ticket.key) {
                jira_post_comment({
                    key: actualParams.ticket.key,
                    comment: 'h3. ❌ Rework Workflow Error\n\n{code}' + error.toString() + '{code}'
                });
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
