/**
 * Diff/comment helpers for js/postStoryTestAutomationReview.js.
 *
 * Extracted in the gh-1008 CRAP split so action() becomes a thin
 * orchestrator. Dependencies (readFile, prReviewComments, outputFiles,
 * getTracker, LABELS) are passed as arguments — this module stays free of
 * requires so suites can load it with an empty require map. Posted comment
 * strings stay byte-identical to the originals.
 */

function getPRNumber(params, storyKey, scm, readFile) {
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

function isInlineCommentInDiff(diffText, inlineComment, prReviewComments) {
    var filePath = inlineComment.path || inlineComment.file;
    var line = inlineComment.line;
    if (!diffText || !filePath || !line) return false;

    var lineInfo = prReviewComments.parseDiffLineInfo(diffText, filePath, line);
    if (lineInfo.present) return true;

    // Allow comments targeting content inside a submodule to be anchored on the
    // submodule pointer change in the parent PR diff.
    var submodulePath = prReviewComments.findSubmodulePathForFile(diffText, filePath);
    if (submodulePath) {
        var subInfo = prReviewComments.parseDiffLineInfo(diffText, submodulePath, 1);
        if (subInfo.present) return true;
    }
    return false;
}

function filterInlineCommentsByDiff(scm, prNumber, inlineComments, prReviewComments) {
    if (!inlineComments || inlineComments.length === 0) return [];

    var diffText = null;
    try {
        diffText = scm.getPrDiff(prNumber);
    } catch (diffError) {
        console.warn('Could not fetch PR diff for inline comment filtering:', diffError.message || diffError);
    }

    if (diffText === null || diffText === '') {
        // Without a diff we cannot anchor inline comments safely. Drop them to avoid
        // the noisy "lines not shown in diff" fallback comments.
        console.warn('PR diff unavailable — dropping all inline comments to avoid out-of-diff noise');
        return [];
    }

    return inlineComments.filter(function(ic) {
        if (isInlineCommentInDiff(diffText, ic, prReviewComments)) return true;
        console.warn('Skipping inline comment not present in PR diff:', (ic.path || ic.file) + ':' + ic.line);
        return false;
    });
}

function postInlineComment(scm, prNumber, inlineComment, storyKey, readFile, prReviewComments) {
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

        var diffText = scm.getPrDiff(prNumber);
        var requestedSide = inlineComment.side || null;
        var effectivePath = filePath;
        var effectiveLine = inlineComment.line;
        var startLine = inlineComment.startLine || null;
        var lineInfo = prReviewComments.parseDiffLineInfo(diffText, effectivePath, effectiveLine);

        if (!lineInfo.present) {
            var submodulePath = prReviewComments.findSubmodulePathForFile(diffText, filePath);
            if (submodulePath) {
                effectivePath = submodulePath;
                effectiveLine = 1;
                startLine = null;
                lineInfo = prReviewComments.parseDiffLineInfo(diffText, effectivePath, effectiveLine);
                requestedSide = (lineInfo.side === 'LEFT' && prReviewComments.submoduleHasNewPointer(diffText, effectivePath))
                    ? 'RIGHT'
                    : (lineInfo.side || 'RIGHT');
                if (submodulePath !== filePath || inlineComment.line != 1) {
                    commentText = '📍 **`' + filePath + ':' + inlineComment.line + '`** (submodule content line)\n\n' + commentText;
                }
            }
        }

        // If the AI did not specify a side, infer it from the diff so deleted files get LEFT.
        if (!requestedSide) {
            if (lineInfo.present) {
                requestedSide = lineInfo.side;
            } else if (prReviewComments.isFileDeletedInDiff(diffText, effectivePath)) {
                requestedSide = 'LEFT';
            }
        }

        if (!lineInfo.present) {
            console.warn('Inline comment line is not present in PR diff; skipping ' + filePath + ':' + inlineComment.line);
            return false;
        }

        scm.addInlineComment(
            prNumber, effectivePath, effectiveLine, commentText,
            startLine, requestedSide
        );

        console.log('✅ Posted inline comment on ' + effectivePath + ':' + effectiveLine +
            (effectivePath !== filePath || effectiveLine !== inlineComment.line ?
                ' (mapped from ' + filePath + ':' + inlineComment.line + ')' : ''));
        return true;
    } catch (error) {
        console.warn('Inline comment failed for ' + filePath + ':' + inlineComment.line, error.message || error);
        return false;
    }
}

function postGeneralComment(scm, prNumber, generalComment, storyKey, workingDir, outputFiles) {
    try {
        var text = '';
        if (generalComment) {
            var detailed = outputFiles.readOutputFileDetailed(generalComment, {
                ticketKey: storyKey,
                workingDir: workingDir
            });
            if (detailed) {
                text = detailed.content || '';
            }
        }

        text = (text || '').trim();
        if (text) {
            scm.addComment(prNumber, text);
            console.log('✅ Posted general review comment to PR');
        }
    } catch (e) {
        console.warn('Failed to post general comment:', e);
    }
}

function resolveExistingAgentReviewThreads(scm, prNumber, repoInfo, fetchDiscussionsAndRawData) {
    if (!repoInfo || !repoInfo.owner || !repoInfo.repo || !prNumber) return;
    try {
        var discussions = fetchDiscussionsAndRawData(repoInfo.owner, repoInfo.repo, prNumber);
        if (!discussions || !discussions.rawThreads || !discussions.rawThreads.threads) return;

        var staleThreads = discussions.rawThreads.threads.filter(function(t) {
            return t.threadId && !t.resolved;
        });
        if (staleThreads.length === 0) return;

        console.log('Resolving ' + staleThreads.length + ' stale review thread(s) before posting new feedback...');
        staleThreads.forEach(function(t) {
            try {
                scm.resolveThread(prNumber, { threadId: t.threadId });
                console.log('✅ Resolved stale review thread', t.threadId);
            } catch (e) {
                console.warn('Failed to resolve stale review thread', t.threadId + ':', e.message || e);
            }
        });
    } catch (e) {
        console.warn('Could not resolve stale review threads:', e.message || e);
    }
}

function applyVerdictLabels(scm, prNumber, storyKey, isApproved, getTracker, LABELS) {
    if (isApproved) {
        try {
            scm.addLabel(prNumber, LABELS.PR_APPROVED);
            console.log('✅ Added pr_approved label to GitHub PR');
        } catch (e) {
            console.warn('Failed to add pr_approved to GitHub PR:', e);
        }
        try {
            getTracker().addLabel(storyKey, LABELS.PR_APPROVED);
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
            getTracker().addLabel(storyKey, LABELS.TEST_PR_REWORK_NEEDED);
            console.log('✅ Added test_pr_rework_needed label to Jira Story');
        } catch (e) {
            console.warn('Failed to add test_pr_rework_needed to Jira Story:', e);
        }
    }
}

function buildReworkFeedback(reviewData, readFile) {
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
    return feedback;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getPRNumber: getPRNumber,
        isInlineCommentInDiff: isInlineCommentInDiff,
        filterInlineCommentsByDiff: filterInlineCommentsByDiff,
        postInlineComment: postInlineComment,
        postGeneralComment: postGeneralComment,
        resolveExistingAgentReviewThreads: resolveExistingAgentReviewThreads,
        applyVerdictLabels: applyVerdictLabels,
        buildReworkFeedback: buildReworkFeedback
    };
}
