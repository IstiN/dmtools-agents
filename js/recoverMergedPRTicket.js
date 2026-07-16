/**
 * Recover Jira tickets whose GitHub PR was already merged while Jira stayed in
 * a review/rework status.
 */

const { LABELS } = require('./config.js');
var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackerHelper = require('./common/tracker.js');

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

function findMergedPRForTicket(scm, ticketKey) {
    try {
        var open = scm.listPrs('open') || [];
        for (var openIndex = 0; openIndex < open.length; openIndex++) {
            if (prMatchesTicket(open[openIndex], ticketKey)) {
                console.log('Open PR still exists for ' + ticketKey + ', skipping merged-PR recovery: #' + open[openIndex].number);
                return null;
            }
        }
    } catch (openError) {
        console.warn('Could not list open PRs for merged recovery guard:', openError.message || openError);
        return null;
    }

    var closed = [];
    try {
        closed = scm.listPrs('closed') || [];
    } catch (e) {
        console.warn('Could not list closed PRs:', e.message || e);
        return null;
    }

    for (var i = 0; i < closed.length; i++) {
        if (prMatchesTicket(closed[i], ticketKey) && isMergedPR(closed[i])) {
            return closed[i];
        }
    }
    return null;
}

function removeLabel(ticketKey, label) {
    if (!ticketKey || !label) return;
    try {
        trackerHelper.removeLabel(ticketKey, label);
        console.log('Removed label from Jira:', label);
    } catch (e) {}
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        console.error('No ticket key provided');
        return { success: false, action: 'missing_ticket' };
    }

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var trackerConfig = config.tracker;
    var scm = scmModule.createScm(config);
    var pr = findMergedPRForTicket(scm, ticketKey);

    if (!pr) {
        console.log('No merged PR found for', ticketKey);
        return { success: true, action: 'none' };
    }

    var prNumber = pr.number || pr.id || '?';
    var prUrl = pr.html_url || pr.url || '';
    console.log('Recovered merged PR #' + prNumber + ' for ' + ticketKey);

    try {
        tracker_move_to_status({ key: ticketKey, statusName: trackerConfig.statuses.MERGED });
        console.log('Moved', ticketKey, 'to', trackerConfig.statuses.MERGED);
    } catch (e) {
        console.warn('Could not move ticket to Merged:', e.message || e);
    }

    removeLabel(ticketKey, LABELS.PR_APPROVED);
    removeLabel(ticketKey, 'sm_pr_merge_triggered');
    removeLabel(ticketKey, 'sm_story_review_triggered');
    removeLabel(ticketKey, 'sm_story_rework_triggered');

    try {
        tracker_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Merged PR Recovered\n\n' +
                'Found already merged PR #' + prNumber + (prUrl ? ' — [View PR|' + prUrl + ']' : '') +
                '. Ticket moved to *' + trackerConfig.statuses.MERGED + '* so the normal post-merge pipeline can continue.'
        });
    } catch (e) {}

    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run.
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }

    return { success: true, action: 'moved_to_merged', prNumber: prNumber };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, findMergedPRForTicket, prMatchesTicket, isMergedPR };
}
