/**
 * Check Task Stories Done — postJSAction for task_done_check agent.
 *
 * Runs on every SM cycle for each intake/in-development Task.
 * Finds all linked Stories/Bugs and checks if they are all Done.
 *
 * - If all linked Stories/Bugs are Done → moves the Task to "Ready For Testing".
 * - If no linked Stories/Bugs exist yet → releases lock (intake may still be running).
 * - Otherwise → removes the SM idempotency label so the SM re-triggers
 *   this check on the next cycle.
 */

const configLoader = require('./configLoader.js');
const trackersModule = require('./common/trackers.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const linkedIssuesReport = require('./common/linkedIssuesReport.js');

function releaseSmLock(tracker, ticketKey, removeLabel) {
    if (!ticketKey || !removeLabel) return;
    try {
        tracker.removeLabel(ticketKey, removeLabel);
        console.log('Released SM label — will re-check next cycle');
    } catch (e) {
        console.warn('Failed to remove SM label:', e);
    }
}

function postTokenUsageSafely(ticketKey, initiator, tracker) {
    tokenUsageComment.postTokenUsageSafely(ticketKey, null, { initiator: initiator, tracker: tracker });
}

function moveTaskToReadyForTesting(tracker, jiraConfig, ticketKey, totalItems) {
    var moveResult = tracker.moveToStatusOrMark(ticketKey, jiraConfig.statuses.READY_FOR_TESTING, 'READY_FOR_TESTING');
    if (moveResult.moved || moveResult.marked) {
        tracker.postComment(ticketKey, 'h3. ✅ Task Complete — All Stories & Bugs Done\n\n' +
                'All *' + totalItems + '* linked Story/Bug(s) are in *Done* status.\n\n' +
                'The task has been automatically moved to *Ready For Testing*.'
        );
        console.log('✅ Task', ticketKey, 'moved to Ready For Testing');
    }
}

function runTaskDoneCheck(tracker, jiraConfig, ticketKey, removeLabel, initiator) {
    console.log('=== Task done check for', ticketKey, '===');
    var allQuery = linkedIssuesReport.buildLinkedIssuesQuery(tracker.provider(), ticketKey, 'issuetype in (Story, Bug)', { issueTypes: ['Story', 'Bug'] });
    var allItems = tracker.searchIssues(allQuery, { maxResults: 100 }) || [];
    var totalItems = allItems.length;
    console.log('Linked Stories + Bugs:', totalItems);

    if (totalItems === 0) {
        console.log('No linked Stories or Bugs found — releasing lock, will re-check next cycle');
        releaseSmLock(tracker, ticketKey, removeLabel);
        return { success: true, action: 'no_stories', ticketKey: ticketKey };
    }

    var notDoneQuery = linkedIssuesReport.buildLinkedIssuesQuery(tracker.provider(), ticketKey, 'issuetype in (Story, Bug) AND status != "' + jiraConfig.statuses.DONE + '"', { issueTypes: ['Story', 'Bug'], statusNotEquals: jiraConfig.statuses.DONE });
    var notDoneItems = tracker.searchIssues(notDoneQuery, { maxResults: 1 }) || [];
    var notDoneCount = notDoneItems.length;
    console.log('Stories/Bugs not yet Done:', notDoneCount, '/', totalItems);

    if (notDoneCount > 0) {
        console.log('Not all Stories/Bugs done — releasing lock, will re-check next cycle');
        releaseSmLock(tracker, ticketKey, removeLabel);
        return { success: true, action: 'waiting', total: totalItems, notDone: notDoneCount, ticketKey: ticketKey };
    }

    console.log('All', totalItems, 'Story/Bug(s) done — moving', ticketKey, 'to Ready For Testing');
    moveTaskToReadyForTesting(tracker, jiraConfig, ticketKey, totalItems);
    postTokenUsageSafely(ticketKey, initiator, tracker);
    return { success: true, action: 'moved_to_ready_for_testing', total: totalItems, ticketKey: ticketKey };
}

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const jiraConfig = projectConfig.jira;
    const tracker = trackersModule.createTracker(projectConfig, customParams || {});

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        return runTaskDoneCheck(tracker, jiraConfig, ticketKey, removeLabel, params.initiator);
    } catch (error) {
        console.error('❌ Error in checkTaskStoriesDone:', error);
        releaseSmLock(tracker, ticketKey, removeLabel);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
