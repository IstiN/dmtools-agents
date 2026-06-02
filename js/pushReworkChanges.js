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
var submoduleHelper = require('./common/submodules.js');
var prHelper = require('./common/pullRequest.js');
var feedbackLoop = require('./common/feedbackLoop.js');
var autoStart = require('./common/autoStart.js');
const { GIT_CONFIG, STATUSES, LABELS, resolveStatuses } = require('./config.js');
var cacheToReleases = require('./cacheToReleases.js');

/**
 * Returns true if the Jira ticket has the pr_approved label.
 */
function hasPrApprovedLabel(ticket) {
    var labels = (ticket && ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    return labels.indexOf(LABELS.PR_APPROVED) !== -1;
}

function normalizeLabels(singleLabel, labelList) {
    var labels = [];
    if (singleLabel) labels.push(singleLabel);
    if (Array.isArray(labelList)) {
        labelList.forEach(function(label) {
            if (label && labels.indexOf(label) === -1) labels.push(label);
        });
    }
    return labels;
}

function removeConfiguredLabels(ticketKey, customParams) {
    normalizeLabels(customParams && customParams.removeLabel, customParams && customParams.removeLabels)
        .forEach(function(label) {
            try {
                jira_remove_label({ key: ticketKey, label: label });
                console.log('✅ Removed SM label:', label);
            } catch (e) {
                console.warn('Failed to remove SM label ' + label + ':', e);
            }
        });
}

function resolveCustomParams(params, actualParams, config) {
    var merged = {};
    var patch = configLoader.resolveInstructions(
        'pr_rework',
        null,
        config
    ).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(
        merged,
        (params.jobParams && params.jobParams.customParams) ||
            (actualParams && actualParams.customParams) ||
            params.customParams ||
            {}
    );
    return merged;
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
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/?#\s]+)/);
        if (!match) {
            return null;
        }
        return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
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

function commitAndPush(ticketKey, config, customParams) {
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
        throw new Error('Missing PR context file input/' + ticketKey + '/pr_info.md. Rework setup did not find or checkout a PR; refusing to commit or push.');
    }
    if (!expectedBranch) {
        throw new Error('Could not determine expected PR branch from input/' + ticketKey + '/pr_info.md; refusing to commit or push.');
    }
    var baseBranch = (config.git && config.git.baseBranch) || 'main';
    try {
        var baseMatch = prInfo.match(/\*\*Branch\*\*:\s*`[^`]+`\s*→\s*`([^`]+)`/);
        if (baseMatch && baseMatch[1]) baseBranch = baseMatch[1].trim();
    } catch (e) {}

    var currentBranch = cleanCommandOutput(cmd('git branch --show-current') || '');
    console.log('Current branch:', currentBranch, '| Expected:', expectedBranch);

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

    submoduleHelper.pushManagedSubmodules({
        run: cmd,
        cleanOutput: cleanCommandOutput,
        config: config,
        customParams: customParams,
        ticketKey: ticketKey
    });

    try {
        cmd('git rm -r --ignore-unmatch .dmtools/copilot-sessions');
    } catch (cleanupErr) {
        console.warn('Could not remove tracked Copilot session cache before staging:', cleanupErr);
    }

    cmd('git add . -- ":!.dmtools/copilot-sessions" ":!.dmtools/copilot-sessions/**"');

    const status = prHelper.readStagedDiffStat(cmd, workingDir);

    var hasChanges = false;
    if (status.trim()) {
        const commitMsg = configLoader.formatTemplate(config.formats.commitMessage.rework, {ticketKey: ticketKey});
        cmd('git commit -m "' + commitMsg + '"');
        console.log('✅ Committed rework changes');
        hasChanges = true;
    } else {
        console.warn('No file changes detected — pushing existing commits only');
    }

    var syncResult = prHelper.syncBranchWithBase({
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        runCommand: function(command, dir) {
            var args = { command: command };
            if (dir) args.workingDirectory = dir;
            return cli_execute_command(args);
        }
    });
    if (!syncResult.success) {
        throw new Error('Could not sync PR branch with origin/' + baseBranch + ' before rework push: ' + syncResult.error);
    }

    try {
        cmd('git push -u origin ' + branchName);
    } catch (pushError) {
        console.log('Normal push failed, retrying with --force-with-lease...');
        cmd('git push -u origin ' + branchName + ' --force-with-lease');
    }

    const remoteCheck = cleanCommandOutput(cmd('git ls-remote --heads origin ' + branchName) || '');
    if (!remoteCheck.trim()) {
        throw new Error('Branch was not successfully pushed to remote');
    }

    console.log('✅ Pushed to remote branch:', branchName);
    return { branch: branchName, hasChanges: hasChanges };
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

function postJiraComment(ticketKey, prUrl, branchName, prCommentPosted, codeChangesCommitted, fixSummary) {
    try {
        let comment;
        if (codeChangesCommitted) {
            comment = 'h3. ✅ Rework Completed\n\n';
            comment += '*Branch*: {code}' + branchName + '{code}\n';
            if (prUrl) {
                comment += '*Pull Request*: ' + prUrl + '\n';
            }
            comment += '\nAI Teammate has addressed all PR review comments and pushed the fixes.\n';
        } else {
            comment = 'h3. ✅ Rework Analysis Completed\n\n';
            if (prUrl) {
                comment += '*Pull Request*: ' + prUrl + '\n';
            }
            comment += '\nAI Teammate analyzed all PR review comments and determined no code changes are required.\n';
        }
        if (prCommentPosted) {
            comment += 'A fix summary has been posted as a comment on the Pull Request.';
        }

        jira_post_comment({ key: ticketKey, comment: comment });
        console.log('✅ Posted completion comment to Jira:', ticketKey);
    } catch (error) {
        console.error('Failed to post Jira comment:', error);
    }
}

function isInterruptedReworkResponse(response) {
    var text = String(response || '');
    return text.indexOf('CLI command executed but did not produce output file') !== -1 ||
        text.indexOf('Command failed (exit code 124)') !== -1 ||
        text.indexOf('Copilot command timed out') !== -1 ||
        text.indexOf('outputs/response.md missing') !== -1 ||
        text.indexOf('"path":"interrupted"') !== -1 ||
        text.indexOf('"path": "interrupted"') !== -1;
}

function handleInterruptedRework(ticketKey, branchName, customParams, statuses) {
    console.warn('Rework CLI was interrupted before writing required outputs; leaving PR conversations open and resetting ticket for retry.');
    try {
        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ⏸️ Rework Interrupted\n\nThe AI agent pushed any staged partial changes, but it was interrupted before writing {code}outputs/response.md{code} and {code}outputs/review_replies.json{code}. PR conversations were left open. The ticket was moved back to *' + statuses.IN_REWORK + '* for retry.\n\n*Branch*: {code}' + branchName + '{code}'
        });
    } catch (e) {
        console.warn('Failed to post interrupted rework Jira comment:', e.message || e);
    }
    try {
        jira_move_to_status({ key: ticketKey, statusName: statuses.IN_REWORK });
        console.log('✅ Moved', ticketKey, 'back to', statuses.IN_REWORK, 'for retry');
    } catch (e) {
        console.warn('Failed to move ticket back to ' + statuses.IN_REWORK + ':', e.message || e);
    }
    removeConfiguredLabels(ticketKey, customParams || {});
    return {
        success: true,
        path: 'rework-interrupted',
        ticketKey: ticketKey,
        branchName: branchName
    };
}

function action(params) {
    try {
        const actualParams = params.ticket ? params : (params.jobParams || params);
        const ticketKey = actualParams.ticket.key;
        const fixSummary = actualParams.response || '_(No fix summary generated)_';
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = scmModule.createScm(config);
        const _customParams = resolveCustomParams(params, actualParams, config);
        const statuses = resolveStatuses(_customParams);

        console.log('=== Push rework changes for:', ticketKey, '===');

        // Configure git
        configureGitAuthor(config);

        var gateResult = feedbackLoop.runQualityGates({
            ticketKey: ticketKey,
            customParams: _customParams,
            section: 'qualityGates'
        });
        if (!gateResult.success) {
            throw new Error('Quality gate failed before rework push: ' + gateResult.failedGate + '\n' + gateResult.error);
        }
        var policyResult = feedbackLoop.runPolicyGates({
            ticketKey: ticketKey,
            customParams: _customParams,
            section: 'policyGates'
        });
        if (!policyResult.success) {
            throw new Error('Policy gate failed before rework push: ' + policyResult.failedGate + '\n' + policyResult.error);
        }

        // Commit and push
        let branchName;
        let codeChangesCommitted = false;
        try {
            const pushResult = commitAndPush(ticketKey, config, _customParams);
            branchName = pushResult.branch;
            codeChangesCommitted = pushResult.hasChanges;
        } catch (gitError) {
            console.error('Git operations failed:', gitError);
            var resume = feedbackLoop.resumeAgent({
                ticketKey: ticketKey,
                customParams: _customParams,
                section: 'postAction',
                stage: 'rework_git_operations',
                error: gitError.toString()
            });
            if (resume.attempted) {
                return action(params);
            }
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ❌ Rework Push Failed\n\n{code}' + gitError.toString() + '{code}\n\nPlease check the logs and retry.'
                });
            } catch (e) {}
            return { success: false, error: gitError.toString() };
        }

        var postPublishGateResult = feedbackLoop.runPostPublishGates({
            ticketKey: ticketKey,
            customParams: _customParams,
            section: 'postPublishGates',
            workingDir: config.workingDir || null
        });
        if (!postPublishGateResult.success) {
            var gateError = 'Post-publish quality gate failed: ' +
                postPublishGateResult.failedGate + '\n' + postPublishGateResult.error;
            if (postPublishGateResult.resumeAttempted) {
                return action(params);
            }
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ❌ Rework Quality Gate Failed\n\n{code}' + gateError + '{code}\n\nThe branch was pushed before running this gate. Please check the logs and retry.'
                });
            } catch (e) {}
            return { success: false, error: gateError };
        }

        if (isInterruptedReworkResponse(fixSummary)) {
            var interruptedResume = feedbackLoop.resumeAgent({
                ticketKey: ticketKey,
                customParams: _customParams,
                section: 'postAction',
                stage: 'rework_missing_outputs',
                error: fixSummary
            });
            if (interruptedResume.attempted) {
                return action(params);
            }
            return handleInterruptedRework(ticketKey, branchName, _customParams, statuses);
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

            // Post general fix summary as a top-level PR comment
            // Post if: code was committed, thread replies were posted, or agent produced a meaningful summary
            var hasMeaningfulSummary = fixSummary && fixSummary.length > 50
                && fixSummary !== '_(No fix summary generated)_';
            if (repliesPosted > 0 || codeChangesCommitted || hasMeaningfulSummary) {
                prCommentPosted = postPRComment(scm, pr.number, fixSummary, ticketKey);
            } else {
                console.log('ℹ️ No thread replies, no code changes, and no meaningful summary — skipping general PR comment');
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
        postJiraComment(ticketKey, prUrl, branchName, prCommentPosted, codeChangesCommitted, fixSummary);

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
        removeConfiguredLabels(ticketKey, _customParams);

        // Auto-start pr_review after rework is pushed to In Review (opt-in via customParams)
        var reviewStarted = false;
        const autoStartReview = _customParams && _customParams.autoStartReview;
        const reviewConfigFile = _customParams && _customParams.autoStartReviewConfigFile;
        if (autoStartReview && reviewConfigFile) {
            // Skip if ticket already has pr_approved label (already approved, merge pending)
            const ticket = actualParams.ticket || (params.jobParams && params.jobParams.ticket);
            if (hasPrApprovedLabel(ticket)) {
                console.log('ℹ️ autoStartReview: skipped — ticket has pr_approved label');
            } else {
                try {
                    reviewStarted = autoStart.triggerConfiguredWorkflowForTicket({
                        ticketKey: ticketKey,
                        customParams: _customParams,
                        config: config,
                        configFile: reviewConfigFile,
                        label: 'pr_review',
                        scm: scm,
                        stripKeys: [
                            'removeLabel',
                            'autoStartReview',
                            'autoStartReviewConfigFile'
                        ]
                    });
                } catch (e) {
                    console.warn('⚠️ autoStartReview trigger failed:', e.message || e);
                }
            }
        }
        if (!reviewStarted) {
            autoStart.triggerSmIfIdle({ config: config, customParams: _customParams, scm: scm });
        }

        // Cache configured artefacts (e.g. cosmo test reports) to GitHub Release — non-fatal
        try { cacheToReleases.action(params); } catch (e) { console.warn('⚠️ cacheToReleases failed (non-fatal):', e); }

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
            const actualParams = params.ticket ? params : (params.jobParams || params);
            if (actualParams && actualParams.ticket && actualParams.ticket.key) {
                const customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
                var resume = feedbackLoop.resumeAgent({
                    ticketKey: actualParams.ticket.key,
                    customParams: customParams,
                    section: 'postAction',
                    stage: 'rework_post_action',
                    error: error.toString()
                });
                if (resume.attempted) {
                    return action(params);
                }
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
    module.exports = { action, resolveCustomParams, isInterruptedReworkResponse };
}
