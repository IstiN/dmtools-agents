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

// GitHub issue key shapes have a single owner (gh-770):
// common/ticketKeyShapes.js. The gate below consults its isGitHubKeyShape()
// and the extractor builds its alternation from shapeSources() — a local
// copy here would drift the next time a shape is added.
var ticketKeyShapes = require('./ticketKeyShapes.js');

// gh-823: load-time require — a deferred (in-function) require resolves
// against the pack's js/ root only at runtime ("Failed to require module:
// ./trackers.js"); load-time requires resolve file-relative and dmtools
// compile discovers them for the pack closure.
var trackersModule = require('./trackers.js');

// Jira-speak alternation first (uppercase normalization applies), then the
// GitHub shapes so gh-N keys keep their original case — uppercasing would
// mint 'GH-12', a different key from the 'gh-12' the machine loop created.
// (A Jira project literally keyed 'GH' is unaffected: its keys already match
// the Jira shape unchanged.)
var KEY_EXTRACTION_RE = new RegExp(
    'key\\s*(?:=|in\\s*\\()\\s*([A-Z][A-Z0-9_]*-\\d+|' +
    ticketKeyShapes.shapeSources().join('|') + ')',
    'i'
);

// ADO WIQL id filter: `[System.Id] = N` / `[System.Id] in (N)` (spaces inside the brackets and
// any letter case are allowed — WIQL field names are case-insensitive).
var WIQL_ID_RE = /\[\s*System\.Id\s*\]\s*(?:=|in\s*\()\s*(\d+)/i;

/**
 * Extract the ticket key from an inputJql string.
 * Handles "key = KEY", "key in (KEY)", the GitHub key shapes and ADO WIQL id filters.
 * @param {string} jql
 * @returns {string|null}
 */
function extractTicketKeyFromJql(jql) {
    if (!jql || typeof jql !== 'string') return null;
    // Azure DevOps WIQL: `[System.Id] = 1839749`, `[ System.Id ] in (1839749)`, or a full
    // `SELECT ... WHERE [System.Id] = N` — the key is the bare numeric work item id (#804).
    var wiql = jql.match(WIQL_ID_RE);
    if (wiql) return wiql[1];
    var m = jql.match(KEY_EXTRACTION_RE);
    if (!m || !m[1]) return null;
    // The Jira branch is case-insensitive, so it can also match a gh-N key —
    // the shape check therefore decides: GitHub keys return as written (no
    // 'GH-12' minting), everything else is a Jira key and uppercases.
    return ticketKeyShapes.isGitHubKeyShape(m[1]) ? m[1] : m[1].toUpperCase();
}

/**
 * Throw if key is null or does not match an expected ticket key format
 * (Jira PROJECT-123 or a GitHub issue key shape).
 * @param {string|null} key
 */
function validateTicketKeyFormat(key) {
    if (!isValidTicketKey(key)) {
        throw new Error('Invalid or missing ticket key: "' + key +
            '". Expected a Jira key (PROJECT-123), a GitHub issue key (gh-123, owner/repo#123, #123, 123) ' +
            'or an Azure DevOps work item id (123)');
    }
}

/**
 * True when key is a Jira key, a GitHub issue key shape or a bare numeric ADO work item id.
 * The single owner of "what is a ticket key" — buildEncodedConfig uses it too (#804).
 * @param {string|null} key
 * @returns {boolean}
 */
function isValidTicketKey(key) {
    return !!key && (TICKET_KEY_RE.test(key) || ticketKeyShapes.isGitHubKeyShape(key));
}

/**
 * The inputJql that selects exactly one ticket: Jira/GitHub `key = KEY`, ADO a WIQL id filter.
 * @param {string} key  A validated ticket key
 * @param {string} [provider] 'jira' | 'ado' | 'github' (anything else behaves like jira)
 * @returns {string}
 */
function inputJqlForKey(key, provider) {
    if (String(provider || '').toLowerCase() === 'ado') {
        return 'SELECT [System.Id] FROM WorkItems WHERE [System.Id] = ' + key;
    }
    return 'key = ' + key;
}

/**
 * Fetch the ticket via the tracker layer and throw if it does not exist.
 * @param {string} key  Validated ticket key
 * @param {Object} [tracker] optional tracker (defaults to env/jira)
 * @returns {Object}    The ticket object
 */
function requireTicketExists(key, tracker) {
    var ticket;
    try {
        if (!tracker) tracker = trackersModule.createTracker(null, {});
        ticket = tracker.getIssue(key);
    } catch (e) {
        throw new Error('Ticket not found: ' + key + ' — ' + (e.message || e));
    }
    if (!ticket || !ticket.key) {
        throw new Error('Ticket not found: ' + key);
    }
    return ticket;
}

/**
 * Convenience wrapper: read inputJql from params, validate the key format,
 * and verify the ticket exists.
 * @param {Object} params  jobParams or full params block containing inputJql
 * @returns {Object}       The Jira ticket object
 */
function validateAndRequireTicket(params, tracker) {
    var jobParams = (params && params.jobParams) ? params.jobParams : params;
    var inputJql = (jobParams && jobParams.inputJql) || '';
    var key = extractTicketKeyFromJql(inputJql);
    validateTicketKeyFormat(key);
    if (!tracker) {
        var cp = (jobParams && jobParams.customParams) || (params && params.customParams) || {};
        tracker = trackersModule.createTracker(null, cp);
    }
    return requireTicketExists(key, tracker);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        extractTicketKeyFromJql: extractTicketKeyFromJql,
        validateTicketKeyFormat: validateTicketKeyFormat,
        isValidTicketKey: isValidTicketKey,
        inputJqlForKey: inputJqlForKey,
        requireTicketExists: requireTicketExists,
        validateAndRequireTicket: validateAndRequireTicket
    };
}
