/**
 * Restore Jira ticket description from changelog history.
 * Merges the last large "before accident" version with any unique content
 * found in the current (accidentally overridden) version.
 *
 * params.ticketKey  - Jira issue key, e.g. "PROJ-1234"
 */

var trackersModule = require('./js/common/trackers.js');
var configLoader = null;
try { configLoader = require('./js/configLoader.js'); } catch (e) { /* unit tests may omit configLoader */ }

var DEFAULT_TICKET_KEY = 'PROJ-1234';
var DEFAULT_JIRA_BASE_URL = 'https://example.atlassian.net';

function resolveTicketKey(params) {
    if (!params) return DEFAULT_TICKET_KEY;
    return params.ticketKey || (params.ticket && params.ticket.key) || DEFAULT_TICKET_KEY;
}

function resolveCustomParams(params) {
    return (params && params.jobParams && params.jobParams.customParams) ||
        (params && params.customParams) || {};
}

function resolveProjectConfig(params) {
    if (!configLoader || typeof configLoader.loadProjectConfig !== 'function') {
        return null;
    }
    return configLoader.loadProjectConfig((params && params.jobParams) || params);
}

function readJiraBasePathEnv() {
    try {
        var val = java.lang.System.getenv('JIRA_BASE_PATH');
        return val ? String(val).trim() : null;
    } catch (e) {
        return null;
    }
}

function resolveJiraBaseUrl(projectConfig) {
    var cfgBase = projectConfig && projectConfig.jira && projectConfig.jira.baseUrl;
    var raw = cfgBase || readJiraBasePathEnv() || DEFAULT_JIRA_BASE_URL;
    return String(raw).replace(/\/+$/, '');
}

function buildChangelogUrl(ticketKey, projectConfig) {
    return resolveJiraBaseUrl(projectConfig) + '/rest/api/3/issue/' + ticketKey + '/changelog?maxResults=100';
}

function parseChangelogPayload(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return raw;
}

function extractDescriptionChanges(values) {
    var descChanges = [];
    var list = values || [];
    for (var i = 0; i < list.length; i++) {
        appendEntryDescriptionChanges(descChanges, list[i]);
    }
    return descChanges;
}

function resolveEntryAuthor(entry) {
    return (entry && entry.author && entry.author.displayName) ? entry.author.displayName : 'unknown';
}

function toDescriptionChangeRecord(entry, author, item) {
    if (!item || item.field !== 'description') {
        return null;
    }
    return {
        created: entry.created,
        author: author,
        fromString: item.fromString || '',
        toString: item.toString || ''
    };
}

function appendEntryDescriptionChanges(descChanges, entry) {
    var items = (entry && entry.items) || [];
    var author = resolveEntryAuthor(entry);
    for (var j = 0; j < items.length; j++) {
        var record = toDescriptionChangeRecord(entry, author, items[j]);
        if (record) {
            descChanges.push(record);
        }
    }
}


function longerText(best, candidate) {
    return candidate.length > best.length ? candidate : best;
}

function findGoldenDescription(descChanges) {
    var goldenDesc = '';
    for (var k = 0; k < descChanges.length; k++) {
        goldenDesc = longerText(goldenDesc, descChanges[k].toString);
        goldenDesc = longerText(goldenDesc, descChanges[k].fromString);
    }
    return goldenDesc;
}

function findUniqueLines(goldenDesc, currentDesc) {
    var currentLines = String(currentDesc || '').split('\n');
    var uniqueLines = [];
    for (var m = 0; m < currentLines.length; m++) {
        var trimmed = currentLines[m].trim();
        if (trimmed.length > 0 && goldenDesc.indexOf(trimmed) === -1) {
            uniqueLines.push(currentLines[m]);
        }
    }
    return uniqueLines;
}

function mergeDescriptions(goldenDesc, uniqueLines) {
    if (!uniqueLines || uniqueLines.length === 0) {
        return goldenDesc;
    }
    var sepIdx = goldenDesc.indexOf('----');
    var uniqueBlock = '\n' + uniqueLines.join('\n') + '\n';
    if (sepIdx !== -1) {
        return goldenDesc.substring(0, sepIdx) + uniqueBlock + '\n' + goldenDesc.substring(sepIdx);
    }
    return goldenDesc + uniqueBlock;
}

function updateRestoredDescription(ticketKey, mergedDesc, tracker) {
    if (typeof jira_update_description === 'function') {
        return tracker.updateDescription(ticketKey, mergedDesc);
    }
    if (typeof jira_update_ticket === 'function') {
        return jira_update_ticket(ticketKey, {
            fields: { description: mergedDesc }
        });
    }
    return tracker.updateDescription(ticketKey, mergedDesc);
}

function buildUnsupportedResult(provider) {
    return {
        success: false,
        error: 'restoreDescription is not supported on the "' + provider +
            '" tracker provider (requires Jira changelog history)'
    };
}

function action(params) {
    var ticketKey = resolveTicketKey(params);
    var customParams = resolveCustomParams(params);
    var projectConfig = resolveProjectConfig(params);
    var tracker = trackersModule.createTracker(projectConfig, customParams);
    var provider = tracker.provider();

    if (provider !== 'jira') {
        return buildUnsupportedResult(provider);
    }

    // ── 1. Fetch the full changelog ──────────────────────────────────────────
    var changelogUrl = buildChangelogUrl(ticketKey, projectConfig);
    var changelog = parseChangelogPayload(jira_execute_request(changelogUrl));

    if (!changelog || !changelog.values) {
        return { success: false, error: 'Could not fetch changelog' };
    }

    // ── 2. Collect all description changes in order ──────────────────────────
    var descChanges = extractDescriptionChanges(changelog.values);
    if (descChanges.length === 0) {
        return { success: false, error: 'No description changes found in changelog' };
    }

    // ── 3. Identify key versions ─────────────────────────────────────────────
    var currentDesc = descChanges[descChanges.length - 1].toString;
    var goldenDesc = findGoldenDescription(descChanges);

    // ── 4. Merge: take golden version, append unique lines from current ───────
    var uniqueLines = findUniqueLines(goldenDesc, currentDesc);
    var mergedDesc = mergeDescriptions(goldenDesc, uniqueLines);

    // ── 5. Update the ticket description ────────────────────────────────────
    var updateResult = updateRestoredDescription(ticketKey, mergedDesc, tracker);

    return {
        success: true,
        ticketKey: ticketKey,
        goldenLength: goldenDesc.length,
        currentLength: currentDesc.length,
        mergedLength: mergedDesc.length,
        uniqueLinesAdded: uniqueLines.length,
        uniqueLines: uniqueLines,
        updateResult: updateResult
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveTicketKey: resolveTicketKey,
        resolveCustomParams: resolveCustomParams,
        resolveProjectConfig: resolveProjectConfig,
        resolveJiraBaseUrl: resolveJiraBaseUrl,
        buildChangelogUrl: buildChangelogUrl,
        parseChangelogPayload: parseChangelogPayload,
        extractDescriptionChanges: extractDescriptionChanges,
        findGoldenDescription: findGoldenDescription,
        findUniqueLines: findUniqueLines,
        mergeDescriptions: mergeDescriptions,
        updateRestoredDescription: updateRestoredDescription,
        buildUnsupportedResult: buildUnsupportedResult
    };
}
