/**
 * Prepare Bug Creation Context (preCliJSAction for bug_creation agent)
 *
 * Fetches all open bugs from the project and writes each one as a separate
 * markdown file in the input folder so the AI can detect duplicates.
 *
 * File format: Bug <KEY> - <Summary>.md
 * Content: bug description (or summary if description is empty)
 */

// Load-time require (gh-823): a deferred require would resolve against the
// pack js/ root only — hoist every require to the top of the module.
var trackersModule = require('./common/trackers.js');
var configLoader = require('./configLoader.js');
/**
 * gh-1188: the actual-params resolution extracted from action — params that
 * already carry inputFolderPath win, else jobParams, else the bare params.
 */
function resolveActionParams(params) {
    return params.inputFolderPath ? params : (params.jobParams || params);
}

function sanitizeFilename(str) {
    return str.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').substring(0, 100).trim();
}

function fetchHistoricalDoneBugs(ticketKey, tracker, queryConfig) {
    tracker = tracker || trackersModule.createTracker(queryConfig, {});
    try {
        // JQL text: provider-specific query (WIQL on ado). The Done status follows jira.statuses.DONE when
        // the project opted in (agents#855); otherwise it is the literal Done, as before.
        var historicalJql = configLoader.interpolateJql(
            'issue in linkedIssues("' + ticketKey + '") AND issuetype = Bug AND status in ({status.DONE:Done}) ORDER BY updated DESC',
            queryConfig || { jira: {} });
        return tracker.searchIssues(historicalJql, {
            fields: ['key', 'summary', 'description', 'status', 'updated'],
            maxResults: 10
        }) || [];
    } catch (e) {
        console.warn('Could not fetch historical Done bugs:', e);
        return [];
    }
}

function writeHistoricalDoneBugs(inputFolder, ticketKey, tracker, queryConfig) {
    var doneBugs = fetchHistoricalDoneBugs(ticketKey, tracker, queryConfig);
    if (!doneBugs || doneBugs.length === 0) {
        return 0;
    }

    var lines = [];
    lines.push('# Historical Done Bugs');
    lines.push('');
    lines.push('These linked Done bugs are recurrence context only. Do not treat them as open duplicate matches.');
    lines.push('If the Test Case is currently Failed and no non-Done bug matches, create a new bug and mention these prior attempts.');
    lines.push('');

    doneBugs.forEach(function(bug) {
        var fields = bug.fields || {};
        var status = fields.status ? fields.status.name : '';
        lines.push('---');
        lines.push('## ' + bug.key + ': ' + (fields.summary || ''));
        if (status) lines.push('**Status**: ' + status);
        if (fields.updated) lines.push('**Updated**: ' + fields.updated);
        if (fields.description) {
            lines.push('');
            lines.push('**Description**:');
            lines.push(String(fields.description).substring(0, 1200));
        }
        lines.push('');
    });

    file_write(inputFolder + '/historical_done_bugs.md', lines.join('\n'));
    console.log('Wrote historical_done_bugs.md with ' + doneBugs.length + ' Done bug(s)');
    return doneBugs.length;
}

/**
 * gh-1188: the TC context markdown builder extracted from action — pure.
 */
function buildTicketContextContent(ticketKey, tcFields) {
    var tcContent = '# Test Case: ' + ticketKey + '\n\n';
    tcContent += '**Summary**: ' + (tcFields.summary || '') + '\n\n';
    if (tcFields.description) {
        tcContent += '**Description**:\n' + tcFields.description + '\n\n';
    }
    if (tcFields.parent) {
        tcContent += '**Parent Story**: ' + tcFields.parent.key + ' — ' + (tcFields.parent.fields && tcFields.parent.fields.summary || '') + '\n';
    }
    return tcContent;
}

/**
 * gh-1188: the TC fetch step extracted from action — a tracker read failure
 * degrades to no ticket context (as before), never a throw.
 */
function fetchTcTicketContext(ticketKey, tracker) {
    try {
        return tracker.getIssue(ticketKey);
    } catch (e) {
        console.warn('Could not fetch TC ticket:', e);
        return null;
    }
}

function writeTicketContextIfPresent(inputFolder, ticketKey, tcTicket) {
    if (!tcTicket) {
        return;
    }
    var tcFields = tcTicket.fields || {};
    file_write(inputFolder + '/ticket.md', buildTicketContextContent(ticketKey, tcFields));
    console.log('Wrote ticket.md for', ticketKey);
}

/**
 * gh-1188: the open-bugs search extracted from action — a search failure
 * degrades to zero bugs (as before), never a throw.
 */
function fetchOpenBugs(tracker, openBugsJql) {
    try {
        return tracker.searchIssues(openBugsJql, {
            fields: ['key', 'summary', 'description', 'status', 'priority'],
            maxResults: 200
        }) || [];
    } catch (e) {
        console.error('Failed to fetch open bugs:', e);
        return [];
    }
}

/**
 * gh-1188: one open-bug markdown document — pure.
 */
function buildBugFileContent(bug) {
    var key = bug.key;
    var fields = bug.fields || {};
    var summary = fields.summary || key;
    var description = fields.description || summary;
    var status = fields.status ? fields.status.name : '';
    var priority = fields.priority ? fields.priority.name : '';

    var content = '# ' + key + ': ' + summary + '\n\n';
    if (status) content += '**Status**: ' + status + '\n';
    if (priority) content += '**Priority**: ' + priority + '\n';
    content += '\n## Description\n\n' + description;
    return content;
}

function writeBugFile(inputFolder, bug) {
    try {
        var content = buildBugFileContent(bug);
        var summary = (bug.fields || {}).summary || bug.key;
        var filename = 'Bug ' + bug.key + ' - ' + sanitizeFilename(summary) + '.md';
        file_write(inputFolder + '/' + filename, content);
    } catch (e) {
        console.warn('Failed to write bug file for', bug.key, ':', e);
    }
}

/**
 * gh-1188: the open-bugs fan-out extracted from action — zero bugs writes
 * the no_open_bugs.md marker (as before).
 */
function writeOpenBugsFiles(inputFolder, bugs) {
    if (bugs.length === 0) {
        file_write(inputFolder + '/no_open_bugs.md', 'No open bugs found in the project. Create a new bug ticket.');
        console.log('No open bugs — wrote no_open_bugs.md');
        return;
    }
    bugs.forEach(function(bug) {
        writeBugFile(inputFolder, bug);
    });
    console.log('Wrote ' + bugs.length + ' bug file(s) to', inputFolder);
}

/**
 * gh-1188: the duplicate-check start comment — pure; the recurrence-history
 * line appears only when Done bugs were loaded.
 */
function buildStartComment(bugsLoaded, historicalDoneCount) {
    return 'h3. 🔍 Bug Detection Started\n\n' +
            'Checking ' + bugsLoaded + ' open bug(s) for duplicates...\n\n' +
            (historicalDoneCount > 0
                ? 'Also loaded ' + historicalDoneCount + ' linked Done bug(s) as recurrence history only.\n\n'
                : '') +
            '_Result will be posted shortly._';
}

function postStartComment(tracker, ticketKey, bugsLoaded, historicalDoneCount) {
    try {
        tracker.postComment(ticketKey, buildStartComment(bugsLoaded, historicalDoneCount));
    } catch (e) {
        console.warn('Failed to post Jira comment:', e);
    }
}

function action(params) {
    try {
        var actualParams = resolveActionParams(params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = inputFolder.split('/').pop();

        var customParams = actualParams.customParams || {};
        // agents#855: status names in these queries follow jira.statuses when the project opted in
        // (jira.useConfiguredStatusesInQueries); otherwise they stay the literals below, as before.
        var queryConfig = configLoader.loadProjectConfig(actualParams);
        var tracker = trackersModule.createTracker(queryConfig, customParams);
        var openBugsJql = configLoader.interpolateJql(
            customParams.openBugsJql
                || 'project = ' + ticketKey.split('-')[0] + ' AND issuetype in (Bug) AND status not in ({status.DONE:Done})',
            queryConfig);

        console.log('=== Preparing bug creation context for', ticketKey, '===');

        // Fetch TC ticket details for context
        writeTicketContextIfPresent(inputFolder, ticketKey, fetchTcTicketContext(ticketKey, tracker));

        var historicalDoneCount = writeHistoricalDoneBugs(inputFolder, ticketKey, tracker, queryConfig);

        // Fetch all open bugs
        console.log('Fetching open bugs with JQL:', openBugsJql);
        var bugs = fetchOpenBugs(tracker, openBugsJql);

        console.log('Found ' + bugs.length + ' open bug(s)');

        writeOpenBugsFiles(inputFolder, bugs);

        // Post Jira comment
        postStartComment(tracker, ticketKey, bugs.length, historicalDoneCount);

        return {
            success: true,
            ticketKey: ticketKey,
            bugsLoaded: bugs.length,
            historicalDoneBugsLoaded: historicalDoneCount
        };

    } catch (error) {
        console.error('❌ Error in prepareBugCreationContext:', error);
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        fetchHistoricalDoneBugs: fetchHistoricalDoneBugs,
        writeHistoricalDoneBugs: writeHistoricalDoneBugs,
        // gh-1188: step helpers extracted from action — exported for direct
        // characterization tests.
        sanitizeFilename: sanitizeFilename,
        resolveActionParams: resolveActionParams,
        fetchTcTicketContext: fetchTcTicketContext,
        buildTicketContextContent: buildTicketContextContent,
        writeTicketContextIfPresent: writeTicketContextIfPresent,
        fetchOpenBugs: fetchOpenBugs,
        buildBugFileContent: buildBugFileContent,
        writeBugFile: writeBugFile,
        writeOpenBugsFiles: writeOpenBugsFiles,
        buildStartComment: buildStartComment,
        postStartComment: postStartComment
    };
}
