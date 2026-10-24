/**
 * Diff/comment helpers for js/postStoryTestAutomationReview.js.
 *
 * Extracted in the gh-1008 CRAP split so action() becomes a thin
 * orchestrator. Dependencies (readFile, prReviewComments, outputFiles,
 * getTracker, LABELS) are passed as arguments — this module stays free of
 * requires so suites can load it with an empty require map. Posted comment
 * strings stay byte-identical to the originals. Every function stays ≤ CC 8
 * so the per-function CRAP ratchet (new keys must be ≤ 8) holds.
 */

/** Pure: pull the PR number/URL/branch out of a pr_info.md payload. */
function parsePrInfoFields(prInfo) {
    const numMatch = prInfo.match(/\*\*PR #\*\*:\s*(\d+)/);
    const urlMatch = prInfo.match(/\*\*URL\*\*:\s*(https:\/\/[^\s]+)/);
    const branchMatch = prInfo.match(/\*\*Branch\*\*:\s*([^\s\n]+)/);
    return {
        prNumber: numMatch ? parseInt(numMatch[1], 10) : null,
        prUrl: urlMatch ? urlMatch[1] : null,
        prBranch: branchMatch ? branchMatch[1] : null
    };
}

/** Finds the open PR whose head branch matches, or null (never throws). */
function findOpenPrForBranch(scm, branchName) {
    try {
        const openPRs = scm.listPrs('open');
        const openMatch = (openPRs || []).filter(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName;
        });
        if (openMatch.length > 0) {
            return openMatch[0];
        }
        console.warn('No open PR found for branch', branchName);
    } catch (e) {
        console.warn('Failed to find test PR by branch:', e);
    }
    return null;
}

function getPRNumber(params, storyKey, scm, readFile) {
    let prNumber = null;
    let prUrl = null;
    let prBranch = null;

    try {
        const inputFolder = params.inputFolderPath || ('input/' + storyKey);
        const prInfo = readFile(inputFolder + '/pr_info.md');
        if (prInfo) {
            const parsed = parsePrInfoFields(prInfo);
            prNumber = parsed.prNumber;
            prUrl = parsed.prUrl;
            prBranch = parsed.prBranch;
        }
    } catch (e) {}

    if (!prNumber && scm) {
        const openPr = findOpenPrForBranch(scm, 'test/' + storyKey);
        if (openPr) {
            prNumber = openPr.number;
            prUrl = openPr.html_url;
            prBranch = openPr.head && openPr.head.ref;
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

function fetchPrDiff(scm, prNumber) {
    try {
        return scm.getPrDiff(prNumber);
    } catch (diffError) {
        console.warn('Could not fetch PR diff for inline comment filtering:', diffError.message || diffError);
        return null;
    }
}

function filterInlineCommentsByDiff(scm, prNumber, inlineComments, prReviewComments) {
    if (!inlineComments || inlineComments.length === 0) return [];

    var diffText = fetchPrDiff(scm, prNumber);

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

/**
 * Side inference for the SCM comment: an explicit AI-provided side wins;
 * otherwise the diff decides (deleted files get LEFT).
 */
function inferRequestedSide(diffText, effectivePath, lineInfo, inlineComment, prReviewComments) {
    if (inlineComment.side) return inlineComment.side;
    if (lineInfo.present) return lineInfo.side;
    if (prReviewComments.isFileDeletedInDiff(diffText, effectivePath)) return 'LEFT';
    return null;
}

/** Side for a submodule-pointer anchor: RIGHT when the pointer moved. */
function submoduleAnchorSide(diffText, effectivePath, lineInfo, prReviewComments) {
    if (lineInfo.side === 'LEFT' && prReviewComments.submoduleHasNewPointer(diffText, effectivePath)) {
        return 'RIGHT';
    }
    return lineInfo.side || 'RIGHT';
}

/**
 * Resolves where an inline comment can be anchored: the direct file/line, or
 * the submodule pointer change when the target lives inside a submodule.
 */
function resolveInlineAnchor(diffText, inlineComment, prReviewComments) {
    var filePath = inlineComment.path || inlineComment.file;
    var effectivePath = filePath;
    var effectiveLine = inlineComment.line;
    var startLine = inlineComment.startLine || null;
    var lineInfo = prReviewComments.parseDiffLineInfo(diffText, effectivePath, effectiveLine);
    var mappedFromSubmodule = false;

    if (!lineInfo.present) {
        var submodulePath = prReviewComments.findSubmodulePathForFile(diffText, filePath);
        if (submodulePath) {
            effectivePath = submodulePath;
            effectiveLine = 1;
            startLine = null;
            lineInfo = prReviewComments.parseDiffLineInfo(diffText, effectivePath, effectiveLine);
            mappedFromSubmodule = true;
        }
    }

    var requestedSide = mappedFromSubmodule
        ? submoduleAnchorSide(diffText, effectivePath, lineInfo, prReviewComments)
        : inferRequestedSide(diffText, effectivePath, lineInfo, inlineComment, prReviewComments);

    return {
        filePath: filePath,
        effectivePath: effectivePath,
        effectiveLine: effectiveLine,
        startLine: startLine,
        requestedSide: requestedSide,
        lineInfo: lineInfo,
        mappedFromSubmodule: mappedFromSubmodule
    };
}

/** Prefixes the original file/line location on a submodule-mapped comment. */
function filePathOf(inlineComment) {
    return inlineComment.path || inlineComment.file;
}

function prefixSubmoduleLocation(text, anchor, inlineComment) {
    if (!anchor.mappedFromSubmodule) return text;
    if (anchor.effectivePath === filePathOf(inlineComment) && inlineComment.line == 1) {
        return text;
    }
    return '📍 **`' + filePathOf(inlineComment) + ':' + inlineComment.line + '`** (submodule content line)\n\n' + text;
}

function logPostedInlineComment(anchor, filePath, inlineComment) {
    var mapped = anchor.effectivePath !== filePath || anchor.effectiveLine !== inlineComment.line;
    console.log('✅ Posted inline comment on ' + anchor.effectivePath + ':' + anchor.effectiveLine +
        (mapped ? ' (mapped from ' + filePath + ':' + inlineComment.line + ')' : ''));
}

/** Inline text of the comment: the body, or the referenced comment file. */
function resolveCommentText(inlineComment, readFile) {
    return inlineComment.body || readFile(inlineComment.comment);
}

function postInlineComment(scm, prNumber, inlineComment, storyKey, readFile, prReviewComments) {
    const filePath = filePathOf(inlineComment);
    const commentText = resolveCommentText(inlineComment, readFile);

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
        var anchor = resolveInlineAnchor(diffText, inlineComment, prReviewComments);
        var text = prefixSubmoduleLocation(commentText, anchor, inlineComment);

        if (!anchor.lineInfo.present) {
            console.warn('Inline comment line is not present in PR diff; skipping ' + filePath + ':' + inlineComment.line);
            return false;
        }

        scm.addInlineComment(
            prNumber, anchor.effectivePath, anchor.effectiveLine, text,
            anchor.startLine, anchor.requestedSide
        );

        logPostedInlineComment(anchor, filePath, inlineComment);
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

function resolveStaleReviewThreads(scm, prNumber, threads) {
    threads.forEach(function(t) {
        try {
            scm.resolveThread(prNumber, { threadId: t.threadId });
            console.log('✅ Resolved stale review thread', t.threadId);
        } catch (e) {
            console.warn('Failed to resolve stale review thread', t.threadId + ':', e.message || e);
        }
    });
}

function hasRepoContext(repoInfo, prNumber) {
    return !!(repoInfo && repoInfo.owner && repoInfo.repo && prNumber);
}

/** Unresolved threads carrying a threadId — the stale ones to resolve. */
function collectStaleThreads(discussions) {
    if (!discussions || !discussions.rawThreads || !discussions.rawThreads.threads) return [];
    return discussions.rawThreads.threads.filter(function(t) {
        return t.threadId && !t.resolved;
    });
}

function resolveExistingAgentReviewThreads(scm, prNumber, repoInfo, fetchDiscussionsAndRawData) {
    if (!hasRepoContext(repoInfo, prNumber)) return;
    try {
        var discussions = fetchDiscussionsAndRawData(repoInfo.owner, repoInfo.repo, prNumber);
        var staleThreads = collectStaleThreads(discussions);
        if (staleThreads.length === 0) return;

        console.log('Resolving ' + staleThreads.length + ' stale review thread(s) before posting new feedback...');
        resolveStaleReviewThreads(scm, prNumber, staleThreads);
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

/** Body of a feedback entry: the inline body, or the referenced comment file. */
function resolveEntryBody(ic, readFile) {
    var body = ic.body;
    if (!body && ic.comment) {
        try { body = readFile(ic.comment); } catch (e) {}
    }
    return (body || '').trim();
}

/** Numbered per-comment section of the rework feedback comment. */
function buildInlineFeedbackEntries(inlineComments, readFile) {
    var entries = '';
    inlineComments.forEach(function(ic, idx) {
        var body = resolveEntryBody(ic, readFile);
        if (!body) return;
        var path = ic.path || ic.file || '(file unknown)';
        var line = ic.line ? ':' + ic.line : '';
        entries += '#' + (idx + 1) + '. *' + path + line + '*\n';
        entries += '{code}' + body + '{code}\n\n';
    });
    return entries;
}

function appendGeneralFeedback(feedback, generalComment, readFile) {
    if (!generalComment) return feedback;
    var generalBody = readFile(generalComment);
    if (generalBody && generalBody.trim()) {
        feedback += 'h4. General comment\n\n{code}' + generalBody.trim() + '{code}\n';
    }
    return feedback;
}

function buildReworkFeedback(reviewData, readFile) {
    var feedback = 'h3. 📝 Test Automation Rework Feedback\n\n';
    feedback += 'The following review comments must be addressed before the test PR can be merged:\n\n';
    feedback += buildInlineFeedbackEntries(reviewData.inlineComments, readFile);
    return appendGeneralFeedback(feedback, reviewData.generalComment, readFile);
}

/**
 * gh-1246: jobParamPatch merge previously duplicated by every review
 * post-action: configLoader.resolveInstructions(contextId) customParams
 * first, then the runtime params' customParams win.
 */
function resolveCustomParams(configLoader, params, config, contextId) {
    var merged = {};
    var patch = configLoader.resolveInstructions(contextId, null, config).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(merged,
        (params.jobParams && params.jobParams.customParams) || params.customParams || {}
    );
    return merged;
}

/**
 * gh-1246: guard + log line shared by every inline-comment poster. Returns
 * false when the comment text or the file path is missing; logs the target
 * location otherwise.
 */
function validateInlineCommentTarget(filePath, line, commentText) {
    if (!commentText) {
        console.warn('No comment content found for inline comment on', filePath);
        return false;
    }
    if (!filePath) {
        console.warn('No file path found for inline comment');
        return false;
    }
    console.log('Posting inline comment on ' + filePath + ':' + line);
    return true;
}

/**
 * gh-1246: autoStartRework configured-workflow trigger (pr_test_automation_rework).
 * Returns the trigger result, or false when not configured or the trigger
 * threw (logged, never rethrown).
 */
function triggerConfiguredReworkWorkflow(autoStart, ticketKey, config, customParams) {
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
            stripKeys: ['removeLabel', 'autoStartRework', 'autoStartReworkConfigFile']
        });
    } catch (e) {
        console.warn('⚠️ autoStartRework trigger failed:', e.message || e);
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parsePrInfoFields: parsePrInfoFields,
        findOpenPrForBranch: findOpenPrForBranch,
        getPRNumber: getPRNumber,
        isInlineCommentInDiff: isInlineCommentInDiff,
        fetchPrDiff: fetchPrDiff,
        filterInlineCommentsByDiff: filterInlineCommentsByDiff,
        inferRequestedSide: inferRequestedSide,
        resolveInlineAnchor: resolveInlineAnchor,
        postInlineComment: postInlineComment,
        postGeneralComment: postGeneralComment,
        resolveStaleReviewThreads: resolveStaleReviewThreads,
        resolveExistingAgentReviewThreads: resolveExistingAgentReviewThreads,
        applyVerdictLabels: applyVerdictLabels,
        buildInlineFeedbackEntries: buildInlineFeedbackEntries,
        appendGeneralFeedback: appendGeneralFeedback,
        buildReworkFeedback: buildReworkFeedback,
        // gh-1246 dedup exports:
        resolveCustomParams: resolveCustomParams,
        validateInlineCommentTarget: validateInlineCommentTarget,
        triggerConfiguredReworkWorkflow: triggerConfiguredReworkWorkflow
    };
}
