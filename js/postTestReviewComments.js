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

const { LABELS } = require('./config.js');
const gh = require('./common/githubHelpers.js');
const autoStart = require('./common/autoStart.js');
const configLoader = require('./configLoader.js');
const outputFiles = require('./common/outputFiles.js');
const trackersModule = require('./common/trackers.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const reviewHelpers = require('./postStoryTestAutomationReviewHelpers.js');
const shared = require('./postStoryTestAutomationShared.js');

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

function getCurrentTicketStatus(ticketKey, tracker) {
    try {
        const ticket = tracker.getIssue(ticketKey);
        return ticket && ticket.fields && ticket.fields.status
            ? ticket.fields.status.name
            : null;
    } catch (e) {
        console.warn('Could not get current ticket status:', e);
        return null;
    }
}

// ── gh-1224: getPRNumber decomposed into small pure helpers ─────────────────

/**
 * PR number/URL parsed from the pr_info.md content. Both fields are
 * best-effort: a missing marker leaves the corresponding field null.
 */
function parsePrInfoMd(prInfoText) {
    var parsed = { prNumber: null, prUrl: null };
    if (!prInfoText) return parsed;
    var numMatch = prInfoText.match(/\*\*PR #\*\*:\s*(\d+)/);
    var urlMatch = prInfoText.match(/\*\*URL\*\*:\s*(https:\/\/[^\s]+)/);
    if (numMatch) parsed.prNumber = parseInt(numMatch[1], 10);
    if (urlMatch) parsed.prUrl = urlMatch[1];
    return parsed;
}

/**
 * Exact test/ branch match on open PRs only — never fuzzy-match (would find
 * ai/ feature PRs). The first matching PR wins.
 */
function prNumberFromOpenPrs(openPRs, ticketKey) {
    var branchName = 'test/' + ticketKey;
    var openMatch = (openPRs || []).filter(function(pr) {
        return pr.head && pr.head.ref && pr.head.ref === branchName;
    });
    if (openMatch.length > 0) {
        return { prNumber: openMatch[0].number, prUrl: openMatch[0].html_url };
    }
    return { prNumber: null, prUrl: null };
}

/** Open-PR branch search; a listing failure degrades to nulls with a warning. */
function prNumberFromBranchSearch(repoInfo, ticketKey) {
    var branchName = 'test/' + ticketKey;
    try {
        var openPRs = github_list_prs({ workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open' });
        var found = prNumberFromOpenPrs(openPRs, ticketKey);
        if (found.prNumber) return found;
        console.warn('No open PR found for branch', branchName);
    } catch (e) {
        console.warn('Failed to find test PR by branch:', e);
    }
    return { prNumber: null, prUrl: null };
}

function getPRNumber(params, ticketKey, repoInfo) {
    var prNumber = null;
    var prUrl = null;

    try {
        const inputFolder = params.inputFolderPath || ('input/' + ticketKey);
        const prInfo = readFile(inputFolder + '/pr_info.md');
        if (prInfo) {
            const parsed = parsePrInfoMd(prInfo);
            prNumber = parsed.prNumber;
            prUrl = parsed.prUrl;
        }
    } catch (e) {}

    if (!prNumber && repoInfo) {
        const found = prNumberFromBranchSearch(repoInfo, ticketKey);
        if (found.prNumber) {
            prNumber = found.prNumber;
            prUrl = found.prUrl;
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
            // pullRequestID — the diff-tool schema casing (both github diff
            // tools declare pullRequestID, unlike the other github_* PR
            // tools that take pullRequestId). Wrong casing makes this call
            // fail every time and the catch below silently skips inline
            // comment validation.
            pullRequestID: String(prNumber)
        }) || '';
    } catch (e) {
        console.warn('Could not fetch PR diff for inline comment validation:', e.message || e);
        return null;
    }
}

// ── gh-1192: isLinePresentInDiff decomposed into small pure helpers ─────────
// The scanner keeps the exact original semantics: only the NEW side of the
// target file is scanned, `-` lines and the no-newline marker never advance
// the counter, and empty/invalid inputs are permissive (true — the line
// cannot be validated, so the comment is allowed).

function newInlineScanState() {
    return { currentFile: null, newLine: null };
}

/** Header bookeeping: 'diff --git ' resets the scan, '+++ b/' switches file. */
function trackInlineHeaderLine(st, line) {
    if (line.indexOf('diff --git ') === 0) {
        st.currentFile = null;
        st.newLine = null;
        return true;
    }
    if (line.indexOf('+++ b/') === 0) {
        st.currentFile = line.substring('+++ b/'.length);
        return true;
    }
    return false;
}

/** The new-side start line of a hunk header, or null when the line is not one. */
function inlineHunkStartOf(line) {
    var hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    return hunk ? parseInt(hunk[1], 10) : null;
}

/** Content line inside the target file segment: does it land on lineNumber? */
function inlineContentLineMatches(st, line, lineNumber) {
    if (line.indexOf('+') === 0 || line.indexOf(' ') === 0) {
        if (st.newLine === lineNumber) return true;
        st.newLine++;
        return false;
    }
    if (line.indexOf('-') === 0) return false;
    if (line === '\\ No newline at end of file') return false;
    st.newLine++;
    return false;
}

function scanInlineLinePresence(lines, filePath, lineNumber) {
    var st = newInlineScanState();
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (trackInlineHeaderLine(st, line)) continue;
        if (st.currentFile !== filePath) continue;
        var hunkStart = inlineHunkStartOf(line);
        if (hunkStart !== null) {
            st.newLine = hunkStart;
            continue;
        }
        if (st.newLine === null) continue;
        if (inlineContentLineMatches(st, line, lineNumber)) return true;
    }
    return false;
}

function isLinePresentInDiff(diffText, filePath, targetLine) {
    if (!diffText || !filePath || !targetLine) return true;

    var lineNumber = parseInt(targetLine, 10);
    if (!lineNumber) return true;

    return scanInlineLinePresence(String(diffText).split(/\r?\n/), filePath, lineNumber);
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

// ── gh-1224: postInlineComment decomposed into small pure helpers ───────────

/** Target file of an inline comment: the JSON `path` field, else the legacy `file`. */
function inlineCommentTargetOf(inlineComment) {
    return inlineComment.path || inlineComment.file;
}

/** Comment text: the inline `body`, else the content of the referenced `comment` file. */
function inlineCommentTextOf(inlineComment, readFileFn) {
    return inlineComment.body || readFileFn(inlineComment.comment);
}

/** The github_add_inline_comment payload; optional range/side fields when set. */
function buildInlineCommentParams(repoInfo, prNumber, filePath, inlineComment, commentText) {
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
    return params;
}

/** Whether the diff check forces the PR-comment fallback (null diff = unknown). */
function lineMissingFromDiff(diffText, filePath, line) {
    return diffText !== null && !isLinePresentInDiff(diffText, filePath, line);
}

function postInlineComment(repoInfo, prNumber, inlineComment) {
    const filePath = inlineCommentTargetOf(inlineComment);
    const commentText = inlineCommentTextOf(inlineComment, readFile);

    try {
        if (!commentText) {
            console.warn('No comment content found for inline comment on', filePath);
            return false;
        }
        if (!filePath) {
            console.warn('No file path found for inline comment');
            return false;
        }

        var diffText = getPrDiff(repoInfo, prNumber);
        if (lineMissingFromDiff(diffText, filePath, inlineComment.line)) {
            console.warn('Inline comment line is not present in PR diff; falling back to PR comment on ' + filePath + ':' + inlineComment.line);
            postFallbackInlineComment(repoInfo, prNumber, filePath, inlineComment.line, commentText);
            return true;
        }

        github_add_inline_comment(buildInlineCommentParams(repoInfo, prNumber, filePath, inlineComment, commentText));
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
    // Canonical trigger in postStoryTestAutomationShared.js (gh-1246).
    return shared.triggerAutoStartReworkWorkflow(autoStart, ticketKey, config, customParams);
}

function markForSmTestRework(ticketKey, tracker) {
    try {
        tracker.addLabel(ticketKey, 'sm_test_rework_triggered');
        console.log('✅ Added SM rework label: sm_test_rework_triggered');
        return true;
    } catch (e) {
        console.warn('⚠️ Failed to add SM rework label:', e.message || e);
        return false;
    }
}

function resolveCustomParams(params, config) {
    // Canonical merge in postStoryTestAutomationReviewHelpers.js (gh-1246).
    return reviewHelpers.resolveCustomParams(configLoader, params, config, 'pr_test_automation_review');
}

// Normalize recommendation: LLM may return "PASS"/"PASED" or "APPROVED" instead of "APPROVE",
// and "FAIL"/"FAILED" instead of "BLOCK".
function normalizeRecommendation(rec) {
    const value = String(rec || '').toUpperCase().trim();
    if (value === 'PASS' || value === 'PASSED' || value === 'APPROVED') return 'APPROVE';
    if (value === 'FAIL' || value === 'FAILED' || value === 'REJECT') return 'BLOCK';
    return rec;
}

// review JSON unreadable/missing: tell the tracker the SM trigger label was
// removed (so SM can retry), best-effort remove the trigger + WIP labels and
// fail the step.
function handleMissingReview(tracker, ticketKey, customParams, params) {
    tracker.postComment(ticketKey, 'h3. ⚠️ Review Error\n\nCould not read pr_review.json. Removed SM trigger label so SM can retry.');
    try {
        const smTriggerLabel = customParams.removeLabel || 'sm_test_review_triggered';
        tracker.removeLabel(ticketKey, smTriggerLabel);
        console.log('✅ Removed SM trigger label after missing review:', smTriggerLabel);
    } catch (e) {
        console.warn('Failed to remove SM trigger label after missing review:', e);
    }
    try {
        const wipLabelMissingReview = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'pr_test_automation_review_wip';
        tracker.removeLabel(ticketKey, wipLabelMissingReview);
    } catch (e) {
        console.warn('Failed to remove WIP label after missing review:', e);
    }
    return { success: false, error: 'No review data found' };
}

// Step 4a: the general review comment (best-effort — a missing/unreadable
// comment file must not fail the step).
function postGeneralReviewComment(repoInfo, prNumber, reviewData) {
    if (!reviewData.generalComment) return;
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

// Step 4b: queue for merge via pr_approved label (same pattern as stories/bugs).
// Returns the mergeSucceeded signal (true only when the PR was actually queued).
function queueApprovedPrForMerge(repoInfo, prNumber, tracker, ticketKey) {
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
        tracker.addLabel(ticketKey, LABELS.PR_APPROVED);
        console.log('✅ Added pr_approved label to Jira ticket');
    } catch (e) {
        console.warn('Failed to add pr_approved to Jira ticket:', e);
    }
    console.log('✅ PR #' + prNumber + ' queued for merge via pr_approved');
    return true;
}

// Step 4: general comment, inline comments, resolved-thread cleanup and the
// pr_approved queueing. Returns the mergeSucceeded signal (true only when an
// approved PR was actually queued for merge).
function postReviewComments(repoInfo, prNumber, reviewData, tracker, ticketKey, isApproved) {
    if (prNumber && repoInfo) {
        postGeneralReviewComment(repoInfo, prNumber, reviewData);

        // Inline comments
        if (reviewData.inlineComments && reviewData.inlineComments.length > 0) {
            reviewData.inlineComments.forEach(function(ic) {
                postInlineComment(repoInfo, prNumber, ic);
            });
        }

        // Resolve threads that were fully fixed in this rework
        resolveApprovedThreads(repoInfo, prNumber, reviewData.resolvedThreadIds);

        if (isApproved) {
            return queueApprovedPrForMerge(repoInfo, prNumber, tracker, ticketKey);
        }
        return false;
    }
    console.warn('No PR info — skipping GitHub comments');
    return false;
}

// Step 6: on approval the ticket stays in In Review - Passed/Failed until SM
// merges the PR via the pr_approved flow; on changes-requested it moves to
// In Rework and triggers the rework continuation.
function moveTicketAfterReview(ticketKey, isApproved, tracker, jiraConfig, currentStatus, config, customParams) {
    if (isApproved) {
        // Ticket stays in In Review - Passed/Failed until SM merges the PR via pr_approved flow
        console.log('✅ Ticket stays in', currentStatus, '— SM will merge and move to final status');
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
    } else {
        try {
            tracker.moveToStatus(ticketKey, jiraConfig.statuses.IN_REWORK);
            console.log('✅ Changes requested — moved', ticketKey, 'to In Rework');
            if (!triggerReworkIfConfigured(ticketKey, config, customParams)) {
                markForSmTestRework(ticketKey, tracker);
                autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
            }
        } catch (e) {
            console.warn('Failed to move to In Rework:', e);
        }
    }
}

// Step 7: reviewed label + WIP/trigger label cleanup (every call is
// best-effort — a failing label op must not fail the step).
function finalizeReviewLabels(tracker, ticketKey, params) {
    try {
        tracker.addLabel(ticketKey, LABELS.AI_PR_REVIEWED);
    } catch (e) {}

    const wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : 'pr_test_automation_review_wip';
    try {
        tracker.removeLabel(ticketKey, wipLabel);
    } catch (e) {}

    try {
        tracker.removeLabel(ticketKey, 'sm_test_review_triggered');
        console.log('✅ Removed SM label: sm_test_review_triggered');
    } catch (e) {}
}

// Terminal status for the result payload (the ticket itself is moved by SM).
function decideFinalStatus(isApproved, mergeSucceeded, currentStatus, statuses) {
    if (isApproved && !mergeSucceeded) {
        return statuses.IN_REWORK;
    }
    if (isApproved) {
        return (currentStatus === statuses.IN_REVIEW_PASSED) ? statuses.PASSED : statuses.FAILED;
    }
    return statuses.IN_REWORK;
}

// Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
// wrote outputs/*_usage.json during the agent run.
function postTokenUsageSummary(ticketKey, params) {
    // Canonical guarded wrapper in common/tokenUsageComment.js (gh-1246).
    tokenUsageComment.postUsageSummariesSafely(ticketKey, params);
}

// Outer-catch cleanup: recreate the tracker when the failure happened before
// it was built, best-effort remove the SM trigger label, post the error
// comment and fail the step.
function failureCustomParamsOf(params) {
    return (params && params.customParams) ||
        (params && params.jobParams && params.jobParams.customParams) ||
        {};
}

function postFailureErrorComment(tracker, ticketKey, error) {
    try {
        tracker.removeLabel(ticketKey, 'sm_test_review_triggered');
    } catch (e) {}
    try {
        tracker.postComment(ticketKey, 'h3. ❌ Test Review Error\n\n{code}' + error.toString() + '{code}');
    } catch (e) {}
}

function loadFailureConfig(params) {
    try { return configLoader.loadProjectConfig(params); } catch (e) { return null; }
}

function resolveFailureTicketKey(params) {
    if (params.ticket) return params.ticket.key;
    return params.inputFolderPath ? params.inputFolderPath.split('/').pop() : null;
}

function handleActionFailure(params, error, tracker) {
    console.error('❌ Error in postTestReviewComments:', error);
    if (!tracker) tracker = trackersModule.createTracker(loadFailureConfig(params), failureCustomParamsOf(params));
    try {
        const ticketKey = resolveFailureTicketKey(params);
        if (ticketKey) {
            postFailureErrorComment(tracker, ticketKey, error);
        }
    } catch (e) {}
    return { success: false, error: error.toString() };
}

function action(params) {
    var tracker = null;
    try {
        const ticketKey = params.ticket.key;
        const jiraComment = params.response || '';
        const config = configLoader.loadProjectConfig(params.jobParams || params);
        const jiraConfig = config.jira;
        const customParams = resolveCustomParams(params, config);
        const workingDir = config.workingDir || null;
        tracker = trackersModule.createTracker(config, customParams);

        console.log('=== Processing test automation review for', ticketKey, '===');

        // Step 1: Read review data
        const reviewData = readReviewJson(ticketKey, workingDir);
        if (!reviewData) {
            return handleMissingReview(tracker, ticketKey, customParams, params);
        }

        reviewData.recommendation = normalizeRecommendation(reviewData.recommendation);
        const isApproved = reviewData.recommendation === 'APPROVE';
        console.log('Review recommendation:', reviewData.recommendation);

        // Step 2: Get current ticket status (to determine Passed vs Failed on approval)
        const currentStatus = getCurrentTicketStatus(ticketKey, tracker);
        console.log('Current ticket status:', currentStatus);

        // Step 3: Get repo info + PR number
        const repoInfo = gh.getGitHubRepoInfo();
        const { prNumber, prUrl } = getPRNumber(params, ticketKey, repoInfo);

        // Step 4: Post GitHub comments
        var mergeSucceeded = postReviewComments(repoInfo, prNumber, reviewData, tracker, ticketKey, isApproved);

        // Step 5: Post Jira comment
        try {
            if (jiraComment) {
                tracker.postComment(ticketKey, jiraComment);
                console.log('✅ Posted review comment to Jira');
            }
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 6: Move ticket status
        moveTicketAfterReview(ticketKey, isApproved, tracker, jiraConfig, currentStatus, config, customParams);

        // Step 7: Add label + remove WIP
        finalizeReviewLabels(tracker, ticketKey, params);

        var finalStatus = decideFinalStatus(isApproved, mergeSucceeded, currentStatus, jiraConfig.statuses);
        console.log('✅ Test review workflow complete:', isApproved ? (mergeSucceeded ? 'APPROVED' : 'MERGE CONFLICT') : 'CHANGES REQUESTED');

        postTokenUsageSummary(ticketKey, params);

        return {
            success: true,
            recommendation: reviewData.recommendation,
            ticketKey: ticketKey,
            mergeSucceeded: mergeSucceeded,
            finalStatus: finalStatus
        };

    } catch (error) {
        return handleActionFailure(params, error, tracker);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        isLinePresentInDiff: isLinePresentInDiff,
        // gh-1192: pure scanner helpers (test surface)
        newInlineScanState: newInlineScanState,
        trackInlineHeaderLine: trackInlineHeaderLine,
        inlineHunkStartOf: inlineHunkStartOf,
        inlineContentLineMatches: inlineContentLineMatches,
        scanInlineLinePresence: scanInlineLinePresence,
        // gh-1224: getPRNumber / postInlineComment pure helpers (test surface)
        parsePrInfoMd: parsePrInfoMd,
        prNumberFromOpenPrs: prNumberFromOpenPrs,
        prNumberFromBranchSearch: prNumberFromBranchSearch,
        inlineCommentTargetOf: inlineCommentTargetOf,
        inlineCommentTextOf: inlineCommentTextOf,
        buildInlineCommentParams: buildInlineCommentParams,
        lineMissingFromDiff: lineMissingFromDiff
    };
}
