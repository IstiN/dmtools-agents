/**
 * retryMergePR.js
 *
 * Called by SM when a Story/Bug ticket is in "In Review" with label "pr_approved".
 * Checks if the GitHub PR is now mergeable (CI passed, no conflicts) and merges it.
 *
 * Outcomes:
 *  - CI still running / blocked → do nothing, release lock so SM retries next cycle
 *  - Merged successfully      → remove pr_approved label (GitHub + Jira), move ticket to Merged
 *  - Conflict / CI failing    → remove pr_approved label, move ticket to In Rework, post comment
 */

const { LABELS } = require('./config.js');
var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
var autoStart = require('./common/autoStart.js');
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


function getGitHubRepoInfo() {
    try {
        const rawOutput = cli_execute_command({ command: 'git config --get remote.origin.url' }) || '';
        const remoteUrl = rawOutput.split('\n')
            .map(function(l) { return l.trim(); })
            .filter(function(l) { return l.indexOf('github.com') !== -1; })[0] || '';
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/?#\s]+)/);
        if (!match) return null;
        return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    } catch (e) {
        console.error('Failed to get repo info:', e);
        return null;
    }
}

function findPRForTicket(scm, ticketKey) {
    try {
        const prList = scm.listPrs('open');
        const matched = (Array.isArray(prList) ? prList : []).find(function(pr) {
            const titleMatch = pr.title && pr.title.indexOf(ticketKey) !== -1;
            const branchMatch = pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1;
            return titleMatch || branchMatch;
        });
        return matched || null;
    } catch (e) {
        console.error('Failed to list PRs:', e);
        return null;
    }
}

function removeApprovedLabels(scm, prNumber, ticketKey) {
    try {
        scm.removeLabel(prNumber, LABELS.PR_APPROVED);
        console.log('Removed pr_approved label from PR');
    } catch (e) {
        console.warn('Could not remove pr_approved from PR:', e);
    }
    try {
        getTracker().removeLabel(ticketKey, LABELS.PR_APPROVED);
        console.log('Removed pr_approved label from Jira ticket');
    } catch (e) {
        console.warn('Could not remove pr_approved from Jira ticket:', e);
    }
}

function releaseLock(ticketKey, customParams) {
    const removeLabel = customParams && customParams.removeLabel;
    if (removeLabel && ticketKey) {
        try { getTracker().removeLabel(ticketKey, removeLabel); } catch (e) {}
    }
}

function resolveMergeJobName(params, customParams) {
    var metadata = (params.jobParams && params.jobParams.metadata) || params.metadata || {};
    if (metadata.contextId === 'retry_merge_test' || (customParams && customParams.testCaseMerge)) {
        return 'retry_merge_test';
    }
    return 'retry_merge';
}

function resolveCustomParams(params, config) {
    var runtime = (params.jobParams && params.jobParams.customParams) ||
        params.customParams ||
        {};
    var jobName = resolveMergeJobName(params, runtime);
    var merged = {};
    var patch = configLoader.resolveInstructions(jobName, null, config).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(merged, runtime);
    return merged;
}

function triggerAutoStartRework(ticketKey, customParams, config, scm) {
    if (!customParams || !customParams.autoStartRework || !customParams.autoStartReworkConfigFile) {
        return false;
    }
    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: ticketKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartReworkConfigFile,
            label: 'pr_rework',
            scm: scm,
            stripKeys: [
                'removeLabel',
                'autoStartRework',
                'autoStartReworkConfigFile'
            ]
        });
    } catch (e) {
        console.warn('⚠️ autoStartRework trigger failed:', e.message || e);
        return false;
    }
}

// ── gh-980: pure decision helpers extracted from action() (CRAP 190 → 30) ──
// The merge-readiness branch table, verbatim semantics: 'retry' covers
// GitHub's still-computing / CI-running states and a null mergeable,
// 'updateBranch' the behind-base case, 'conflict' every pre-merge conflict
// signal, 'merge' everything else.
var RETRY_MERGE_STATES = {
    unknown: true, blocked: true, unstable: true, checking: true,
    unchecked: true, preparing: true, ci_must_pass: true, ci_still_running: true
};
var CONFLICT_MERGE_STATES = { cannot_be_merged: true, conflict: true };

function decideMergeReadiness(mergeable, mergeableState) {
    if (mergeable === null || RETRY_MERGE_STATES[mergeableState]) return 'retry';
    if (mergeableState === 'behind') return 'updateBranch';
    if (mergeable === false && mergeableState === 'dirty') return 'conflict';
    if (CONFLICT_MERGE_STATES[mergeableState]) return 'conflict';
    return 'merge';
}

function isCiBlockingMessage(errMsg) {
    return errMsg.indexOf('blocked') !== -1 || errMsg.indexOf('422') !== -1 || errMsg.indexOf('405') !== -1;
}

// The merge-error classification, verbatim semantics: a message mentioning
// 'conflict' (case-insensitive) is a conflict; an empty or CI-blocking
// message is a temporary block (retry next cycle, keep pr_approved);
// anything else is a hard failure → In Rework.
function classifyMergeError(mergeErr) {
    var errMsg = mergeErr ? String(mergeErr) : '';
    if (errMsg.toLowerCase().indexOf('conflict') !== -1) return 'conflict';
    if (errMsg === '' || isCiBlockingMessage(errMsg)) return 'temporary';
    return 'ci-failing';
}

// The shared In-Rework escalation: strip pr_approved (SCM + tracker),
// release the SM lock, post the caller-built comment, move the ticket,
// re-arm the rework leg. Called by both the pre-merge conflict path and
// the post-merge-failure path.
function escalateToInRework(opts) {
    removeApprovedLabels(opts.scm, opts.prNumber, opts.ticketKey);
    releaseLock(opts.ticketKey, opts.customParams);
    getTracker().postComment(opts.ticketKey, opts.commentBody);
    getTracker().moveToStatus(opts.ticketKey, opts.config.jira.statuses.IN_REWORK);
    console.log('✅ Ticket moved to In Rework (' + opts.reason + ')');
    triggerAutoStartRework(opts.ticketKey, opts.customParams, opts.config, opts.scm);
}

// Cosmetic label strips around a successful merge — each best-effort with
// its own warning, exactly the historical log lines.
function stripMergedPrLabel(scm, prNumber) {
    try {
        scm.removeLabel(prNumber, LABELS.PR_APPROVED);
        console.log('Removed pr_approved label from GitHub PR');
    } catch (e) {
        console.warn('Could not remove pr_approved from GitHub PR:', e);
    }
}

function stripApprovedLabelAfterMerge(ticketKey) {
    try {
        getTracker().removeLabel(ticketKey, LABELS.PR_APPROVED);
        console.log('Removed pr_approved label from Jira ticket');
    } catch (e) {
        console.warn('Could not remove pr_approved from Jira ticket:', e);
    }
}

// gh-916: Passed/Failed/Merged can be tag-only (restricted ADO workflows) —
// stage-label fallback on a rejected transition.
function resolveTestCaseFinalStatus(ticketKey, jiraConfig) {
    var ticketDetail = getTracker().getIssue(ticketKey);
    // hasStage also accepts the stage_in_review_passed marker a rejected transition
    // left (jira.stageFallback 'label'); 'none' mode compares the status only.
    var wasReviewPassed = getTracker().hasStage(ticketDetail, 'IN_REVIEW_PASSED', jiraConfig.statuses.IN_REVIEW_PASSED);
    var finalStatus = wasReviewPassed ? jiraConfig.statuses.PASSED : jiraConfig.statuses.FAILED;
    var moved = getTracker().moveToStatusOrMark(ticketKey, finalStatus, wasReviewPassed ? 'PASSED' : 'FAILED');
    if (moved.moved || moved.marked) {
        console.log('✅ Ticket moved to ' + finalStatus);
    }
}

function moveTicketToMerged(ticketKey, jiraConfig) {
    var mergedMove = getTracker().moveToStatusOrMark(ticketKey, jiraConfig.statuses.MERGED, 'MERGED');
    if (mergedMove.moved || mergedMove.marked) {
        console.log('✅ Ticket moved to Merged');
    }
}

// Post-merge finalization: move the ticket to its final status BEFORE
// removing pr_approved from Jira. Jira's search index can lag: if the status
// update hasn't propagated yet when the next SM rule runs its JQL, the
// ticket would still appear as "In Review". Keeping pr_approved on the Jira
// ticket until after the status move means the review-trigger rule (JQL:
// NOT IN pr_approved) naturally skips the ticket.
function finalizeMergedTicket(params, ticketKey, jiraConfig) {
    var isTestCase = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.testCaseMerge;
    if (isTestCase) {
        resolveTestCaseFinalStatus(ticketKey, jiraConfig);
    } else {
        moveTicketToMerged(ticketKey, jiraConfig);
    }
}

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        console.error('No ticketKey provided');
        return false;
    }

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = config.jira;
    var scm = scmModule.createScm(config);
    var customParams = resolveCustomParams(params, config);
    initTracker(config, customParams);

    const repoInfo = scm.getRemoteRepoInfo();
    if (!repoInfo) {
        console.error('Could not determine owner/repo');
        releaseLock(ticketKey, customParams);
        return false;
    }
    const { owner, repo } = repoInfo;

    const pr = findPRForTicket(scm, ticketKey);
    if (!pr) {
        console.warn('No open PR found for ticket ' + ticketKey + ' — releasing lock');
        releaseLock(ticketKey, customParams);
        return false;
    }

    const prNumber = pr.number;
    const prUrl = pr.html_url;
    console.log('Found PR #' + prNumber + ' for ticket ' + ticketKey);

    // Check PR mergeable status
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

    // GitHub hasn't computed mergeability yet, or CI checks still running — retry next cycle
    var readiness = decideMergeReadiness(mergeable, mergeableState);
    if (readiness === 'retry') {
        console.log('PR not ready to merge (' + mergeableState + ') — will retry next cycle');
        return false;
    }

    // PR branch is behind base — update it so CI can re-run, then retry next cycle
    if (readiness === 'updateBranch') {
        console.log('PR branch is behind base — requesting branch update');
        try {
            if (scm.updateBranch) {
                scm.updateBranch(prNumber, owner, repo);
            } else {
                throw new Error('SCM provider does not support updateBranch');
            }
            console.log('Branch update requested — will retry merge next cycle after CI passes');
        } catch (updateErr) {
            console.warn('Could not update branch (may already be updating):', updateErr);
        }
        return false;
    }

    // Conflict detected before attempting merge
    if (readiness === 'conflict') {
        console.log('PR has merge conflict — moving ticket to In Rework');
        escalateToInRework({
            scm: scm,
            prNumber: prNumber,
            ticketKey: ticketKey,
            customParams: customParams,
            config: config,
            reason: 'merge conflict',
            commentBody: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *MERGE CONFLICT* — PR #' + prNumber + ' has a merge conflict with main. Please resolve conflicts and re-push.\n\n[View PR|' + prUrl + ']{panel}'
        });
        return true;
    }

    // Attempt merge
    try {
        scm.mergePr(prNumber, 'squash');
        console.log('✅ PR #' + prNumber + ' merged successfully');

        // Remove GitHub PR label immediately (cosmetic — PR is closed)
        stripMergedPrLabel(scm, prNumber);
        releaseLock(ticketKey, customParams);

        finalizeMergedTicket(params, ticketKey, jiraConfig);

        // Now safe to remove pr_approved from Jira — status is already updated
        stripApprovedLabelAfterMerge(ticketKey);
        return true;
    } catch (mergeErr) {
        console.warn('Merge failed:', mergeErr);
        var failure = classifyMergeError(mergeErr);

        if (failure === 'temporary') {
            // Temporary block — retry next cycle, keep pr_approved
            console.log('Merge blocked temporarily — will retry next cycle');
            return false;
        }

        var reason = failure === 'conflict' ? 'merge conflict' : 'CI checks failing or PR not mergeable';
        escalateToInRework({
            scm: scm,
            prNumber: prNumber,
            ticketKey: ticketKey,
            customParams: customParams,
            config: config,
            reason: reason,
            commentBody: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *MERGE FAILED* — Could not merge PR #' + prNumber + ': ' + reason + '. Please check and re-push.\n\n[View PR|' + prUrl + ']{panel}'
        });

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return true;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, resolveCustomParams, triggerAutoStartRework, decideMergeReadiness, classifyMergeError };
}
