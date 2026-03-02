/**
 * Check Subtasks Done For BA — postJSAction for story_ba_check agent.
 *
 * Runs on every SM cycle for each Story in "PO Review".
 * Uses params.ticket.fields.subtasks (loaded with ticketContextDepth:1) so no
 * JQL is needed — avoids issues with parent= filter in this Jira instance.
 *
 * - If all subtasks are Done → moves the Story to "BA Analysis".
 * - Otherwise → removes the SM idempotency label so the SM re-triggers
 *   this check on the next cycle.
 */

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        console.log('=== BA readiness check for', ticketKey, '===');

        const customParams = params.jobParams && params.jobParams.customParams;
        const removeLabel = customParams && customParams.removeLabel;

        function releaseLock() {
            if (removeLabel) {
                try {
                    jira_remove_label({ key: ticketKey, label: removeLabel });
                    console.log('Released SM label — will re-check next cycle');
                } catch (e) {
                    console.warn('Failed to remove SM label:', e);
                }
            }
        }

        // Subtasks are included in the ticket fields (ticketContextDepth: 1)
        const subtasks = (params.ticket.fields && params.ticket.fields.subtasks) || [];
        console.log('Total subtasks:', subtasks.length);

        if (subtasks.length === 0) {
            console.log('No subtasks found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_subtasks', ticketKey };
        }

        const notDone = subtasks.filter(function(st) {
            return !st.fields || !st.fields.status || st.fields.status.name !== 'Done';
        });
        console.log('Subtasks not yet Done:', notDone.length, '/', subtasks.length);

        if (notDone.length > 0) {
            console.log('Not all subtasks done — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', total: subtasks.length, notDone: notDone.length, ticketKey };
        }

        // All subtasks Done → move to BA Analysis
        console.log('All', subtasks.length, 'subtask(s) done — moving', ticketKey, 'to BA Analysis');

        jira_move_to_status({
            key: ticketKey,
            statusName: 'BA Analysis'
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ PO Review Complete — Moving to BA Analysis\n\n' +
                'All *' + subtasks.length + '* subtask(s) are *Done*.\n\n' +
                'The story has been automatically moved to *BA Analysis*.'
        });

        console.log('✅ Story', ticketKey, 'moved to BA Analysis');
        return { success: true, action: 'moved_to_ba_analysis', total: subtasks.length, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkSubtasksDoneForBA:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
