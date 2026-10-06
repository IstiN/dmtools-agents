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

// GitHub issue key shapes (gh-770) — same convention list as
// commentMarkup's GITHUB_KEY_SHAPES: 'gh-N' is the machine-loop router key,
// 'owner/repo#N' the composite form, '#N' and bare 'N' appear in dispatch
// payloads. A tracker-agnostic gate must not abort GitHub-backed legs with
// "Invalid or missing Jira ticket key".
var GITHUB_KEY_SHAPES = [
    /^gh-\d+$/i,
    /^[\w.-]+\/[\w.-]+#\d+$/,
    /^#\d+$/,
    /^\d+$/
];

function isGitHubKeyShape(key) {
    var k = String(key == null ? '' : key).trim();
    for (var i = 0; i < GITHUB_KEY_SHAPES.length; i++) {
        if (GITHUB_KEY_SHAPES[i].test(k)) return true;
    }
    return false;
}

/**
 * Extract the ticket key from an inputJql string.
 * Handles "key = KEY", "key in (KEY)" and the GitHub key shapes.
 * @param {string} jql
 * @returns {string|null}
 */
function extractTicketKeyFromJql(jql) {
    if (!jql || typeof jql !== 'string') return null;
    // GitHub shapes are matched FIRST so gh-N keys keep their original case —
    // uppercasing would mint 'GH-12', a different key from the 'gh-12' the
    // machine loop created. (A Jira project literally keyed 'GH' is unaffected:
    // its keys already match the Jira shape unchanged.)
    var gh = jql.match(/key\s*(?:=|in\s*\()\s*(gh-\d+|[\w.-]+\/[\w.-]+#\d+|#\d+|\d+)/i);
    if (gh && gh[1]) return gh[1];
    var m = jql.match(/key\s*(?:=|in\s*\()\s*([A-Z][A-Z0-9_]*-\d+)/i);
    return m ? m[1].toUpperCase() : null;
}

/**
 * Throw if key is null or does not match an expected ticket key format
 * (Jira PROJECT-123 or a GitHub issue key shape).
 * @param {string|null} key
 */
function validateTicketKeyFormat(key) {
    if (!key || (!TICKET_KEY_RE.test(key) && !isGitHubKeyShape(key))) {
        throw new Error('Invalid or missing ticket key: "' + key +
            '". Expected a Jira key (PROJECT-123) or a GitHub issue key (gh-123, owner/repo#123, #123, 123)');
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
