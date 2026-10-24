/**
 * Intake Pre-Action
 * 1. Checks for WIP label (returns false to stop processing if found)
 * 2. Fetches existing epics and writes them into the input folder
 *    (file_write creates parent dirs, so this runs before dmtools creates input/<KEY>/)
 */

var epicIntakeFetch = require('./common/epicIntakeFetch.js');
var trackersModule = require('./common/trackers.js');
var configLoader = null;
try { configLoader = require('./configLoader.js'); } catch (e) {}

// ── pure parse/build helpers (CRAP gate: each ≤ 8) ──────────────────────────

// Tracker for this action: the project config loads from the params body and
// the config loader is optional (absent in some packs).
function createTrackerFor(params) {
    return epicIntakeFetch.createTrackerFor(trackersModule, configLoader, params, params);
}

// The WIP label of this agent's context when present on the ticket, null
// otherwise (including when there is no contextId to derive one from).
function wipLabelOn(ticket, metadata) {
    if (!(metadata && metadata.contextId)) {
        console.log('No contextId in metadata, skipping WIP check');
        return null;
    }
    var wipLabel = metadata.contextId + '_wip';
    var labels = ticket.fields && ticket.fields.labels ? ticket.fields.labels : [];

    return labels.includes(wipLabel) ? wipLabel : null;
}

// Best-effort skip notice — a comment failure must not change the outcome.
function postSkipComment(tracker, ticketKey, wipLabel) {
    try {
        tracker.postComment(ticketKey, 'h3. *Processing Skipped*\n\n' +
            'This ticket has the *' + wipLabel + '* label indicating work is in progress.\n' +
            'Processing will be skipped until the label is removed.\n\n' +
            '_Remove the label to allow automated processing._');
    } catch (e) {
        console.warn('Failed to post skip comment:', e);
    }
}

// Diagrams value as it arrives on raw search results.
function rawDiagramsOf(fields) {
    return fields.diagrams || null;
}

// Epic summary shape written to existing_epics.json (from raw search results).
function mapEpic(issue) {
    return epicIntakeFetch.mapEpic(issue, rawDiagramsOf);
}

// Story summary shape written to existing_stories.json (raw search results).
function mapStory(issue) {
    return epicIntakeFetch.mapStory(issue, { diagramsOf: rawDiagramsOf });
}

// Static-analysis hooks (docs-freshness): agentDocGenerator discovers written
// artifacts with literal-path regexes, so each family keeps its concrete file
// name inside the file_write call — a dynamic spec.fileName path would
// collapse the generated "Writes" list to input/<KEY>/ and red the
// docs-freshness CI (pinned in test_configLoader.js).
function writeEpicsFile(inputFolder, payload) {
    file_write(inputFolder + '/existing_epics.json', payload);
}

function writeStoriesFile(inputFolder, payload) {
    file_write(inputFolder + '/existing_stories.json', payload);
}

// Map straight off the search results — no per-issue re-fetch at intake time.
function collectFromSearch(tracker, spec) {
    return tracker.searchIssues(spec.jql, { fields: spec.fields }).map(spec.map);
}

// Search spec for one issue family (provider-specific query: WIQL on ado).
function epicSpec(project) {
    return {
        jql: 'project = ' + project + ' AND issuetype = Epic ORDER BY created DESC',
        fields: ['key', 'summary', 'description', 'priority', 'diagrams', 'parent'],
        map: mapEpic,
        listKey: 'epics',
        fileName: 'existing_epics.json',
        writeFile: writeEpicsFile,
        plural: 'epics',
        collect: collectFromSearch
    };
}

function storySpec(project) {
    return {
        jql: 'project = ' + project + ' AND issuetype = Story ORDER BY created DESC',
        fields: ['key', 'summary', 'status', 'priority', 'diagrams', 'parent'],
        map: mapStory,
        listKey: 'stories',
        fileName: 'existing_stories.json',
        writeFile: writeStoriesFile,
        plural: 'stories',
        collect: collectFromSearch
    };
}

function action(params) {
    try {
        var ticket = params.ticket;
        var ticketKey = ticket.key;
        var tracker = createTrackerFor(params);

        // --- WIP label check ---
        var wipLabel = wipLabelOn(ticket, params.metadata);
        if (wipLabel) {
            console.log('Ticket ' + ticketKey + ' has WIP label "' + wipLabel + '" - skipping');
            postSkipComment(tracker, ticketKey, wipLabel);
            return false;
        }

        // --- Fetch existing epics into input folder ---
        // file_write creates parent directories automatically,
        // so this works even before dmtools creates input/<KEY>/
        var inputFolder = 'input/' + ticketKey;
        var project = ticketKey.split('-')[0];
        console.log('Fetching existing epics for ' + ticketKey + '...');

        epicIntakeFetch.fetchAndWrite(tracker, inputFolder, epicSpec(project));
        epicIntakeFetch.fetchAndWrite(tracker, inputFolder, storySpec(project));

        return true;

    } catch (error) {
        console.error('Error in intakePreAction:', error);
        return true; // don't block on unexpected error
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
