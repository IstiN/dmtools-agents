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

function readFile(path) {
    try {
        const content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        console.warn('Could not read file ' + path + ':', e);
        return null;
    }
}

function readReviewJson() {
    try {
        const raw = readFile('outputs/pr_review.json');
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

function postInlineComment(repoInfo, prNumber, inlineComment) {
    try {
        const comment = readFile(inlineComment.comment);
        if (!comment) return;

        const params = {
            workspace: repoInfo.owner,
            repository: repoInfo.repo,
            pullRequestId: String(prNumber),
            path: inlineComment.file,
            line: String(inlineComment.line),
            text: comment
        };
        if (inlineComment.startLine) params.startLine = String(inlineComment.startLine);
        if (inlineComment.side) params.side = inlineComment.side;

        github_add_inline_comment(params);
        console.log('✅ Inline comment on ' + inlineComment.file + ':' + inlineComment.line);
    } catch (e) {
        console.warn('Failed to post inline comment:', e);
    }
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const jiraComment = params.response || '';

        console.log('=== Processing test automation review for', ticketKey, '===');

        // Step 1: Read review data
        const reviewData = readReviewJson();
        if (!reviewData) {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ⚠️ Review Error\n\nCould not read pr_review.json. Check workflow logs.'
            });
            return { success: false, error: 'No review data found' };
        }

        // Normalize: LLM sometimes returns "APPROVED" instead of "APPROVE"
        const isApproved = (reviewData.recommendation || '').replace(/^APPROVED$/, 'APPROVE') === 'APPROVE';
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
        } else {
            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REWORK });
                console.log('✅ Changes requested — moved', ticketKey, 'to In Rework');
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
