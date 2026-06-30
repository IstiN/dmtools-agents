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

function action(params) {
    try {
        var saKey = params.ticket && params.ticket.key;
        if (!saKey) {
            return { success: false, error: 'No ticket key in params' };
        }

        console.log('createRepoTasks: processing SA ticket ' + saKey);

        // Customisable via customParams (or .dmtools/config.js jobParamPatches.createRepoTasks.customParams)
        var customParams = params.customParams || (params.jobParams && params.jobParams.customParams) || {};
        var blocksRelationship = customParams.blocksRelationship || 'Blocks';
        var blockedStatus      = customParams.blockedStatus      || 'Blocked';

        // Fetch the SA ticket to get description + parent
        var saTicket = jira_get_ticket({ key: saKey, fields: ['description', 'summary', 'parent'] });
        var saFields = saTicket && saTicket.fields ? saTicket.fields : saTicket;
        var description = saFields.description ? saFields.description.toString() : '';

        // Resolve parent key
        var parentInfo = saFields.parent;
        var parentKey = parentInfo && typeof parentInfo === 'object' ? parentInfo.key : null;
        if (!parentKey) {
            return { success: false, error: 'SA ticket ' + saKey + ' has no parent ticket' };
        }
        console.log('Parent ticket: ' + parentKey);

        // Fetch parent summary
        var parentTicket = jira_get_ticket({ key: parentKey, fields: ['summary'] });
        var parentFields = parentTicket && parentTicket.fields ? parentTicket.fields : parentTicket;
        var parentSummary = (parentFields.summary || parentKey).toString();

        // Extract repos from description
        var repos = parseAffectedRepos(description);
        if (repos.length === 0) {
            return { success: false, error: 'No affected repos found in ' + saKey + ' — ensure writeSolutionAndLabels ran first' };
        }
        console.log('Found ' + repos.length + ' affected repo(s): ' + repos.map(function(r) { return typeof r === 'string' ? r : r.name; }).join(', '));

        var baseUrl = getJiraBaseUrl();
        var projectKey = parentKey.split('-')[0];

        // Load existing Sub-tasks under the parent to avoid duplicates
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
        // repoName → created Jira key (for dependency linking)
        var repoKeyMap = {};

        repos.forEach(function(repo) {
            var repoName = typeof repo === 'string' ? repo : repo.name;
            if (!repoName) return;

            var summary = '[' + repoName + '] ' + parentSummary;

            // Skip if a sub-task with this repo tag already exists
            var duplicate = existingSummaries.some(function(s) {
                return s.indexOf('[' + repoName + ']') !== -1;
            });
            if (duplicate) {
                console.log('Skipping ' + repoName + ' — sub-task already exists');
                skipped.push(repoName);
                return;
            }

            var saRef  = baseUrl ? jiraLink(saKey, baseUrl)     : saKey;
            var parRef = baseUrl ? jiraLink(parentKey, baseUrl)  : parentKey;
            var desc = 'Your scope only development for *' + repoName +
                       '* based on solution in ' + saRef +
                       ' and parent acceptance criteria ' + parRef;

            try {
                var result = jira_create_ticket_with_parent({
                    project: projectKey,
                    issueType: 'Sub-task',
                    summary: summary,
                    description: desc,
                    parentKey: parentKey
                });

                var createdKey = null;
                try {
                    var parsed = typeof result === 'string' ? JSON.parse(result) : result;
                    createdKey = parsed && (parsed.key || parsed.id) ? (parsed.key || parsed.id) : null;
                } catch (e) { /* key extraction failed — non-critical */ }

                console.log('Created Sub-task ' + (createdKey || '(key unavailable)') + ': ' + summary);
                created.push({ repo: repoName, key: createdKey, summary: summary, depends_on: repo.depends_on || [] });
                if (createdKey) repoKeyMap[repoName] = createdKey;

            } catch (e) {
                console.error('Failed to create Sub-task for ' + repoName + ':', e);
                created.push({ repo: repoName, key: null, error: e.toString(), depends_on: [] });
            }
        });

        // Wire dependencies: blocker Blocks dependent + move dependent to Blocked status
        created.forEach(function(c) {
            if (!c.key || !Array.isArray(c.depends_on) || c.depends_on.length === 0) return;
            var anyLinked = false;
            c.depends_on.forEach(function(depRepo) {
                var blockerKey = repoKeyMap[depRepo];
                if (!blockerKey) {
                    console.warn('Cannot resolve depends_on "' + depRepo + '" for ' + c.key + ' — skipping link');
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
                        comment += '* ❌ ' + c.repo + ': ' + c.error + '\n';
                    } else {
                        var ref = c.key && baseUrl ? jiraLink(c.key, baseUrl) : (c.key || c.summary);
                        comment += '* ✅ ' + ref + ' — ' + c.repo + '\n';
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
        console.error('Error in createRepoTasks:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, parseAffectedRepos: parseAffectedRepos };
}
