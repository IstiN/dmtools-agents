/**
 * retryMergeGithubPR.js — GitHub-issues machine loop: merge leg.
 *
 * The sm counterpart of retryMergePR.js for repos where GitHub issues (not
 * Jira) carry the machine state. Called by SM (localExecution) for issues
 * whose linked PR is approved (label pr_approved) and CI-green. Locks ride
 * sm-trigger labels on the issue exactly like the Jira flow.
 *
 * Outcomes (mirrors retryMergePR semantics):
 *  - CI running / mergeability unknown → do nothing, release lock (SM retries)
 *  - Branch behind                    → update branch, retry next cycle
 *  - Merged                           → remove pr_approved (+ lock), close issue
 *  - Conflict / CI failing            → remove pr_approved, re-label agent:rework
 */
'use strict';

var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');

function issueNumberFromKey(ticketKey) {
    var m = /(\d+)$/.exec(String(ticketKey || ''));
    return m ? parseInt(m[1], 10) : null;
}

function removeIssueLabel(number, label, what) {
    try {
        github_remove_label({ owner: REPO.owner, repo: REPO.repo, number: number, label: label });
        console.log('Removed "' + label + '" from ' + (what || 'issue'));
    } catch (e) {
        console.warn('Could not remove "' + label + '" from ' + (what || 'issue') + ':', e.message || e);
    }
}

function addIssueLabel(number, label, what) {
    try {
        github_add_labels({ owner: REPO.owner, repo: REPO.repo, number: number, labels: [label] });
        console.log('Added "' + label + '" to ' + (what || 'issue'));
    } catch (e) {
        console.warn('Could not add "' + label + '":', e.message || e);
    }
}

var REPO = { owner: null, repo: null };

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var issueNumber = issueNumberFromKey(ticketKey);
    if (!issueNumber) {
        console.error('retryMergeGithubPR: no issue number in ticket key "' + ticketKey + '"');
        return false;
    }
    var customParams = (params.jobParams && params.jobParams.customParams) ||
        params.customParams || {};
    var branchPrefix = customParams.branchPrefix || 'ai/gh-';
    var reworkLabel = customParams.reworkLabel || 'agent:rework';
    var approvedLabel = customParams.approvedLabel || 'pr_approved';
    var lockLabel = customParams.removeLabel || null;
    var prNumberDirect = (params.ticket && params.ticket.prNumber) || customParams.prNumber || null;

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    // Target repo precedence: explicit config.repository (the SM passes the
    // RULE's repo — the machine loop lives in the target repo, not in this
    // agents checkout) > git remote of CWD. getRemoteRepoInfo() alone is
    // WRONG when running from the dmtools-agents checkout: it would resolve
    // to dmtools-agents and operate on its PRs.
    var explicitRepo = (config && config.repository && config.repository.owner &&
                        config.repository.repo)
        ? { owner: config.repository.owner, repo: config.repository.repo }
        : null;
    if (explicitRepo) {
        config = Object.assign({}, config, { repository: explicitRepo });
    }
    var scm = scmModule.createScm(config);
    var repoInfo = explicitRepo || scm.getRemoteRepoInfo();
    if (!repoInfo) {
        console.error('retryMergeGithubPR: could not determine owner/repo');
        return false;
    }
    REPO.owner = repoInfo.owner;
    REPO.repo = repoInfo.repo;

    function releaseLock() {
        if (lockLabel) removeIssueLabel(issueNumber, lockLabel, 'lock');
    }

    // Resolve the linked PR: explicit number, or branch/body match.
    var pr = null;
    if (prNumberDirect) {
        pr = { number: prNumberDirect };
    } else {
        var prList = scm.listPrs('open');
        var bodyRe = new RegExp('(^|[^0-9])#' + issueNumber + '([^0-9]|$)');
        var branchRe = new RegExp('^' + branchPrefix + issueNumber + '$');
        pr = (Array.isArray(prList) ? prList : []).find(function (p) {
            return branchRe.test((p.head && p.head.ref) || '');
        }) || null;
        if (!pr) {
            pr = (Array.isArray(prList) ? prList : []).find(function (p) {
                return bodyRe.test(String(p.body || ''));
            }) || null;
        }
        // Already merged? Cleanup: drop approved label, close the issue.
        // Branch match wins — a body mention of "#125" is too loose (release
        // notes and cross-references also match).
        if (!pr) {
            var mergedList = scm.listPrs('merged');
            var byBranch = (Array.isArray(mergedList) ? mergedList : []).find(function (p) {
                return branchRe.test((p.head && p.head.ref) || '');
            }) || null;
            pr = byBranch;
            if (!pr) {
                pr = (Array.isArray(mergedList) ? mergedList : []).find(function (p) {
                    return bodyRe.test(String(p.body || '')) && branchRe.test((p.head && p.head.ref) || '(^$)');
                }) || null;
            }
            if (pr) {
                console.log('PR #' + pr.number + ' already merged for ' + ticketKey + ' — cleanup');
                try { github_remove_label({ owner: REPO.owner, repo: REPO.repo, number: issueNumber, label: approvedLabel }); } catch (e) {}
                try {
                    github_create_comment({ workspace: repoInfo.owner, repository: repoInfo.repo,
                                            number: issueNumber, body: '✅ Merged via #' + pr.number + ' — closing.' });
                } catch (e) {}
                try {
                    github_close_issue({ workspace: repoInfo.owner, repository: repoInfo.repo, number: issueNumber });
                } catch (e) {}
                releaseLock();
                return true;
            }
        }
    }
    if (!pr) {
        console.warn('No open PR found for ' + ticketKey + ' — releasing lock');
        releaseLock();
        return false;
    }
    console.log('Found PR #' + pr.number + ' for ' + ticketKey);

    // Mergeability + CI observation via the provider surface.
    var detail = scm.getPr(pr.number) || {};
    var mergeable = detail.mergeable;
    var mergeState = detail.mergeable_state || detail.mergeStateStatus;

    if (mergeable === null || ['unknown', 'blocked', 'unstable', 'checking',
            'unchecked', 'preparing', 'ci_must_pass', 'ci_still_running',
            'pending'].indexOf(mergeState) !== -1) {
        console.log('PR not ready to merge (' + mergeState + ') — will retry next cycle');
        releaseLock();
        return false;
    }

    if (mergeState === 'behind' || mergeState === 'BEHIND') {
        console.log('PR branch is behind base — requesting branch update');
        try {
            scm.updateBranch(pr.number, repoInfo.owner, repoInfo.repo);
        } catch (e) {
            console.warn('Branch update failed (may already be in flight):', e.message || e);
        }
        releaseLock();
        return false;
    }

    if (mergeState === 'dirty' || mergeState === 'DIRTY' || mergeable === false) {
        console.warn('Conflicts detected — returning to rework');
        removeIssueLabel(issueNumber, approvedLabel);
        addIssueLabel(issueNumber, reworkLabel);
        releaseLock();
        return false;
    }

    // Merge (squash — merge-trigger parity).
    try {
        scm.mergePr(pr.number, repoInfo.owner, repoInfo.repo, 'squash');
        console.log('✅ Merged PR #' + pr.number + ' (squash)');
    } catch (e) {
        console.warn('Merge failed:', e.message || e);
        releaseLock();
        return false;
    }

    removeIssueLabel(issueNumber, approvedLabel);
    releaseLock();

    // Fixes-#N usually closes the issue on merge; this is the safety net.
    try {
        var issue = github_get_issue({ number: issueNumber }) || {};
        var parsed = typeof issue === 'string' ? JSON.parse(issue) : issue;
        if (parsed && parsed.state === 'open') {
            github_close_issue({ number: issueNumber });
            console.log('Closed issue #' + issueNumber + ' (safety net)');
        }
    } catch (e) {
        console.warn('Issue close safety net failed (non-fatal):', e.message || e);
    }
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, issueNumberFromKey: issueNumberFromKey };
}
