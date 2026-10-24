/**
 * Create Repository Development Sub-tasks
 *
 * Reads the {code:json|title=affected_repos} block from a story-solution (SA)
 * ticket description and creates one development Sub-task per repository under
 * the same parent as the SA ticket.
 *
 * Summary format:   [repo] [parent summary]
 * Description:      Your scope only development for [repo] based on solution in
 *                   [SA link] and parent acceptance criteria [parent link]
 *
 * Duplicate-safe: skips repos that already have a matching Sub-task under the parent.
 *
 * gh-1004: action was one 200+ line function (CRAP 180.9). The pure decisions
 * and payload builders are extracted below so action only orchestrates; every
 * helper is covered directly by js/unit-tests/test_createRepoTasks.js.
 */

var configModule = require('./config.js');
var trackersModule = require('./common/trackers.js');
var linkedIssuesReport = require('./common/linkedIssuesReport.js');
var configLoader = null;
try { configLoader = require('./configLoader.js'); } catch (e) {}
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
// Pure helpers (gh-1004) — no tracker calls, unit-tested directly
// ---------------------------------------------------------------------------

function decideDuplicate(existingSummaries, repoName) {
    return existingSummaries.some(function(s) {
        return s.indexOf('[' + repoName + ']') !== -1;
    });
}

function buildRepoSummary(repoName, parentSummary) {
    // Parent summary is Jira-controlled and usually short, but a "[repo] "
    // prefix plus a long parent summary could still exceed the 255-char
    // hard limit — truncate defensively (see createRepoTasksMulti.js).
    return truncateSummary('[' + repoName + '] ' + parentSummary, JIRA_SUMMARY_MAX_LENGTH);
}

function buildScopeDescription(repoName, saKey, parentKey, baseUrl) {
    var saRef  = baseUrl ? jiraLink(saKey, baseUrl)    : saKey;
    var parRef = baseUrl ? jiraLink(parentKey, baseUrl) : parentKey;
    return 'Your scope only development for *' + repoName +
           '* based on solution in ' + saRef +
           ' and parent acceptance criteria ' + parRef;
}

function extractCreatedKey(result) {
    try {
        var parsed = typeof result === 'string' ? (/^[A-Za-z0-9_-]+$/.test(result) ? { key: result } : JSON.parse(result)) : result;
        return parsed && (parsed.key || parsed.id) ? (parsed.key || parsed.id) : null;
    } catch (e) {
        // key extraction failed — non-critical
        return null;
    }
}

function buildSummaryComment(created, skipped, baseUrl) {
    var comment = 'h3. Development Sub-tasks\n\n';
    created.forEach(function(c) {
        if (c.error) {
            comment += '* ❌ ' + c.repo + ': ' + c.error + '\n';
        } else {
            var ref = c.key && baseUrl ? jiraLink(c.key, baseUrl) : (c.key || c.summary);
            comment += '* ✅ ' + ref + ' — ' + c.repo + '\n';
        }
    });
    if (skipped.length > 0) {
        comment += '\n_Skipped (already exist): ' + skipped.join(', ') + '_\n';
    }
    return comment;
}

// ---------------------------------------------------------------------------
// Tracker-backed helpers (gh-1004) — each failure mode is non-fatal by design
// ---------------------------------------------------------------------------

function loadExistingSummaries(tracker, parentKey) {
    var existingSummaries = [];
    try {
        var provider = tracker && typeof tracker.provider === 'function' ? tracker.provider() : 'jira';
        var existing = tracker.searchIssues(
            // JQL text: provider-specific query (WIQL on ado)
            linkedIssuesReport.buildChildrenQuery(provider, parentKey, 'parent = ' + parentKey + ' AND issuetype = Sub-task', 'Sub-task'), {
            fields: ['summary']
        });
        if (Array.isArray(existing)) {
            existing.forEach(function(t) {
                var s = t.fields && t.fields.summary ? t.fields.summary : (t.summary || '');
                existingSummaries.push(s);
            });
        }
    } catch (e) {
        console.warn('Could not fetch existing Sub-tasks (will create without dedup check):', e);
    }
    return existingSummaries;
}

function createSubTasks(tracker, repos, projectKey, parentKey, parentSummary, saKey, baseUrl, ticketLabels, existingSummaries) {
    var created = [];
    var skipped = [];
    // repoName → created Jira key (for dependency linking)
    var repoKeyMap = {};

    repos.forEach(function(repo) {
        var repoName = typeof repo === 'string' ? repo : repo.name;
        if (!repoName) return;

        var summary = buildRepoSummary(repoName, parentSummary);

        // Skip if a sub-task with this repo tag already exists
        if (decideDuplicate(existingSummaries, repoName)) {
            console.log('Skipping ' + repoName + ' — sub-task already exists');
            skipped.push(repoName);
            return;
        }

        var desc = buildScopeDescription(repoName, saKey, parentKey, baseUrl);

        try {
            var result = tracker.createTicketWithParent(projectKey, 'Sub-task', summary, desc, parentKey, { labels: ticketLabels });

            var createdKey = extractCreatedKey(result);

            console.log('Created Sub-task ' + (createdKey || '(key unavailable)') + ': ' + summary);
            created.push({ repo: repoName, key: createdKey, summary: summary, depends_on: repo.depends_on || [] });
            if (createdKey) repoKeyMap[repoName] = createdKey;

        } catch (e) {
            console.error('Failed to create Sub-task for ' + repoName + ':', e);
            created.push({ repo: repoName, key: null, error: e.toString(), depends_on: [] });
        }
    });

    return { created: created, skipped: skipped, repoKeyMap: repoKeyMap };
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

function wireDependencies(tracker, created, repoKeyMap, blocksRelationship, blockedStatus) {
    created.forEach(function(c) {
        if (!c.key || !Array.isArray(c.depends_on) || c.depends_on.length === 0) return;
        var anyLinked = false;
        c.depends_on.forEach(function(depRepo) {
            var blockerKey = repoKeyMap[depRepo];
            if (!blockerKey) {
                console.warn('Cannot resolve depends_on "' + depRepo + '" for ' + c.key + ' — skipping link');
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
// Action-phase helpers (gh-1197) — each decision or fetch of the original
// action body, small and directly unit-testable; same tracker/file calls in
// the same order as before.
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

function postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome) {
    // Post summary comment on the SA ticket
    if (outcome.created.length > 0 || outcome.skipped.length > 0) {
        postSummaryComment(tracker, saKey, buildSummaryComment(outcome.created, outcome.skipped, baseUrl));
    }
}

function action(params) {
    try {
        var saInfo = extractSaKey(params);
        if (saInfo.error) {
            return { success: false, error: saInfo.error };
        }
        var saKey = saInfo.saKey;

        console.log('createRepoTasks: processing SA ticket ' + saKey);

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
        console.log('Found ' + repos.length + ' affected repo(s): ' + repoNamesCsv(repos));

        var baseUrl = getJiraBaseUrl();
        var projectKey = saContext.parentKey.split('-')[0];

        // Load existing Sub-tasks under the parent to avoid duplicates
        var existingSummaries = loadExistingSummaries(tracker, saContext.parentKey);

        var outcome = createSubTasks(tracker, repos, projectKey, saContext.parentKey, parentSummary, saKey, baseUrl, options.ticketLabels, existingSummaries);

        // Wire dependencies: blocker Blocks dependent + move dependent to Blocked status
        wireDependencies(tracker, outcome.created, outcome.repoKeyMap, options.blocksRelationship, options.blockedStatus);

        postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome);

        var successCount = outcome.created.filter(function(c) { return !c.error; }).length;
        return {
            success: true,
            message: 'Created ' + successCount + ' Sub-task(s) under ' + saContext.parentKey + ', skipped ' + outcome.skipped.length,
            created: successCount,
            skipped: outcome.skipped.length
        };

    } catch (error) {
        console.error('Error in createRepoTasks:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parseAffectedRepos: parseAffectedRepos,
        decideDuplicate: decideDuplicate,
        buildRepoSummary: buildRepoSummary,
        buildScopeDescription: buildScopeDescription,
        extractCreatedKey: extractCreatedKey,
        buildSummaryComment: buildSummaryComment,
        loadExistingSummaries: loadExistingSummaries,
        createSubTasks: createSubTasks,
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
