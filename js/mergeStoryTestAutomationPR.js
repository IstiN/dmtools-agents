/**
 * Merge Story Test Automation PR
 * Merges the PR on branch test/{STORY_KEY} and moves all linked Test Cases
 * from In Review - Passed/Failed to Passed/Failed.
 */

const { STATUSES, LABELS } = require('./config.js');
var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
var autoStart = require('./common/autoStart.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

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
        try { jira_remove_label({ key: storyKey, label: removeLabel }); } catch (e) {}
    }
}

function fetchLinkedTestCases(storyKey, testCaseType) {
    var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = "' + testCaseType + '"';
    try {
        return jira_search_by_jql({ jql: jql, maxResults: 100, fields: ['key', 'status'] }) || [];
    } catch (e) {
        console.warn('Failed to fetch linked Test Cases for merge:', e);
        return [];
    }
}

function resolveFinalStatus(currentStatus) {
    if (currentStatus === STATUSES.IN_REVIEW_PASSED) return STATUSES.PASSED;
    if (currentStatus === STATUSES.IN_REVIEW_FAILED) return STATUSES.FAILED;
    return null;
}

function moveLinkedTestCases(storyKey, testCaseType) {
    var testCases = fetchLinkedTestCases(storyKey, testCaseType);
    var moved = 0;
    var skipped = 0;
    testCases.forEach(function(tc) {
        var currentStatus = tc.fields && tc.fields.status ? tc.fields.status.name : '';
        var finalStatus = resolveFinalStatus(currentStatus);
        if (!finalStatus) {
            console.log('Skipping linked TC', tc.key, '— current status', currentStatus);
            skipped++;
            return;
        }
        try {
            jira_move_to_status({ key: tc.key, statusName: finalStatus });
            console.log('✅ Moved', tc.key, 'to', finalStatus);
            moved++;
        } catch (e) {
            console.warn('Failed to move', tc.key, 'to', finalStatus, ':', e);
            skipped++;
        }
    });
    return { moved: moved, skipped: skipped, total: testCases.length };
}

function finalizeAlreadyMergedPR(params, scm, storyKey, pr, testCaseType, customParams) {
    const prNumber = pr.number;
    const prUrl = pr.html_url;
    console.log('PR #' + prNumber + ' already merged for story ' + storyKey + ' — finalizing');

    var issueType = params.ticket && params.ticket.fields &&
        params.ticket.fields.issuetype && params.ticket.fields.issuetype.name;

    var tcResult = moveLinkedTestCases(storyKey, testCaseType);

    if (issueType === 'Bug') {
        try {
            jira_move_to_status({ key: storyKey, statusName: STATUSES.DONE });
            console.log('Moved Bug', storyKey, 'to Done after merged test PR');
        } catch (e) {
            console.warn('Could not move Bug', storyKey, 'to Done:', e);
        }
    }

    try {
        jira_remove_label({ key: storyKey, label: LABELS.PR_APPROVED });
    } catch (e) {
        console.warn('Could not remove pr_approved label:', e);
    }
    try {
        jira_remove_label({ key: storyKey, label: LABELS.TEST_PR_MERGED });
    } catch (e) {
        console.warn('Could not remove test_pr_merged label:', e);
    }

    releaseLock(storyKey, customParams);

    var ticketLabel = issueType || 'Story';
    jira_post_comment({
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

function action(params) {
    const storyKey = params.ticket && params.ticket.key;
    if (!storyKey) {
        console.error('No storyKey provided');
        return false;
    }

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var scm = scmModule.createScm(config);
    var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var testCaseType = projectConfig.jira && projectConfig.jira.issueTypes && projectConfig.jira.issueTypes.TEST_CASE
        ? projectConfig.jira.issueTypes.TEST_CASE
        : 'Test Case';

    const repoInfo = scm.getRemoteRepoInfo();
    if (!repoInfo) {
        console.error('Could not determine owner/repo');
        releaseLock(storyKey, customParams);
        return false;
    }

    const found = findPRForStory(scm, storyKey);
    if (!found) {
        console.warn('No open or merged PR found for story', storyKey, '— releasing lock');
        releaseLock(storyKey, customParams);
        return false;
    }

    if (found.merged) {
        return finalizeAlreadyMergedPR(params, scm, storyKey, found.pr, testCaseType, customParams);
    }

    const pr = found.pr;
    const prNumber = pr.number;
    const prUrl = pr.html_url;
    console.log('Found PR #' + prNumber + ' for story ' + storyKey);

    let mergeableState = null;
    let mergeable = null;
    try {
        const prDetail = scm.getPr(prNumber);
        mergeable = prDetail && prDetail.mergeable;
        mergeableState = prDetail && prDetail.mergeable_state;
        console.log('PR mergeable: ' + mergeable + ', state: ' + mergeableState);
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
        console.log('PR not ready to merge (' + mergeableState + ') — will retry next cycle');
        return false;
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
        return false;
    }

    if ((mergeable === false && mergeableState === 'dirty') ||
        mergeableState === 'cannot_be_merged' ||
        mergeableState === 'conflict') {
        console.log('PR has merge conflict — moving Story to In Rework');
        try { scm.removeLabel(prNumber, LABELS.PR_APPROVED); } catch (e) {}
        try { jira_remove_label({ key: storyKey, label: LABELS.PR_APPROVED }); } catch (e) {}
        releaseLock(storyKey, customParams);
        jira_post_comment({
            key: storyKey,
            comment: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *MERGE CONFLICT* — PR #' + prNumber + ' has a merge conflict with main.\n\n[View PR|' + prUrl + ']{panel}'
        });
        jira_move_to_status({ key: storyKey, statusName: STATUSES.IN_REWORK });
        return true;
    }

    try {
        scm.mergePr(prNumber, 'squash');
        console.log('✅ PR #' + prNumber + ' merged successfully');

        try { scm.removeLabel(prNumber, LABELS.PR_APPROVED); } catch (e) {}

        // Move linked Test Cases to final status before removing Jira pr_approved label
        var tcResult = moveLinkedTestCases(storyKey, testCaseType);

        var issueType = params.ticket && params.ticket.fields &&
            params.ticket.fields.issuetype && params.ticket.fields.issuetype.name;

        if (issueType === 'Bug') {
            // Bug test-automation PR merged: move Bug straight to Done
            try {
                jira_move_to_status({ key: storyKey, statusName: STATUSES.DONE });
                console.log('Moved Bug', storyKey, 'to Done after test PR merge');
            } catch (e) {
                console.warn('Could not move Bug', storyKey, 'to Done:', e);
            }
        }

        // Story stays In Testing; story_done_check will move it to Done when all TCs are Passed
        try {
            jira_remove_label({ key: storyKey, label: LABELS.PR_APPROVED });
            console.log('Removed pr_approved label from Jira Story');
        } catch (e) {
            console.warn('Could not remove pr_approved from Jira Story:', e);
        }
        try {
            jira_remove_label({ key: storyKey, label: LABELS.TEST_PR_MERGED });
        } catch (e) {
            console.warn('Could not remove test_pr_merged label:', e);
        }

        releaseLock(storyKey, customParams);

        var ticketLabel = issueType || 'Story';
        jira_post_comment({
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

        return true;

    } catch (mergeErr) {
        console.warn('Merge failed:', mergeErr);
        const errMsg = mergeErr ? String(mergeErr) : '';
        const isConflict = errMsg.toLowerCase().indexOf('conflict') !== -1;
        const isCIBlocking = errMsg.indexOf('blocked') !== -1 || errMsg.indexOf('422') !== -1 || errMsg.indexOf('405') !== -1;

        if (!isConflict && (isCIBlocking || errMsg === '')) {
            console.log('Merge blocked temporarily — will retry next cycle');
            return false;
        }

        try { scm.removeLabel(prNumber, LABELS.PR_APPROVED); } catch (e) {}
        try { jira_remove_label({ key: storyKey, label: LABELS.PR_APPROVED }); } catch (e) {}
        releaseLock(storyKey, customParams);
        const reason = isConflict ? 'merge conflict' : 'CI checks failing or PR not mergeable';
        jira_post_comment({
            key: storyKey,
            comment: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *MERGE FAILED* — Could not merge PR #' + prNumber + ': ' + reason + '.\n\n[View PR|' + prUrl + ']{panel}'
        });
        jira_move_to_status({ key: storyKey, statusName: STATUSES.IN_REWORK });
        return true;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
