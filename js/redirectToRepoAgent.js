/**
 * redirectToRepoAgent.js
 * preJSAction for story_development_redirect*.json
 *
 * Extracts [repo] from ticket summary, then runs:
 *   dmtools run "{repo}/{targetAgentName}" --inputJql "key={ticketKey}"
 *
 * customParams.targetAgentName controls which agent to delegate to
 * (e.g. "story_development.json" or "story_development_test.json").
 *
 * Returns false to abort own processing — target agent handles everything.
 */

function action(params) {
    var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
    var folder = actualParams.inputFolderPath || '';
    var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams || {};
    var targetAgentName = customParams.targetAgentName || 'story_development.json';

    var ticket = params.ticket || actualParams.ticket;
    if (!ticket || !ticket.fields) {
        var keyFromFolder = folder.split('/').pop() || '';
        try {
            ticket = jira_get_ticket({ key: keyFromFolder });
        } catch (e) {
            console.error('redirectToRepoAgent: could not fetch ticket: ' + e);
            return false;
        }
    }

    // ticket.key is the authoritative source — inputFolderPath may be empty when ticketContextDepth=0
    var ticketKey = (ticket && ticket.key) ? ticket.key : (folder.split('/').pop() || '');

    var summary = (ticket && ticket.fields && ticket.fields.summary)
        ? ticket.fields.summary.toString()
        : '';

    var bracketEnd = summary.indexOf(']');
    if (summary.charAt(0) !== '[' || bracketEnd === -1) {
        console.error('redirectToRepoAgent: no [repo] tag found in summary: "' + summary + '"');
        return false;
    }
    var repoName = summary.substring(1, bracketEnd).trim();
    var agent = repoName + '/' + targetAgentName;

    console.log('redirectToRepoAgent: ' + ticketKey + ' \u2192 ' + agent);

    try {
        cli_execute_command({ command: 'dmtools run "' + agent + '" --inputJql "key=' + ticketKey + '"' });
    } catch (e) {
        console.error('redirectToRepoAgent: failed to run ' + agent + ': ' + e);
        return false;
    }

    return false;
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
