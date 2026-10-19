/**
 * Prepare Bulk Bugs Creation Context (preCliJSAction for bulk_bugs_creation agent)
 *
 * Fetches all failed Test Cases (without sm_bug_creation_triggered label) and
 * all non-Done bugs, then writes them to input files for the AI to process in batch.
 *
 * Writes:
 *   input/failed_tcs.json  — array of failed TC objects
 *   input/open_bugs.json   — array of non-Done bug objects
 *   input/context.md       — summary for the AI
 *
 * The SM passes one ticket as the "trigger" but this action ignores it and
 * fetches ALL eligible failed TCs up to batchSize.
 *
 * Structure (gh-1081): `action` only orchestrates — every decision lives in a
 * small, pure, unit-tested helper below (parse/build/decide split). The
 * tracker/file-call order is part of the contract and must not move.
 */

var configLoader = require('./configLoader.js');
const { JIRA_FIELDS } = require('./config.js');
var trackersModule = require('./common/trackers.js');

function summarizeDoneBug(bug) {
    var fields = bug.fields || {};
    return {
        key: bug.key,
        summary: fields.summary || '',
        status: fields.status ? fields.status.name : '',
        updated: fields.updated || '',
        description: (fields.description || '').substring(0, 500)
    };
}

/**
 * params may arrive bare (inputFolderPath on params) or wrapped in jobParams.
 */
function resolveActionParams(params) {
    return params.inputFolderPath ? params : (params.jobParams || params);
}

/**
 * Resolve the run settings: input folder, custom params, project key
 * ({jiraProject} source) and the fetch batch size.
 */
function resolveSettings(actualParams, params) {
    var customParams = actualParams.customParams || {};
    var projectKey = (actualParams.jira && actualParams.jira.project)
        || (params.ticket && params.ticket.key && params.ticket.key.split('-')[0])
        || 'TS';
    return {
        inputFolder: actualParams.inputFolderPath,
        customParams: customParams,
        projectKey: projectKey,
        batchSize: customParams.batchSize || 50
    };
}

/**
 * {jiraProject}/{status.*} interpolation source: configured statuses win only
 * when the project opted in (jira.useConfiguredStatusesInQueries, agents#855).
 */
function buildStatusConfig(config, projectKey) {
    return { jira: { statuses: (config.jira && config.jira.statuses) || {},
        useConfiguredStatusesInQueries: !!(config.jira && config.jira.useConfiguredStatusesInQueries),
        project: projectKey, parentTicket: '' } };
}

/**
 * The two sweep queries (customParams override > shipped defaults, both
 * interpolated against statusConfig).
 */
function buildQueries(customParams, statusConfig) {
    return {
        openBugsJql: configLoader.interpolateJql(
            customParams.openBugsJql || 'project = {jiraProject} AND issuetype in (Bug) AND status not in ({status.DONE:Done})',
            statusConfig),
        // gh-916: {stage.*} — in label mode a TC carrying the stage_failed marker is selectable too;
        // in 'none' mode this expands to the same `status in ('Failed')` clause as before.
        failedTCsJql: configLoader.interpolateJql(customParams.failedTCsJql ||
            'project = {jiraProject} AND issuetype = "Test Case" AND {stage.FAILED:Failed} AND (labels is EMPTY OR labels NOT IN (sm_bug_creation_triggered)) ORDER BY created ASC',
            statusConfig)
    };
}

function getFailedReasonFieldName(config, customParams) {
    return (customParams && customParams.failedReasonField)
        || (config && config.jira && config.jira.fields && config.jira.fields.failedReason)
        || JIRA_FIELDS.FAILED_REASON
        || 'Failed Reason';
}

function extractFailedReason(fields, fieldName) {
    if (!fields || !fieldName) return '';
    var raw = fields[fieldName];
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw.value === 'string') return raw.value;
    // Fallback: dmtools may transform customfield_12345 into "Name (customfield_12345)".
    if (fieldName.indexOf('customfield_') === -1) return '';
    return scanTransformedFailedReason(fields, fieldName);
}

function scanTransformedFailedReason(fields, fieldName) {
    for (var key in fields) {
        if (fields.hasOwnProperty(key) && key.indexOf(fieldName) !== -1) {
            var v = fields[key];
            if (typeof v === 'string') return v;
            if (v && typeof v.value === 'string') return v.value;
        }
    }
    return '';
}

function extractAttachmentNames(fields) {
    var attachments = fields && fields.attachment;
    if (!Array.isArray(attachments)) return [];
    return attachments.map(function(a) { return a.filename || ''; }).filter(function(n) { return n; });
}

function lastCommentOf(fields) {
    var comments = fields.comment && fields.comment.comments;
    return comments && comments.length > 0
        ? comments[comments.length - 1].body
        : '';
}

function parentLabel(fields) {
    return fields.parent ? fields.parent.key + ' — ' + (fields.parent.fields && fields.parent.fields.summary || '') : '';
}

function fetchHistoricalDoneBugs(tcKey, tracker) {
    try {
        tracker = tracker || trackersModule.createTracker(null, {});
        // JQL text: provider-specific query (WIQL on ado)
        var bugs = tracker.searchIssues('issue in linkedIssues("' + tcKey + '") AND issuetype = Bug AND status in (Done) ORDER BY updated DESC', {
            fields: ['key', 'summary', 'description', 'status', 'updated'],
            maxResults: 10
        }) || [];
        return bugs.map(summarizeDoneBug);
    } catch (e) {
        console.warn('Failed to fetch historical Done bugs for ' + tcKey + ':', e);
        return [];
    }
}

/**
 * Failed-TC sweep. A failed search degrades to [] — the action then takes the
 * no_failed_tcs early return (same as an empty result).
 */
function fetchFailedTCs(tracker, failedTCsJql, batchSize, failedReasonFieldName) {
    try {
        var tcFields = ['key', 'summary', 'description', 'comment', 'status', 'labels', 'parent', 'attachment'];
        if (failedReasonFieldName && failedReasonFieldName.indexOf('customfield_') !== -1) {
            tcFields.push(failedReasonFieldName);
        }
        return tracker.searchIssues(failedTCsJql, {
            fields: tcFields,
            maxResults: batchSize
        }) || [];
    } catch (e) {
        console.error('Failed to fetch failed TCs:', e);
        return [];
    }
}

/**
 * Build the per-TC entries for the AI, fetching each TC's historical Done bugs
 * (recurrence context) on the way. Returns the list plus the accumulated count
 * for the context summary.
 */
function buildTcList(failedTCs, tracker, failedReasonFieldName) {
    var totalHistoricalDoneBugs = 0;
    var tcList = failedTCs.map(function(tc) {
        var fields = tc.fields || {};
        var historicalDoneBugs = fetchHistoricalDoneBugs(tc.key, tracker);
        totalHistoricalDoneBugs += historicalDoneBugs.length;
        return {
            key: tc.key,
            summary: fields.summary || '',
            description: fields.description || '',
            failedReason: extractFailedReason(fields, failedReasonFieldName),
            attachmentNames: extractAttachmentNames(fields),
            lastComment: lastCommentOf(fields),
            parent: parentLabel(fields),
            historicalDoneBugs: historicalDoneBugs
        };
    });
    return { tcList: tcList, totalHistoricalDoneBugs: totalHistoricalDoneBugs };
}

/**
 * Non-Done bug sweep. A failed search degrades to [] — the context is still
 * written, with zero open bugs.
 */
function fetchOpenBugs(tracker, openBugsJql) {
    try {
        return tracker.searchIssues(openBugsJql, {
            fields: ['key', 'summary', 'description', 'status', 'priority'],
            maxResults: 300
        }) || [];
    } catch (e) {
        console.error('Failed to fetch open bugs:', e);
        return [];
    }
}

function bugToEntry(bug) {
    var fields = bug.fields || {};
    return {
        key: bug.key,
        summary: fields.summary || '',
        description: (fields.description || '').substring(0, 500),
        status: fields.status ? fields.status.name : '',
        priority: fields.priority ? fields.priority.name : ''
    };
}

function writeOpenBugs(inputFolder, bugList) {
    if (bugList.length === 0) {
        file_write(inputFolder + '/open_bugs.json', '[]');
        console.log('No non-Done bugs found — wrote empty open_bugs.json');
    } else {
        file_write(inputFolder + '/open_bugs.json', JSON.stringify(bugList, null, 2));
        console.log('Wrote input/open_bugs.json with ' + bugList.length + ' bugs');
    }
}

function buildContextMd(projectKey, tcCount, bugCount, historicalCount) {
    return '# Bulk Bug Creation Context\n\n' +
        '- **Project**: ' + projectKey + '\n' +
        '- **Failed TCs to process**: ' + tcCount + '\n' +
        '- **Non-Done bugs for dedup check**: ' + bugCount + '\n' +
        '- **Historical Done linked bugs**: ' + historicalCount + ' (recurrence context only; not open matches)\n\n' +
        'Each failed TC in `input/failed_tcs.json` now includes `failedReason` (from the Failed Reason field) ' +
        'and `attachmentNames` (any files attached to the TC, including the failed-description file). ' +
        'Use these as the *primary* failure evidence when creating or matching bugs.\n\n' +
        'Read `input/failed_tcs.json` and `input/open_bugs.json`, then follow the prompt instructions.\n';
}

function action(params) {
    try {
        var actualParams = resolveActionParams(params);
        var settings = resolveSettings(actualParams, params);
        var inputFolder = settings.inputFolder;
        var customParams = settings.customParams;
        var projectKey = settings.projectKey;
        var batchSize = settings.batchSize;

        var config = configLoader.loadProjectConfig(actualParams);
        // agents#855: {jiraProject} is replaced with the project key derived above; {status.KEY:Literal}
        // follows jira.statuses only when the project opted in (jira.useConfiguredStatusesInQueries),
        // otherwise it stays the literal — the default queries are byte-identical to the previous ones.
        var statusConfig = buildStatusConfig(config, projectKey);
        var queries = buildQueries(customParams, statusConfig);

        var tracker = trackersModule.createTracker(config, customParams);
        var failedReasonFieldName = getFailedReasonFieldName(config, customParams);
        console.log('Failed Reason field name:', failedReasonFieldName);

        console.log('=== Preparing bulk bugs creation context ===');
        console.log('Project:', projectKey, '| batchSize:', batchSize);

        // Fetch failed TCs
        console.log('Fetching failed TCs with JQL:', queries.failedTCsJql);
        var failedTCs = fetchFailedTCs(tracker, queries.failedTCsJql, batchSize, failedReasonFieldName);

        console.log('Found ' + failedTCs.length + ' failed TC(s) to process');

        if (failedTCs.length === 0) {
            file_write(inputFolder + '/no_failed_tcs.md', 'No failed Test Cases to process. Exiting.');
            console.log('No failed TCs — wrote no_failed_tcs.md');
            return;
        }

        // Build TC list for AI
        var tcBuild = buildTcList(failedTCs, tracker, failedReasonFieldName);
        var tcList = tcBuild.tcList;
        var totalHistoricalDoneBugs = tcBuild.totalHistoricalDoneBugs;

        file_write(inputFolder + '/failed_tcs.json', JSON.stringify(tcList, null, 2));
        console.log('Wrote input/failed_tcs.json with ' + tcList.length + ' TCs');

        // Fetch non-Done bugs
        console.log('Fetching non-Done bugs with JQL:', queries.openBugsJql);
        var bugs = fetchOpenBugs(tracker, queries.openBugsJql);

        console.log('Found ' + bugs.length + ' non-Done bug(s)');

        writeOpenBugs(inputFolder, bugs.map(bugToEntry));

        // Write context summary for the AI
        file_write(inputFolder + '/context.md',
            buildContextMd(projectKey, tcList.length, bugs.length, totalHistoricalDoneBugs));
        console.log('=== Context preparation complete ===');

    } catch (e) {
        console.error('prepareBulkBugsCreationContext failed:', e);
        throw e;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        fetchHistoricalDoneBugs: fetchHistoricalDoneBugs,
        resolveActionParams: resolveActionParams,
        resolveSettings: resolveSettings,
        buildStatusConfig: buildStatusConfig,
        buildQueries: buildQueries,
        getFailedReasonFieldName: getFailedReasonFieldName,
        extractFailedReason: extractFailedReason,
        extractAttachmentNames: extractAttachmentNames,
        summarizeDoneBug: summarizeDoneBug,
        lastCommentOf: lastCommentOf,
        parentLabel: parentLabel,
        fetchFailedTCs: fetchFailedTCs,
        buildTcList: buildTcList,
        fetchOpenBugs: fetchOpenBugs,
        bugToEntry: bugToEntry,
        writeOpenBugs: writeOpenBugs,
        buildContextMd: buildContextMd
    };
}
