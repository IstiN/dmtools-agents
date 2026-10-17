/**
 * Create Intake Tickets Post-Action
 * Reads AI-generated stories.json, creates Epics and Stories in Jira (two-pass),
 * posts an analysis comment, labels the source ticket, and moves it to Done.
 */

const trackersModule = require('./common/trackers.js');
const { buildSummary } = require('./common/aiResponseParser.js');
const { ISSUE_TYPES, LABELS, STATUSES } = require('./config.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

// Tracker for the current action() run (built inside action(), never at module load).
var tracker = null;

/**
 * Read and parse outputs/stories.json
 * @returns {Array} Array of story/epic entries, or empty array on error
 */
function readStoriesJson() {
    try {
        var raw = file_read('outputs/stories.json');
        if (!raw || raw.trim() === '') {
            console.warn('outputs/stories.json is empty');
            return [];
        }
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            console.warn('outputs/stories.json is not an array');
            return [];
        }
        return parsed;
    } catch (error) {
        console.error('Failed to read/parse outputs/stories.json:', error);
        return [];
    }
}

/**
 * Read outputs/comment.md, with fallback text
 * @returns {string} Comment text
 */
function readCommentFile() {
    try {
        var content = file_read('outputs/comment.md');
        if (content && content.trim() !== '') {
            return content;
        }
    } catch (error) {
        console.warn('Could not read outputs/comment.md:', error);
    }
    return 'h3. *Intake Analysis*\n\n_No analysis comment was generated._';
}

/**
 * Read a description file, falling back to the entry summary
 * @param {string} filePath - Path to the description markdown file
 * @param {string} fallbackSummary - Summary to use if file can't be read
 * @returns {string} Description content
 */
function readDescriptionFile(filePath, fallbackSummary) {
    if (!filePath) {
        return fallbackSummary || '';
    }
    try {
        var content = file_read(filePath);
        if (content && content.trim() !== '') {
            return content;
        }
    } catch (error) {
        console.warn('Could not read description file ' + filePath + ':', error);
    }
    return fallbackSummary || '';
}

/**
 * Get MIME content type from file extension
 * @param {string} filePath
 * @returns {string} MIME type
 */
function getContentType(filePath) {
    var ext = filePath.split('.').pop().toLowerCase();
    var types = {
        'pdf':  'application/pdf',
        'png':  'image/png',
        'jpg':  'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif':  'image/gif',
        'webp': 'image/webp',
        'svg':  'image/svg+xml',
        'zip':  'application/zip',
        'doc':  'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls':  'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'txt':  'text/plain',
        'md':   'text/markdown',
        'json': 'application/json',
        'mp4':  'video/mp4',
        'mov':  'video/quicktime'
    };
    return types[ext] || 'application/octet-stream';
}

/**
 * Attach files listed in entry.attachments to a created ticket
 * @param {string} key - Jira ticket key
 * @param {Object} entry - Entry from stories.json
 */
function attachFilesToTicket(key, entry) {
    if (!key || !Array.isArray(entry.attachments) || entry.attachments.length === 0) return;
    entry.attachments.forEach(function(filePath) {
        try {
            var fileName = filePath.split('/').pop();
            tracker.attachFile(key, fileName, filePath, getContentType(filePath));
            console.log('Attached ' + fileName + ' to ' + key);
        } catch (error) {
            console.warn('Failed to attach ' + filePath + ' to ' + key + ':', error);
        }
    });
}

/**
 * Set Story Points on a ticket after creation (field is not on create screen)
 */
function setStoryPoints(key, entry) {
    if (!key || entry.storyPoints == null || isNaN(entry.storyPoints)) return;
    try {
        tracker.updateField(key, 'Story Points', Number(entry.storyPoints));
        console.log('Set Story Points=' + entry.storyPoints + ' on ' + key);
    } catch (error) {
        console.warn('Failed to set Story Points on ' + key + ':', error);
    }
}

/**
 * Create an Bug in Jira from an intake entry.
 * After creation, moves the bug directly to Ready For Development.
 * @param {Object} entry - Entry from stories.json with type === 'Bug'
 * @param {string} projectKey - Jira project key
 * @returns {string|null} Created ticket key or null on failure
 */
function createBug(entry, projectKey) {
    var summary = buildSummary(entry.summary, 0);
    var description = readDescriptionFile(entry.description, summary);

    try {
        var bugFields = {
            summary: summary,
            description: description,
            issuetype: { name: ISSUE_TYPES.BUG }
        };
        if (entry.priority) {
            bugFields.priority = { name: entry.priority };
        }
        var key = tracker.createTicketWithFields(projectKey, bugFields);
        console.log('Created Bug: ' + (key || '(unknown key)') + ' - ' + summary);
        return key;
    } catch (error) {
        console.error('Failed to create Bug "' + summary + '":', error);
        return null;
    }
}

/**
 * Create an Epic in Jira
 * @param {Object} entry - Entry from stories.json (no parent)
 * @param {string} projectKey - Jira project key
 * @returns {string|null} Created ticket key or null on failure
 */
function createEpic(entry, projectKey) {
    var summary = buildSummary(entry.summary, 0);
    var description = readDescriptionFile(entry.description, summary);

    try {
        var epicFields = {
            summary: summary,
            description: description,
            issuetype: { name: ISSUE_TYPES.EPIC }
        };
        if (entry.priority) {
            epicFields.priority = { name: entry.priority };
        }
        var key = tracker.createTicketWithFields(projectKey, epicFields);
        console.log('Created Epic: ' + (key || '(unknown key)') + ' - ' + summary);
        return key;
    } catch (error) {
        console.error('Failed to create Epic "' + summary + '":', error);
        return null;
    }
}

/**
 * Create a Story in Jira under the given parent
 * @param {Object} entry - Entry from stories.json (has parent)
 * @param {string} resolvedParent - Resolved parent ticket key
 * @param {string} projectKey - Jira project key
 * @returns {string|null} Created ticket key or null on failure
 */
function createStory(entry, resolvedParent, projectKey) {
    var summary = buildSummary(entry.summary, 0);
    var description = readDescriptionFile(entry.description, summary);

    try {
        var storyFields = {
            summary: summary,
            description: description,
            issuetype: { name: ISSUE_TYPES.STORY },
            parent: { key: resolvedParent }
        };
        if (entry.priority) {
            storyFields.priority = { name: entry.priority };
        }
        var key = tracker.createTicketWithFields(projectKey, storyFields);
        console.log('Created Story: ' + (key || '(unknown key)') + ' under ' + resolvedParent + ' - ' + summary);
        return key;
    } catch (error) {
        console.error('Failed to create Story "' + summary + '" under ' + resolvedParent + ':', error);
        return null;
    }
}

/**
 * Add "Relates" link between a created ticket and the source intake ticket
 * @param {string} createdKey - Newly created Epic/Story key
 * @param {string} sourceKey - Source intake ticket key
 */
function linkToSource(createdKey, sourceKey) {
    if (!createdKey) return;
    try {
        tracker.linkIssues(createdKey, sourceKey, 'Relates');
        console.log('Linked ' + createdKey + ' relates to ' + sourceKey);
    } catch (error) {
        console.warn('Failed to link ' + createdKey + ' to ' + sourceKey + ':', error);
    }
}

/**
 * Build the final comment combining AI analysis + created ticket list
 * @param {Array} results - Array of { type, summary, key, success, error }
 * @param {string} aiComment - AI-generated comment from outputs/comment.md
 * @returns {string} Full comment for Jira
 */
function buildFinalComment(results, aiComment) {
    var comment = aiComment + '\n\n';
    comment += 'h3. *Created Tickets*\n\n';

    var successes = results.filter(function(r) { return r.success; });
    var failures = results.filter(function(r) { return !r.success; });

    if (successes.length === 0 && failures.length === 0) {
        comment += '_No tickets were created (stories.json was empty)._\n';
    } else {
        successes.forEach(function(r) {
            comment += '* [' + r.key + '|https://dmtools.atlassian.net/browse/' + r.key + '] (' + r.type + ') - ' + r.summary + '\n';
        });

        if (failures.length > 0) {
            comment += '\n*Failed to Create:*\n';
            failures.forEach(function(r) {
                comment += '* (' + r.type + ') ' + r.summary + ' - Error: ' + r.error + '\n';
            });
        }

        comment += '\n*Total Created:* ' + successes.length + ' ticket(s)';
    }

    return comment;
}

/**
 * Resolve a story parent reference to a real tracker key.
 * @param {Object} entry - Entry from stories.json (has parent)
 * @param {Object} keyMap - Maps tempId OR real key -> actual tracker key
 * @returns {{resolved: boolean, parent: string|null}} Resolved key, or resolved=false for an unresolvable tempId
 */
function resolveParentRef(entry, keyMap) {
    if (keyMap[entry.parent]) {
        return { resolved: true, parent: keyMap[entry.parent] };
    }
    if (!/^[A-Z]+-\d+$/.test(entry.parent)) {
        return { resolved: false, parent: null };
    }
    return { resolved: true, parent: entry.parent };
}

/**
 * Resolve any ref (tempId or real key) to a created tracker key.
 * @param {string} ref
 * @param {Object} keyMap
 * @returns {string|null}
 */
function resolveKey(ref, keyMap) {
    return keyMap[ref] || null;
}

/**
 * Build the per-run action context (pure — no tracker or file access).
 * @param {Object} params - action() params
 * @returns {{ticketKey: string, projectKey: string, initiatorId: *, wipLabel: string|null}}
 */
function initActionContext(params) {
    var ticketKey = params.ticket.key;
    return {
        ticketKey: ticketKey,
        projectKey: ticketKey.split('-')[0],
        initiatorId: params.initiator,
        wipLabel: params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null
    };
}

/**
 * PASS 0: create all Bugs (entries with type === 'Bug').
 * Bugs are standalone — no parent, no tempId resolution needed,
 * moved directly to Ready For Development after creation.
 * @param {Array} stories - Entries from stories.json
 * @param {Object} ctx - Action context from initActionContext()
 * @param {Object} state - Mutable { results, tempIdMap, keyMap }
 */
function createBugsPass(stories, ctx, state) {
    stories.forEach(function(entry) {
        if (entry.type !== 'Bug') return;

        var key = createBug(entry, ctx.projectKey);
        var summary = buildSummary(entry.summary, 0);

        if (key) {
            if (entry.tempId) {
                state.tempIdMap[entry.tempId] = key;
                state.keyMap[entry.tempId] = key;
            }
            state.keyMap[key] = key;

            // Move bug to Ready For Development so SM picks it up immediately
            try {
                tracker.moveToStatus(key, STATUSES.READY_FOR_DEVELOPMENT);
                console.log('Moved Bug ' + key + ' to Ready For Development');
            } catch (e) {
                console.warn('Failed to move bug ' + key + ' to Ready For Development:', e);
            }
        }

        entry._createdKey = key;
        attachFilesToTicket(key, entry);
        linkToSource(key, ctx.ticketKey);
        state.results.push({
            type: 'Bug',
            summary: summary,
            key: key,
            success: !!key,
            error: key ? null : 'Creation failed (see logs)'
        });
    });
}

/**
 * PASS 1: create all Epics (entries with no parent or parent=null, not Bug type).
 * @param {Array} stories - Entries from stories.json
 * @param {Object} ctx - Action context from initActionContext()
 * @param {Object} state - Mutable { results, tempIdMap, keyMap }
 */
function createEpicsPass(stories, ctx, state) {
    stories.forEach(function(entry) {
        if (entry.type === 'Bug') return; // already handled in pass 0
        if (!entry.parent) {
            var key = createEpic(entry, ctx.projectKey);
            var summary = buildSummary(entry.summary, 0);
            if (key && entry.tempId) {
                state.tempIdMap[entry.tempId] = key;
                state.keyMap[entry.tempId] = key;
                console.log('Mapped tempId ' + entry.tempId + ' -> ' + key);
            }
            if (key) state.keyMap[key] = key;
            entry._createdKey = key; // track for pass 4
            attachFilesToTicket(key, entry);
            linkToSource(key, ctx.ticketKey);
            setStoryPoints(key, entry);
            state.results.push({
                type: 'Epic',
                summary: summary,
                key: key,
                success: !!key,
                error: key ? null : 'Creation failed (see logs)'
            });
        }
    });
}

/**
 * PASS 2: create all Stories (entries with parent set), resolving tempIds via keyMap.
 * @param {Array} stories - Entries from stories.json
 * @param {Object} ctx - Action context from initActionContext()
 * @param {Object} state - Mutable { results, tempIdMap, keyMap }
 */
function createStoriesPass(stories, ctx, state) {
    stories.forEach(function(entry) {
        if (entry.type === 'Bug') return; // already handled in pass 0
        if (!entry.parent) return;        // already handled in pass 1

        var parent = resolveParentRef(entry, state.keyMap);
        if (!parent.resolved) {
            // Not a real tracker key and not in keyMap — unresolvable tempId
            console.warn('Could not resolve parent "' + entry.parent + '" - skipping story: ' + entry.summary);
            entry._createdKey = null;
            state.results.push({
                type: 'Story',
                summary: buildSummary(entry.summary, 0),
                key: null,
                success: false,
                error: 'Could not resolve parent "' + entry.parent + '"'
            });
            return;
        }

        var key = createStory(entry, parent.parent, ctx.projectKey);
        var summary = buildSummary(entry.summary, 0);
        if (key) {
            if (entry.tempId) state.keyMap[entry.tempId] = key;
            state.keyMap[key] = key;
        }
        entry._createdKey = key; // track for pass 4
        attachFilesToTicket(key, entry);
        linkToSource(key, ctx.ticketKey);
        setStoryPoints(key, entry);
        state.results.push({
            type: 'Story',
            summary: summary,
            key: key,
            success: !!key,
            error: key ? null : 'Creation failed (see logs)'
        });
    });
}

/**
 * PASS 3a: blockedBy — create Blocks links + move blocked story to Blocked status.
 * Uses entry._createdKey to avoid index mismatch with results.
 * @param {Array} stories - Entries from stories.json
 * @param {Object} keyMap - Maps tempId OR real key -> actual tracker key
 */
function linkBlockedByPass(stories, keyMap) {
    stories.forEach(function(entry) {
        var blockedKey = entry._createdKey;
        if (!blockedKey || !Array.isArray(entry.blockedBy) || entry.blockedBy.length === 0) return;
        var anyLinked = false;
        entry.blockedBy.forEach(function(ref) {
            var blockerKey = resolveKey(ref, keyMap);
            if (!blockerKey) {
                console.warn('Cannot resolve blockedBy ref "' + ref + '" for ' + blockedKey);
                return;
            }
            try {
                tracker.linkIssues(blockedKey, blockerKey, 'Blocks');
                console.log(blockerKey + ' blocks ' + blockedKey);
                anyLinked = true;
            } catch (e) {
                console.warn('Failed to link ' + blockerKey + ' blocks ' + blockedKey + ':', e);
            }
        });
        if (anyLinked) {
            try {
                tracker.moveToStatus(blockedKey, STATUSES.BLOCKED);
                console.log('Set ' + blockedKey + ' to Blocked');
            } catch (e) {
                console.warn('Failed to set Blocked status on ' + blockedKey + ':', e);
            }
        }
    });
}

/**
 * PASS 3b: integrates — create Relates links between parallel stories that will be combined.
 * @param {Array} stories - Entries from stories.json
 * @param {Object} keyMap - Maps tempId OR real key -> actual tracker key
 */
function linkIntegrationsPass(stories, keyMap) {
    stories.forEach(function(entry) {
        var storyKey = entry._createdKey;
        if (!storyKey || !Array.isArray(entry.integrates) || entry.integrates.length === 0) return;
        entry.integrates.forEach(function(ref) {
            var otherKey = resolveKey(ref, keyMap);
            if (!otherKey || otherKey === storyKey) return;
            try {
                tracker.linkIssues(storyKey, otherKey, 'Relates');
                console.log(storyKey + ' relates to ' + otherKey + ' (integration)');
            } catch (e) {
                console.warn('Failed to link integration ' + storyKey + ' <-> ' + otherKey + ':', e);
            }
        });
    });
}

/**
 * Finalize the source intake ticket: post combined comment, labels, assignee,
 * status move, WIP label removal and token usage comments.
 * @param {Object} ctx - Action context from initActionContext()
 * @param {Array} results - Per-entry creation results
 * @param {Object} params - action() params
 */
function finalizeIntakeTicket(ctx, results, params) {
    // Post combined comment to source ticket
    try {
        var finalComment = buildFinalComment(results, readCommentFile());
        tracker.postComment(ctx.ticketKey, finalComment);
        console.log('Posted intake analysis comment to ' + ctx.ticketKey);
    } catch (commentError) {
        console.warn('Failed to post comment to ' + ctx.ticketKey + ':', commentError);
    }

    // Add ai_intake label
    try {
        tracker.addLabel(ctx.ticketKey, LABELS.AI_INTAKE);
    } catch (labelError) {
        console.warn('Failed to add ' + LABELS.AI_INTAKE + ' label:', labelError);
    }

    // Add ai_generated label
    try {
        tracker.addLabel(ctx.ticketKey, LABELS.AI_GENERATED);
    } catch (labelError) {
        console.warn('Failed to add ' + LABELS.AI_GENERATED + ' label:', labelError);
    }

    // Assign to initiator
    try {
        tracker.assignTo(ctx.ticketKey, ctx.initiatorId);
        console.log('Assigned ' + ctx.ticketKey + ' to initiator');
    } catch (assignError) {
        console.warn('Failed to assign ticket:', assignError);
    }

    // Move to In Development (transition name is 'In Progress' in this Jira instance)
    try {
        tracker.moveToStatus(ctx.ticketKey, STATUSES.IN_PROGRESS);
        console.log('Moved ' + ctx.ticketKey + ' to In Development');
    } catch (statusError) {
        console.warn('Failed to move ticket to In Development:', statusError);
    }

    // Remove WIP label if present
    if (ctx.wipLabel) {
        try {
            tracker.removeLabel(ctx.ticketKey, ctx.wipLabel);
            console.log('Removed WIP label "' + ctx.wipLabel + '" from ' + ctx.ticketKey);
        } catch (wipError) {
            console.warn('Failed to remove WIP label:', wipError);
        }
    }

    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run.
    try {
        tokenUsageComment.postTokenUsageComments(ctx.ticketKey, { initiator: params.initiator, tracker: tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function action(params) {
    tracker = trackersModule.createTracker(null, (params && params.jobParams && params.jobParams.customParams) || (params && params.customParams) || {});
    try {
        var ctx = initActionContext(params);

        console.log('Processing intake ticket creation for:', ctx.ticketKey);

        // 1. Read stories.json
        var stories = readStoriesJson();
        console.log('Found ' + stories.length + ' entries in stories.json');

        var state = {
            results: [],
            tempIdMap: {}, // maps "temp-X" / "epic-X" -> actual tracker key
            keyMap: {}     // maps tempId OR real key -> actual tracker key (for dependency resolution)
        };

        // 2-4. Creation passes: Bugs -> Epics -> Stories (same tracker calls, same order)
        createBugsPass(stories, ctx, state);
        createEpicsPass(stories, ctx, state);
        createStoriesPass(stories, ctx, state);

        // 5. Dependency and integration links
        linkBlockedByPass(stories, state.keyMap);
        linkIntegrationsPass(stories, state.keyMap);

        // 6-11. Finalize the source ticket
        finalizeIntakeTicket(ctx, state.results, params);

        var successCount = state.results.filter(function(r) { return r.success; }).length;

        return {
            success: true,
            message: 'Intake complete for ' + ctx.ticketKey + ': created ' + successCount + ' ticket(s), moved to In Development',
            results: state.results
        };

    } catch (error) {
        console.error('Error in createIntakeTickets:', error);

        try {
            if (params && params.ticket && params.ticket.key) {
                tracker.postComment(params.ticket.key, '*Intake Workflow Error:* ' + error.toString() + '. Please check server logs for details.');
            }
        } catch (commentError) {
            console.error('Failed to post error comment:', commentError);
        }

        return {
            success: false,
            error: error.toString()
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
