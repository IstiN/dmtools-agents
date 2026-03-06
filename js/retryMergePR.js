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

const { STATUSES, LABELS } = require('./config.js');

function getGitHubRepoInfo() {
    try {
        const rawOutput = cli_execute_command({ command: 'git config --get remote.origin.url' }) || '';
        const remoteUrl = rawOutput.split('\n')
            .map(function(l) { return l.trim(); })
            .filter(function(l) { return l.indexOf('github.com') !== -1; })[0] || '';
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.?\s]+)/);
        if (!match) return null;
        return { owner: match[1], repo: match[2].replace('.git', '') };
    } catch (e) {
        console.error('Failed to get repo info:', e);
        return null;
    }
}

function findPRForTicket(owner, repo, ticketKey) {
    try {
        const openPRs = github_list_prs({ workspace: owner, repository: repo, state: 'open' });
        const prList = Array.isArray(openPRs) ? openPRs : [];
        const matched = prList.find(function(pr) {
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

function removeApprovedLabels(owner, repo, prNumber, ticketKey) {
    try {
        github_remove_pr_label({ workspace: owner, repository: repo, pullRequestId: String(prNumber), label: LABELS.PR_APPROVED });
        console.log('Removed pr_approved label from GitHub PR');
    } catch (e) {
        console.warn('Could not remove pr_approved from GitHub PR:', e);
    }
    try {
        jira_remove_label({ key: ticketKey, label: LABELS.PR_APPROVED });
        console.log('Removed pr_approved label from Jira ticket');
    } catch (e) {
        console.warn('Could not remove pr_approved from Jira ticket:', e);
    }
}

function releaseLock(ticketKey, params) {
    const removeLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
    if (removeLabel && ticketKey) {
        try { jira_remove_label({ key: ticketKey, label: removeLabel }); } catch (e) {}
    }
}

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        console.error('No ticketKey provided');
        return false;
    }

    const repoInfo = getGitHubRepoInfo();
    if (!repoInfo) {
        console.error('Could not determine owner/repo');
        releaseLock(ticketKey, params);
        return false;
    }
    const { owner, repo } = repoInfo;

    const pr = findPRForTicket(owner, repo, ticketKey);
    if (!pr) {
        console.warn('No open PR found for ticket ' + ticketKey + ' — releasing lock');
        releaseLock(ticketKey, params);
        return false;
    }

    const prNumber = pr.number;
    const prUrl = pr.html_url;
    console.log('Found PR #' + prNumber + ' for ticket ' + ticketKey);

    // Check PR mergeable status
    let mergeableState = null;
    let mergeable = null;
    try {
        const prDetail = github_get_pr({ workspace: owner, repository: repo, pullRequestId: String(prNumber) });
        mergeable = prDetail && prDetail.mergeable;
        mergeableState = prDetail && prDetail.mergeable_state;
        console.log('PR mergeable: ' + mergeable + ', state: ' + mergeableState);
    } catch (e) {
        console.warn('Could not get PR details, will attempt merge anyway:', e);
    }

    // GitHub hasn't computed mergeability yet, or CI checks still running — retry next cycle
    if (mergeable === null || mergeableState === 'unknown' || mergeableState === 'blocked' || mergeableState === 'unstable') {
        console.log('PR not ready to merge (' + mergeableState + ') — will retry next cycle');
        return false;
    }

    // PR branch is behind base — update it so CI can re-run, then retry next cycle
    if (mergeableState === 'behind') {
        console.log('PR branch is behind base — requesting branch update');
        try {
            cli_execute_command({ command: 'gh api repos/' + owner + '/' + repo + '/pulls/' + prNumber + '/update-branch -X PUT' });
            console.log('Branch update requested — will retry merge next cycle after CI passes');
        } catch (updateErr) {
            console.warn('Could not update branch (may already be updating):', updateErr);
        }
        return false;
    }

    // Conflict detected before attempting merge
    if (mergeable === false && mergeableState === 'dirty') {
        console.log('PR has merge conflict — moving ticket to In Rework');
        removeApprovedLabels(owner, repo, prNumber, ticketKey);
        releaseLock(ticketKey, params);
        jira_post_comment({
            key: ticketKey,
            comment: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *MERGE CONFLICT* — PR #' + prNumber + ' has a merge conflict with main. Please resolve conflicts and re-push.\n\n[View PR|' + prUrl + ']{panel}'
        });
        jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REWORK });
        console.log('✅ Ticket moved to In Rework (merge conflict)');
        return true;
    }

    // Attempt merge
    try {
        github_merge_pr({
            workspace: owner,
            repository: repo,
            pullRequestId: String(prNumber),
            mergeMethod: 'squash'
        });
        console.log('✅ PR #' + prNumber + ' merged successfully');
        removeApprovedLabels(owner, repo, prNumber, ticketKey);
        releaseLock(ticketKey, params);

        // For test cases: move to Passed/Failed based on current status; for stories/bugs: Merged
        const isTestCase = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.testCaseMerge;
        if (isTestCase) {
            var ticketDetail = jira_get_ticket({ key: ticketKey });
            var currentStatus = ticketDetail && ticketDetail.fields && ticketDetail.fields.status && ticketDetail.fields.status.name;
            var finalStatus = (currentStatus === STATUSES.IN_REVIEW_PASSED) ? STATUSES.PASSED : STATUSES.FAILED;
            jira_move_to_status({ key: ticketKey, statusName: finalStatus });
            console.log('✅ Ticket moved to ' + finalStatus);
            // Prevent same-cycle review trigger: Jira eventual consistency may still return
            // the old "In Review" status in the next rule's JQL within the same SM cycle.
            try { jira_add_label({ key: ticketKey, label: 'sm_test_review_triggered' }); } catch (e) {}
        } else {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.MERGED });
            console.log('✅ Ticket moved to Merged');
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
        removeApprovedLabels(owner, repo, prNumber, ticketKey);
        releaseLock(ticketKey, params);
        jira_post_comment({
            key: ticketKey,
            comment: '{panel:bgColor=#FFEBE6|borderColor=#DE350B}⚠️ *MERGE FAILED* — Could not merge PR #' + prNumber + ': ' + reason + '. Please check and re-push.\n\n[View PR|' + prUrl + ']{panel}'
        });
        jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REWORK });
        console.log('✅ Ticket moved to In Rework (' + reason + ')');
        return true;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
