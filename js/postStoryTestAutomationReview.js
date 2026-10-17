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

function action(params) {
    try {
        const storyKey = params.ticket.key;
        const config = configLoader.loadProjectConfig(params.jobParams || params);
        const customParams = resolveCustomParams(params, config);
        initTracker(config, customParams);
        const workingDir = config.workingDir || null;
        const scm = scmModule.createScm(config);

        console.log('=== Processing story test automation review for', storyKey, '===');

        const reviewData = readReviewJson(storyKey, workingDir);
        if (!reviewData) {
            getTracker().postComment(storyKey, 'h3. ⚠️ Story Test Review Error\n\nCould not read pr_review.json. Removed SM trigger label so SM can retry.');
            removeAutomationLabels(storyKey, params, customParams);
            return { success: false, error: 'No review data found' };
        }

        const isApproved = (reviewData.recommendation || '').replace(/^APPROVED$/, 'APPROVE') === 'APPROVE';
        console.log('Review recommendation:', reviewData.recommendation);

        const { prNumber, prUrl } = reviewHelpers.getPRNumber(params, storyKey, scm, readFile);
        const repoInfo = getRepoInfo(config);

        var inlineComments = reviewHelpers.filterInlineCommentsByDiff(scm, prNumber, reviewData.inlineComments, prReviewComments);

        if (prNumber) {
            reviewHelpers.resolveExistingAgentReviewThreads(scm, prNumber, repoInfo, ghHelpers.fetchDiscussionsAndRawData);

            if (inlineComments && inlineComments.length > 0) {
                console.log('Posting ' + inlineComments.length + ' inline comment(s)');
                inlineComments.forEach(function(ic, index) {
                    console.log('Processing inline comment ' + (index + 1) + '/' + inlineComments.length);
                    reviewHelpers.postInlineComment(scm, prNumber, ic, storyKey, readFile, prReviewComments);
                });
            }

            // Post the general comment AFTER inline comments.
            if (reviewData.generalComment) {
                reviewHelpers.postGeneralComment(scm, prNumber, reviewData.generalComment, storyKey, workingDir, outputFiles);
            }
            prReviewComments.resolveApprovedThreads(scm, prNumber, reviewData.resolvedThreadIds);

            reviewHelpers.applyVerdictLabels(scm, prNumber, storyKey, isApproved, getTracker, LABELS);
        } else {
            console.warn('No PR number found — skipping GitHub comments');
        }

        if (params.response) {
            try {
                getTracker().postComment(storyKey, params.response);
            } catch (e) {
                console.warn('Failed to post Jira review comment:', e);
            }
        }

        if (!isApproved) {
            postReworkFeedback(storyKey, reviewData, inlineComments);
        }

        if (isApproved) {
            console.log('✅ Story PR approved — triggering merge agent');
            if (!triggerMerge(storyKey, config, customParams)) {
                autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
            }
        } else {
            console.log('📝 Changes requested on test-automation PR — keeping ticket in In Testing for rework');
            if (!triggerRework(storyKey, config, customParams)) {
                autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
            }
        }

        try {
            getTracker().addLabel(storyKey, LABELS.AI_PR_REVIEWED);
        } catch (e) {}

        removeAutomationLabels(storyKey, params, customParams);

        try {
            tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
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
                getTracker().removeLabel(storyKey, 'sm_story_test_review_triggered');
                getTracker().postComment(storyKey, 'h3. ❌ Story Test Review Error\n\n{code}' + error.toString() + '{code}');
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
