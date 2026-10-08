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

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const jiraConfig = projectConfig.jira;
    const tracker = trackersModule.createTracker(projectConfig, customParams || {});

    function releaseLock() {
        if (ticketKey && removeLabel) {
            try {
                tracker.removeLabel(ticketKey, removeLabel);
                console.log('Released SM label — will re-check next cycle');
            } catch (e) {
                console.warn('Failed to remove SM label:', e);
            }
        }
    }

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Task done check for', ticketKey, '===');

        // JQL text: provider-specific query (WIQL on ado)
        // Step 1: Count all linked Stories and Bugs
        const allItems = tracker.searchIssues('issue in linkedIssues("' + ticketKey + '") AND issuetype in (Story, Bug)', { maxResults: 100 }) || [];
        const totalItems = allItems.length;
        console.log('Linked Stories + Bugs:', totalItems);

        if (totalItems === 0) {
            console.log('No linked Stories or Bugs found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_stories', ticketKey };
        }

        // Step 2: Find linked Stories/Bugs NOT yet Done
        const notDoneItems = tracker.searchIssues('issue in linkedIssues("' + ticketKey + '") AND issuetype in (Story, Bug) AND status != "' + jiraConfig.statuses.DONE + '"', { maxResults: 1 }) || [];
        const notDoneCount = notDoneItems.length;
        console.log('Stories/Bugs not yet Done:', notDoneCount, '/', totalItems);

        if (notDoneCount > 0) {
            console.log('Not all Stories/Bugs done — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', total: totalItems, notDone: notDoneCount, ticketKey };
        }

        // Step 3: All Stories/Bugs Done → move Task to Ready For Testing
        console.log('All', totalItems, 'Story/Bug(s) done — moving', ticketKey, 'to Ready For Testing');

        tracker.moveToStatus(ticketKey, jiraConfig.statuses.READY_FOR_TESTING);

        tracker.postComment(ticketKey, 'h3. ✅ Task Complete — All Stories & Bugs Done\n\n' +
                'All *' + totalItems + '* linked Story/Bug(s) are in *Done* status.\n\n' +
                'The task has been automatically moved to *Ready For Testing*.'
        );

        console.log('✅ Task', ticketKey, 'moved to Ready For Testing');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, tracker: tracker });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return { success: true, action: 'moved_to_ready_for_testing', total: totalItems, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkTaskStoriesDone:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
