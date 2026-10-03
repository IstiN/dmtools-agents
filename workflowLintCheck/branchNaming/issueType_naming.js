/**
 * Issue-type-based branch naming strategy.
 *
 * Produces: <issueType>/<TICKET-KEY>
 *   e.g.  bug/PROJ-123   story/PROJ-456   task/PROJ-789
 *
 * Usage in agent customParams:
 *   "branchNamingFnPath": "agents/js/branchNaming/issueType_naming.js"
 *
 * Works for all branchRoles (development, feature, test) — always derives
 * prefix from the ticket's issue type.  Suitable for projects that want
 * every branch named after its Jira issue type rather than a fixed prefix.
 */
module.exports = function(ticket, branchRole) {
    var issueType = (
        ticket &&
        ticket.fields &&
        ticket.fields.issuetype &&
        ticket.fields.issuetype.name
    ) || 'feature';
    return issueType.toLowerCase() + '/' + ticket.key;
};
