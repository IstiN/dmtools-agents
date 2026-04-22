/**
 * Check Task Stories Done — postJSAction for task_done_check agent.
 *
 * Runs on every SM cycle for each Task in "In Development".
 * Finds all child Stories (parent = ticketKey) and checks if they are all Done.
 *
 * - If all child Stories are Done → moves the Task to "Ready For Testing".
 * - If no Stories exist yet → releases lock (intake may still be running).
 * - Otherwise → removes the SM idempotency label so the SM re-triggers
 *   this check on the next cycle.
 */

const { STATUSES } = require('./config.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;

    function releaseLock() {
        if (ticketKey && removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('Released SM label — will re-check next cycle');
            } catch (e) {
                console.warn('Failed to remove SM label:', e);
            }
        }
    }

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Task done check for', ticketKey, '===');

        // Step 1: Count all linked Stories and Bugs
        const allItems = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype in (Story, Bug)',
            maxResults: 100
        }) || [];
        const totalItems = allItems.length;
        console.log('Linked Stories + Bugs:', totalItems);

        if (totalItems === 0) {
            console.log('No linked Stories or Bugs found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_stories', ticketKey };
        }

        // Step 2: Find linked Stories/Bugs NOT yet Done
        const notDoneItems = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype in (Story, Bug) AND status != "Done"',
            maxResults: 1
        }) || [];
        const notDoneCount = notDoneItems.length;
        console.log('Stories/Bugs not yet Done:', notDoneCount, '/', totalItems);

        if (notDoneCount > 0) {
            console.log('Not all Stories/Bugs done — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', total: totalItems, notDone: notDoneCount, ticketKey };
        }

        // Step 3: All Stories/Bugs Done → move Task to Ready For Testing
        console.log('All', totalItems, 'Story/Bug(s) done — moving', ticketKey, 'to Ready For Testing');

        jira_move_to_status({
            key: ticketKey,
            statusName: STATUSES.READY_FOR_TESTING
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Task Complete — All Stories & Bugs Done\n\n' +
                'All *' + totalItems + '* linked Story/Bug(s) are in *Done* status.\n\n' +
                'The task has been automatically moved to *Ready For Testing*.'
        });

        console.log('✅ Task', ticketKey, 'moved to Ready For Testing');
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
