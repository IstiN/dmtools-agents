/**
 * Create Repository Development Sub-tasks — Multi-Task Variant
 *
 * Like createRepoTasks.js, reads the {code:json|title=affected_repos} block from
 * a story-solution (SA) ticket description and creates development Sub-tasks
 * under the same parent as the SA ticket — but supports splitting a single
 * repository's work into several independently trackable Sub-tasks via an
 * optional `tasks` array on a repo entry (see
 * instructions/story_solution/affected_repos_multi_task_split.md).
 *
 * Backward compatible: a repo entry with no `tasks` array still produces
 * exactly one Sub-task, identical to createRepoTasks.js.
 *
 * Summary format:   [repo] <task title OR repo-level reason>
 * Description:      Your scope only development for [repo] based on solution in
 *                   [SA link] and parent acceptance criteria [parent link]
 *
 * Duplicate-safe: skips (repo, title) pairs that already have a matching
 * Sub-task under the parent.
 *
 * gh-1004: action was one 200+ line function (CRAP 57.2). The pure decisions
 * and payload builders are extracted below so action only orchestrates; every
 * helper is covered directly by js/unit-tests/test_createRepoTasksMulti.js.
 */

var configModule = require('./config.js');
var trackersModule = require('./common/trackers.js');
var linkedIssuesReport = require('./common/linkedIssuesReport.js');
var truncateSummary = configModule.truncateSummary;
var JIRA_SUMMARY_MAX_LENGTH = configModule.JIRA_SUMMARY_MAX_LENGTH;

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
// Flatten repo entries (with optional `tasks`) into a flat list of tasks,
// each carrying a globally-unique key "repo:id" and resolved depends_on keys.
// ---------------------------------------------------------------------------

function flattenTasks(repos) {
    var normalised = repos.map(function(r) {
        return typeof r === 'string' ? { name: r } : r;
    });

    // repoName -> array of task keys ("repo:id"), used to expand bare-repo-name deps
    var repoTaskKeys = {};
    var flat = [];

    normalised.forEach(function(repo) {
        var repoName = repo.name;
        if (!repoName) return;

        if (Array.isArray(repo.tasks) && repo.tasks.length > 0) {
            repoTaskKeys[repoName] = [];
            repo.tasks.forEach(function(t) {
                var id = t.id || t.title;
                var key = repoName + ':' + id;
                repoTaskKeys[repoName].push(key);
                flat.push({
                    key: key,
                    repo: repoName,
                    title: t.title || id,
                    reason: t.reason || '',
                    rawDependsOn: Array.isArray(t.depends_on) ? t.depends_on : [],
                    repoLevelDependsOn: Array.isArray(repo.depends_on) ? repo.depends_on : []
                });
            });
        } else {
            // Implicit single task for this repo — identical to createRepoTasks.js behaviour
            var implicitKey = repoName + ':' + repoName;
            repoTaskKeys[repoName] = [implicitKey];
            flat.push({
                key: implicitKey,
                repo: repoName,
                title: repo.reason || repoName,
                reason: repo.reason || '',
                rawDependsOn: [],
                repoLevelDependsOn: Array.isArray(repo.depends_on) ? repo.depends_on : []
            });
        }
    });

    // Resolve depends_on references into concrete task keys.
    function resolveRef(ref, ownRepo) {
        if (ref.indexOf(':') !== -1) {
            // Already a fully-qualified "repo:id" reference
            return repoTaskKeys[ref.split(':')[0]] && flat.some(function(f) { return f.key === ref; })
                ? [ref] : [];
        }
        if (repoTaskKeys[ref]) {
            // Bare repo name → depends on all of that repo's tasks
            return repoTaskKeys[ref].slice();
        }
        // Bare task id within the same repo
        var sameRepoKey = ownRepo + ':' + ref;
        return flat.some(function(f) { return f.key === sameRepoKey; }) ? [sameRepoKey] : [];
    }

    flat.forEach(function(t) {
        var resolved = {};
        t.rawDependsOn.concat(t.repoLevelDependsOn).forEach(function(ref) {
            resolveRef(ref, t.repo).forEach(function(k) {
                if (k !== t.key) resolved[k] = true;
            });
        });
        t.depends_on = Object.keys(resolved);
    });

    return flat;
}

// ---------------------------------------------------------------------------
// Topological sort over the flattened task graph
// ---------------------------------------------------------------------------

function topologicalSortTasks(tasks) {
    var byKey = {};
    tasks.forEach(function(t) { byKey[t.key] = t; });

    var sorted = [];
    var visited = {};

    function visit(key) {
        if (visited[key]) return;
        visited[key] = true;
        var t = byKey[key];
        if (t) {
            t.depends_on.forEach(function(dep) { if (byKey[dep]) visit(dep); });
            sorted.push(t);
        }
    }

    tasks.forEach(function(t) { visit(t.key); });
    return sorted;
}

// ---------------------------------------------------------------------------
// Pure helpers (gh-1004) — no tracker calls, unit-tested directly
// ---------------------------------------------------------------------------

function buildTaskPlan(repos) {
    return topologicalSortTasks(flattenTasks(repos));
}

function buildTaskSummary(repo, title) {
    // AI-authored task titles are free text and can exceed Jira's 255-char
    // summary limit (the API rejects ticket creation outright if they do) —
    // truncate defensively so a single overlong title can't sink the whole run.
    return truncateSummary('[' + repo + '] ' + title, JIRA_SUMMARY_MAX_LENGTH);
}

function buildTaskDescription(repo, reason, saKey, parentKey, baseUrl) {
    var saRef  = baseUrl ? jiraLink(saKey, baseUrl)    : saKey;
    var parRef = baseUrl ? jiraLink(parentKey, baseUrl) : parentKey;
    return (reason ? reason + '\n\n' : '') +
           'Your scope only development for *' + repo +
           '* based on solution in ' + saRef +
           ' and parent acceptance criteria ' + parRef;
}

function decideDuplicate(existingSummaries, summary) {
    return existingSummaries.indexOf(summary) !== -1;
}

function extractCreatedKey(result) {
    try {
        // tracker.createTicketWithParent already returns the extracted key
        return typeof result === 'string' ? (result || null) : (result && (result.key || result.id)) || null;
    } catch (e) {
        // key extraction failed — non-critical
        return null;
    }
}

function buildSummaryComment(created, skipped, baseUrl) {
    var comment = 'h3. Development Sub-tasks\n\n';
    created.forEach(function(c) {
        if (c.error) {
            comment += '* ❌ ' + c.summary + ': ' + c.error + '\n';
        } else {
            var ref = c.key && baseUrl ? jiraLink(c.key, baseUrl) : (c.key || c.summary);
            comment += '* ✅ ' + ref + ' — ' + c.summary + '\n';
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
        // JQL text: provider-specific query (WIQL on ado)
        var provider = tracker && typeof tracker.provider === 'function' ? tracker.provider() : 'jira';
        var existing = tracker.searchIssues(linkedIssuesReport.buildChildrenQuery(provider, parentKey, 'parent = ' + parentKey + ' AND issuetype = Sub-task', 'Sub-task'), {
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

function createSubTasks(tracker, tasks, projectKey, parentKey, saKey, baseUrl, ticketLabels, existingSummaries) {
    var created = [];
    var skipped = [];
    // task key ("repo:id") → created Jira key, for dependency linking
    var taskKeyMap = {};

    tasks.forEach(function(t) {
        var summary = buildTaskSummary(t.repo, t.title);

        // Dedup key is "[repo] title" (not just "[repo]") so multiple tasks
        // in the same repo don't falsely collide.
        if (decideDuplicate(existingSummaries, summary)) {
            console.log('Skipping "' + summary + '" — sub-task already exists');
            skipped.push(summary);
            return;
        }

        var descBody = buildTaskDescription(t.repo, t.reason, saKey, parentKey, baseUrl);

        try {
            var result = tracker.createTicketWithParent(projectKey, 'Sub-task', summary, descBody, parentKey, { labels: ticketLabels });

            var createdKey = extractCreatedKey(result);

            console.log('Created Sub-task ' + (createdKey || '(key unavailable)') + ': ' + summary);
            created.push({ taskKey: t.key, repo: t.repo, key: createdKey, summary: summary, depends_on: t.depends_on });
            if (createdKey) taskKeyMap[t.key] = createdKey;

        } catch (e) {
            console.error('Failed to create Sub-task for ' + summary + ':', e);
            created.push({ taskKey: t.key, repo: t.repo, key: null, summary: summary, error: e.toString(), depends_on: [] });
        }
    });

    return { created: created, skipped: skipped, taskKeyMap: taskKeyMap };
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

function wireDependencies(tracker, created, taskKeyMap, blocksRelationship, blockedStatus) {
    created.forEach(function(c) {
        if (!c.key || !Array.isArray(c.depends_on) || c.depends_on.length === 0) return;
        var anyLinked = false;
        c.depends_on.forEach(function(depKey) {
            var blockerKey = taskKeyMap[depKey];
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

function action(params) {
    try {
        var saKey = params.ticket && params.ticket.key;
        if (!saKey) {
            return { success: false, error: 'No ticket key in params' };
        }

        console.log('createRepoTasksMulti: processing SA ticket ' + saKey);

        var customParams = params.customParams || (params.jobParams && params.jobParams.customParams) || {};
        var blocksRelationship = customParams.blocksRelationship || 'Blocks';
        var blockedStatus      = customParams.blockedStatus      || 'Blocked';
        var ticketLabels       = customParams.labels             || ['development'];

        var tracker = trackersModule.createTracker(null, customParams);
        var saTicket = tracker.getIssue(saKey, ['description', 'summary', 'parent']);
        var saFields = saTicket && saTicket.fields ? saTicket.fields : saTicket;
        var description = saFields.description ? saFields.description.toString() : '';

        var parentInfo = saFields.parent;
        var parentKey = parentInfo && typeof parentInfo === 'object' ? parentInfo.key : null;
        if (!parentKey) {
            return { success: false, error: 'SA ticket ' + saKey + ' has no parent ticket' };
        }
        console.log('Parent ticket: ' + parentKey);

        var parentTicket = tracker.getIssue(parentKey, ['summary']);
        var parentFields = parentTicket && parentTicket.fields ? parentTicket.fields : parentTicket;
        var parentSummary = (parentFields.summary || parentKey).toString();

        var repos = parseAffectedRepos(description);
        if (repos.length === 0) {
            return { success: false, error: 'No affected repos found in ' + saKey + ' — ensure writeSolutionAndLabels ran first' };
        }

        var tasks = buildTaskPlan(repos);
        console.log('Flattened into ' + tasks.length + ' task(s) across ' +
            repos.map(function(r) { return typeof r === 'string' ? r : r.name; }).join(', '));

        var baseUrl = getJiraBaseUrl();
        var projectKey = parentKey.split('-')[0];

        // Load existing Sub-tasks under the parent to avoid duplicates
        var existingSummaries = loadExistingSummaries(tracker, parentKey);

        var outcome = createSubTasks(tracker, tasks, projectKey, parentKey, saKey, baseUrl, ticketLabels, existingSummaries);

        // Wire dependencies: blocker Blocks dependent + move dependent to Blocked status
        wireDependencies(tracker, outcome.created, outcome.taskKeyMap, blocksRelationship, blockedStatus);

        // Post summary comment on the SA ticket
        if (outcome.created.length > 0 || outcome.skipped.length > 0) {
            postSummaryComment(tracker, saKey, buildSummaryComment(outcome.created, outcome.skipped, baseUrl));
        }

        var successCount = outcome.created.filter(function(c) { return !c.error; }).length;
        return {
            success: true,
            message: 'Created ' + successCount + ' Sub-task(s) under ' + parentKey + ', skipped ' + outcome.skipped.length,
            created: successCount,
            skipped: outcome.skipped.length
        };

    } catch (error) {
        console.error('Error in createRepoTasksMulti:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parseAffectedRepos: parseAffectedRepos,
        flattenTasks: flattenTasks,
        topologicalSortTasks: topologicalSortTasks,
        buildTaskPlan: buildTaskPlan,
        buildTaskSummary: buildTaskSummary,
        buildTaskDescription: buildTaskDescription,
        decideDuplicate: decideDuplicate,
        extractCreatedKey: extractCreatedKey,
        buildSummaryComment: buildSummaryComment,
        loadExistingSummaries: loadExistingSummaries,
        createSubTasks: createSubTasks,
        wireDependencies: wireDependencies,
        postSummaryComment: postSummaryComment
    };
}
