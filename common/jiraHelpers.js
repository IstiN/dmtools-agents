/**
 * Common Jira Helper Functions
 * Shared utilities for Jira ticket operations
 */

var configModule = require('../js/config.js');
var trackersModule = require('../js/common/trackers.js');

/**
 * Assign ticket to initiator and move to "In Review" status with AI-generated label
 * This is the common post-processing logic used by multiple agents
 * 
 * @param {string} ticketKey - The ticket key
 * @param {string} initiatorId - Account ID of the person to assign the ticket to
 * @param {string} [wipLabel] - Optional WIP label to remove after processing
 * @param {string} [targetStatus] - Optional status name (defaults to "In Review")
 * @param {Object} [tracker] - Optional tracker instance from js/common/trackers.js
 * @returns {Object} Result object with success status and message
 */
function assignForReview(ticketKey, initiatorId, wipLabel, targetStatus, tracker) {
    var statusName = targetStatus || configModule.STATUSES.IN_REVIEW;
    try {
        var t = tracker || trackersModule.createTracker(null, {});
        return t.assignForReview(ticketKey, initiatorId, wipLabel, statusName);
    } catch (error) {
        console.error('❌ Error in assignForReview:', error);
        return {
            success: false,
            error: error.toString()
        };
    }
}

/**
 * Extract ticket key from tracker API response
 * 
 * @param {string|Object} result - Tracker API response
 * @returns {string|null} Extracted ticket key or null if not found
 */
function extractTicketKey(result) {
    if (!result) {
        return null;
    }
    if (typeof result === 'string') {
        try {
            var parsed = JSON.parse(result);
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
 * Set priority on a ticket using the appropriate tracker API
 * 
 * @param {string} ticketKey - The ticket key
 * @param {string} priority - Priority name (e.g., 'Low', 'Medium', 'High')
 * @param {Object} [tracker] - Optional tracker instance from js/common/trackers.js
 * @returns {boolean} True if successful, false otherwise
 */
function setTicketPriority(ticketKey, priority, tracker) {
    if (!ticketKey || !priority) {
        return false;
    }

    try {
        var t = tracker || trackersModule.createTracker(null, {});
        t.setPriority(ticketKey, priority);
        console.log('Set priority ' + priority + ' on ticket ' + ticketKey);
        return true;
    } catch (priorityError) {
        console.error('Failed to set priority on ticket ' + ticketKey + ':', priorityError);
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        assignForReview: assignForReview,
        extractTicketKey: extractTicketKey,
        setTicketPriority: setTicketPriority
    };
}
