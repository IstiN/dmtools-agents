/**
 * Create planned follow-up stories from outputs/stories.json.
 *
 * Reusable post-action helper for workflows where the CLI agent produces an
 * intake-compatible story plan that should be materialized in Jira.
 */

const { ISSUE_TYPES, STATUSES } = require('./config.js');
const { extractTicketKey, setTicketPriority } = require('./common/jiraHelpers.js');
const { buildSummary } = require('./common/aiResponseParser.js');

function tryReadFile(path) {
    try {
        return file_read(path);
    } catch (e) {
        try {
            return file_read({ path: path });
        } catch (e2) {
            return '';
        }
    }
}

function readStoriesJson(path) {
    var raw = tryReadFile(path);
    if (!raw || !raw.trim()) {
        return { found: false, stories: [] };
    }

    try {
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return { found: true, stories: [], error: 'stories.json is not an array' };
        }
        return { found: true, stories: parsed };
    } catch (error) {
        return { found: true, stories: [], error: 'stories.json is invalid JSON: ' + error };
    }
}

function readDescriptionFile(filePath, fallbackSummary) {
    if (!filePath) {
        return fallbackSummary || '';
    }

    var content = tryReadFile(filePath);
    return (content && content.trim()) ? content : (fallbackSummary || '');
}

function getSourceLabels(params) {
    return (params.ticket && params.ticket.fields && params.ticket.fields.labels) ? params.ticket.fields.labels : [];
}

function resolveTargetKey(target, params) {
    if (target === 'sourceTicket') {
        return params.ticket && params.ticket.key ? params.ticket.key : null;
    }

    if (target === 'sourceParent') {
        return params.ticket && params.ticket.fields && params.ticket.fields.parent
            ? params.ticket.fields.parent.key
            : null;
    }

    return null;
}

function getDefaultParentKey(params, config) {
    if (config.defaultParentKey) {
        return config.defaultParentKey;
    }

    if (config.defaultParentSource) {
        return resolveTargetKey(config.defaultParentSource, params);
    }

    if (config.defaultParentFromSourceParent) {
        return resolveTargetKey('sourceParent', params);
    }

    return null;
}

function getSourcePriorityName(params) {
    var priority = params && params.ticket && params.ticket.fields ? params.ticket.fields.priority : null;
    if (!priority) return null;
    if (typeof priority === 'string') return priority;
    return priority.name || null;
}

function normalizePriorityName(priority) {
    if (!priority) return null;
    if (typeof priority === 'string') return priority;
    return priority.name || null;
}

function resolveStoryPriority(entry, params, config) {
    var entryPriority = entry ? normalizePriorityName(entry.priority) : null;
    if (entryPriority) {
        return entryPriority;
    }

    var defaultPriority = config ? normalizePriorityName(config.defaultPriority) : null;
    if (defaultPriority) {
        return defaultPriority;
    }

    if (config && config.inheritSourcePriority === false) {
        return null;
    }

    return getSourcePriorityName(params);
}

function getJiraIssueTypeName(config) {
    return (config && config.issueTypeName) ? config.issueTypeName : ISSUE_TYPES.STORY;
}

function isStoryEntry(entry) {
    return !entry.type || entry.type === ISSUE_TYPES.STORY || entry.type === 'Story';
}

function fetchExistingStoriesByParent(parentKey, issueTypeName) {
    var summaryToKey = {};
    if (!parentKey) return summaryToKey;

    var issues = jira_search_by_jql({
        jql: 'parent = ' + parentKey + ' AND issuetype = "' + issueTypeName + '" ORDER BY created ASC',
        fields: ['key', 'summary']
    }) || [];

    for (var i = 0; i < issues.length; i++) {
        var issue = issues[i];
        var summary = issue && issue.fields ? issue.fields.summary : '';
        if (summary) {
            summaryToKey[summary] = issue.key;
        }
    }

    return summaryToKey;
}

function createStory(entry, resolvedParentKey, params, config) {
    var summary = buildSummary(entry.summary, 0);
    var description = readDescriptionFile(entry.description, summary);
    var projectKey = resolvedParentKey.split('-')[0];
    var priority = resolveStoryPriority(entry, params, config);
    var issueTypeName = getJiraIssueTypeName(config);

    var fieldsJson = {
        summary: summary,
        description: description,
        issuetype: { name: issueTypeName },
        parent: { key: resolvedParentKey }
    };

    if (priority) {
        fieldsJson.priority = priority;
    }

    var result = jira_create_ticket_with_json({
        project: projectKey,
        fieldsJson: fieldsJson
    });

    var createdKey = extractTicketKey(result);
    if (!createdKey) {
        throw new Error('Could not extract Jira key from create response');
    }

    if (priority) {
        setTicketPriority(createdKey, priority);
    }

    if (entry.storyPoints != null && !isNaN(entry.storyPoints)) {
        jira_update_field({
            key: createdKey,
            field: 'Story Points',
            value: Number(entry.storyPoints)
        });
    }

    return createdKey;
}

function linkToSource(createdKey, sourceKey, relationship) {
    if (!createdKey || !sourceKey || !relationship) return;

    jira_link_issues({
        sourceKey: createdKey,
        anotherKey: sourceKey,
        relationship: relationship
    });
}

function linkStory(createdKey, params, config, isExisting) {
    if (!createdKey) return;

    var links = [];

    if (config.linkToSourceRelationship) {
        links.push({
            target: 'sourceTicket',
            relationship: config.linkToSourceRelationship,
            includeExisting: true
        });
    }

    if (Array.isArray(config.additionalLinks)) {
        links = links.concat(config.additionalLinks);
    }

    for (var i = 0; i < links.length; i++) {
        var link = links[i] || {};
        if (!link.relationship) continue;
        if (isExisting && link.includeExisting === false) continue;

        var targetKey = link.targetKey || resolveTargetKey(link.target, params);
        if (!targetKey) continue;

        try {
            linkToSource(createdKey, targetKey, link.relationship);
        } catch (error) {
            console.warn('Failed to create link from ' + createdKey + ' to ' + targetKey + ':', error);
        }
    }
}

function buildSummaryComment(results, title) {
    var created = results.filter(function(r) { return r.success && !r.existing; });
    var reused = results.filter(function(r) { return r.success && r.existing; });
    var failed = results.filter(function(r) { return !r.success; });

    var lines = [
        'h3. *' + (title || 'Planned Stories') + '*',
        ''
    ];

    if (created.length === 0 && reused.length === 0 && failed.length === 0) {
        lines.push('_No follow-up stories were processed._');
        return lines.join('\n');
    }

    if (created.length > 0) {
        lines.push('*Created:*');
        created.forEach(function(item) {
            lines.push('* ' + item.key + ' - ' + item.summary);
        });
        lines.push('');
    }

    if (reused.length > 0) {
        lines.push('*Reused Existing:*');
        reused.forEach(function(item) {
            lines.push('* ' + item.key + ' - ' + item.summary);
        });
        lines.push('');
    }

    if (failed.length > 0) {
        lines.push('*Failed:*');
        failed.forEach(function(item) {
            lines.push('* ' + item.summary + ' - ' + item.error);
        });
        lines.push('');
    }

    lines.push('*Total Processed:* ' + (created.length + reused.length));
    return lines.join('\n');
}

function action(params) {
    try {
        var jobParams = params.jobParams || {};
        var customParams = (params.customParams) || (jobParams.customParams) || {};
        var config = customParams.storyPlanCreation || {};
        var sourceTicketKey = params.ticket && params.ticket.key;
        var sourceLabels = getSourceLabels(params);

        if (config.enabled === false) {
            return { success: true, skipped: true, message: 'storyPlanCreation disabled' };
        }

        if (!sourceTicketKey) {
            return { success: false, error: 'Missing source ticket key' };
        }

        if (config.skipIfLabel && sourceLabels.indexOf(config.skipIfLabel) !== -1) {
            console.log('Story plan creation skipped for ' + sourceTicketKey + ' because label "' + config.skipIfLabel + '" is present');
            return { success: true, skipped: true, message: 'Skip label present' };
        }

        var outputFile = config.outputFile || 'outputs/stories.json';
        var parsed = readStoriesJson(outputFile);
        if (parsed.error) {
            return { success: false, error: parsed.error };
        }

        if (!parsed.found) {
            if (config.required) {
                return { success: false, error: outputFile + ' not found or empty' };
            }
            console.log(outputFile + ' not found — skipping planned story creation');
            return { success: true, skipped: true, message: 'No story plan file found' };
        }

        var stories = parsed.stories || [];
        if (stories.length === 0) {
            console.log(outputFile + ' contains no planned stories');
            return { success: true, createdTickets: [], message: 'No planned stories to create' };
        }

        var defaultParentKey = getDefaultParentKey(params, config);
        var issueTypeName = getJiraIssueTypeName(config);
        var existingByParent = {};
        var keyMap = {};
        var results = [];

        for (var i = 0; i < stories.length; i++) {
            var entry = stories[i] || {};
            var summary = buildSummary(entry.summary, i);
            var resolvedParentKey = entry.parent || defaultParentKey;

            if (!isStoryEntry(entry)) {
                results.push({
                    type: entry.type || 'Unknown',
                    summary: summary,
                    key: null,
                    success: false,
                    error: 'Unsupported entry type for story plan: ' + (entry.type || '(missing)')
                });
                continue;
            }

            if (!resolvedParentKey) {
                results.push({
                    type: ISSUE_TYPES.STORY,
                    summary: summary,
                    key: null,
                    success: false,
                    error: 'No parent key resolved for story'
                });
                continue;
            }

            if (!existingByParent[resolvedParentKey]) {
                existingByParent[resolvedParentKey] = fetchExistingStoriesByParent(resolvedParentKey, issueTypeName);
            }

            var existingKey = existingByParent[resolvedParentKey][summary] || null;
            if (existingKey) {
                entry._createdKey = existingKey;
                if (entry.tempId) keyMap[entry.tempId] = existingKey;
                keyMap[existingKey] = existingKey;
                linkStory(existingKey, params, config, true);
                results.push({
                    type: ISSUE_TYPES.STORY,
                    summary: summary,
                    key: existingKey,
                    success: true,
                    existing: true
                });
                continue;
            }

            try {
                var createdKey = createStory(entry, resolvedParentKey, params, config);
                entry._createdKey = createdKey;
                existingByParent[resolvedParentKey][summary] = createdKey;
                if (entry.tempId) keyMap[entry.tempId] = createdKey;
                keyMap[createdKey] = createdKey;
                linkStory(createdKey, params, config, false);

                results.push({
                    type: ISSUE_TYPES.STORY,
                    summary: summary,
                    key: createdKey,
                    success: true,
                    existing: false
                });
            } catch (error) {
                entry._createdKey = null;
                results.push({
                    type: ISSUE_TYPES.STORY,
                    summary: summary,
                    key: null,
                    success: false,
                    error: error.toString()
                });
            }
        }

        function resolveKey(ref) {
            return keyMap[ref] || null;
        }

        for (var j = 0; j < stories.length; j++) {
            var story = stories[j];
            var blockedKey = story._createdKey;
            if (!blockedKey || !Array.isArray(story.blockedBy)) continue;

            var anyBlocked = false;
            var blockedByRelationship = config.blockedByRelationship || 'Blocks';
            for (var b = 0; b < story.blockedBy.length; b++) {
                var blockerKey = resolveKey(story.blockedBy[b]);
                if (!blockerKey) continue;
                try {
                    jira_link_issues({
                        sourceKey: blockedKey,
                        anotherKey: blockerKey,
                        relationship: blockedByRelationship
                    });
                    anyBlocked = true;
                } catch (e) {
                    console.warn('Failed to create ' + blockedByRelationship + ' link between ' + blockerKey + ' and ' + blockedKey + ':', e);
                }
            }

            if (anyBlocked && config.blockedStatusName !== false) {
                try {
                    jira_move_to_status({
                        key: blockedKey,
                        statusName: config.blockedStatusName || STATUSES.BLOCKED
                    });
                } catch (statusError) {
                    console.warn('Failed to move ' + blockedKey + ' to Blocked:', statusError);
                }
            }
        }

        for (var k = 0; k < stories.length; k++) {
            var storyForLinking = stories[k];
            var storyKey = storyForLinking._createdKey;
            if (!storyKey || !Array.isArray(storyForLinking.integrates)) continue;

            for (var l = 0; l < storyForLinking.integrates.length; l++) {
                var otherKey = resolveKey(storyForLinking.integrates[l]);
                if (!otherKey || otherKey === storyKey) continue;
                try {
                    jira_link_issues({
                        sourceKey: storyKey,
                        anotherKey: otherKey,
                        relationship: 'Relates'
                    });
                } catch (e) {
                    console.warn('Failed to create Relates link between ' + storyKey + ' and ' + otherKey + ':', e);
                }
            }
        }

        var successfulCount = results.filter(function(item) { return item.success; }).length;
        var failureCount = results.filter(function(item) { return !item.success; }).length;

        if (config.postSummaryComment !== false) {
            try {
                jira_post_comment({
                    key: sourceTicketKey,
                    comment: buildSummaryComment(results, config.summaryCommentTitle || 'Planned Follow-up Stories')
                });
            } catch (commentError) {
                console.warn('Failed to post story plan summary comment to ' + sourceTicketKey + ':', commentError);
            }
        }

        if (successfulCount > 0 && config.addLabel) {
            try {
                jira_add_label({ key: sourceTicketKey, label: config.addLabel });
            } catch (labelError) {
                console.warn('Failed to add label "' + config.addLabel + '" to ' + sourceTicketKey + ':', labelError);
            }
        }

        return {
            success: failureCount === 0,
            createdTickets: results,
            message: 'Processed ' + successfulCount + ' planned stor' + (successfulCount === 1 ? 'y' : 'ies') +
                (failureCount ? ', ' + failureCount + ' failed' : '')
        };
    } catch (error) {
        console.error('Error in createPlannedStoriesFromOutput:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
