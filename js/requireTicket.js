/**
 * Require Ticket Pre-Action
 *
 * preJSAction for agents that have no other early guard (story_questions,
 * discovery, story_acceptance_criteria, story_acceptance_criterias).
 *
 * Validates that:
 *  1. inputJql contains a properly-formatted Jira ticket key (prevents
 *     injection and catches placeholder defaults like "key = JD-82").
 *  2. That ticket actually exists in Jira (aborts early with a clear error
 *     instead of silently processing a non-existent ticket).
 *
 * GraalJS-compatible: var declarations, plain functions, no arrow functions.
 */

var validateInputJql = require('./common/validateInputJql.js');

function action(params) {
    validateInputJql.validateAndRequireTicket(params);
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
