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
 */

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

        var saTicket = jira_get_ticket({ key: saKey, fields: ['description', 'summary', 'parent'] });
        var saFields = saTicket && saTicket.fields ? saTicket.fields : saTicket;
        var description = saFields.description ? saFields.description.toString() : '';

        var parentInfo = saFields.parent;
        var parentKey = parentInfo && typeof parentInfo === 'object' ? parentInfo.key : null;
        if (!parentKey) {
            return { success: false, error: 'SA ticket ' + saKey + ' has no parent ticket' };
        }
        console.log('Parent ticket: ' + parentKey);

        var parentTicket = jira_get_ticket({ key: parentKey, fields: ['summary'] });
        var parentFields = parentTicket && parentTicket.fields ? parentTicket.fields : parentTicket;
        var parentSummary = (parentFields.summary || parentKey).toString();

        var repos = parseAffectedRepos(description);
        if (repos.length === 0) {
            return { success: false, error: 'No affected repos found in ' + saKey + ' — ensure writeSolutionAndLabels ran first' };
        }

        var tasks = topologicalSortTasks(flattenTasks(repos));
        console.log('Flattened into ' + tasks.length + ' task(s) across ' +
            repos.map(function(r) { return typeof r === 'string' ? r : r.name; }).join(', '));

        var baseUrl = getJiraBaseUrl();
        var projectKey = parentKey.split('-')[0];

        // Load existing Sub-tasks under the parent to avoid duplicates.
        // Dedup key is "[repo] title" (not just "[repo]") so multiple tasks
        // in the same repo don't falsely collide.
        var existingSummaries = [];
        try {
            var existing = jira_search_by_jql({
                jql: 'parent = ' + parentKey + ' AND issuetype = Sub-task',
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

        var created = [];
        var skipped = [];
        // task key ("repo:id") → created Jira key, for dependency linking
        var taskKeyMap = {};

        tasks.forEach(function(t) {
            var summary = '[' + t.repo + '] ' + t.title;

            var duplicate = existingSummaries.indexOf(summary) !== -1;
            if (duplicate) {
                console.log('Skipping "' + summary + '" — sub-task already exists');
                skipped.push(summary);
                return;
            }

            var saRef  = baseUrl ? jiraLink(saKey, baseUrl)     : saKey;
            var parRef = baseUrl ? jiraLink(parentKey, baseUrl)  : parentKey;
            var descBody = (t.reason ? t.reason + '\n\n' : '') +
                       'Your scope only development for *' + t.repo +
                       '* based on solution in ' + saRef +
                       ' and parent acceptance criteria ' + parRef;

            try {
                var result = jira_create_ticket_with_parent({
                    project: projectKey,
                    issueType: 'Sub-task',
                    summary: summary,
                    description: descBody,
                    parentKey: parentKey,
                    labels: ticketLabels
                });

                var createdKey = null;
                try {
                    var parsed = typeof result === 'string' ? JSON.parse(result) : result;
                    createdKey = parsed && (parsed.key || parsed.id) ? (parsed.key || parsed.id) : null;
                } catch (e) { /* key extraction failed — non-critical */ }

                console.log('Created Sub-task ' + (createdKey || '(key unavailable)') + ': ' + summary);
                created.push({ taskKey: t.key, repo: t.repo, key: createdKey, summary: summary, depends_on: t.depends_on });
                if (createdKey) taskKeyMap[t.key] = createdKey;

            } catch (e) {
                console.error('Failed to create Sub-task for ' + summary + ':', e);
                created.push({ taskKey: t.key, repo: t.repo, key: null, summary: summary, error: e.toString(), depends_on: [] });
            }
        });

        // Wire dependencies: blocker Blocks dependent + move dependent to Blocked status
        created.forEach(function(c) {
            if (!c.key || !Array.isArray(c.depends_on) || c.depends_on.length === 0) return;
            var anyLinked = false;
            c.depends_on.forEach(function(depKey) {
                var blockerKey = taskKeyMap[depKey];
                if (!blockerKey) {
                    console.warn('Cannot resolve depends_on "' + depKey + '" for ' + c.key + ' — skipping link');
                    return;
                }
                try {
                    jira_link_issues({ sourceKey: blockerKey, anotherKey: c.key, relationship: blocksRelationship });
                    console.log(blockerKey + ' ' + blocksRelationship + ' ' + c.key);
                    anyLinked = true;
                } catch (e) {
                    console.warn('Failed to link ' + blockerKey + ' ' + blocksRelationship + ' ' + c.key + ':', e);
                }
            });
            if (anyLinked) {
                try {
                    jira_move_to_status({ key: c.key, statusName: blockedStatus });
                    console.log('Moved ' + c.key + ' to ' + blockedStatus);
                } catch (e) {
                    console.warn('Failed to move ' + c.key + ' to ' + blockedStatus + ':', e);
                }
            }
        });

        // Post summary comment on the SA ticket
        if (created.length > 0 || skipped.length > 0) {
            try {
                var comment = 'h3. Development Sub-tasks\n\n';
                created.forEach(function(c) {
                    if (c.error) {
                        comment += '* \u274c ' + c.summary + ': ' + c.error + '\n';
                    } else {
                        var ref = c.key && baseUrl ? jiraLink(c.key, baseUrl) : (c.key || c.summary);
                        comment += '* \u2705 ' + ref + ' \u2014 ' + c.summary + '\n';
                    }
                });
                if (skipped.length > 0) {
                    comment += '\n_Skipped (already exist): ' + skipped.join(', ') + '_\n';
                }
                jira_post_comment({ key: saKey, comment: comment });
            } catch (e) {
                console.warn('Failed to post summary comment on ' + saKey + ':', e);
            }
        }

        var successCount = created.filter(function(c) { return !c.error; }).length;
        return {
            success: true,
            message: 'Created ' + successCount + ' Sub-task(s) under ' + parentKey + ', skipped ' + skipped.length,
            created: successCount,
            skipped: skipped.length
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
        topologicalSortTasks: topologicalSortTasks
    };
}
