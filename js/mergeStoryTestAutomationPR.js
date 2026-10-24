/**
 * Merge Story/Bug Test Automation PR
 * Merges the PR on branch test/{TICKET_KEY} and moves all linked Test Cases
 * from In Review - Passed/Failed to Passed/Failed.
 */

const { LABELS } = require('./config.js');
var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;


/**
 * The first PR on `branchName` with the expected merged state, or undefined.
 * `expectMerged` mirrors the two original predicates: falsy → open PR
 * (`!pr.merged_at`), truthy → closed-and-merged PR (`pr.merged_at`).
 */
function findPrOnBranch(prList, branchName, expectMerged) {
    return (Array.isArray(prList) ? prList : []).find(function(pr) {
        return pr.head && pr.head.ref && pr.head.ref === branchName && !!pr.merged_at === expectMerged;
    });
}

function findPRForStory(scm, storyKey) {
    try {
        const branchName = 'test/' + storyKey;
        const openMatch = findPrOnBranch(scm.listPrs('open'), branchName, false);
        if (openMatch) return { pr: openMatch, merged: false };

        const mergedMatch = findPrOnBranch(scm.listPrs('closed'), branchName, true);
        if (mergedMatch) return { pr: mergedMatch, merged: true };

        return null;
    } catch (e) {
        console.error('Failed to list PRs:', e);
        return null;
    }
}

function releaseLock(storyKey, customParams) {
    const removeLabel = customParams && customParams.removeLabel;
    if (removeLabel && storyKey) {
        try { getTracker().removeLabel(storyKey, removeLabel); } catch (e) {}
    }
}

// ── gh-964: pure check-run classification (extracted from checkCiStatus) ──

/**
 * Normalizes the raw getCommitCheckRuns payload into a check-run array.
 * Accepts a bare array, a { check_runs: [...] } wrapper, or a JSON string
 * of either shape; anything else yields [].
 */
function normalizeCheckRuns(raw) {
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) {}
    }
    return Array.isArray(raw) ? raw
        : (raw && raw.check_runs ? raw.check_runs : []);
}

function isPendingCheckStatus(status) {
    return status === 'in_progress' || status === 'queued' ||
        status === 'pending' || status === 'waiting';
}

function isFailedCheckConclusion(conclusion) {
    return conclusion === 'failure' || conclusion === 'timed_out' ||
        conclusion === 'action_required';
}

/**
 * Pure classification of a check-run list: which checks are still running,
 * which failed (and their names), and how many there were in total.
 */
function classifyCheckRuns(checkRuns) {
    var result = { inProgress: false, failed: false, failedNames: [], total: checkRuns.length };
    checkRuns.forEach(function(c) {
        var status = (c.status || '').toLowerCase();
        var conclusion = (c.conclusion || '').toLowerCase();
        if (isPendingCheckStatus(status)) {
            result.inProgress = true;
        }
        if (isFailedCheckConclusion(conclusion)) {
            result.failed = true;
            if (c.name) result.failedNames.push(c.name);
        }
    });
    return result;
}

function checkCiStatus(scm, headSha) {
    var result = { inProgress: false, failed: false, failedNames: [], total: 0 };
    if (!scm || typeof scm.getCommitCheckRuns !== 'function' || !headSha) {
        return result;
    }
    try {
        var raw = scm.getCommitCheckRuns(headSha);
        result = classifyCheckRuns(normalizeCheckRuns(raw));
    } catch (e) {
        console.warn('Could not determine CI status:', e);
    }
    return result;
}

function fetchLinkedTestCases(storyKey, testCaseType) {
    // JQL text: provider-specific query (WIQL on ado)
    var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = "' + testCaseType + '"';
    try {
        // gh-916: in label mode the final-status gate also reads stage markers, so labels are requested;
        // 'none' mode sends the exact same fields list as before.
        var fields = ['key', 'status'];
        if (getTracker().stageFallback() === 'label') fields = fields.concat(['labels']);
        return getTracker().searchIssues(jql, { maxResults: 100, fields: fields }) || [];
    } catch (e) {
        console.warn('Failed to fetch linked Test Cases for merge:', e);
        return [];
    }
}

function resolveFinalStatus(tc, jiraConfig, tracker) {
    // gh-916: hasStage also accepts the stage_<key> marker a rejected In Review - Passed/Failed
    // transition left (jira.stageFallback 'label'); 'none' mode compares the status only.
    if (tracker.hasStage(tc, 'IN_REVIEW_PASSED', jiraConfig.statuses.IN_REVIEW_PASSED)) return jiraConfig.statuses.PASSED;
    if (tracker.hasStage(tc, 'IN_REVIEW_FAILED', jiraConfig.statuses.IN_REVIEW_FAILED)) return jiraConfig.statuses.FAILED;
    return null;
}

function moveLinkedTestCases(storyKey, testCaseType, jiraConfig) {
    var testCases = fetchLinkedTestCases(storyKey, testCaseType);
    var moved = 0;
    var skipped = 0;
    testCases.forEach(function(tc) {
        var finalStatus = resolveFinalStatus(tc, jiraConfig, getTracker());
        if (!finalStatus) {
            console.log('Skipping linked TC', tc.key, '— current status', tc.fields && tc.fields.status ? tc.fields.status.name : '');
            skipped++;
            return;
        }
        try {
            // gh-916: Passed/Failed can be tag-only (restricted ADO workflows) — stage-label fallback.
            var result = getTracker().moveToStatusOrMark(tc.key, finalStatus,
                finalStatus === jiraConfig.statuses.PASSED ? 'PASSED' : 'FAILED');
            if (result.moved || result.marked) {
                console.log('✅ Moved', tc.key, 'to', finalStatus);
                moved++;
            } else {
                skipped++;
            }
        } catch (e) {
            console.warn('Failed to move', tc.key, 'to', finalStatus, ':', e);
            skipped++;
        }
    });
    return { moved: moved, skipped: skipped, total: testCases.length };
}

function finalizeAlreadyMergedPR(params, scm, storyKey, pr, testCaseType, customParams, jiraConfig) {
    const prNumber = pr.number;
    const prUrl = pr.html_url;
    console.log('PR #' + prNumber + ' already merged for story ' + storyKey + ' — finalizing');

    var issueType = params.ticket && params.ticket.fields &&
        params.ticket.fields.issuetype && params.ticket.fields.issuetype.name;

    var tcResult = moveLinkedTestCases(storyKey, testCaseType, jiraConfig);

    // Bug stays In Testing; bug_done_check will move it to Done only when all
    // directly linked Test Cases are Passed. Moving it here allowed bugs to be
    // closed while their acceptance tests were still failing.

    try {
        getTracker().removeLabel(storyKey, LABELS.PR_APPROVED);
    } catch (e) {
        console.warn('Could not remove pr_approved label:', e);
    }
    try {
        getTracker().removeLabel(storyKey, LABELS.TEST_PR_MERGED);
    } catch (e) {
        console.warn('Could not remove test_pr_merged label:', e);
    }
    try {
        getTracker().addLabel(storyKey, LABELS.TEST_PR_FINALIZED);
        console.log('Added test_pr_finalized label to', storyKey);
    } catch (e) {
        console.warn('Could not add test_pr_finalized label:', e);
    }

    var ticketLabel = issueType || 'Story';
    getTracker().postComment(storyKey, 'h3. ✅ ' + ticketLabel + ' Test PR Already Merged\n\n' +
            'PR [#' + prNumber + '|' + prUrl + '] for branch {code}test/' + storyKey + '{code} was already merged.\n\n' +
            'Linked Test Cases moved to final status: *' + tcResult.moved + '* moved, *' + tcResult.skipped + '* skipped.');

    postTokenUsageCommentsSafe(params, storyKey);

    return true;
}

// ── gh-964: pure merge-decision helpers (extracted from attemptMerge) ──

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

// Mergeable states that mean "GitHub has not finished computing / CI gates the
// merge" — the CI check-run gate below decides between failed / running / retry.
var UNDETERMINED_MERGE_STATES = {
    unknown: true,
    blocked: true,
    unstable: true,
    checking: true,
    unchecked: true,
    preparing: true,
    ci_must_pass: true,
    ci_still_running: true
};

function isUndeterminedMergeState(mergeable, mergeableState) {
    return mergeable === null || !!UNDETERMINED_MERGE_STATES[mergeableState];
}

function isConflictMergeState(mergeable, mergeableState) {
    return (mergeable === false && mergeableState === 'dirty') ||
        mergeableState === 'cannot_be_merged' ||
        mergeableState === 'conflict';
}

/**
 * Pure decision over a classified CI status: 'ci_failed' when a check failed,
 * 'ci_running' while checks are pending or none are known at all, null when
 * every check has passed (callers map null to their own default action).
 */
function decideCiBlock(ci) {
    if (ci.failed) return 'ci_failed';
    if (ci.inProgress || ci.total === 0) return 'ci_running';
    return null;
}

/**
 * Pure classification of a merge error message: the message itself, whether it
 * denotes a conflict, and whether it looks like a CI-required/blocking failure
 * worth re-checking the check runs for.
 */
function classifyMergeError(mergeErr) {
    var errMsg = mergeErr ? String(mergeErr) : '';
    return {
        errMsg: errMsg,
        isConflict: errMsg.toLowerCase().indexOf('conflict') !== -1,
        isCIBlocking: errMsg.indexOf('blocked') !== -1 ||
            errMsg.indexOf('422') !== -1 ||
            errMsg.indexOf('405') !== -1
    };
}

/**
 * Reads PR merge details, tolerating provider errors (logged, details stay
 * null so the merge state is treated as undetermined downstream).
 */
function readPrMergeDetail(scm, prNumber) {
    var detail = { mergeable: null, mergeableState: null, headSha: null };
    try {
        const prDetail = scm.getPr(prNumber);
        detail.mergeable = prDetail && prDetail.mergeable;
        detail.mergeableState = prDetail && prDetail.mergeable_state;
        detail.headSha = prDetail && prDetail.head && prDetail.head.sha;
        console.log('PR mergeable: ' + detail.mergeable + ', state: ' + detail.mergeableState +
            ', headSha: ' + (detail.headSha ? detail.headSha.substring(0, 8) : 'n/a'));
    } catch (e) {
        console.warn('Could not get PR details, will attempt merge anyway:', e);
    }
    return detail;
}

/**
 * Best-effort base-branch update for a behind PR; failures are logged and
 * swallowed — the caller reports 'behind' either way so the SM retries.
 */
function requestBranchUpdate(scm, prNumber, repoInfo) {
    try {
        if (scm.updateBranch) {
            scm.updateBranch(prNumber, repoInfo.owner, repoInfo.repo);
        } else {
            throw new Error('SCM provider does not support updateBranch');
        }
    } catch (updateErr) {
        console.warn('Could not update branch:', updateErr);
    }
}

/**
 * Shared tail of both finalize paths: post the token-usage summary comments,
 * logging and swallowing provider errors.
 */
function postTokenUsageCommentsSafe(params, storyKey) {
    try {
        tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

/**
 * Everything that happens after a successful squash merge: label cleanup on
 * the PR and the ticket, the merge summary comment, token-usage comments, and
 * moving the linked Test Cases to their final status. Returns the merged
 * result object (with tcResult) for the caller.
 */
function finalizeMergedPR(params, scm, storyKey, prNumber, prUrl, testCaseType, jiraConfig, issueType) {
    console.log('✅ PR #' + prNumber + ' merged successfully');

    try { scm.removeLabel(prNumber, LABELS.PR_APPROVED); } catch (e) {}

    var tcResult = moveLinkedTestCases(storyKey, testCaseType, jiraConfig);

    try {
        getTracker().removeLabel(storyKey, LABELS.PR_APPROVED);
        console.log('Removed pr_approved label from Jira ticket');
    } catch (e) {
        console.warn('Could not remove pr_approved from Jira ticket:', e);
    }
    try {
        getTracker().removeLabel(storyKey, LABELS.TEST_PR_MERGED);
    } catch (e) {
        console.warn('Could not remove test_pr_merged label:', e);
    }
    try {
        getTracker().addLabel(storyKey, LABELS.TEST_PR_FINALIZED);
        console.log('Added test_pr_finalized label to', storyKey);
    } catch (e) {
        console.warn('Could not add test_pr_finalized label:', e);
    }

    var ticketLabel = issueType || 'Story';
    getTracker().postComment(storyKey, 'h3. ✅ ' + ticketLabel + ' Test PR Merged\n\n' +
            'PR [#' + prNumber + '|' + prUrl + '] for branch {code}test/' + storyKey + '{code} was merged.\n\n' +
            'Linked Test Cases moved to final status: *' + tcResult.moved + '* moved, *' + tcResult.skipped + '* skipped.');

    postTokenUsageCommentsSafe(params, storyKey);

    return { success: true, reason: 'merged', prNumber: prNumber, prUrl: prUrl, tcResult: tcResult };
}

/**
 * Attempts to merge/finalize the test-automation PR for the given ticket.
 * Does NOT move the ticket to a different status and does NOT release SM locks.
 *
 * Returns an object:
 *   { success: true, noPr: true }                              — no PR found, nothing to do
 *   { success: true, alreadyMerged: true, prNumber, prUrl }    — PR already merged, finalized
 *   { success: true, reason: 'merged', prNumber, prUrl, tcResult } — PR merged now
 *   { success: false, reason: 'missing_key'|'no_repo'|'no_pr'|     — could not proceed
 *                             'ci_running'|'not_ready'|'behind'|
 *                             'conflict'|'ci_failed'|'merge_failed',
 *     prNumber?, prUrl?, failedNames?, error? }
 */
function attemptMerge(params) {
    const storyKey = params.ticket && params.ticket.key;
    if (!storyKey) {
        console.error('No storyKey provided');
        return { success: false, reason: 'missing_key' };
    }

    var ctx = resolveMergeContext(params, storyKey);
    if (!ctx.repoInfo) {
        console.error('Could not determine owner/repo');
        return { success: false, reason: 'no_repo' };
    }

    const found = findPRForStory(ctx.scm, storyKey);
    if (!found) {
        console.log('No open or merged PR found for', storyKey, '— nothing to merge');
        return { success: true, noPr: true };
    }

    if (found.merged) {
        finalizeAlreadyMergedPR(params, ctx.scm, storyKey, found.pr, ctx.testCaseType, ctx.customParams, ctx.jiraConfig);
        return {
            success: true,
            alreadyMerged: true,
            prNumber: found.pr.number,
            prUrl: found.pr.html_url,
            reason: 'already_merged'
        };
    }

    const pr = found.pr;
    console.log('Found PR #' + pr.number + ' for story ' + storyKey);

    var prDetail = readPrMergeDetail(ctx.scm, pr.number);

    if (isUndeterminedMergeState(prDetail.mergeable, prDetail.mergeableState)) {
        return undeterminedMergeOutcome(ctx.scm, pr, prDetail);
    }

    var staticOutcome = staticMergeStateOutcome(ctx.scm, ctx.repoInfo, pr, prDetail);
    if (staticOutcome) return staticOutcome;

    return mergePrOrHandleFailure(params, ctx, pr, prDetail.headSha);
}

// ── gh-1186: merge-context and outcome helpers (extracted from attemptMerge/action) ──

// Issue type of the ticket, or undefined when any link of the chain is missing.
function issueTypeNameOf(params) {
    return params.ticket && params.ticket.fields &&
        params.ticket.fields.issuetype && params.ticket.fields.issuetype.name;
}

/**
 * One attemptMerge run's resolved collaborators, in the original order:
 * project config → jira section → SCM → custom params → tracker init, then
 * the derived testCaseType/issueType and the remote repo coordinates.
 */
function resolveMergeContext(params, storyKey) {
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = config.jira;
    var scm = scmModule.createScm(config);
    var customParams = resolveCustomParams(params);
    initTracker(config, customParams);
    var testCaseType = jiraConfig.issueTypes.TEST_CASE || 'Test Case';
    var issueType = issueTypeNameOf(params);
    return {
        storyKey: storyKey,
        config: config,
        jiraConfig: jiraConfig,
        scm: scm,
        customParams: customParams,
        testCaseType: testCaseType,
        issueType: issueType,
        repoInfo: scm.getRemoteRepoInfo()
    };
}

/**
 * Outcome of the "GitHub has not finished computing the mergeable state"
 * branch: the CI check-run gate decides between ci_failed / ci_running /
 * not_ready (all three are retryable).
 */
function undeterminedMergeOutcome(scm, pr, prDetail) {
    const ci = checkCiStatus(scm, prDetail.headSha);
    const block = decideCiBlock(ci);
    if (block === 'ci_failed') {
        console.log('PR #' + pr.number + ' CI checks failed');
        return { success: false, reason: 'ci_failed', prNumber: pr.number, prUrl: pr.html_url, failedNames: ci.failedNames };
    }
    if (block === 'ci_running') {
        console.log('PR not ready to merge (' + prDetail.mergeableState + ') — checks still running or unknown — will retry');
        return { success: false, reason: 'ci_running', prNumber: pr.number, prUrl: pr.html_url };
    }
    console.log('PR not ready to merge (' + prDetail.mergeableState + ') — will retry');
    return { success: false, reason: 'not_ready', prNumber: pr.number, prUrl: pr.html_url };
}

/**
 * Outcome of the two static (non-CI) blockers: a behind PR gets a best-effort
 * branch update and reports 'behind' so the SM retries; a conflicting PR
 * reports 'conflict'. Returns null when neither applies and the merge should
 * proceed.
 */
function staticMergeStateOutcome(scm, repoInfo, pr, prDetail) {
    if (prDetail.mergeableState === 'behind') {
        console.log('PR branch is behind base — requesting branch update');
        requestBranchUpdate(scm, pr.number, repoInfo);
        return { success: false, reason: 'behind', prNumber: pr.number, prUrl: pr.html_url };
    }
    if (isConflictMergeState(prDetail.mergeable, prDetail.mergeableState)) {
        console.log('PR #' + pr.number + ' has merge conflict');
        return { success: false, reason: 'conflict', prNumber: pr.number, prUrl: pr.html_url };
    }
    return null;
}

/**
 * Re-check decision after a failed merge: 'ci_failed' / 'ci_running' results
 * when the error looks CI-blocked and the check runs agree; null leaves the
 * decision to the caller (plain merge failure or conflict).
 */
function ciRetryOutcome(scm, headSha, errInfo, prNumber, prUrl) {
    if (errInfo.isConflict) return null;
    if (!(errInfo.isCIBlocking || errInfo.errMsg === '')) return null;
    const ci = checkCiStatus(scm, headSha);
    const block = decideCiBlock(ci);
    if (block === 'ci_failed') {
        return { success: false, reason: 'ci_failed', prNumber: prNumber, prUrl: prUrl, failedNames: ci.failedNames };
    }
    if (block === 'ci_running') {
        console.log('Merge blocked temporarily — checks still running or unknown — will retry');
        return { success: false, reason: 'ci_running', prNumber: prNumber, prUrl: prUrl };
    }
    return null;
}

/** Terminal merge-failure outcome: conflict vs plain merge_failed. */
function mergeFailureOutcome(errInfo, prNumber, prUrl) {
    return {
        success: false,
        reason: errInfo.isConflict ? 'conflict' : 'merge_failed',
        prNumber: prNumber,
        prUrl: prUrl,
        error: errInfo.errMsg
    };
}

/**
 * The merge itself plus its failure handling. Success finalizes the merged
 * PR; failure classifies the error, retries the CI gate when the error looks
 * CI-blocked, and otherwise reports conflict / merge_failed.
 */
function mergePrOrHandleFailure(params, ctx, pr, headSha) {
    try {
        ctx.scm.mergePr(pr.number, 'squash');
        return finalizeMergedPR(params, ctx.scm, ctx.storyKey, pr.number, pr.html_url, ctx.testCaseType, ctx.jiraConfig, ctx.issueType);
    } catch (mergeErr) {
        console.warn('Merge failed:', mergeErr);
        const errInfo = classifyMergeError(mergeErr);
        var retry = ciRetryOutcome(ctx.scm, headSha, errInfo, pr.number, pr.html_url);
        if (retry) return retry;
        return mergeFailureOutcome(errInfo, pr.number, pr.html_url);
    }
}

// ── gh-1186: action-level decision helpers (extracted from action) ──────────

// Retryable merge failures: the SM keeps the lock and retries next cycle.
function isRetryPendingReason(reason) {
    return reason === 'ci_running' || reason === 'behind' || reason === 'not_ready';
}

// Failures before any PR state was involved: nothing to rework, release the lock.
function isMissingPrerequisiteReason(reason) {
    return reason === 'missing_key' || reason === 'no_repo';
}

/** Best-effort PR label cleanup; missing PR numbers and provider errors are ignored. */
function removePrLabelSafe(scm, prNumber) {
    if (!prNumber) return;
    try { scm.removeLabel(prNumber, LABELS.PR_APPROVED); } catch (e) {}
}

// The rework skip label differs for bugs and stories.
function reworkSkipLabelOf(issueType, jiraConfig) {
    return issueType === jiraConfig.issueTypes.BUG ? 'sm_bug_test_rework_triggered' : 'sm_story_test_rework_triggered';
}

// Human-readable cause of the rework, naming the failed checks when known.
function reworkFailureReason(mergeResult) {
    var isConflict = mergeResult.reason === 'conflict';
    var reasonText = isConflict ? 'merge conflict' : 'CI checks failing or PR not mergeable';
    if (mergeResult.reason === 'ci_failed' && mergeResult.failedNames) {
        var checksList = mergeResult.failedNames && mergeResult.failedNames.length ? mergeResult.failedNames.join(', ') : 'unknown';
        return 'required checks failed: ' + checksList;
    }
    return reasonText;
}

// The rework panel comment posted to the ticket.
function reworkFailureComment(mergeResult) {
    var isConflict = mergeResult.reason === 'conflict';
    var panelTitle = isConflict ? 'MERGE CONFLICT' : 'MERGE FAILED';
    var prLink = mergeResult.prUrl ? '[View PR|' + mergeResult.prUrl + ']' : '';
    return '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *' + panelTitle + '* — Could not merge PR #' +
        (mergeResult.prNumber || 'unknown') + ': ' + reworkFailureReason(mergeResult) + '.\n' + prLink + '{panel}';
}

/**
 * The conflict / CI-failure / merge-failure tail of action(): PR and ticket
 * label cleanup, lock release, the rework panel comment and the ticket move
 * to In Rework.
 */
function triggerTestRework(params, customParams, scm, jiraConfig, mergeResult) {
    var storyKey = params.ticket && params.ticket.key;

    console.log('Test-automation PR merge failed (' + mergeResult.reason + ') — moving ticket to In Rework');

    removePrLabelSafe(scm, mergeResult.prNumber);
    try { getTracker().removeLabel(storyKey, LABELS.PR_APPROVED); } catch (e) {}
    try { getTracker().addLabel(storyKey, LABELS.TEST_PR_REWORK_NEEDED); } catch (e) {}
    try { getTracker().removeLabel(storyKey, reworkSkipLabelOf(issueTypeNameOf(params), jiraConfig)); } catch (e) {}

    releaseLock(storyKey, customParams);

    getTracker().postComment(storyKey, reworkFailureComment(mergeResult));
    getTracker().moveToStatus(storyKey, jiraConfig.statuses.IN_REWORK);
}

function action(params) {
    var customParams = resolveCustomParams(params);
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    initTracker(config, customParams);

    // Some callers (e.g. checkBugTestsPassed.js) only need the merge attempt
    // without the surrounding finalize/retry logic. The GraalJS loader may return
    // the action function as the module default, so we also support an explicit
    // flag instead of relying on attemptMerge being reachable as a named export.
    if (customParams.onlyAttemptMerge) {
        return attemptMerge(params);
    }

    const storyKey = params.ticket && params.ticket.key;
    if (!storyKey) {
        console.error('No storyKey provided');
        return false;
    }

    var issueType = issueTypeNameOf(params);
    var jiraConfig = config.jira;
    var scm = scmModule.createScm(config);

    const mergeResult = attemptMerge(params);

    if (mergeResult.success) {
        releaseLock(storyKey, customParams);
        return true;
    }

    if (isRetryPendingReason(mergeResult.reason)) {
        // Keep lock; SM will retry on the next cycle.
        return false;
    }

    if (isMissingPrerequisiteReason(mergeResult.reason)) {
        releaseLock(storyKey, customParams);
        return false;
    }

    // Conflict, CI failure, or other merge failure — move ticket to test-automation rework.
    triggerTestRework(params, customParams, scm, jiraConfig, mergeResult);
    return true;
}

// Expose attemptMerge on the action function as well, so callers that receive
// the action as the module default (common in the GraalJS/SM loader) can still
// invoke attemptMerge directly.
action.attemptMerge = attemptMerge;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        attemptMerge: attemptMerge,
        findPRForStory: findPRForStory,
        findPrOnBranch: findPrOnBranch,
        // gh-964: pure helpers extracted from checkCiStatus / attemptMerge —
        // exported for direct unit testing (additive surface, same signatures).
        normalizeCheckRuns: normalizeCheckRuns,
        classifyCheckRuns: classifyCheckRuns,
        isPendingCheckStatus: isPendingCheckStatus,
        isFailedCheckConclusion: isFailedCheckConclusion,
        decideCiBlock: decideCiBlock,
        classifyMergeError: classifyMergeError,
        isUndeterminedMergeState: isUndeterminedMergeState,
        isConflictMergeState: isConflictMergeState,
        resolveCustomParams: resolveCustomParams,
        // gh-1186: merge-outcome and action-decision helpers — additive surface.
        undeterminedMergeOutcome: undeterminedMergeOutcome,
        staticMergeStateOutcome: staticMergeStateOutcome,
        ciRetryOutcome: ciRetryOutcome,
        mergeFailureOutcome: mergeFailureOutcome,
        issueTypeNameOf: issueTypeNameOf,
        isRetryPendingReason: isRetryPendingReason,
        isMissingPrerequisiteReason: isMissingPrerequisiteReason,
        reworkSkipLabelOf: reworkSkipLabelOf,
        reworkFailureComment: reworkFailureComment,
        removePrLabelSafe: removePrLabelSafe
    };
}
