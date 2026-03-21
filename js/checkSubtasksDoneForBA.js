/**
 * Check Subtasks Done For BA — postJSAction for story_ba_check agent.
 *
 * Runs on every SM cycle for each Story in "PO Review".
 * Fetches subtasks via JQL (jira_search_by_jql returns a plain array).
 *
 * - If all subtasks are Done → moves the Story to "BA Analysis".
 * - Otherwise → removes the SM idempotency label so the SM re-triggers
 *   this check on the next cycle.
 *
 * Configurable via .dmtools/config.js:
 *   jira.questions.fetchJql     — JQL to find question subtasks ({ticketKey} placeholder)
 *   jira.statuses.BA_ANALYSIS   — target status name (default: 'BA Analysis')
 */

var configLoader = require('./configLoader.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;

    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const questionsJql = projectConfig.jira.questions.fetchJql;
    const baAnalysisStatus = projectConfig.jira.statuses.BA_ANALYSIS;
    const subtaskIssueType = projectConfig.jira.issueTypes.SUBTASK;

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
        console.log('=== BA readiness check for', ticketKey, '===');

        // Step 1: Fetch subtasks via JQL — jira_search_by_jql returns a plain array
        const allJql = questionsJql.replace('{ticketKey}', ticketKey);
        const subtasks = jira_search_by_jql({
            jql: allJql,
            maxResults: 100
        }) || [];
        const totalSubtasks = subtasks.length;
        console.log('Total subtasks:', totalSubtasks);

        if (totalSubtasks === 0) {
            console.log('No subtasks found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_subtasks', ticketKey };
        }

        // Step 2: Find subtasks NOT yet Done via JQL (more reliable than client-side field check)
        const notDoneSubtasks = jira_search_by_jql({
            jql: allJql.replace('ORDER BY created ASC', '') + ' AND status != "Done"',
            maxResults: 1
        }) || [];
        const notDoneCount = notDoneSubtasks.length;
        console.log('Subtasks not yet Done:', notDoneCount, '/', totalSubtasks);

        if (notDoneCount > 0) {
            console.log('Not all subtasks done — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', total: totalSubtasks, notDone: notDoneCount, ticketKey };
        }

        // All subtasks Done → move to BA Analysis
        console.log('All', totalSubtasks, 'subtask(s) done — moving', ticketKey, 'to', baAnalysisStatus);

        jira_move_to_status({
            key: ticketKey,
            statusName: baAnalysisStatus
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ PO Review Complete — Moving to ' + baAnalysisStatus + '\n\n' +
                'All *' + totalSubtasks + '* subtask(s) are *Done*.\n\n' +
                'The story has been automatically moved to *' + baAnalysisStatus + '*.'
        });

        console.log('✅ Story', ticketKey, 'moved to BA Analysis');
        return { success: true, action: 'moved_to_ba_analysis', total: totalSubtasks, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkSubtasksDoneForBA:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
