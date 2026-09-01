/**
 * Validates the ticket key embedded in an inputJql string, and verifies the
 * ticket actually exists in Jira.  Call this from a preJSAction so the agent
 * aborts with a clear error instead of silently processing a missing or
 * placeholder ticket (e.g. the default "key = JD-82").
 *
 * GraalJS-compatible: var declarations, plain functions, no arrow functions.
 */

// Accepts PROJECT-123 or PROJECT_CODE-123 (uppercase project key, numeric id)
var TICKET_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * Extract the ticket key from an inputJql string.
 * Handles both "key = PROJ-1" and "key in (PROJ-1)" forms.
 * @param {string} jql
 * @returns {string|null}
 */
function extractTicketKeyFromJql(jql) {
    if (!jql || typeof jql !== 'string') return null;
    var m = jql.match(/key\s*(?:=|in\s*\()\s*([A-Z][A-Z0-9_]*-\d+)/i);
    return m ? m[1].toUpperCase() : null;
}

/**
 * Throw if key is null or does not match the expected Jira key format.
 * @param {string|null} key
 */
function validateTicketKeyFormat(key) {
    if (!key || !TICKET_KEY_RE.test(key)) {
        throw new Error('Invalid or missing Jira ticket key: "' + key + '". Expected format: PROJECT-123');
    }
}

/**
 * Fetch the ticket via jira_get_ticket and throw if it does not exist.
 * @param {string} key  Validated Jira ticket key
 * @returns {Object}    The Jira ticket object
 */
function requireTicketExists(key) {
    var ticket;
    try {
        ticket = jira_get_ticket({ key: key });
    } catch (e) {
        throw new Error('Jira ticket not found: ' + key + ' — ' + (e.message || e));
    }
    if (!ticket || !ticket.key) {
        throw new Error('Jira ticket not found: ' + key);
    }
    return ticket;
}

/**
 * Convenience wrapper: read inputJql from params, validate the key format,
 * and verify the ticket exists.
 * @param {Object} params  jobParams or full params block containing inputJql
 * @returns {Object}       The Jira ticket object
 */
function validateAndRequireTicket(params) {
    var jobParams = (params && params.jobParams) ? params.jobParams : params;
    var inputJql = (jobParams && jobParams.inputJql) || '';
    var key = extractTicketKeyFromJql(inputJql);
    validateTicketKeyFormat(key);
    return requireTicketExists(key);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        extractTicketKeyFromJql: extractTicketKeyFromJql,
        validateTicketKeyFormat: validateTicketKeyFormat,
        requireTicketExists: requireTicketExists,
        validateAndRequireTicket: validateAndRequireTicket
    };
}
