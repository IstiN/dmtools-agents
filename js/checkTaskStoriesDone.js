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
const smDoneCheck = require('./common/smDoneCheck.js');

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
        smDoneCheck.releaseSmLock(tracker, ticketKey, removeLabel);
        return { success: true, action: 'no_stories', ticketKey: ticketKey };
    }

    var notDoneQuery = linkedIssuesReport.buildLinkedIssuesQuery(tracker.provider(), ticketKey, 'issuetype in (Story, Bug) AND status != "' + jiraConfig.statuses.DONE + '"', { issueTypes: ['Story', 'Bug'], statusNotEquals: jiraConfig.statuses.DONE });
    var notDoneItems = tracker.searchIssues(notDoneQuery, { maxResults: 1 }) || [];
    var notDoneCount = notDoneItems.length;
    console.log('Stories/Bugs not yet Done:', notDoneCount, '/', totalItems);

    if (notDoneCount > 0) {
        return smDoneCheck.waitingResult(
            tracker,
            ticketKey,
            removeLabel,
            'Not all Stories/Bugs done — releasing lock, will re-check next cycle',
            totalItems,
            notDoneCount
        );
    }

    console.log('All', totalItems, 'Story/Bug(s) done — moving', ticketKey, 'to Ready For Testing');
    moveTaskToReadyForTesting(tracker, jiraConfig, ticketKey, totalItems);
    tokenUsageComment.postTokenUsageCommentsSafely(ticketKey, { initiator: initiator, tracker: tracker });
    return { success: true, action: 'moved_to_ready_for_testing', total: totalItems, ticketKey: ticketKey };
}

function action(params) {
    return smDoneCheck.runDoneCheckAction(params, function(tracker, projectConfig, ticketKey, removeLabel, initiator) {
        return runTaskDoneCheck(tracker, projectConfig.jira, ticketKey, removeLabel, initiator);
    }, 'checkTaskStoriesDone', configLoader, trackersModule);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
