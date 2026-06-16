/**
 * Post Test Automation Review Comments Action (postJSAction for pr_test_automation_review)
 * Reads outputs/pr_review.json (same format as pr_review agent).
 *
 * If APPROVED:
 *   - Merges PR
 *   - Moves to Passed (if currently In Review - Passed) or Failed (if currently In Review - Failed)
 *
 * If REQUEST_CHANGES / BLOCK:
 *   - Does NOT merge
 *   - Moves to In Rework
 */

const { STATUSES, LABELS } = require('./config.js');
const gh = require('./common/githubHelpers.js');
const autoStart = require('./common/autoStart.js');
const configLoader = require('./configLoader.js');
const outputFiles = require('./common/outputFiles.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

function readFile(path) {
    return outputFiles.readOutputFile(path, {});
}

function readReviewJson(ticketKey, workingDir) {
    try {
        const raw = outputFiles.readOutputFile('pr_review.json', {
            ticketKey: ticketKey,
            workingDir: workingDir
        });
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse pr_review.json:', e);
        return null;
    }
}

function getCurrentTicketStatus(ticketKey) {
    try {
        const ticket = jira_get_ticket({ key: ticketKey });
        return ticket && ticket.fields && ticket.fields.status
            ? ticket.fields.status.name
            : null;
    } catch (e) {
        console.warn('Could not get current ticket status:', e);
        return null;
    }
}

function getPRNumber(params, ticketKey, repoInfo) {
    let prNumber = null;
    let prUrl = null;

    try {
        const inputFolder = params.inputFolderPath || ('input/' + ticketKey);
        const prInfo = readFile(inputFolder + '/pr_info.md');
        if (prInfo) {
            const numMatch = prInfo.match(/\*\*PR #\*\*:\s*(\d+)/);
            const urlMatch = prInfo.match(/\*\*URL\*\*:\s*(https:\/\/[^\s]+)/);
            if (numMatch) prNumber = parseInt(numMatch[1], 10);
            if (urlMatch) prUrl = urlMatch[1];
        }
    } catch (e) {}

    if (!prNumber && repoInfo) {
        // Use exact test/ branch match on open PRs only — never fuzzy-match (would find ai/ feature PRs)
        const branchName = 'test/' + ticketKey;
        try {
            const openPRs = github_list_prs({ workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open' });
            const openMatch = openPRs.filter(function(pr) {
                return pr.head && pr.head.ref && pr.head.ref === branchName;
            });
            if (openMatch.length > 0) {
                prNumber = openMatch[0].number;
                prUrl = openMatch[0].html_url;
            } else {
                console.warn('No open PR found for branch', branchName);
            }
        } catch (e) {
            console.warn('Failed to find test PR by branch:', e);
        }
    }

    return { prNumber: prNumber, prUrl: prUrl };
}

function resolveApprovedThreads(repoInfo, prNumber, resolvedThreadIds) {
    if (!resolvedThreadIds || resolvedThreadIds.length === 0) return;
    console.log('Resolving ' + resolvedThreadIds.length + ' fixed review thread(s)...');
    resolvedThreadIds.forEach(function(threadId) {
        try {
            github_resolve_pr_thread({
                workspace: repoInfo.owner,
                repository: repoInfo.repo,
                pullRequestId: String(prNumber),
                threadId: threadId
            });
            console.log('✅ Resolved thread', threadId);
        } catch (e) {
            console.warn('Failed to resolve thread ' + threadId + ':', e.message || e);
        }
    });
}

function getPrDiff(repoInfo, prNumber) {
    try {
        return github_get_pr_diff({
            workspace: repoInfo.owner,
            repository: repoInfo.repo,
            pullRequestId: String(prNumber)
        }) || '';
    } catch (e) {
        console.warn('Could not fetch PR diff for inline comment validation:', e.message || e);
        return null;
    }
}

function isLinePresentInDiff(diffText, filePath, targetLine) {
    if (!diffText || !filePath || !targetLine) return true;

    var lineNumber = parseInt(targetLine, 10);
    if (!lineNumber) return true;

    var currentFile = null;
    var newLine = null;
    var lines = String(diffText).split(/\r?\n/);

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        if (line.indexOf('diff --git ') === 0) {
            currentFile = null;
            newLine = null;
            continue;
        }

        if (line.indexOf('+++ b/') === 0) {
            currentFile = line.substring('+++ b/'.length);
            continue;
        }

        if (currentFile !== filePath) continue;

        var hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            newLine = parseInt(hunk[1], 10);
            continue;
        }

        if (newLine === null) continue;

        if (line.indexOf('+') === 0 || line.indexOf(' ') === 0) {
            if (newLine === lineNumber) return true;
            newLine++;
        } else if (line.indexOf('-') === 0) {
            continue;
        } else if (line === '\\ No newline at end of file') {
            continue;
        } else {
            newLine++;
        }
    }

    return false;
}

function postFallbackInlineComment(repoInfo, prNumber, filePath, line, commentText) {
    var lineRef = filePath + (line ? ':' + line : '');
    github_add_pr_comment({
        workspace: repoInfo.owner,
        repository: repoInfo.repo,
        pullRequestId: String(prNumber),
        text: '📍 **`' + lineRef + '`**\n\n' + commentText
    });
    console.log('✅ Posted fallback PR comment for ' + lineRef);
}

function postInlineComment(repoInfo, prNumber, inlineComment) {
    const filePath = inlineComment.path || inlineComment.file;
    const commentText = inlineComment.body || readFile(inlineComment.comment);

    try {
        if (!commentText) {
            console.warn('No comment content found for inline comment on', filePath);
            return false;
        }
        if (!filePath) {
            console.warn('No file path found for inline comment');
            return false;
        }

        const params = {
            workspace: repoInfo.owner,
            repository: repoInfo.repo,
            pullRequestId: String(prNumber),
            path: filePath,
            line: String(inlineComment.line),
            text: commentText
        };
        if (inlineComment.startLine) params.startLine = String(inlineComment.startLine);
        if (inlineComment.side) params.side = inlineComment.side;

        var diffText = getPrDiff(repoInfo, prNumber);
        if (diffText !== null && !isLinePresentInDiff(diffText, filePath, inlineComment.line)) {
            console.warn('Inline comment line is not present in PR diff; falling back to PR comment on ' + filePath + ':' + inlineComment.line);
            postFallbackInlineComment(repoInfo, prNumber, filePath, inlineComment.line, commentText);
            return true;
        }

        github_add_inline_comment(params);
        console.log('✅ Inline comment on ' + filePath + ':' + inlineComment.line);
        return true;
    } catch (e) {
        console.warn('Inline comment failed (line not in diff?), falling back to PR comment on ' + filePath + ':' + inlineComment.line);
        try {
            postFallbackInlineComment(repoInfo, prNumber, filePath, inlineComment.line, commentText);
            return true;
        } catch (fallbackError) {
            console.warn('Failed to post fallback PR comment:', fallbackError);
            return false;
        }
    }
}

function triggerReworkIfConfigured(ticketKey, config, customParams) {
    if (!customParams || !customParams.autoStartRework || !customParams.autoStartReworkConfigFile) {
        return false;
    }

    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: ticketKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartReworkConfigFile,
            label: 'pr_test_automation_rework',
            stripKeys: [
                'removeLabel',
                'autoStartRework',
                'autoStartReworkConfigFile'
            ]
        });
    } catch (e) {
        console.warn('⚠️ autoStartRework trigger failed:', e.message || e);
        return false;
    }
}

function markForSmTestRework(ticketKey) {
    try {
        jira_add_label({ key: ticketKey, label: 'sm_test_rework_triggered' });
        console.log('✅ Added SM rework label: sm_test_rework_triggered');
        return true;
    } catch (e) {
        console.warn('⚠️ Failed to add SM rework label:', e.message || e);
        return false;
    }
}

function resolveCustomParams(params, config) {
    var merged = {};
    var patch = configLoader.resolveInstructions(
        'pr_test_automation_review',
        null,
        config
    ).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(
        merged,
        (params.jobParams && params.jobParams.customParams) ||
            params.customParams ||
            {}
    );
    return merged;
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const jiraComment = params.response || '';
        const config = configLoader.loadProjectConfig(params.jobParams || params);
        const customParams = resolveCustomParams(params, config);
        const workingDir = config.workingDir || null;

        console.log('=== Processing test automation review for', ticketKey, '===');

        // Step 1: Read review data
        const reviewData = readReviewJson(ticketKey, workingDir);
        if (!reviewData) {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ⚠️ Review Error\n\nCould not read pr_review.json. Removed SM trigger label so SM can retry.'
            });
            try {
                const smTriggerLabel = customParams.removeLabel || 'sm_test_review_triggered';
                jira_remove_label({ key: ticketKey, label: smTriggerLabel });
                console.log('✅ Removed SM trigger label after missing review:', smTriggerLabel);
            } catch (e) {
                console.warn('Failed to remove SM trigger label after missing review:', e);
            }
            try {
                const wipLabelMissingReview = params.metadata && params.metadata.contextId
                    ? params.metadata.contextId + '_wip'
                    : 'pr_test_automation_review_wip';
                jira_remove_label({ key: ticketKey, label: wipLabelMissingReview });
            } catch (e) {
                console.warn('Failed to remove WIP label after missing review:', e);
            }
            return { success: false, error: 'No review data found' };
        }

        // Normalize recommendation: LLM may return "PASS"/"PASSED" or "APPROVED" instead of "APPROVE",
        // and "FAIL"/"FAILED" instead of "BLOCK".
        function normalizeRecommendation(rec) {
            const value = String(rec || '').toUpperCase().trim();
            if (value === 'PASS' || value === 'PASSED' || value === 'APPROVED') return 'APPROVE';
            if (value === 'FAIL' || value === 'FAILED' || value === 'REJECT') return 'BLOCK';
            return rec;
        }
        reviewData.recommendation = normalizeRecommendation(reviewData.recommendation);
        const isApproved = reviewData.recommendation === 'APPROVE';
        console.log('Review recommendation:', reviewData.recommendation);

        // Step 2: Get current ticket status (to determine Passed vs Failed on approval)
        const currentStatus = getCurrentTicketStatus(ticketKey);
        console.log('Current ticket status:', currentStatus);

        // Step 3: Get repo info + PR number
        const repoInfo = gh.getGitHubRepoInfo();
        const { prNumber, prUrl } = getPRNumber(params, ticketKey, repoInfo);

        // Step 4: Post GitHub comments
        var mergeSucceeded = false;
        if (prNumber && repoInfo) {
            // General comment
            if (reviewData.generalComment) {
                try {
                    const commentText = readFile(reviewData.generalComment);
                    if (commentText) {
                        github_add_pr_comment({
                            workspace: repoInfo.owner,
                            repository: repoInfo.repo,
                            pullRequestId: String(prNumber),
                            text: commentText
                        });
                        console.log('✅ Posted general review comment to PR');
                    }
                } catch (e) {
                    console.warn('Failed to post general comment:', e);
                }
            }

            // Inline comments
            if (reviewData.inlineComments && reviewData.inlineComments.length > 0) {
                reviewData.inlineComments.forEach(function(ic) {
                    postInlineComment(repoInfo, prNumber, ic);
                });
            }

            // Resolve threads that were fully fixed in this rework
            resolveApprovedThreads(repoInfo, prNumber, reviewData.resolvedThreadIds);

            // Queue for merge via pr_approved label (same pattern as stories/bugs)
            if (isApproved) {
                try {
                    github_add_pr_label({
                        workspace: repoInfo.owner,
                        repository: repoInfo.repo,
                        pullRequestId: String(prNumber),
                        label: LABELS.PR_APPROVED
                    });
                    console.log('✅ Added pr_approved label to GitHub PR');
                } catch (e) {
                    console.warn('Failed to add pr_approved to GitHub PR:', e);
                }
                try {
                    jira_add_label({ key: ticketKey, label: LABELS.PR_APPROVED });
                    console.log('✅ Added pr_approved label to Jira ticket');
                } catch (e) {
                    console.warn('Failed to add pr_approved to Jira ticket:', e);
                }
                mergeSucceeded = true; // signal "no conflict yet"
                console.log('✅ PR #' + prNumber + ' queued for merge via pr_approved');
            }
        } else {
            console.warn('No PR info — skipping GitHub comments');
        }

        // Step 5: Post Jira comment
        try {
            if (jiraComment) {
                jira_post_comment({ key: ticketKey, comment: jiraComment });
                console.log('✅ Posted review comment to Jira');
            }
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 6: Move ticket status
        if (isApproved) {
            // Ticket stays in In Review - Passed/Failed until SM merges the PR via pr_approved flow
            console.log('✅ Ticket stays in', currentStatus, '— SM will merge and move to final status');
            autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
        } else {
            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REWORK });
                console.log('✅ Changes requested — moved', ticketKey, 'to In Rework');
                if (!triggerReworkIfConfigured(ticketKey, config, customParams)) {
                    markForSmTestRework(ticketKey);
                    autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
                }
            } catch (e) {
                console.warn('Failed to move to In Rework:', e);
            }
        }

        // Step 7: Add label + remove WIP
        try {
            jira_add_label({ key: ticketKey, label: LABELS.AI_PR_REVIEWED });
        } catch (e) {}

        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'pr_test_automation_review_wip';
        try {
            jira_remove_label({ key: ticketKey, label: wipLabel });
        } catch (e) {}

        try {
            jira_remove_label({ key: ticketKey, label: 'sm_test_review_triggered' });
            console.log('✅ Removed SM label: sm_test_review_triggered');
        } catch (e) {}

        var finalStatus;
        if (isApproved && !mergeSucceeded) {
            finalStatus = STATUSES.IN_REWORK;
        } else if (isApproved) {
            finalStatus = (currentStatus === STATUSES.IN_REVIEW_PASSED) ? STATUSES.PASSED : STATUSES.FAILED;
        } else {
            finalStatus = STATUSES.IN_REWORK;
        }
        console.log('✅ Test review workflow complete:', isApproved ? (mergeSucceeded ? 'APPROVED' : 'MERGE CONFLICT') : 'CHANGES REQUESTED');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            recommendation: reviewData.recommendation,
            ticketKey: ticketKey,
            mergeSucceeded: mergeSucceeded,
            finalStatus: finalStatus
        };

    } catch (error) {
        console.error('❌ Error in postTestReviewComments:', error);
        try {
            const ticketKey = params.ticket ? params.ticket.key : (params.inputFolderPath ? params.inputFolderPath.split('/').pop() : null);
            if (ticketKey) {
                jira_remove_label({ key: ticketKey, label: 'sm_test_review_triggered' });
            }
        } catch (e) {}
        try {
            jira_post_comment({
                key: params.ticket.key,
                comment: 'h3. ❌ Test Review Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
