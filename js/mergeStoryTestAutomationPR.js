/**
 * Merge Story/Bug Test Automation PR
 * Merges the PR on branch test/{TICKET_KEY} and moves all linked Test Cases
 * from In Review - Passed/Failed to Passed/Failed.
 */

const { LABELS } = require('./config.js');
var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackerHelper = require('./common/tracker.js');

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
        try { trackerHelper.removeLabel(storyKey, removeLabel); } catch (e) {}
    }
}

function checkCiStatus(scm, headSha) {
    var result = { inProgress: false, failed: false, failedNames: [], total: 0 };
    if (!scm || typeof scm.getCommitCheckRuns !== 'function' || !headSha) {
        return result;
    }
    try {
        var raw = scm.getCommitCheckRuns(headSha);
        if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch (e) {}
        }
        var checkRuns = Array.isArray(raw) ? raw
            : (raw && raw.check_runs ? raw.check_runs : []);
        result.total = checkRuns.length;
        checkRuns.forEach(function(c) {
            var status = (c.status || '').toLowerCase();
            var conclusion = (c.conclusion || '').toLowerCase();
            if (status === 'in_progress' || status === 'queued' || status === 'pending' || status === 'waiting') {
                result.inProgress = true;
            }
            if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') {
                result.failed = true;
                if (c.name) result.failedNames.push(c.name);
            }
        });
    } catch (e) {
        console.warn('Could not determine CI status:', e);
    }
    return result;
}

function fetchLinkedTestCases(storyKey, testCaseType) {
    var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = "' + testCaseType + '"';
    try {
        return tracker_search({ jql: jql, maxResults: 100, fields: ['key', 'status'] }) || [];
    } catch (e) {
        console.warn('Failed to fetch linked Test Cases for merge:', e);
        return [];
    }
}

function resolveFinalStatus(currentStatus, trackerConfig) {
    if (currentStatus === trackerConfig.statuses.IN_REVIEW_PASSED) return trackerConfig.statuses.PASSED;
    if (currentStatus === trackerConfig.statuses.IN_REVIEW_FAILED) return trackerConfig.statuses.FAILED;
    return null;
}

function moveLinkedTestCases(storyKey, testCaseType, trackerConfig) {
    var testCases = fetchLinkedTestCases(storyKey, testCaseType);
    var moved = 0;
    var skipped = 0;
    testCases.forEach(function(tc) {
        var currentStatus = tc.fields && tc.fields.status ? tc.fields.status.name : '';
        var finalStatus = resolveFinalStatus(currentStatus, trackerConfig);
        if (!finalStatus) {
            console.log('Skipping linked TC', tc.key, '— current status', currentStatus);
            skipped++;
            return;
        }
        try {
            tracker_move_to_status({ key: tc.key, statusName: finalStatus });
            console.log('✅ Moved', tc.key, 'to', finalStatus);
            moved++;
        } catch (e) {
            console.warn('Failed to move', tc.key, 'to', finalStatus, ':', e);
            skipped++;
        }
    });
    return { moved: moved, skipped: skipped, total: testCases.length };
}

function finalizeAlreadyMergedPR(params, scm, storyKey, pr, testCaseType, customParams, trackerConfig) {
    const prNumber = pr.number;
    const prUrl = pr.html_url;
    console.log('PR #' + prNumber + ' already merged for story ' + storyKey + ' — finalizing');

    var issueType = params.ticket && params.ticket.fields &&
        params.ticket.fields.issuetype && params.ticket.fields.issuetype.name;

    var tcResult = moveLinkedTestCases(storyKey, testCaseType, trackerConfig);

    // Bug stays In Testing; bug_done_check will move it to Done only when all
    // directly linked Test Cases are Passed. Moving it here allowed bugs to be
    // closed while their acceptance tests were still failing.

    try {
        trackerHelper.removeLabel(storyKey, LABELS.PR_APPROVED);
    } catch (e) {
        console.warn('Could not remove pr_approved label:', e);
    }
    try {
        trackerHelper.removeLabel(storyKey, LABELS.TEST_PR_MERGED);
    } catch (e) {
        console.warn('Could not remove test_pr_merged label:', e);
    }
    try {
        trackerHelper.addLabel(storyKey, LABELS.TEST_PR_FINALIZED);
        console.log('Added test_pr_finalized label to', storyKey);
    } catch (e) {
        console.warn('Could not add test_pr_finalized label:', e);
    }

    var ticketLabel = issueType || 'Story';
    tracker_post_comment({
        key: storyKey,
        comment: 'h3. ✅ ' + ticketLabel + ' Test PR Already Merged\n\n' +
            'PR [#' + prNumber + '|' + prUrl + '] for branch {code}test/' + storyKey + '{code} was already merged.\n\n' +
            'Linked Test Cases moved to final status: *' + tcResult.moved + '* moved, *' + tcResult.skipped + '* skipped.'
    });

    try {
        tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }

    return true;
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
    var trackerConfig = config.tracker;
    var scm = scmModule.createScm(config);
    var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
    var testCaseType = trackerConfig.issueTypes.TEST_CASE || 'Test Case';
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
        finalizeAlreadyMergedPR(params, scm, storyKey, found.pr, testCaseType, customParams, trackerConfig);
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

    let mergeableState = null;
    let mergeable = null;
    let headSha = null;
    try {
        const prDetail = scm.getPr(prNumber);
        mergeable = prDetail && prDetail.mergeable;
        mergeableState = prDetail && prDetail.mergeable_state;
        headSha = prDetail && prDetail.head && prDetail.head.sha;
        console.log('PR mergeable: ' + mergeable + ', state: ' + mergeableState + ', headSha: ' + (headSha ? headSha.substring(0, 8) : 'n/a'));
    } catch (e) {
        console.warn('Could not get PR details, will attempt merge anyway:', e);
    }

    if (mergeable === null ||
        mergeableState === 'unknown' ||
        mergeableState === 'blocked' ||
        mergeableState === 'unstable' ||
        mergeableState === 'checking' ||
        mergeableState === 'unchecked' ||
        mergeableState === 'preparing' ||
        mergeableState === 'ci_must_pass' ||
        mergeableState === 'ci_still_running') {
        const ci = checkCiStatus(scm, headSha);
        if (ci.failed) {
            console.log('PR #' + prNumber + ' CI checks failed');
            return { success: false, reason: 'ci_failed', prNumber, prUrl, failedNames: ci.failedNames };
        }
        if (ci.inProgress || ci.total === 0) {
            console.log('PR not ready to merge (' + mergeableState + ') — checks still running or unknown — will retry');
            return { success: false, reason: 'ci_running', prNumber, prUrl };
        }
        console.log('PR not ready to merge (' + mergeableState + ') — will retry');
        return { success: false, reason: 'not_ready', prNumber, prUrl };
    }

    if (mergeableState === 'behind') {
        console.log('PR branch is behind base — requesting branch update');
        try {
            if (scm.updateBranch) {
                scm.updateBranch(prNumber, repoInfo.owner, repoInfo.repo);
            } else {
                throw new Error('SCM provider does not support updateBranch');
            }
        } catch (updateErr) {
            console.warn('Could not update branch:', updateErr);
        }
        return { success: false, reason: 'behind', prNumber, prUrl };
    }

    if ((mergeable === false && mergeableState === 'dirty') ||
        mergeableState === 'cannot_be_merged' ||
        mergeableState === 'conflict') {
        console.log('PR #' + prNumber + ' has merge conflict');
        return { success: false, reason: 'conflict', prNumber, prUrl };
    }

    try {
        scm.mergePr(prNumber, 'squash');
        console.log('✅ PR #' + prNumber + ' merged successfully');

        try { scm.removeLabel(prNumber, LABELS.PR_APPROVED); } catch (e) {}

        var tcResult = moveLinkedTestCases(storyKey, testCaseType, trackerConfig);

        try {
            trackerHelper.removeLabel(storyKey, LABELS.PR_APPROVED);
            console.log('Removed pr_approved label from Jira ticket');
        } catch (e) {
            console.warn('Could not remove pr_approved from Jira ticket:', e);
        }
        try {
            trackerHelper.removeLabel(storyKey, LABELS.TEST_PR_MERGED);
        } catch (e) {
            console.warn('Could not remove test_pr_merged label:', e);
        }
        try {
            trackerHelper.addLabel(storyKey, LABELS.TEST_PR_FINALIZED);
            console.log('Added test_pr_finalized label to', storyKey);
        } catch (e) {
            console.warn('Could not add test_pr_finalized label:', e);
        }

        var ticketLabel = issueType || 'Story';
        tracker_post_comment({
            key: storyKey,
            comment: 'h3. ✅ ' + ticketLabel + ' Test PR Merged\n\n' +
                'PR [#' + prNumber + '|' + prUrl + '] for branch {code}test/' + storyKey + '{code} was merged.\n\n' +
                'Linked Test Cases moved to final status: *' + tcResult.moved + '* moved, *' + tcResult.skipped + '* skipped.'
        });

        try {
            tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return { success: true, reason: 'merged', prNumber, prUrl, tcResult };

    } catch (mergeErr) {
        console.warn('Merge failed:', mergeErr);
        const errMsg = mergeErr ? String(mergeErr) : '';
        const isConflict = errMsg.toLowerCase().indexOf('conflict') !== -1;
        const isCIBlocking = errMsg.indexOf('blocked') !== -1 || errMsg.indexOf('422') !== -1 || errMsg.indexOf('405') !== -1;

        if (!isConflict && (isCIBlocking || errMsg === '')) {
            const ci = checkCiStatus(scm, headSha);
            if (ci.failed) {
                return { success: false, reason: 'ci_failed', prNumber, prUrl, failedNames: ci.failedNames };
            }
            if (ci.inProgress || ci.total === 0) {
                console.log('Merge blocked temporarily — checks still running or unknown — will retry');
                return { success: false, reason: 'ci_running', prNumber, prUrl };
            }
        }

        return { success: false, reason: isConflict ? 'conflict' : 'merge_failed', prNumber, prUrl, error: errMsg };
    }
}

function action(params) {
    const storyKey = params.ticket && params.ticket.key;
    var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};

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

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var trackerConfig = config.tracker;
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
    try { trackerHelper.removeLabel(storyKey, LABELS.PR_APPROVED); } catch (e) {}
    try { trackerHelper.addLabel(storyKey, LABELS.TEST_PR_REWORK_NEEDED); } catch (e) {}
    var reworkSkipLabel = issueType === trackerConfig.issueTypes.BUG ? 'sm_bug_test_rework_triggered' : 'sm_story_test_rework_triggered';
    try { trackerHelper.removeLabel(storyKey, reworkSkipLabel); } catch (e) {}

    releaseLock(storyKey, customParams);

    var checksList = mergeResult.failedNames && mergeResult.failedNames.length ? mergeResult.failedNames.join(', ') : 'unknown';
    var isConflict = mergeResult.reason === 'conflict';
    var panelTitle = isConflict ? 'MERGE CONFLICT' : 'MERGE FAILED';
    var reasonText = isConflict ? 'merge conflict' : 'CI checks failing or PR not mergeable';
    if (mergeResult.reason === 'ci_failed' && mergeResult.failedNames) {
        reasonText = 'required checks failed: ' + checksList;
    }
    tracker_post_comment({
        key: storyKey,
        comment: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *' + panelTitle + '* — Could not merge PR #' + (prNumber || 'unknown') + ': ' + reasonText + '.\n\n' + (prUrl ? '[View PR|' + prUrl + ']' : '') + '{panel}'
    });
    tracker_move_to_status({ key: storyKey, statusName: trackerConfig.statuses.IN_REWORK });
    return true;
}

// Expose attemptMerge on the action function as well, so callers that receive
// the action as the module default (common in the GraalJS/SM loader) can still
// invoke attemptMerge directly.
action.attemptMerge = attemptMerge;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, attemptMerge };
}
