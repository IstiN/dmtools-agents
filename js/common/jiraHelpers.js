/**
 * Common Tracker Helper Functions
 * Shared utilities for ticket operations (Jira, ADO, Rally).
 */

const { STATUSES, LABELS } = require('../config.js');
const trackerHelper = require('./tracker.js');

/**
 * Assign ticket to initiator and move to "In Review" status with AI-generated label.
 *
 * @param {string} ticketKey   - The ticket key
 * @param {string} initiatorId - Account ID of the person to assign the ticket to
 * @param {string} wipLabel    - Optional WIP label to remove after processing
 * @param {string} targetStatus
 * @param {Object} [config]    - Optional project config (for tracker type detection)
 * @returns {Object} Result object with success status and message
 */
function assignForReview(ticketKey, initiatorId, wipLabel, targetStatus, config) {
    const statusName = targetStatus || STATUSES.IN_REVIEW;
    try {
        console.log("Processing ticket:", ticketKey);

        tracker_assign_ticket({
            key: ticketKey,
            accountId: initiatorId
        });

        tracker_move_to_status({
            key: ticketKey,
            statusName: statusName
        });

        trackerHelper.addLabel(ticketKey, LABELS.AI_GENERATED, config);

        if (wipLabel) {
            try {
                trackerHelper.removeLabel(ticketKey, wipLabel, config);
                console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
            } catch (labelError) {
                console.warn('Failed to remove WIP label "' + wipLabel + '":', labelError);
            }
        }

        console.log('✅ Assigned to initiator and moved to ' + statusName);

        return {
            success: true,
            message: 'Ticket ' + ticketKey + ' assigned and moved to ' + statusName
        };

    } catch (error) {
        console.error("❌ Error in assignForReview:", error);
        return {
            success: false,
            error: error.toString()
        };
    }
}

/**
 * Extract ticket key from tracker API response.
 *
 * @param {string|Object} result - API response
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
 * Set priority on a ticket.
 *
 * @param {string} ticketKey - The ticket key
 * @param {string} priority  - Priority name (e.g., 'Low', 'Medium', 'High')
 * @param {Object} [config]  - Optional project config (for tracker type detection)
 * @returns {boolean} True if successful, false otherwise
 */
function setTicketPriority(ticketKey, priority, config) {
    if (!ticketKey || !priority) {
        return false;
    }

    try {
        trackerHelper.setPriority(ticketKey, priority, config);
        console.log('Set priority ' + priority + ' on ticket ' + ticketKey);
        return true;
    } catch (priorityError) {
        console.error('Failed to set priority on ticket ' + ticketKey + ':', priorityError);
        return false;
    }
}

module.exports = {
    assignForReview,
    extractTicketKey,
    setTicketPriority
};
