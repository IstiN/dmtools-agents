/**
 * Notify Bug Merged Post-Action
 * postJSAction for bug_merged agent.
 *
 * Called when a Bug PR is merged and the ticket reaches "Merged" status.
 * Posts a Jira comment and removes the SM idempotency label.
 * Status transition to "Ready For Testing" is handled by the SM targetStatus rule.
 */

const { LABELS } = require('./config.js');

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        console.log('=== Bug merged notification for', ticketKey, '===');

        try {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ✅ Bug Fix Merged — Ready for Testing\n\nThe bug fix PR has been merged and the ticket has been moved to *Ready For Testing*.'
            });
            console.log('✅ Posted merge notification to Jira');
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Remove WIP label
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip' : null;
        if (wipLabel) {
            try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
        }

        // Remove SM idempotency label
        const customParams = params.jobParams && params.jobParams.customParams;
        const removeLabel = customParams && customParams.removeLabel;
        if (removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('✅ Removed SM label:', removeLabel);
            } catch (e) {}
        }

        return { success: true, ticketKey };

    } catch (error) {
        console.error('❌ Error in notifyBugMerged:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
