/**
 * Simple Assign For Review Action
 * Assigns ticket to initiator and moves to "In Review" status
 */

// Import common Jira helper functions
const { assignForReview } = require('./common/jiraHelpers.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const initiatorId = params.initiator;
        
        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        // Use common assignForReview function
        return assignForReview(ticketKey, initiatorId);
        
    } catch (error) {
        console.error("❌ Error:", error);
        return {
            success: false,
            error: error.toString()
        };
    }
}
