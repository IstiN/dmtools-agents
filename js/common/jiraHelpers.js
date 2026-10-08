/**
 * Common Jira Helper Functions
 * Shared utilities for Jira ticket operations
 */

const { STATUSES, LABELS } = require('../config.js');

/**
 * Assign ticket to initiator and move to "In Review" status with AI-generated label
 * This is the common post-processing logic used by multiple agents
 * 
 * @param {string} ticketKey - The Jira ticket key
 * @param {string} initiatorId - Account ID of the person to assign the ticket to
 * @param {string} wipLabel - Optional WIP label to remove after processing
 * @returns {Object} Result object with success status and message
 */
function assignForReview(ticketKey, initiatorId, wipLabel, targetStatus, tracker) {
    const statusName = targetStatus || STATUSES.IN_REVIEW;
    try {
        const t = tracker || require('./trackers.js').createTracker(null, {});
        return t.assignForReview(ticketKey, initiatorId, wipLabel, statusName);
    } catch (error) {
        console.error("❌ Error in assignForReview:", error);
        return {
            success: false,
            error: error.toString()
        };
    }
}

/**
 * Extract ticket key from Jira API response
 * 
 * @param {string|Object} result - Jira API response
 * @returns {string|null} Extracted ticket key or null if not found
 */
function extractTicketKey(result) {
    if (!result) {
        return null;
    }
    if (typeof result === 'string') {
        try {
            const parsed = JSON.parse(result);
            return parsed && parsed.key ? parsed.key : null;
        } catch (error) {
            return null;
        }
    }
    if (typeof result === 'object' && typeof result.key === 'string') {
        return result.key;
    }
    return null;
}

/**
 * Set priority on a Jira ticket using the appropriate API
 * 
 * @param {string} ticketKey - The Jira ticket key
 * @param {string} priority - Priority name (e.g., 'Low', 'Medium', 'High')
 * @returns {boolean} True if successful, false otherwise
 */
function setTicketPriority(ticketKey, priority, tracker) {
    if (!ticketKey || !priority) {
        return false;
    }
    
    try {
        const t = tracker || require('./trackers.js').createTracker(null, {});
        t.setPriority(ticketKey, priority);
        console.log('Set priority ' + priority + ' on ticket ' + ticketKey);
        return true;
    } catch (priorityError) {
        console.error('Failed to set priority on ticket ' + ticketKey + ':', priorityError);
        return false;
    }
}

// Export functions for use by other modules
module.exports = {
    assignForReview,
    extractTicketKey,
    setTicketPriority
};

