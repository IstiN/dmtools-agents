/**
 * redirectToRepoAgent.js
 * preJSAction for story_development_redirect*.json
 *
 * Extracts [repo] from ticket summary, then runs:
 *   dmtools run "{repo}/{targetAgentName}" --inputJql "key={ticketKey}" --debug
 *
 * customParams.targetAgentName controls which agent to delegate to
 * (e.g. "story_development.json" or "story_development_test.json").
 *
 * IMPORTANT: --debug is required here. Without it, dmtools' launcher selects
 * log4j2-cli.xml (Root level OFF) for this nested process, which silently
 * discards EVERY java-side logger.info()/warn() call — including
 * CliExecutionHelper's "Executing CLI command: ..." announcement and, more
 * importantly, CommandLineUtils.runCommand()'s real-time streaming of the
 * actual CLI agent's (Copilot/etc.) own stdout via logger.info(line). Only
 * plain JS console.log() calls (which bypass log4j, writing straight to
 * System.out) would have survived — making it look like the CLI agent never
 * ran at all, when it may well have, just with zero visibility.
 *
 * Returns false to abort own processing — target agent handles everything.
 */


// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}

// ── pure parse/build helpers (CRAP gate: each ≤ 8) ──────────────────────────

// Last path segment of the input folder — the ticket key container.
function folderKey(folder) {
    return (folder || '').split('/').pop() || '';
}

// customParams as seen by this action: jobParams win, then the params body.
function customParamsOf(params, actualParams) {
    return (params.jobParams && params.jobParams.customParams) || actualParams.customParams || {};
}

// CI run URL forwarded to the target agent for ticket↔run tracing.
function ciRunUrlOf(params, actualParams) {
    return actualParams.ciRunUrl || params.ciRunUrl || (params.jobParams && params.jobParams.ciRunUrl) || '';
}

// Everything action() needs to know about the incoming dmtools params.
function resolveRunScope(params) {
    var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
    var customParams = customParamsOf(params, actualParams);
    return {
        actualParams: actualParams,
        folder: actualParams.inputFolderPath || '',
        customParams: customParams,
        targetAgentName: customParams.targetAgentName || 'story_development.json',
        agentsDir: customParams.repoAgentsDir || 'repo-agents',
        ciRunUrl: ciRunUrlOf(params, actualParams)
    };
}

// Ticket key: the ticket itself is authoritative, the folder is the fallback.
function ticketKeyOf(ticket, folder) {
    return (ticket && ticket.key) ? ticket.key : folderKey(folder);
}

// Summary string of a fetched ticket, '' when the shape is unexpected.
function summaryOf(ticket) {
    return (ticket && ticket.fields && ticket.fields.summary)
        ? ticket.fields.summary.toString()
        : '';
}

// [repo] tag parsed from the summary — null when absent or malformed.
function repoTagOf(summary) {
    if (!summary || summary.charAt(0) !== '[') return null;
    var bracketEnd = summary.indexOf(']');
    if (bracketEnd === -1) return null;
    return summary.substring(1, bracketEnd).trim();
}

// The nested dmtools run command (— --debug keeps java-side logging visible).
function buildRunCommand(agent, ticketKey, ciRunUrl) {
    var command = 'dmtools --debug run "' + agent + '" --inputJql "key=' + ticketKey + '"';
    if (ciRunUrl) {
        command += ' --ciRunUrl "' + ciRunUrl + '"';
    }
    return command;
}

function action(params) {
    var scope = resolveRunScope(params);
    initTracker(null, scope.customParams);

    var ticket = params.ticket || scope.actualParams.ticket;
    if (!ticket || !ticket.fields) {
        try {
            ticket = getTracker().getIssue(folderKey(scope.folder));
        } catch (e) {
            console.error('redirectToRepoAgent: could not fetch ticket: ' + e);
            return false;
        }
    }

    var ticketKey = ticketKeyOf(ticket, scope.folder);
    var summary = summaryOf(ticket);
    var repoName = repoTagOf(summary);
    if (!repoName) {
        console.error('redirectToRepoAgent: no [repo] tag found in summary: "' + summary + '"');
        return false;
    }
    var agent = scope.agentsDir + '/' + repoName + '/' + scope.targetAgentName;

    console.log('redirectToRepoAgent: ' + ticketKey + ' \u2192 ' + agent);

    try {
        cli_execute_command({ command: buildRunCommand(agent, ticketKey, scope.ciRunUrl) });
    } catch (e) {
        console.error('redirectToRepoAgent: failed to run ' + agent + ': ' + e);
        return false;
    }

    return false;
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
