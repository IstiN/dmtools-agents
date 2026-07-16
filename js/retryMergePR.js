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
        jira_remove_label({ key: ticketKey, label: LABELS.PR_APPROVED });
        console.log('Removed pr_approved label from Jira ticket');
    } catch (e) {
        console.warn('Could not remove pr_approved from Jira ticket:', e);
    }
}

function releaseLock(ticketKey, customParams) {
    const removeLabel = customParams && customParams.removeLabel;
    if (removeLabel && ticketKey) {
        try { jira_remove_label({ key: ticketKey, label: removeLabel }); } catch (e) {}
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

    // PR branch is behind base — update it so CI can re-run, then retry next cycle
    if (mergeableState === 'behind') {
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
    if ((mergeable === false && mergeableState === 'dirty') ||
        mergeableState === 'cannot_be_merged' ||
        mergeableState === 'conflict') {
        console.log('PR has merge conflict — moving ticket to In Rework');
        removeApprovedLabels(scm, prNumber, ticketKey);
        releaseLock(ticketKey, customParams);
        jira_post_comment({
            key: ticketKey,
            comment: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *MERGE CONFLICT* — PR #' + prNumber + ' has a merge conflict with main. Please resolve conflicts and re-push.\n\n[View PR|' + prUrl + ']{panel}'
        });
        jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.IN_REWORK });
        console.log('✅ Ticket moved to In Rework (merge conflict)');
        triggerAutoStartRework(ticketKey, customParams, config, scm);
        return true;
    }

    // Attempt merge
    try {
        scm.mergePr(prNumber, 'squash');
        console.log('✅ PR #' + prNumber + ' merged successfully');

        // Remove GitHub PR label immediately (cosmetic — PR is closed)
        try {
            scm.removeLabel(prNumber, LABELS.PR_APPROVED);
            console.log('Removed pr_approved label from GitHub PR');
        } catch (e) {
            console.warn('Could not remove pr_approved from GitHub PR:', e);
        }
        releaseLock(ticketKey, customParams);

        // Move ticket to final status BEFORE removing pr_approved from Jira.
        // Jira's search index can lag: if the status update hasn't propagated yet when
        // the next SM rule runs its JQL, the ticket would still appear as "In Review".
        // Keeping pr_approved on the Jira ticket until after the status move means
        // the review-trigger rule (JQL: NOT IN pr_approved) naturally skips the ticket.
        const isTestCase = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.testCaseMerge;
        if (isTestCase) {
            var ticketDetail = jira_get_ticket({ key: ticketKey });
            var currentStatus = ticketDetail && ticketDetail.fields && ticketDetail.fields.status && ticketDetail.fields.status.name;
            var finalStatus = (currentStatus === jiraConfig.statuses.IN_REVIEW_PASSED) ? jiraConfig.statuses.PASSED : jiraConfig.statuses.FAILED;
            jira_move_to_status({ key: ticketKey, statusName: finalStatus });
            console.log('✅ Ticket moved to ' + finalStatus);
        } else {
            jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.MERGED });
            console.log('✅ Ticket moved to Merged');
        }

        // Now safe to remove pr_approved from Jira — status is already updated
        try {
            jira_remove_label({ key: ticketKey, label: LABELS.PR_APPROVED });
            console.log('Removed pr_approved label from Jira ticket');
        } catch (e) {
            console.warn('Could not remove pr_approved from Jira ticket:', e);
        }
        return true;
    } catch (mergeErr) {
        console.warn('Merge failed:', mergeErr);
        const errMsg = mergeErr ? String(mergeErr) : '';
        const isConflict = errMsg.toLowerCase().indexOf('conflict') !== -1;
        const isCIBlocking = errMsg.indexOf('blocked') !== -1 || errMsg.indexOf('422') !== -1 || errMsg.indexOf('405') !== -1;

        if (!isConflict && (isCIBlocking || errMsg === '')) {
            // Temporary block — retry next cycle, keep pr_approved
            console.log('Merge blocked temporarily — will retry next cycle');
            return false;
        }

        const reason = isConflict ? 'merge conflict' : 'CI checks failing or PR not mergeable';
        removeApprovedLabels(scm, prNumber, ticketKey);
        releaseLock(ticketKey, customParams);
        jira_post_comment({
            key: ticketKey,
            comment: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *MERGE FAILED* — Could not merge PR #' + prNumber + ': ' + reason + '. Please check and re-push.\n\n[View PR|' + prUrl + ']{panel}'
        });
        jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.IN_REWORK });
        console.log('✅ Ticket moved to In Rework (' + reason + ')');
        triggerAutoStartRework(ticketKey, customParams, config, scm);

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return true;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, resolveCustomParams, triggerAutoStartRework };
}
