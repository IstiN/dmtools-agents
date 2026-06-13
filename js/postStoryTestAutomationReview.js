/**
 * Post Story Test Automation Review Comments Action
 * Handles the bulk review result for a Story PR.
 * - APPROVED → add pr_approved label, trigger story_test_automation_merge
 * - REQUEST_CHANGES / BLOCK → move Story to In Rework, trigger story_test_automation_rework
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

function readReviewJson(storyKey, workingDir) {
    try {
        const raw = outputFiles.readOutputFile('pr_review.json', {
            ticketKey: storyKey,
            workingDir: workingDir
        });
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse pr_review.json:', e);
        return null;
    }
}

function getPRNumber(storyKey, repoInfo) {
    let prNumber = null;
    let prUrl = null;
    try {
        const prInfo = readFile('input/' + storyKey + '/pr_info.md');
        if (prInfo) {
            const numMatch = prInfo.match(/\*\*PR #\*\*:\s*(\d+)/);
            const urlMatch = prInfo.match(/\*\*URL\*\*:\s*(https:\/\/[^\s]+)/);
            if (numMatch) prNumber = parseInt(numMatch[1], 10);
            if (urlMatch) prUrl = urlMatch[1];
        }
    } catch (e) {}

    if (!prNumber && repoInfo) {
        const branchName = 'test/' + storyKey;
        try {
            const openPRs = github_list_prs({ workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open' });
            const openMatch = openPRs.filter(function(pr) {
                return pr.head && pr.head.ref && pr.head.ref === branchName;
            });
            if (openMatch.length > 0) {
                prNumber = openMatch[0].number;
                prUrl = openMatch[0].html_url;
            }
        } catch (e) {
            console.warn('Failed to find test PR by branch:', e);
        }
    }
    return { prNumber: prNumber, prUrl: prUrl };
}

function resolveCustomParams(params, config) {
    var merged = {};
    var patch = configLoader.resolveInstructions('pr_story_test_automation_review', null, config).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(merged,
        (params.jobParams && params.jobParams.customParams) || params.customParams || {}
    );
    return merged;
}

function postGeneralComment(repoInfo, prNumber, generalComment) {
    try {
        const text = readFile(generalComment);
        if (text) {
            github_add_pr_comment({
                workspace: repoInfo.owner,
                repository: repoInfo.repo,
                pullRequestId: String(prNumber),
                text: text
            });
            console.log('✅ Posted general review comment to PR');
        }
    } catch (e) {
        console.warn('Failed to post general comment:', e);
    }
}

function postInlineComments(repoInfo, prNumber, inlineComments) {
    if (!inlineComments || inlineComments.length === 0) return;
    // Reuse the same diff-aware posting logic from postTestReviewComments is ideal,
    // but to keep this file self-contained we fall back to PR comments.
    inlineComments.forEach(function(ic) {
        try {
            const filePath = ic.path || ic.file;
            const body = ic.body || readFile(ic.comment);
            if (!body || !filePath) return;
            const lineRef = filePath + (ic.line ? ':' + ic.line : '');
            github_add_pr_comment({
                workspace: repoInfo.owner,
                repository: repoInfo.repo,
                pullRequestId: String(prNumber),
                text: '📍 **`' + lineRef + '`**\n\n' + body
            });
            console.log('✅ Posted fallback PR comment for', lineRef);
        } catch (e) {
            console.warn('Failed to post inline comment:', e);
        }
    });
}

function triggerMerge(storyKey, config, customParams) {
    if (!customParams || !customParams.autoStartMerge || !customParams.autoStartMergeConfigFile) {
        return false;
    }
    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: storyKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartMergeConfigFile,
            label: 'story_test_automation_merge',
            stripKeys: ['removeLabel', 'autoStartMerge', 'autoStartMergeConfigFile']
        });
    } catch (e) {
        console.warn('⚠️ autoStartMerge trigger failed:', e.message || e);
        return false;
    }
}

function triggerRework(storyKey, config, customParams) {
    if (!customParams || !customParams.autoStartRework || !customParams.autoStartReworkConfigFile) {
        return false;
    }
    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: storyKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartReworkConfigFile,
            label: 'story_test_automation_rework',
            stripKeys: ['removeLabel', 'autoStartRework', 'autoStartReworkConfigFile']
        });
    } catch (e) {
        console.warn('⚠️ autoStartRework trigger failed:', e.message || e);
        return false;
    }
}

function action(params) {
    try {
        const storyKey = params.ticket.key;
        const config = configLoader.loadProjectConfig(params.jobParams || params);
        const customParams = resolveCustomParams(params, config);
        const workingDir = config.workingDir || null;

        console.log('=== Processing story test automation review for', storyKey, '===');

        const reviewData = readReviewJson(storyKey, workingDir);
        if (!reviewData) {
            jira_post_comment({
                key: storyKey,
                comment: 'h3. ⚠️ Story Test Review Error\n\nCould not read pr_review.json. Removed SM trigger label so SM can retry.'
            });
            try {
                const smTriggerLabel = customParams.removeLabel || 'sm_story_test_review_triggered';
                jira_remove_label({ key: storyKey, label: smTriggerLabel });
            } catch (e) {}
            try {
                const wipLabel = params.metadata && params.metadata.contextId
                    ? params.metadata.contextId + '_wip'
                    : 'pr_story_test_automation_review_wip';
                jira_remove_label({ key: storyKey, label: wipLabel });
            } catch (e) {}
            return { success: false, error: 'No review data found' };
        }

        const isApproved = (reviewData.recommendation || '').replace(/^APPROVED$/, 'APPROVE') === 'APPROVE';
        console.log('Review recommendation:', reviewData.recommendation);

        const repoInfo = gh.getGitHubRepoInfo();
        const { prNumber, prUrl } = getPRNumber(storyKey, repoInfo);

        if (prNumber && repoInfo) {
            if (reviewData.generalComment) {
                postGeneralComment(repoInfo, prNumber, reviewData.generalComment);
            }
            if (reviewData.inlineComments && reviewData.inlineComments.length > 0) {
                postInlineComments(repoInfo, prNumber, reviewData.inlineComments);
            }

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
                    jira_add_label({ key: storyKey, label: LABELS.PR_APPROVED });
                    console.log('✅ Added pr_approved label to Jira Story');
                } catch (e) {
                    console.warn('Failed to add pr_approved to Jira Story:', e);
                }
            }
        }

        if (params.response) {
            try {
                jira_post_comment({ key: storyKey, comment: params.response });
            } catch (e) {
                console.warn('Failed to post Jira review comment:', e);
            }
        }

        if (isApproved) {
            console.log('✅ Story PR approved — triggering merge agent');
            if (!triggerMerge(storyKey, config, customParams)) {
                autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
            }
        } else {
            console.log('📝 Changes requested on story PR — moving Story to In Rework');
            try {
                jira_move_to_status({ key: storyKey, statusName: STATUSES.IN_REWORK });
                console.log('✅ Moved Story', storyKey, 'to', STATUSES.IN_REWORK);
            } catch (e) {
                console.warn('Failed to move Story to In Rework:', e);
            }
            if (!triggerRework(storyKey, config, customParams)) {
                autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
            }
        }

        // Labels cleanup
        try {
            jira_add_label({ key: storyKey, label: LABELS.AI_PR_REVIEWED });
        } catch (e) {}

        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'pr_story_test_automation_review_wip';
        try {
            jira_remove_label({ key: storyKey, label: wipLabel });
        } catch (e) {}

        try {
            jira_remove_label({ key: storyKey, label: 'sm_story_test_review_triggered' });
        } catch (e) {}

        try {
            tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            recommendation: reviewData.recommendation,
            storyKey: storyKey,
            prUrl: prUrl
        };

    } catch (error) {
        console.error('❌ Error in postStoryTestAutomationReview:', error);
        try {
            const storyKey = params.ticket ? params.ticket.key : null;
            if (storyKey) {
                jira_remove_label({ key: storyKey, label: 'sm_story_test_review_triggered' });
                jira_post_comment({
                    key: storyKey,
                    comment: 'h3. ❌ Story Test Review Error\n\n{code}' + error.toString() + '{code}'
                });
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
