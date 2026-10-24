/**
 * Post Story Test Automation Review Comments Action
 * Handles the bulk review result for a Story PR.
 * - APPROVED → add pr_approved label, trigger story_test_automation_merge
 * - REQUEST_CHANGES / BLOCK → move Story to In Rework, trigger story_test_automation_rework
 *
 * Posts comments through the SCM abstraction (same as pr_review) so that
 * inline comments become diff conversation threads rather than generic PR comments.
 *
 * gh-1008 CRAP split: diff/comment helpers live in
 * js/postStoryTestAutomationReviewHelpers.js; tracker/label helpers in
 * js/postStoryTestAutomationShared.js; action() is a thin orchestrator.
 */

const { LABELS } = require('./config.js');
const scmModule = require('./common/scm.js');
const ghHelpers = require('./common/githubHelpers.js');
const autoStart = require('./common/autoStart.js');
const configLoader = require('./configLoader.js');
const outputFiles = require('./common/outputFiles.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const prReviewComments = require('./postPRReviewComments.js');
const shared = require('./postStoryTestAutomationShared.js');
const reviewHelpers = require('./postStoryTestAutomationReviewHelpers.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = shared.createTrackerHolder(trackersModule);
function initTracker(config, customParams) {
    trackerHolder.initTracker(config, customParams);
}
function getTracker() {
    return trackerHolder.getTracker();
}

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

function getRepoInfo(config) {
    if (config && config.repository && config.repository.owner && config.repository.repo) {
        return { owner: config.repository.owner, repo: config.repository.repo };
    }
    try {
        return ghHelpers.getGitHubRepoInfo();
    } catch (e) {
        console.warn('Could not determine repo info:', e.message || e);
        return null;
    }
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

function removeAutomationLabels(storyKey, params, customParams) {
    const wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : 'pr_story_test_automation_review_wip';
    shared.removeLabelSafely(getTracker, storyKey, wipLabel);

    const smTriggerLabel = customParams && customParams.removeLabel;
    if (smTriggerLabel) {
        if (shared.removeLabelSafely(getTracker, storyKey, smTriggerLabel)) {
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        }
    }
}

/**
 * Posts the numbered rework feedback (inline comments + general comment) to
 * the tracker so the rework agent sees what must be addressed.
 */
function postReworkFeedback(storyKey, reviewData, inlineComments) {
    if (!inlineComments || inlineComments.length === 0) return;

    try {
        var feedback = reviewHelpers.buildReworkFeedback({
            generalComment: reviewData.generalComment,
            inlineComments: inlineComments
        }, readFile);
        getTracker().postComment(storyKey, feedback);
        console.log('✅ Posted detailed rework feedback to Jira');
    } catch (e) {
        console.warn('Failed to post detailed rework feedback:', e);
    }
}

// ── gh-1192: action() decomposed into a context builder + per-step helpers ──
// Same tracker/SCM/git/file calls in the same order; only the control flow
// moved into named units so every branch is unit-testable.

/** Whether the review recommendation is an approval (APPROVED normalizes). */
function reviewRecommendationIsApprove(recommendation) {
    return (recommendation || '').replace(/^APPROVED$/, 'APPROVE') === 'APPROVE';
}

/** The shared per-run context: config, tracker, SCM and workingDir. */
function buildReviewActionContext(params) {
    const storyKey = params.ticket.key;
    const config = configLoader.loadProjectConfig(params.jobParams || params);
    const customParams = resolveCustomParams(params, config);
    initTracker(config, customParams);
    const workingDir = config.workingDir || null;
    const scm = scmModule.createScm(config);

    console.log('=== Processing story test automation review for', storyKey, '===');

    return {
        storyKey: storyKey,
        config: config,
        customParams: customParams,
        workingDir: workingDir,
        scm: scm
    };
}

/** Missing/unreadable review data: tell the tracker, clean the labels, fail. */
function handleMissingReviewData(ctx, params) {
    getTracker().postComment(ctx.storyKey, 'h3. ⚠️ Story Test Review Error\n\nCould not read pr_review.json. Removed SM trigger label so SM can retry.');
    removeAutomationLabels(ctx.storyKey, params, ctx.customParams);
    return { success: false, error: 'No review data found' };
}

/** Posts the filtered inline comments to the PR, numbered, in order. */
function postInlineReviewComments(ctx, prNumber, inlineComments) {
    if (inlineComments && inlineComments.length > 0) {
        console.log('Posting ' + inlineComments.length + ' inline comment(s)');
        inlineComments.forEach(function(ic, index) {
            console.log('Processing inline comment ' + (index + 1) + '/' + inlineComments.length);
            reviewHelpers.postInlineComment(ctx.scm, prNumber, ic, ctx.storyKey, readFile, prReviewComments);
        });
    }
}

/** PR-side publish step: threads, inline + general comments, verdict labels. */
function publishReviewCommentsToPr(ctx, prNumber, repoInfo, reviewData, inlineComments, isApproved) {
    if (!prNumber) {
        console.warn('No PR number found — skipping GitHub comments');
        return;
    }

    reviewHelpers.resolveExistingAgentReviewThreads(ctx.scm, prNumber, repoInfo, ghHelpers.fetchDiscussionsAndRawData);

    postInlineReviewComments(ctx, prNumber, inlineComments);

    // Post the general comment AFTER inline comments.
    if (reviewData.generalComment) {
        reviewHelpers.postGeneralComment(ctx.scm, prNumber, reviewData.generalComment, ctx.storyKey, ctx.workingDir, outputFiles);
    }
    prReviewComments.resolveApprovedThreads(ctx.scm, prNumber, reviewData.resolvedThreadIds);

    reviewHelpers.applyVerdictLabels(ctx.scm, prNumber, ctx.storyKey, isApproved, getTracker, LABELS);
}

/** The agent's own review summary (params.response) goes to the tracker. */
function postReviewResponseComment(storyKey, params) {
    if (!params.response) return;
    try {
        getTracker().postComment(storyKey, params.response);
    } catch (e) {
        console.warn('Failed to post Jira review comment:', e);
    }
}

/** After the verdict: merge or rework continuation, falling back to the SM. */
function triggerOutcomeFollowUp(storyKey, config, customParams, isApproved) {
    var triggered;
    if (isApproved) {
        console.log('✅ Story PR approved — triggering merge agent');
        triggered = triggerMerge(storyKey, config, customParams);
    } else {
        console.log('📝 Changes requested on test-automation PR — keeping ticket in In Testing for rework');
        triggered = triggerRework(storyKey, config, customParams);
    }
    if (!triggered) {
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
    }
}

/** Best-effort token-usage summary; failures must not fail the step. */
function postTokenUsageSafely(storyKey, params) {
    tokenUsageComment.postTokenUsageSafely(storyKey, params);
}

/** Outer-catch: report the failure to the tracker and fail the action. */
function handleReviewActionError(params, error) {
    console.error('❌ Error in postStoryTestAutomationReview:', error);
    try {
        const storyKey = params.ticket ? params.ticket.key : null;
        if (storyKey) {
            getTracker().removeLabel(storyKey, 'sm_story_test_review_triggered');
            getTracker().postComment(storyKey, 'h3. ❌ Story Test Review Error\n\n{code}' + error.toString() + '{code}');
        }
    } catch (e) {}
    return { success: false, error: error.toString() };
}

function action(params) {
    try {
        const ctx = buildReviewActionContext(params);

        const reviewData = readReviewJson(ctx.storyKey, ctx.workingDir);
        if (!reviewData) {
            return handleMissingReviewData(ctx, params);
        }

        const isApproved = reviewRecommendationIsApprove(reviewData.recommendation);
        console.log('Review recommendation:', reviewData.recommendation);

        const prInfo = reviewHelpers.getPRNumber(params, ctx.storyKey, ctx.scm, readFile);
        const repoInfo = getRepoInfo(ctx.config);

        var inlineComments = reviewHelpers.filterInlineCommentsByDiff(ctx.scm, prInfo.prNumber, reviewData.inlineComments, prReviewComments);

        publishReviewCommentsToPr(ctx, prInfo.prNumber, repoInfo, reviewData, inlineComments, isApproved);

        postReviewResponseComment(ctx.storyKey, params);

        if (!isApproved) {
            postReworkFeedback(ctx.storyKey, reviewData, inlineComments);
        }

        triggerOutcomeFollowUp(ctx.storyKey, ctx.config, ctx.customParams, isApproved);

        try {
            getTracker().addLabel(ctx.storyKey, LABELS.AI_PR_REVIEWED);
        } catch (e) {}

        removeAutomationLabels(ctx.storyKey, params, ctx.customParams);

        postTokenUsageSafely(ctx.storyKey, params);

        return {
            success: true,
            recommendation: reviewData.recommendation,
            storyKey: ctx.storyKey,
            prUrl: prInfo.prUrl
        };

    } catch (error) {
        return handleReviewActionError(params, error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
