/**
 * Recover Failed Test Cases after bug triage.
 *
 * If a Failed TC already has linked non-Done Bugs, it must not stay in Failed
 * waiting for bug_creation again. Move it to Bug To Fix while any linked bug is
 * still active. Done Bugs are historical context only; they must not suppress
 * new bug creation.
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const linkedIssuesReport = require('./common/linkedIssuesReport.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;


function removeLabel(ticketKey, label) {
    if (!ticketKey || !label) return;
    try {
        getTracker().removeLabel(ticketKey, label);
        console.log('Removed label:', label);
    } catch (e) {}
}

function moveFailedTcToBugToFix(ticketKey, jiraConfig) {
    var b2fMove = getTracker().moveToStatusOrMark(ticketKey, jiraConfig.statuses.BUG_TO_FIX, 'BUG_TO_FIX');
    if (b2fMove.moved || b2fMove.marked) {
        console.log('Moved', ticketKey, 'to', jiraConfig.statuses.BUG_TO_FIX);
    }
    removeLabel(ticketKey, 'sm_bug_creation_triggered');
    removeLabel(ticketKey, 'sm_bulk_bugs_creation_triggered');
    removeLabel(ticketKey, 'sm_test_automation_triggered');
    getTracker().postComment(ticketKey, 'h3. 🐛 Linked Non-Done Bug Found — Moved to Bug To Fix\n\n' +
            'This failed test case already has linked non-Done Bug issue(s), so it was moved to *' +
            jiraConfig.statuses.BUG_TO_FIX + '* instead of staying in *Failed* and re-running bug creation.');
}

function postTokenUsageSafely(ticketKey, params) {
    tokenUsageComment.postTokenUsageSafely(ticketKey, params);
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        throw new Error('params.ticket.key is missing');
    }
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    initTracker(projectConfig, (params.jobParams && params.jobParams.customParams) || params.customParams || {});
    var jiraConfig = projectConfig.jira;

    console.log('=== Failed TC bug status recovery for', ticketKey, '===');

    var query = linkedIssuesReport.buildLinkedIssuesQuery(
        getTracker().provider(),
        ticketKey,
        'issuetype = Bug AND status not in ("' + jiraConfig.statuses.DONE + '")',
        { issueType: 'Bug', statusNotIn: [jiraConfig.statuses.DONE] }
    );
    var linkedBugs = getTracker().searchIssues(query, { maxResults: 50 }) || [];

    if (linkedBugs.length === 0) {
        console.log('No linked non-Done Bugs found for', ticketKey);
        removeLabel(ticketKey, 'sm_bug_creation_triggered');
        return { success: true, action: 'released_for_bulk_bug_creation', ticketKey: ticketKey };
    }

    moveFailedTcToBugToFix(ticketKey, jiraConfig);
    postTokenUsageSafely(ticketKey, params);

    return {
        success: true,
        action: 'moved_to_bug_to_fix',
        ticketKey: ticketKey,
        linkedBugs: linkedBugs.length
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
