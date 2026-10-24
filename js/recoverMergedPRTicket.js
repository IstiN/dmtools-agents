/**
 * Recover Jira tickets whose GitHub PR was already merged while Jira stayed in
 * a review/rework status.
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

function prMatchesTicket(pr, ticketKey) {
    if (!pr || !ticketKey) return false;
    var titleMatch = pr.title && pr.title.indexOf(ticketKey) !== -1;
    var branchMatch = pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1;
    return !!(titleMatch || branchMatch);
}

function isMergedPR(pr) {
    if (!pr) return false;
    return !!(pr.merged_at || pr.mergedAt || pr.merge_commit_sha || pr.mergeCommit) ||
        pr.state === 'MERGED' ||
        pr.merged === true;
}

/**
 * The first OPEN PR matching the ticket, or null — its presence means the
 * PR pipeline is still live and merged-PR recovery must not touch anything.
 * Logs the guard outcome for the matched PR (same message as before gh-1229).
 */
function firstOpenMatchingPR(openPrs, ticketKey) {
    for (var openIndex = 0; openIndex < openPrs.length; openIndex++) {
        if (prMatchesTicket(openPrs[openIndex], ticketKey)) {
            console.log('Open PR still exists for ' + ticketKey + ', skipping merged-PR recovery: #' + openPrs[openIndex].number);
            return openPrs[openIndex];
        }
    }
    return null;
}

/** The first closed PR matching the ticket that is confirmed merged, or null. */
function firstMergedClosedPR(closedPrs, ticketKey) {
    for (var i = 0; i < closedPrs.length; i++) {
        if (prMatchesTicket(closedPrs[i], ticketKey) && isMergedPR(closedPrs[i])) {
            return closedPrs[i];
        }
    }
    return null;
}

function findMergedPRForTicket(scm, ticketKey) {
    var open = [];
    try {
        open = scm.listPrs('open') || [];
    } catch (openError) {
        console.warn('Could not list open PRs for merged recovery guard:', openError.message || openError);
        return null;
    }
    if (firstOpenMatchingPR(open, ticketKey)) {
        return null;
    }

    var closed = [];
    try {
        closed = scm.listPrs('closed') || [];
    } catch (e) {
        console.warn('Could not list closed PRs:', e.message || e);
        return null;
    }
    return firstMergedClosedPR(closed, ticketKey);
}

function removeLabel(ticketKey, label) {
    if (!ticketKey || !label) return;
    try {
        getTracker().removeLabel(ticketKey, label);
        console.log('Removed label from Jira:', label);
    } catch (e) {}
}

// Labels the merge pipeline may have put on the ticket while it was in
// review/rework — all of them are stale once the PR is confirmed merged.
var RECOVERY_LABELS = [
    LABELS.PR_APPROVED,
    'sm_pr_merge_triggered',
    'sm_story_review_triggered',
    'sm_story_rework_triggered'
];

function removeRecoveryLabels(ticketKey) {
    for (var i = 0; i < RECOVERY_LABELS.length; i++) {
        removeLabel(ticketKey, RECOVERY_LABELS[i]);
    }
}

/** PR number/url read across GitHub REST and dmtools-normalized field namings. */
function prIdentity(pr) {
    return {
        number: pr.number || pr.id || '?',
        url: pr.html_url || pr.url || ''
    };
}

/** The customParams bag: jobParams (JSRunner/post-action path) wins, then the params bag. */
function recoveryCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/**
 * Move the ticket to the merged status. gh-916: MERGED can be tag-only
 * (restricted ADO workflows) — moveToStatusOrMark carries the stage-label
 * fallback. A hard tracker failure is non-fatal: the recovery continues.
 */
function moveTicketToMerged(ticketKey, mergedStatus) {
    try {
        var moveResult = getTracker().moveToStatusOrMark(ticketKey, mergedStatus, 'MERGED');
        if (moveResult.moved || moveResult.marked) {
            console.log('Moved', ticketKey, 'to', mergedStatus);
        }
    } catch (e) {
        console.warn('Could not move ticket to Merged:', e.message || e);
    }
}

/** Announce the recovered PR on the ticket (non-fatal on failure). */
function postRecoveryComment(ticketKey, prNumber, prUrl, mergedStatus) {
    try {
        getTracker().postComment(ticketKey, 'h3. ✅ Merged PR Recovered\n\n' +
                'Found already merged PR #' + prNumber + (prUrl ? ' — [View PR|' + prUrl + ']' : '') +
                '. Ticket moved to *' + mergedStatus + '* so the normal post-merge pipeline can continue.');
    } catch (e) {}
}

/**
 * Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
 * wrote outputs/*_usage.json during the agent run (non-fatal on failure).
 */
function postRunTokenUsage(params, ticketKey) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        console.error('No ticket key provided');
        return { success: false, action: 'missing_ticket' };
    }

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = config.jira;
    initTracker(config, recoveryCustomParams(params));
    var scm = scmModule.createScm(config);
    var pr = findMergedPRForTicket(scm, ticketKey);

    if (!pr) {
        console.log('No merged PR found for', ticketKey);
        return { success: true, action: 'none' };
    }

    var identity = prIdentity(pr);
    var prNumber = identity.number;
    var prUrl = identity.url;
    console.log('Recovered merged PR #' + prNumber + ' for ' + ticketKey);

    moveTicketToMerged(ticketKey, jiraConfig.statuses.MERGED);

    removeRecoveryLabels(ticketKey);

    postRecoveryComment(ticketKey, prNumber, prUrl, jiraConfig.statuses.MERGED);

    postRunTokenUsage(params, ticketKey);

    return { success: true, action: 'moved_to_merged', prNumber: prNumber };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        findMergedPRForTicket: findMergedPRForTicket,
        firstOpenMatchingPR: firstOpenMatchingPR,
        firstMergedClosedPR: firstMergedClosedPR,
        prMatchesTicket: prMatchesTicket,
        isMergedPR: isMergedPR,
        prIdentity: prIdentity,
        recoveryCustomParams: recoveryCustomParams
    };
}
