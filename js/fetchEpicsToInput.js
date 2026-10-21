/**
 * Fetch Epics To Input Pre-CLI Action
 * Fetches existing epics and writes them to the input folder before CLI agent runs.
 * Receives params.inputFolderPath from DMTools after input folder creation.
 */

/**
 * Pre-CLI action: fetch existing epics into input folder
 *
 * @param {Object} params - Parameters from DMTools
 * @param {string} params.inputFolderPath - Path to the input folder for this run
 */

// Load-time require (gh-823): a deferred require would resolve against the
// pack js/ root only — hoist every require to the top of the module.
var trackersModule = require("./common/trackers.js");
var configLoader = require("./configLoader.js");

/**
 * GitHub has no epics: the existing work of an issue is its sub-issues (a
 * previous intake run may have created some). Written as existing_stories.json
 * so the agent does not plan them again; existing_epics.json is empty.
 */
function mapSubIssue(issueKey, child) {
    return {
        key: child.key,
        summary: child.title || '',
        description: child.description || '',
        status: child.status || '',
        parent: issueKey
    };
}

function writeGithubSubIssues(tracker, folder, issueKey) {
    try {
        var stories = tracker.listChildTickets(issueKey).map(function (c) { return mapSubIssue(issueKey, c); });
        writeEpicsFile(folder, '{"epics":[]}');
        writeStoriesFile(folder, '{"stories":' + JSON.stringify(stories, null, 2) + '}');
        console.log('Wrote ' + stories.length + ' existing sub-issue(s) of ' + issueKey + ' to ' + folder);
    } catch (subIssueError) {
        console.error('Failed to fetch sub-issues, continuing without files:', subIssueError);
    }
}

/**
 * Find a field value by partial key name (handles "Display Name (customfieldXXX)" keys).
 */
function findField(fields, nameSubstring) {
    for (var key in fields) {
        if (key.indexOf(nameSubstring) !== -1) {
            return fields[key];
        }
    }
    return null;
}

// ── pure parse/build helpers (CRAP gate: each ≤ 8) ──────────────────────────

// Last path segment of the input folder — the ticket key container.
function folderKeyOf(folder) {
    return folder ? folder.split('/').pop() : '';
}

// Jira project part of a ticket key (everything before the first dash).
function projectOf(ticketKey) {
    return ticketKey ? ticketKey.split('-')[0] : '';
}

// customParams as seen by this action: jobParams win, then the params body.
// The project config carries the repository that GitHub issue keys resolve against.
function createTrackerFor(params) {
    var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
    var projectConfig = (configLoader && configLoader.loadProjectConfig && configLoader.loadProjectConfig(params.jobParams || params)) || null;
    return trackersModule.createTracker(projectConfig, customParams);
}

function priorityNameOf(fields) {
    return fields.priority ? fields.priority.name : '';
}

function parentKeyOf(fields) {
    return fields.parent ? fields.parent.key : null;
}

function statusNameOf(fields) {
    return fields.status ? fields.status.name : '';
}

// "Acceptance Criteria" first, legacy "Acceptance Criterias" spelling second.
function acceptanceCriteriaOf(fields) {
    return findField(fields, 'Acceptance Criteria') || findField(fields, 'Acceptance Criterias') || null;
}

// Epic summary shape written to existing_epics.json.
function mapEpic(issue) {
    var f = issue.fields || {};
    return {
        key: issue.key || '',
        summary: f.summary || '',
        description: f.description || '',
        priority: priorityNameOf(f),
        diagrams: f['Diagrams (customfield_10296)'] || f.Diagrams || null,
        parent: parentKeyOf(f)
    };
}

// Story summary shape written to existing_stories.json.
function mapStory(issue) {
    var sf = issue.fields || {};
    return {
        key: issue.key || '',
        summary: sf.summary || '',
        description: sf.description || '',
        status: statusNameOf(sf),
        priority: priorityNameOf(sf),
        diagrams: findField(sf, 'Diagrams') || null,
        acceptanceCriteria: acceptanceCriteriaOf(sf),
        solution: findField(sf, 'Solution') || null,
        parent: parentKeyOf(sf)
    };
}

// Static-analysis hooks (docs-freshness): agentDocGenerator discovers written
// artifacts with literal-path regexes, so each family keeps its concrete file
// name inside the file_write call — a dynamic spec.fileName path would
// collapse the generated "Writes" list to input/<KEY>/ and red the
// docs-freshness CI (pinned in test_configLoader.js).
function writeEpicsFile(folder, payload) {
    file_write(folder + '/existing_epics.json', payload);
}

function writeStoriesFile(folder, payload) {
    file_write(folder + '/existing_stories.json', payload);
}

// Search spec for one issue family (provider-specific query: WIQL on ado).
function epicSpec(project) {
    return {
        jql: 'project = ' + project + ' AND issuetype = Epic ORDER BY created DESC',
        fields: ['key', 'summary', 'description', 'priority', 'parent'],
        map: mapEpic,
        listKey: 'epics',
        fileName: 'existing_epics.json',
        writeFile: writeEpicsFile,
        plural: 'epics',
        brokenLabel: 'Failed to fetch epic'
    };
}

function storySpec(project) {
    return {
        jql: 'project = ' + project + ' AND issuetype = Story ORDER BY created DESC',
        fields: ['key', 'summary', 'status', 'priority', 'parent'],
        map: mapStory,
        listKey: 'stories',
        fileName: 'existing_stories.json',
        writeFile: writeStoriesFile,
        plural: 'stories',
        brokenLabel: 'Failed to fetch story'
    };
}

// Re-fetch every found issue (full field set) and map it; one broken fetch is
// skipped with a log line, the rest still land in the file.
function collectMappedIssues(tracker, spec) {
    var rawIssues = tracker.searchIssues(spec.jql, { fields: spec.fields });
    var issues = [];
    for (var i = 0; i < rawIssues.length; i++) {
        try {
            issues.push(spec.map(tracker.getIssue(rawIssues[i].key)));
        } catch (e) {
            console.error(spec.brokenLabel + ' ' + rawIssues[i].key + ':', e);
        }
    }
    return issues;
}

// Search → map → write one existing_*.json payload; a fetch failure is logged
// and the run continues without the file.
function fetchAndWrite(tracker, folder, spec) {
    try {
        var issues = collectMappedIssues(tracker, spec);
        console.log('Found ' + issues.length + ' ' + spec.plural);
        spec.writeFile(folder, '{"' + spec.listKey + '":' + JSON.stringify(issues, null, 2) + '}');
        console.log('Wrote ' + spec.fileName + ' to ' + folder);
    } catch (fetchError) {
        console.error('Failed to fetch ' + spec.plural + ', continuing without file:', fetchError);
    }
}

function action(params) {
    try {
        const folder = params.inputFolderPath;
        var ticketKey = folderKeyOf(folder);
        var project = projectOf(ticketKey);
        var tracker = createTrackerFor(params);
        if (tracker.provider && tracker.provider() === 'github') {
            writeGithubSubIssues(tracker, folder, ticketKey);
            return;
        }
        console.log('Fetching existing epics for project ' + project + '...');

        fetchAndWrite(tracker, folder, epicSpec(project));
        fetchAndWrite(tracker, folder, storySpec(project));
    } catch (error) {
        console.error('Error in fetchEpicsToInput:', error);
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { action, findField };
}
