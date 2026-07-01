/**
 * resolveRepoNameToFile.js
 * preJSAction for story_development_redirect.json
 *
 * Extracts [repo] from ticket summary and writes:
 *   .dmtools-target-repo   — repo name (e.g. "gens-igt")
 *   .dmtools-target-ticket — ticket key (e.g. "GENSGENP-52971")
 *
 * The redirect shell script reads these files to call the correct per-repo agent.
 * Using disk files because preJSAction and cliCommands are separate processes.
 */

function action(params) {
    var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
    var folder = actualParams.inputFolderPath || '';
    var ticketKey = folder.split('/').pop() || '';

    // Try to get ticket from params, fallback to jira_get_ticket
    var ticket = params.ticket || actualParams.ticket;
    if (!ticket || !ticket.fields) {
        try {
            ticket = jira_get_ticket({ key: ticketKey });
        } catch (e) {
            console.warn('resolveRepoNameToFile: could not fetch ticket:', e);
        }
    }

    var summary = (ticket && ticket.fields && ticket.fields.summary)
        ? ticket.fields.summary.toString()
        : '';

    // Extract first [bracket-tag] from summary
    var bracketEnd = summary.indexOf(']');
    if (summary.charAt(0) !== '[' || bracketEnd === -1) {
        console.error('resolveRepoNameToFile: no [repo] tag found in summary: "' + summary + '"');
        return false;
    }
    var repoName = summary.substring(1, bracketEnd).trim();

    if (!repoName) {
        console.error('resolveRepoNameToFile: empty repo name in summary: "' + summary + '"');
        return false;
    }

    file_write({ path: '.dmtools-target-repo', content: repoName });
    file_write({ path: '.dmtools-target-ticket', content: ticketKey });
    console.log('resolveRepoNameToFile: repo=' + repoName + ', ticket=' + ticketKey);
    return true;
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
