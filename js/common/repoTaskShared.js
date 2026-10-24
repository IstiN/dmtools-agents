/**
 * Shared helpers for the repo-task creation scripts (js/createRepoTasks.js and
 * js/createRepoTasksMulti.js) — gh-1245. Both read the
 * {code:json|title=affected_repos} block of a story-solution (SA) ticket and
 * create development Sub-tasks under the SA ticket's parent; every helper both
 * scripts need lives here so the pair keeps a single implementation.
 *
 * The createSubTasks() helper is generic over a list of "plans" — each plan
 * carries the pre-built summary/description plus small closures describing how
 * to record success/failure — so the two scripts only differ in how they shape
 * their plans (per-repo vs per-task), not in the creation loop itself.
 *
 * GralJS: var + plain functions only, requires hoisted to the top.
 */

var configModule = require('../config.js');
var trackersModule = require('./trackers.js');
var linkedIssuesReport = require('./linkedIssuesReport.js');
var configLoader = null;
try { configLoader = require('../configLoader.js'); } catch (e) {}
var truncateSummary = configModule.truncateSummary;
var JIRA_SUMMARY_MAX_LENGTH = configModule.JIRA_SUMMARY_MAX_LENGTH;

function resolveProjectConfig(params) {
    return configLoader ? configLoader.loadProjectConfig(params) : null;
}

function getJiraBaseUrl() {
    try {
        var url = java.lang.System.getenv('JIRA_BASE_PATH');
        return url ? url.replace(/\/$/, '') : '';
    } catch (e) {
        return '';
    }
}

function jiraLink(key, baseUrl) {
    return '[' + key + '|' + baseUrl + '/browse/' + key + ']';
}

function parseAffectedRepos(description) {
    if (!description) return [];
    var startMarker = '{code:json|title=affected_repos}';
    var endMarker = '{code}';
    var startIdx = description.indexOf(startMarker);
    if (startIdx === -1) {
        console.warn('No {code:json|title=affected_repos} block found in description');
        return [];
    }
    var jsonStart = startIdx + startMarker.length;
    var endIdx = description.indexOf(endMarker, jsonStart);
    if (endIdx === -1) {
        console.warn('Closing {code} not found after affected_repos block');
        return [];
    }
    var jsonStr = description.substring(jsonStart, endIdx).trim();
    try {
        var parsed = JSON.parse(jsonStr);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn('Failed to parse affected_repos JSON:', e);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Pure payload builders — no tracker calls, unit-tested directly
// ---------------------------------------------------------------------------

function buildScopedSummary(scope, title) {
    // Titles come from Jira-controlled parent summaries or free-text AI task
    // titles; either can exceed the 255-char hard limit — truncate
    // defensively so a single overlong title can't sink the whole run.
    return truncateSummary('[' + scope + '] ' + title, JIRA_SUMMARY_MAX_LENGTH);
}

function buildScopeDescription(repo, saKey, parentKey, baseUrl, reason) {
    var saRef  = baseUrl ? jiraLink(saKey, baseUrl)    : saKey;
    var parRef = baseUrl ? jiraLink(parentKey, baseUrl) : parentKey;
    return (reason ? reason + '\n\n' : '') +
           'Your scope only development for *' + repo +
           '* based on solution in ' + saRef +
           ' and parent acceptance criteria ' + parRef;
}

function decideDuplicate(existingSummaries, needle) {
    return existingSummaries.some(function(s) {
        return s.indexOf(needle) !== -1;
    });
}

function tryParseCreatedResult(result) {
    if (typeof result !== 'string') return result;
    if (/^[A-Za-z0-9_-]+$/.test(result)) return { key: result };
    try {
        return JSON.parse(result);
    } catch (e) {
        return null;
    }
}

function extractCreatedKey(result) {
    try {
        var parsed = tryParseCreatedResult(result);
        return parsed && (parsed.key || parsed.id) ? (parsed.key || parsed.id) : null;
    } catch (e) {
        // key extraction failed — non-critical
        return null;
    }
}

function buildSummaryComment(created, skipped, baseUrl, labelField) {
    var comment = 'h3. Development Sub-tasks\n\n';
    created.forEach(function(c) {
        if (c.error) {
            comment += '* ❌ ' + c[labelField] + ': ' + c.error + '\n';
        } else {
            var ref = c.key && baseUrl ? jiraLink(c.key, baseUrl) : (c.key || c[labelField]);
            comment += '* ✅ ' + ref + ' — ' + c[labelField] + '\n';
        }
    });
    if (skipped.length > 0) {
        comment += '\n_Skipped (already exist): ' + skipped.join(', ') + '_\n';
    }
    return comment;
}

// ---------------------------------------------------------------------------
// Tracker-backed helpers — each failure mode is non-fatal by design
// ---------------------------------------------------------------------------

function resolveTrackerProvider(tracker) {
    return tracker && typeof tracker.provider === 'function' ? tracker.provider() : 'jira';
}

function summaryOf(t) {
    return t.fields && t.fields.summary ? t.fields.summary : (t.summary || '');
}

function loadExistingSummaries(tracker, parentKey) {
    var existingSummaries = [];
    try {
        var provider = resolveTrackerProvider(tracker);
        var existing = tracker.searchIssues(
            // JQL text: provider-specific query (WIQL on ado)
            linkedIssuesReport.buildChildrenQuery(provider, parentKey, 'parent = ' + parentKey + ' AND issuetype = Sub-task', 'Sub-task'), {
            fields: ['summary']
        });
        if (Array.isArray(existing)) {
            existing.forEach(function(t) {
                existingSummaries.push(summaryOf(t));
            });
        }
    } catch (e) {
        console.warn('Could not fetch existing Sub-tasks (will create without dedup check):', e);
    }
    return existingSummaries;
}

/**
 * Create one Sub-task per plan; every failure is recorded on the plan's record
 * instead of aborting the loop.
 *
 * @param {Object} tracker - Tracker from js/common/trackers.js
 * @param {Array} plans - One entry per Sub-task:
 *   {summary, description, dedupeLabel, skipLog, skipValue, mapKey,
 *    buildRecord(createdKey), buildErrorRecord(error)}
 * @param {Object} options - {projectKey, parentKey, ticketLabels}
 * @param {Array} existingSummaries - Summaries of Sub-tasks already under the parent
 * @returns {{created: Array, skipped: Array, keyMap: Object}} plan mapKey → created ticket key
 */
function createSubTasks(tracker, plans, options, existingSummaries) {
    var created = [];
    var skipped = [];
    var keyMap = {};

    plans.forEach(function(p) {
        if (decideDuplicate(existingSummaries, p.dedupeLabel)) {
            console.log('Skipping ' + p.skipLog + ' — sub-task already exists');
            skipped.push(p.skipValue);
            return;
        }

        try {
            var result = tracker.createTicketWithParent(options.projectKey, 'Sub-task', p.summary, p.description, options.parentKey, { labels: options.ticketLabels });

            var createdKey = extractCreatedKey(result);

            console.log('Created Sub-task ' + (createdKey || '(key unavailable)') + ': ' + p.summary);
            created.push(p.buildRecord(createdKey));
            if (createdKey) keyMap[p.mapKey] = createdKey;

        } catch (e) {
            console.error('Failed to create Sub-task for ' + p.summary + ':', e);
            created.push(p.buildErrorRecord(e));
        }
    });

    return { created: created, skipped: skipped, keyMap: keyMap };
}

function linkDependency(tracker, blockerKey, dependentKey, blocksRelationship) {
    try {
        tracker.linkIssues(blockerKey, dependentKey, blocksRelationship);
        console.log(blockerKey + ' ' + blocksRelationship + ' ' + dependentKey);
        return true;
    } catch (e) {
        console.warn('Failed to link ' + blockerKey + ' ' + blocksRelationship + ' ' + dependentKey + ':', e);
        return false;
    }
}

function moveToBlocked(tracker, key, blockedStatus) {
    try {
        tracker.moveToStatus(key, blockedStatus);
        console.log('Moved ' + key + ' to ' + blockedStatus);
    } catch (e) {
        console.warn('Failed to move ' + key + ' to ' + blockedStatus + ':', e);
    }
}

function wireDependencies(tracker, created, keyMap, blocksRelationship, blockedStatus) {
    created.forEach(function(c) {
        if (!c.key || !Array.isArray(c.depends_on) || c.depends_on.length === 0) return;
        var anyLinked = false;
        c.depends_on.forEach(function(depKey) {
            var blockerKey = keyMap[depKey];
            if (!blockerKey) {
                console.warn('Cannot resolve depends_on "' + depKey + '" for ' + c.key + ' — skipping link');
                return;
            }
            if (linkDependency(tracker, blockerKey, c.key, blocksRelationship)) anyLinked = true;
        });
        if (anyLinked) moveToBlocked(tracker, c.key, blockedStatus);
    });
}

function postSummaryComment(tracker, saKey, comment) {
    try {
        tracker.postComment(saKey, comment);
    } catch (e) {
        console.warn('Failed to post summary comment on ' + saKey + ':', e);
    }
}

// ---------------------------------------------------------------------------
// Action-phase helpers — each decision or fetch of the original action body,
// small and directly unit-testable; same tracker/file calls in the same order
// as before (gh-1197).
// ---------------------------------------------------------------------------

function extractSaKey(params) {
    var saKey = params.ticket && params.ticket.key;
    if (!saKey) {
        return { error: 'No ticket key in params' };
    }
    return { saKey: saKey };
}

function resolveTaskOptions(params) {
    // Customisable via customParams (or .dmtools/config.js jobParamPatches.createRepoTasks.customParams)
    var customParams = params.customParams || (params.jobParams && params.jobParams.customParams) || {};
    return {
        customParams: customParams,
        blocksRelationship: customParams.blocksRelationship || 'Blocks',
        blockedStatus:      customParams.blockedStatus      || 'Blocked',
        ticketLabels:       customParams.labels             || ['development']
    };
}

function resolveSaTicketContext(tracker, saKey) {
    // Fetch the SA ticket to get description + parent
    var saTicket = tracker.getIssue(saKey, ['description', 'summary', 'parent']);
    var saFields = saTicket && saTicket.fields ? saTicket.fields : saTicket;
    var description = saFields.description ? saFields.description.toString() : '';

    // Resolve parent key
    var parentInfo = saFields.parent;
    var parentKey = parentInfo && typeof parentInfo === 'object' ? parentInfo.key : null;
    return { description: description, parentKey: parentKey };
}

function resolveParentSummary(tracker, parentKey) {
    // Fetch parent summary
    var parentTicket = tracker.getIssue(parentKey, ['summary']);
    var parentFields = parentTicket && parentTicket.fields ? parentTicket.fields : parentTicket;
    return (parentFields.summary || parentKey).toString();
}

function requireAffectedRepos(description, saKey) {
    // Extract repos from description
    var repos = parseAffectedRepos(description);
    if (repos.length === 0) {
        return { error: 'No affected repos found in ' + saKey + ' — ensure writeSolutionAndLabels ran first' };
    }
    return { repos: repos };
}

function repoNamesCsv(repos) {
    return repos.map(function(r) { return typeof r === 'string' ? r : r.name; }).join(', ');
}

function postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome, labelField) {
    // Post summary comment on the SA ticket
    if (outcome.created.length > 0 || outcome.skipped.length > 0) {
        postSummaryComment(tracker, saKey, buildSummaryComment(outcome.created, outcome.skipped, baseUrl, labelField));
    }
}

// ---------------------------------------------------------------------------
// Shared action orchestration (gh-1245) — createRepoTasks.js and
// createRepoTasksMulti.js run the exact same sequence of tracker/file calls;
// only the unit shaping differs, so the skeleton lives here and each script
// injects its variant:
//   {scriptName, labelField, keyMapOf(outcome), buildUnits(repos, parentSummary),
//    describeUnits(repos, units), createSubTasks(...)}
// ---------------------------------------------------------------------------

function runRepoTaskAction(params, variant) {
    try {
        var saInfo = extractSaKey(params);
        if (saInfo.error) {
            return { success: false, error: saInfo.error };
        }
        var saKey = saInfo.saKey;

        console.log(variant.scriptName + ': processing SA ticket ' + saKey);

        var options = resolveTaskOptions(params);
        var tracker = trackersModule.createTracker(resolveProjectConfig(params), options.customParams);

        var saContext = resolveSaTicketContext(tracker, saKey);
        if (!saContext.parentKey) {
            return { success: false, error: 'SA ticket ' + saKey + ' has no parent ticket' };
        }
        console.log('Parent ticket: ' + saContext.parentKey);

        var parentSummary = resolveParentSummary(tracker, saContext.parentKey);

        var reposInfo = requireAffectedRepos(saContext.description, saKey);
        if (reposInfo.error) {
            return { success: false, error: reposInfo.error };
        }
        var repos = reposInfo.repos;

        var units = variant.buildUnits(repos, parentSummary);
        console.log(variant.describeUnits(repos, units));

        var baseUrl = getJiraBaseUrl();
        var projectKey = saContext.parentKey.split('-')[0];

        // Load existing Sub-tasks under the parent to avoid duplicates
        var existingSummaries = loadExistingSummaries(tracker, saContext.parentKey);

        var outcome = variant.createSubTasks(tracker, units, projectKey, saContext.parentKey, parentSummary, saKey, baseUrl, options.ticketLabels, existingSummaries);

        // Wire dependencies: blocker Blocks dependent + move dependent to Blocked status
        wireDependencies(tracker, outcome.created, variant.keyMapOf(outcome), options.blocksRelationship, options.blockedStatus);

        postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome, variant.labelField);

        var successCount = outcome.created.filter(function(c) { return !c.error; }).length;
        return {
            success: true,
            message: 'Created ' + successCount + ' Sub-task(s) under ' + saContext.parentKey + ', skipped ' + outcome.skipped.length,
            created: successCount,
            skipped: outcome.skipped.length
        };

    } catch (error) {
        console.error('Error in ' + variant.scriptName + ':', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        runRepoTaskAction: runRepoTaskAction,
        resolveProjectConfig: resolveProjectConfig,
        getJiraBaseUrl: getJiraBaseUrl,
        jiraLink: jiraLink,
        parseAffectedRepos: parseAffectedRepos,
        buildScopedSummary: buildScopedSummary,
        buildScopeDescription: buildScopeDescription,
        decideDuplicate: decideDuplicate,
        extractCreatedKey: extractCreatedKey,
        buildSummaryComment: buildSummaryComment,
        loadExistingSummaries: loadExistingSummaries,
        createSubTasks: createSubTasks,
        linkDependency: linkDependency,
        moveToBlocked: moveToBlocked,
        wireDependencies: wireDependencies,
        postSummaryComment: postSummaryComment,
        extractSaKey: extractSaKey,
        resolveTaskOptions: resolveTaskOptions,
        resolveSaTicketContext: resolveSaTicketContext,
        resolveParentSummary: resolveParentSummary,
        requireAffectedRepos: requireAffectedRepos,
        repoNamesCsv: repoNamesCsv,
        postOutcomeSummaryComment: postOutcomeSummaryComment
    };
}
