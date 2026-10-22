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
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}


function findPRForStory(scm, storyKey) {
    try {
        const branchName = 'test/' + storyKey;
        const openList = scm.listPrs('open');
        const openMatch = (Array.isArray(openList) ? openList : []).find(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName && !pr.merged_at;
        });
        if (openMatch) return { pr: openMatch, merged: false };

        const closedList = scm.listPrs('closed');
        const mergedMatch = (Array.isArray(closedList) ? closedList : []).find(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName && pr.merged_at;
        });
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

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = config.jira;
    var scm = scmModule.createScm(config);
    var customParams = resolveCustomParams(params);
    initTracker(config, customParams);
    var testCaseType = jiraConfig.issueTypes.TEST_CASE || 'Test Case';
    var issueType = params.ticket && params.ticket.fields &&
        params.ticket.fields.issuetype && params.ticket.fields.issuetype.name;

    const repoInfo = scm.getRemoteRepoInfo();
    if (!repoInfo) {
        console.error('Could not determine owner/repo');
        return { success: false, reason: 'no_repo' };
    }

    const found = findPRForStory(scm, storyKey);
    if (!found) {
        console.log('No open or merged PR found for', storyKey, '— nothing to merge');
        return { success: true, noPr: true };
    }

    if (found.merged) {
        finalizeAlreadyMergedPR(params, scm, storyKey, found.pr, testCaseType, customParams, jiraConfig);
        return {
            success: true,
            alreadyMerged: true,
            prNumber: found.pr.number,
            prUrl: found.pr.html_url,
            reason: 'already_merged'
        };
    }

    const pr = found.pr;
    const prNumber = pr.number;
    const prUrl = pr.html_url;
    console.log('Found PR #' + prNumber + ' for story ' + storyKey);

    var prDetail = readPrMergeDetail(scm, prNumber);
    var mergeable = prDetail.mergeable;
    var mergeableState = prDetail.mergeableState;
    var headSha = prDetail.headSha;

    if (isUndeterminedMergeState(mergeable, mergeableState)) {
        const ci = checkCiStatus(scm, headSha);
        const block = decideCiBlock(ci);
        if (block === 'ci_failed') {
            console.log('PR #' + prNumber + ' CI checks failed');
            return { success: false, reason: 'ci_failed', prNumber, prUrl, failedNames: ci.failedNames };
        }
        if (block === 'ci_running') {
            console.log('PR not ready to merge (' + mergeableState + ') — checks still running or unknown — will retry');
            return { success: false, reason: 'ci_running', prNumber, prUrl };
        }
        console.log('PR not ready to merge (' + mergeableState + ') — will retry');
        return { success: false, reason: 'not_ready', prNumber, prUrl };
    }

    if (mergeableState === 'behind') {
        console.log('PR branch is behind base — requesting branch update');
        requestBranchUpdate(scm, prNumber, repoInfo);
        return { success: false, reason: 'behind', prNumber, prUrl };
    }

    if (isConflictMergeState(mergeable, mergeableState)) {
        console.log('PR #' + prNumber + ' has merge conflict');
        return { success: false, reason: 'conflict', prNumber, prUrl };
    }

    try {
        scm.mergePr(prNumber, 'squash');
        return finalizeMergedPR(params, scm, storyKey, prNumber, prUrl, testCaseType, jiraConfig, issueType);
    } catch (mergeErr) {
        console.warn('Merge failed:', mergeErr);
        const errInfo = classifyMergeError(mergeErr);

        if (!errInfo.isConflict && (errInfo.isCIBlocking || errInfo.errMsg === '')) {
            const ci = checkCiStatus(scm, headSha);
            const block = decideCiBlock(ci);
            if (block === 'ci_failed') {
                return { success: false, reason: 'ci_failed', prNumber, prUrl, failedNames: ci.failedNames };
            }
            if (block === 'ci_running') {
                console.log('Merge blocked temporarily — checks still running or unknown — will retry');
                return { success: false, reason: 'ci_running', prNumber, prUrl };
            }
        }

        return { success: false, reason: errInfo.isConflict ? 'conflict' : 'merge_failed', prNumber, prUrl, error: errInfo.errMsg };
    }
}

function action(params) {
    const storyKey = params.ticket && params.ticket.key;
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

    if (!storyKey) {
        console.error('No storyKey provided');
        return false;
    }

    var issueType = params.ticket && params.ticket.fields &&
        params.ticket.fields.issuetype && params.ticket.fields.issuetype.name;

    var jiraConfig = config.jira;
    var scm = scmModule.createScm(config);

    const mergeResult = attemptMerge(params);

    if (mergeResult.success) {
        releaseLock(storyKey, customParams);
        return true;
    }

    const prNumber = mergeResult.prNumber;
    const prUrl = mergeResult.prUrl;

    if (mergeResult.reason === 'ci_running' || mergeResult.reason === 'behind' || mergeResult.reason === 'not_ready') {
        // Keep lock; SM will retry on the next cycle.
        return false;
    }

    if (mergeResult.reason === 'missing_key' || mergeResult.reason === 'no_repo') {
        releaseLock(storyKey, customParams);
        return false;
    }

    // Conflict, CI failure, or other merge failure — move ticket to test-automation rework.
    console.log('Test-automation PR merge failed (' + mergeResult.reason + ') — moving ticket to In Rework');

    if (prNumber) {
        try { scm.removeLabel(prNumber, LABELS.PR_APPROVED); } catch (e) {}
    }
    try { getTracker().removeLabel(storyKey, LABELS.PR_APPROVED); } catch (e) {}
    try { getTracker().addLabel(storyKey, LABELS.TEST_PR_REWORK_NEEDED); } catch (e) {}
    var reworkSkipLabel = issueType === jiraConfig.issueTypes.BUG ? 'sm_bug_test_rework_triggered' : 'sm_story_test_rework_triggered';
    try { getTracker().removeLabel(storyKey, reworkSkipLabel); } catch (e) {}

    releaseLock(storyKey, customParams);

    var checksList = mergeResult.failedNames && mergeResult.failedNames.length ? mergeResult.failedNames.join(', ') : 'unknown';
    var isConflict = mergeResult.reason === 'conflict';
    var panelTitle = isConflict ? 'MERGE CONFLICT' : 'MERGE FAILED';
    var reasonText = isConflict ? 'merge conflict' : 'CI checks failing or PR not mergeable';
    if (mergeResult.reason === 'ci_failed' && mergeResult.failedNames) {
        reasonText = 'required checks failed: ' + checksList;
    }
    getTracker().postComment(storyKey, '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *' + panelTitle + '* — Could not merge PR #' + (prNumber || 'unknown') + ': ' + reasonText + '.\n\n' + (prUrl ? '[View PR|' + prUrl + ']' : '') + '{panel}');
    getTracker().moveToStatus(storyKey, jiraConfig.statuses.IN_REWORK);
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
        resolveCustomParams: resolveCustomParams
    };
}
