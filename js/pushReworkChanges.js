/**
 * Push Rework Changes Post-Action
 * postJSAction for pr_rework agent:
 * 1. Stages, commits, and force-pushes changes to the existing PR branch
 * 2. Posts the fix summary (outputs/response.md) as a PR comment
 * 3. Moves ticket to "In Review"
 * 4. Posts completion comment to Jira
 */

var configLoader = require('./configLoader.js');
var scmModule = require('./common/scm.js');
const { GIT_CONFIG, STATUSES, LABELS, resolveStatuses } = require('./config.js');

/**
 * Derive project key from customParams.configPath or customParams.projectKey.
 */
function deriveProjectKey(customParams) {
    if (!customParams) return '';
    if (customParams.projectKey) return customParams.projectKey;
    var cp = customParams.configPath || '';
    if (!cp) return '';
    var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
    return (base && base !== 'config') ? base : '';
}

/**
 * Build minimal encoded_config for an auto-started downstream workflow.
 */
function buildAutoStartEncodedConfig(ticketKey, customParams) {
    var p = { inputJql: 'key = ' + ticketKey };
    var cp = customParams && customParams.configPath;
    if (cp) {
        p.customParams = { configPath: cp };
    }
    return encodeURIComponent(JSON.stringify({ params: p }));
}

/**
 * Returns true if the Jira ticket has the pr_approved label.
 */
function hasPrApprovedLabel(ticket) {
    var labels = (ticket && ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    return labels.indexOf(LABELS.PR_APPROVED) !== -1;
}

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

function findPRForTicket(scm, ticketKey) {
    try {
        const openPRs = scm.listPrs('open');

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

function configureGitAuthor(config) {
    try {
        cli_execute_command({ command: 'git config user.name "' + config.git.authorName + '"' });
        cli_execute_command({ command: 'git config user.email "' + config.git.authorEmail + '"' });
        return true;
    } catch (error) {
        console.error('Failed to configure git author:', error);
        return false;
    }
}

function commitAndPush(ticketKey, config) {
    var workingDir = config.workingDir || null;
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };

    // Read expected branch from pr_info.md (written by preCliReworkSetup).
    // Do NOT trust git branch --show-current — the CLI agent may have switched branches.
    var expectedBranch = null;
    try {
        var prInfoPath = 'input/' + ticketKey + '/pr_info.md';
        var prInfo = file_read({ path: prInfoPath }) || '';
        var branchMatch = prInfo.match(/\*\*Branch\*\*:\s*`([^`]+)`/);
        if (branchMatch) expectedBranch = branchMatch[1].trim();
    } catch (e) {
        console.warn('Could not read pr_info.md for expected branch:', e);
    }

    var currentBranch = cleanCommandOutput(cmd('git branch --show-current') || '');
    console.log('Current branch:', currentBranch, '| Expected:', expectedBranch || '(unknown)');

    var branchName = currentBranch;
    if (expectedBranch && currentBranch !== expectedBranch) {
        console.warn('⚠️ Branch mismatch — forcing checkout to expected branch:', expectedBranch);
        try {
            cmd('git checkout ' + expectedBranch);
            branchName = expectedBranch;
            console.log('✅ Switched to expected branch:', branchName);
        } catch (e) {
            console.warn('Could not checkout expected branch, using current:', currentBranch, e);
        }
    }

    if (!branchName) {
        throw new Error('Could not determine git branch to commit to');
    }

    cmd('git add .');

    const rawStatus = cmd('git status --porcelain') || '';
    const status = cleanCommandOutput(rawStatus);

    if (status.trim()) {
        const commitMsg = configLoader.formatTemplate(config.formats.commitMessage.rework, {ticketKey: ticketKey});
        cmd('git commit -m "' + commitMsg + '"');
        console.log('✅ Committed rework changes');
    } else {
        console.warn('No file changes detected — pushing existing commits only');
    }

    try {
        cmd('git push -u origin ' + branchName);
    } catch (pushError) {
        console.log('Normal push failed, force pushing...');
        cmd('git push -u origin ' + branchName + ' --force');
    }

    const remoteCheck = cleanCommandOutput(cmd('git ls-remote --heads origin ' + branchName) || '');
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
function postThreadReplies(scm, pullRequestId) {
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
        const replyText = item.reply || '✅ Addressed.';
        const thread = { rootCommentId: item.inReplyToId || null, threadId: item.threadId || null };

        try {
            scm.replyToThread(pullRequestId, thread, replyText);
            if (item.inReplyToId) {
                console.log('✅ Replied to comment #' + item.inReplyToId);
            } else {
                console.log('✅ Posted general reply (no threadId)');
            }
            posted++;
        } catch (e) {
            console.warn('Failed to post reply:', e.message || e);
        }

        if (item.threadId) {
            try {
                scm.resolveThread(pullRequestId, thread);
                console.log('✅ Resolved thread', item.threadId);
            } catch (e) {
                console.warn('Failed to resolve thread', item.threadId + ':', e.message || e);
            }
        }
    });

    console.log('Posted ' + posted + '/' + replies.length + ' thread replies');
    return posted;
}

function postPRComment(scm, pullRequestId, fixSummary, ticketKey) {
    try {
        const commentText = '## 🔧 Rework Complete — ' + ticketKey + '\n\n' +
            'All PR review comments have been addressed. See fix summary below.\n\n' +
            '---\n\n' +
            fixSummary;
        scm.addComment(pullRequestId, commentText);
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
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = scmModule.createScm(config);
        const _customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
        const statuses = resolveStatuses(_customParams);

        console.log('=== Push rework changes for:', ticketKey, '===');

        // Configure git
        configureGitAuthor(config);

        // Commit and push
        let branchName;
        try {
            branchName = commitAndPush(ticketKey, config);
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

        // Find PR to post comment — prefer targetRepository from config over git remote
        var repoInfo = null;
        if (config.repository && config.repository.owner && config.repository.repo) {
            repoInfo = { owner: config.repository.owner, repo: config.repository.repo };
            console.log('Using targetRepository from config:', repoInfo.owner + '/' + repoInfo.repo);
        } else {
            repoInfo = scm.getRemoteRepoInfo();
        }
        const pr = repoInfo ? findPRForTicket(scm, ticketKey) : null;
        let prCommentPosted = false;

        if (pr && repoInfo) {
            // Reply to each review thread and resolve it
            const repliesPosted = postThreadReplies(scm, pr.number);
            console.log('Thread replies posted:', repliesPosted);

            // Post general fix summary as a top-level PR comment (skip if no replies were posted — nothing was fixed)
            if (repliesPosted > 0) {
                prCommentPosted = postPRComment(scm, pr.number, fixSummary, ticketKey);
            } else {
                console.log('ℹ️ No thread replies posted — skipping general PR comment (nothing to fix)');
            }
        } else {
            console.warn('Could not find PR to post comment — skipping GitHub PR comment');
        }

        // Move ticket to In Review
        try {
            jira_move_to_status({ key: ticketKey, statusName: statuses.IN_REVIEW });
            console.log('✅ Moved', ticketKey, 'to', statuses.IN_REVIEW);
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

        // Auto-start pr_review after rework is pushed to In Review (opt-in via customParams)
        const autoStartReview = customParams && customParams.autoStartReview;
        const reviewConfigFile = customParams && customParams.autoStartReviewConfigFile;
        if (autoStartReview && reviewConfigFile) {
            // Skip if ticket already has pr_approved label (already approved, merge pending)
            const ticket = actualParams.ticket || (params.jobParams && params.jobParams.ticket);
            if (hasPrApprovedLabel(ticket)) {
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
                        scm.triggerWorkflow(
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
