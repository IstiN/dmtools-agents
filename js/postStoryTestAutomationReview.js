/**
 * Post Story Test Automation Review Comments Action
 * Handles the bulk review result for a Story PR.
 * - APPROVED → add pr_approved label, trigger story_test_automation_merge
 * - REQUEST_CHANGES / BLOCK → move Story to In Rework, trigger story_test_automation_rework
 *
 * Posts comments through the SCM abstraction (same as pr_review) so that
 * inline comments become diff conversation threads rather than generic PR comments.
 */

const { LABELS } = require('./config.js');
const scmModule = require('./common/scm.js');
const ghHelpers = require('./common/githubHelpers.js');
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

function getPRNumber(params, storyKey, scm) {
    let prNumber = null;
    let prUrl = null;
    let prBranch = null;

    try {
        const inputFolder = params.inputFolderPath || ('input/' + storyKey);
        const prInfo = readFile(inputFolder + '/pr_info.md');
        if (prInfo) {
            const numMatch = prInfo.match(/\*\*PR #\*\*:\s*(\d+)/);
            const urlMatch = prInfo.match(/\*\*URL\*\*:\s*(https:\/\/[^\s]+)/);
            const branchMatch = prInfo.match(/\*\*Branch\*\*:\s*([^\s\n]+)/);
            if (numMatch) prNumber = parseInt(numMatch[1], 10);
            if (urlMatch) prUrl = urlMatch[1];
            if (branchMatch) prBranch = branchMatch[1];
        }
    } catch (e) {}

    if (!prNumber && scm) {
        const branchName = 'test/' + storyKey;
        try {
            const openPRs = scm.listPrs('open');
            const openMatch = (openPRs || []).filter(function(pr) {
                return pr.head && pr.head.ref && pr.head.ref === branchName;
            });
            if (openMatch.length > 0) {
                prNumber = openMatch[0].number;
                prUrl = openMatch[0].html_url;
                prBranch = openMatch[0].head && openMatch[0].head.ref;
            } else {
                console.warn('No open PR found for branch', branchName);
            }
        } catch (e) {
            console.warn('Failed to find test PR by branch:', e);
        }
    }

    return { prNumber: prNumber, prUrl: prUrl, prBranch: prBranch };
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
            if (currentFile === '/dev/null') currentFile = null;
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

function postFallbackInlineComment(scm, prNumber, filePath, line, commentText) {
    var lineRef = filePath + (line ? ':' + line : '');
    scm.addComment(prNumber, '📍 **`' + lineRef + '`**\n\n' + commentText);
    console.log('✅ Posted fallback PR comment for ' + lineRef);
}

function postInlineComment(scm, prNumber, inlineComment, storyKey, workingDir) {
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

        console.log('Posting inline comment on ' + filePath + ':' + inlineComment.line);

        var diffText = null;
        try {
            diffText = scm.getPrDiff(prNumber);
        } catch (diffError) {
            console.warn('Could not fetch PR diff for inline comment validation:', diffError.message || diffError);
        }

        if (diffText === null || diffText === '') {
            console.warn('PR diff unavailable; falling back to general PR comment on ' + filePath + ':' + inlineComment.line);
            postFallbackInlineComment(scm, prNumber, filePath, inlineComment.line, commentText);
            return true;
        }

        if (!isLinePresentInDiff(diffText, filePath, inlineComment.line)) {
            console.warn('Inline comment line is not present in PR diff; falling back to PR comment on ' + filePath + ':' + inlineComment.line);
            postFallbackInlineComment(scm, prNumber, filePath, inlineComment.line, commentText);
            return true;
        }

        scm.addInlineComment(
            prNumber, filePath, inlineComment.line, commentText,
            inlineComment.startLine || null, inlineComment.side || null
        );

        console.log('✅ Posted inline comment on ' + filePath + ':' + inlineComment.line);
        return true;
    } catch (error) {
        console.warn('Inline comment failed (line not in diff?), falling back to PR comment on ' + filePath + ':' + inlineComment.line);
        try {
            postFallbackInlineComment(scm, prNumber, filePath, inlineComment.line, commentText);
            return true;
        } catch (fallbackError) {
            console.error('Failed to post fallback PR comment for ' + filePath + ':', fallbackError);
            return false;
        }
    }
}

function postGeneralComment(scm, prNumber, generalComment, storyKey, workingDir) {
    try {
        const text = readFile(generalComment);
        if (text) {
            scm.addComment(prNumber, text);
            console.log('✅ Posted general review comment to PR');
        }
    } catch (e) {
        console.warn('Failed to post general comment:', e);
    }
}

function resolveApprovedThreads(scm, prNumber, resolvedThreadIds) {
    if (!resolvedThreadIds || resolvedThreadIds.length === 0) return;
    console.log('Resolving ' + resolvedThreadIds.length + ' fixed review thread(s)...');
    resolvedThreadIds.forEach(function(threadId) {
        try {
            scm.resolveThread(prNumber, { threadId: threadId });
            console.log('✅ Resolved thread', threadId);
        } catch (e) {
            console.warn('Failed to resolve thread ' + threadId + ':', e.message || e);
        }
    });
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

function resolveExistingBotReviewThreads(scm, prNumber, repoInfo) {
    if (!repoInfo || !repoInfo.owner || !repoInfo.repo || !prNumber) return;
    try {
        var discussions = ghHelpers.fetchDiscussionsAndRawData(repoInfo.owner, repoInfo.repo, prNumber);
        if (!discussions || !discussions.rawThreads || !discussions.rawThreads.threads) return;

        var botThreads = discussions.rawThreads.threads.filter(function(t) {
            return t.bot === true && t.threadId && !t.resolved;
        });
        if (botThreads.length === 0) return;

        console.log('Resolving ' + botThreads.length + ' stale bot-authored review thread(s) before posting new feedback...');
        botThreads.forEach(function(t) {
            try {
                scm.resolveThread(prNumber, { threadId: t.threadId });
                console.log('✅ Resolved stale bot thread', t.threadId);
            } catch (e) {
                console.warn('Failed to resolve stale bot thread', t.threadId + ':', e.message || e);
            }
        });
    } catch (e) {
        console.warn('Could not resolve stale bot review threads:', e.message || e);
    }
}

function countOpenReviewThreads(scm, prNumber, repoInfo) {
    if (!repoInfo || !repoInfo.owner || !repoInfo.repo || !prNumber) return 0;
    try {
        var discussions = ghHelpers.fetchDiscussionsAndRawData(repoInfo.owner, repoInfo.repo, prNumber);
        if (!discussions || !discussions.rawThreads || !discussions.rawThreads.threads) return 0;
        return discussions.rawThreads.threads.filter(function(t) { return !t.resolved; }).length;
    } catch (e) {
        console.warn('Could not count open review threads:', e.message || e);
        return 0;
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
    try {
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'pr_story_test_automation_review_wip';
        jira_remove_label({ key: storyKey, label: wipLabel });
    } catch (e) {}

    try {
        const smTriggerLabel = customParams && customParams.removeLabel;
        if (smTriggerLabel) {
            jira_remove_label({ key: storyKey, label: smTriggerLabel });
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        }
    } catch (e) {}
}

function action(params) {
    try {
        const storyKey = params.ticket.key;
        const config = configLoader.loadProjectConfig(params.jobParams || params);
        const customParams = resolveCustomParams(params, config);
        const workingDir = config.workingDir || null;
        const scm = scmModule.createScm(config);

        console.log('=== Processing story test automation review for', storyKey, '===');

        const reviewData = readReviewJson(storyKey, workingDir);
        if (!reviewData) {
            jira_post_comment({
                key: storyKey,
                comment: 'h3. ⚠️ Story Test Review Error\n\nCould not read pr_review.json. Removed SM trigger label so SM can retry.'
            });
            removeAutomationLabels(storyKey, params, customParams);
            return { success: false, error: 'No review data found' };
        }

        const isApproved = (reviewData.recommendation || '').replace(/^APPROVED$/, 'APPROVE') === 'APPROVE';
        console.log('Review recommendation:', reviewData.recommendation);

        const { prNumber, prUrl } = getPRNumber(params, storyKey, scm);
        const repoInfo = getRepoInfo(config);

        if (prNumber) {
            resolveExistingBotReviewThreads(scm, prNumber, repoInfo);

            if (reviewData.generalComment) {
                postGeneralComment(scm, prNumber, reviewData.generalComment, storyKey, workingDir);
            }
            if (reviewData.inlineComments && reviewData.inlineComments.length > 0) {
                console.log('Posting ' + reviewData.inlineComments.length + ' inline comment(s)');
                reviewData.inlineComments.forEach(function(ic, index) {
                    console.log('Processing inline comment ' + (index + 1) + '/' + reviewData.inlineComments.length);
                    postInlineComment(scm, prNumber, ic, storyKey, workingDir);
                });
            }
            resolveApprovedThreads(scm, prNumber, reviewData.resolvedThreadIds);

            if (isApproved) {
                try {
                    scm.addLabel(prNumber, LABELS.PR_APPROVED);
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
            } else {
                try {
                    scm.addLabel(prNumber, LABELS.TEST_PR_REWORK_NEEDED);
                    console.log('✅ Added test_pr_rework_needed label to GitHub PR');
                } catch (e) {
                    console.warn('Failed to add test_pr_rework_needed to GitHub PR:', e);
                }
                try {
                    jira_add_label({ key: storyKey, label: LABELS.TEST_PR_REWORK_NEEDED });
                    console.log('✅ Added test_pr_rework_needed label to Jira Story');
                } catch (e) {
                    console.warn('Failed to add test_pr_rework_needed to Jira Story:', e);
                }
            }
        } else {
            console.warn('No PR number found — skipping GitHub comments');
        }

        if (params.response) {
            try {
                jira_post_comment({ key: storyKey, comment: params.response });
            } catch (e) {
                console.warn('Failed to post Jira review comment:', e);
            }
        }

        if (!isApproved && reviewData.inlineComments && reviewData.inlineComments.length > 0) {
            try {
                var feedback = 'h3. 📝 Test Automation Rework Feedback\n\n';
                feedback += 'The following review comments must be addressed before the test PR can be merged:\n\n';
                reviewData.inlineComments.forEach(function(ic, idx) {
                    var path = ic.path || ic.file || '(file unknown)';
                    var line = ic.line ? ':' + ic.line : '';
                    var body = ic.body;
                    if (!body && ic.comment) {
                        try { body = readFile(ic.comment); } catch (e) {}
                    }
                    body = (body || '').trim();
                    if (!body) return;
                    feedback += '#' + (idx + 1) + '. *' + path + line + '*\n';
                    feedback += '{code}' + body + '{code}\n\n';
                });
                if (reviewData.generalComment) {
                    var generalBody = readFile(reviewData.generalComment);
                    if (generalBody && generalBody.trim()) {
                        feedback += 'h4. General comment\n\n{code}' + generalBody.trim() + '{code}\n';
                    }
                }
                jira_post_comment({ key: storyKey, comment: feedback });
                console.log('✅ Posted detailed rework feedback to Jira');
            } catch (e) {
                console.warn('Failed to post detailed rework feedback:', e);
            }
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
            jira_add_label({ key: storyKey, label: LABELS.AI_PR_REVIEWED });
        } catch (e) {}

        removeAutomationLabels(storyKey, params, customParams);

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
