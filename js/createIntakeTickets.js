/**
 * Create Intake Tickets Post-Action
 * Reads AI-generated stories.json, creates Epics and Stories in Jira (two-pass),
 * posts an analysis comment, labels the source ticket, and moves it to Done.
 */

const { extractTicketKey } = require('./common/jiraHelpers.js');
const { buildSummary } = require('./common/aiResponseParser.js');
const { ISSUE_TYPES, LABELS, STATUSES } = require('./config.js');

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
            jira_attach_file_to_ticket({
                ticketKey: key,
                name: fileName,
                filePath: filePath,
                contentType: getContentType(filePath)
            });
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
        jira_update_field({
            key: key,
            field: 'Story Points',
            value: Number(entry.storyPoints)
        });
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
        var result = jira_create_ticket_with_json({
            project: projectKey,
            fieldsJson: bugFields
        });
        var key = extractTicketKey(result);
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
        var result = jira_create_ticket_with_json({
            project: projectKey,
            fieldsJson: epicFields
        });
        var key = extractTicketKey(result);
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
        var result = jira_create_ticket_with_json({
            project: projectKey,
            fieldsJson: storyFields
        });
        var key = extractTicketKey(result);
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
        jira_link_issues({
            sourceKey: createdKey,
            anotherKey: sourceKey,
            relationship: 'Relates'
        });
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

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var projectKey = ticketKey.split('-')[0];
        var initiatorId = params.initiator;
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;

        console.log('Processing intake ticket creation for:', ticketKey);

        // 1. Read stories.json
        var stories = readStoriesJson();
        console.log('Found ' + stories.length + ' entries in stories.json');

        var results = [];
        var tempIdMap = {}; // maps "temp-X" / "epic-X" -> actual Jira key
        var keyMap = {};   // maps tempId OR real key -> actual Jira key (for dependency resolution)

        // 2. PASS 0: Create all Bugs (entries with type === 'Bug')
        // Bugs are standalone — no parent, no tempId resolution needed,
        // moved directly to Ready For Development after creation.
        stories.forEach(function(entry) {
            if (entry.type !== 'Bug') return;

            var key = createBug(entry, projectKey);
            var summary = buildSummary(entry.summary, 0);

            if (key) {
                if (entry.tempId) {
                    tempIdMap[entry.tempId] = key;
                    keyMap[entry.tempId] = key;
                }
                keyMap[key] = key;

                // Move bug to Ready For Development so SM picks it up immediately
                try {
                    jira_move_to_status({ key: key, statusName: STATUSES.READY_FOR_DEVELOPMENT });
                    console.log('Moved Bug ' + key + ' to Ready For Development');
                } catch (e) {
                    console.warn('Failed to move bug ' + key + ' to Ready For Development:', e);
                }
            }

            entry._createdKey = key;
            attachFilesToTicket(key, entry);
            linkToSource(key, ticketKey);
            results.push({
                type: 'Bug',
                summary: summary,
                key: key,
                success: !!key,
                error: key ? null : 'Creation failed (see logs)'
            });
        });

        // 3. PASS 1: Create all Epics (entries with no parent or parent=null, not Bug type)
        stories.forEach(function(entry) {
            if (entry.type === 'Bug') return; // already handled in pass 0
            if (!entry.parent) {
                var key = createEpic(entry, projectKey);
                var summary = buildSummary(entry.summary, 0);
                if (key && entry.tempId) {
                    tempIdMap[entry.tempId] = key;
                    keyMap[entry.tempId] = key;
                    console.log('Mapped tempId ' + entry.tempId + ' -> ' + key);
                }
                if (key) keyMap[key] = key;
                entry._createdKey = key; // track for pass 4
                attachFilesToTicket(key, entry);
                linkToSource(key, ticketKey);
                setStoryPoints(key, entry);
                results.push({
                    type: 'Epic',
                    summary: summary,
                    key: key,
                    success: !!key,
                    error: key ? null : 'Creation failed (see logs)'
                });
            }
        });

        // 4. PASS 2: Create all Stories (entries with parent set)
        stories.forEach(function(entry) {
            if (entry.type === 'Bug') return; // already handled in pass 0
            if (entry.parent) {
                var resolvedParent = entry.parent;
                // Resolve tempIds (e.g. "epic-1", "temp-1") to actual Jira keys via keyMap
                if (keyMap[resolvedParent]) {
                    resolvedParent = keyMap[resolvedParent];
                } else if (!/^[A-Z]+-\d+$/.test(resolvedParent)) {
                    // Not a real Jira key and not in keyMap — unresolvable tempId
                    console.warn('Could not resolve parent "' + entry.parent + '" - skipping story: ' + entry.summary);
                    entry._createdKey = null;
                    results.push({
                        type: 'Story',
                        summary: buildSummary(entry.summary, 0),
                        key: null,
                        success: false,
                        error: 'Could not resolve parent "' + entry.parent + '"'
                    });
                    return;
                }
                var key = createStory(entry, resolvedParent, projectKey);
                var summary = buildSummary(entry.summary, 0);
                if (key) {
                    if (entry.tempId) keyMap[entry.tempId] = key;
                    keyMap[key] = key;
                }
                entry._createdKey = key; // track for pass 4
                attachFilesToTicket(key, entry);
                linkToSource(key, ticketKey);
                setStoryPoints(key, entry);
                results.push({
                    type: 'Story',
                    summary: summary,
                    key: key,
                    success: !!key,
                    error: key ? null : 'Creation failed (see logs)'
                });
            }
        });

        // 4. Dependency and integration links
        function resolveKey(ref) {
            return keyMap[ref] || null;
        }

        // blockedBy: create Blocks links + move blocked story to Blocked status
        // Uses entry._createdKey instead of results[idx] to avoid index mismatch
        stories.forEach(function(entry) {
            var blockedKey = entry._createdKey;
            if (!blockedKey || !Array.isArray(entry.blockedBy) || entry.blockedBy.length === 0) return;
            var anyLinked = false;
            entry.blockedBy.forEach(function(ref) {
                var blockerKey = resolveKey(ref);
                if (!blockerKey) {
                    console.warn('Cannot resolve blockedBy ref "' + ref + '" for ' + blockedKey);
                    return;
                }
                try {
                    jira_link_issues({ sourceKey: blockedKey, anotherKey: blockerKey, relationship: 'Blocks' });
                    console.log(blockerKey + ' blocks ' + blockedKey);
                    anyLinked = true;
                } catch (e) {
                    console.warn('Failed to link ' + blockerKey + ' blocks ' + blockedKey + ':', e);
                }
            });
            if (anyLinked) {
                try {
                    jira_move_to_status({ key: blockedKey, statusName: STATUSES.BLOCKED });
                    console.log('Set ' + blockedKey + ' to Blocked');
                } catch (e) {
                    console.warn('Failed to set Blocked status on ' + blockedKey + ':', e);
                }
            }
        });

        // integrates: create Relates links between parallel stories that will be combined
        stories.forEach(function(entry) {
            var storyKey = entry._createdKey;
            if (!storyKey || !Array.isArray(entry.integrates) || entry.integrates.length === 0) return;
            entry.integrates.forEach(function(ref) {
                var otherKey = resolveKey(ref);
                if (!otherKey || otherKey === storyKey) return;
                try {
                    jira_link_issues({ sourceKey: storyKey, anotherKey: otherKey, relationship: 'Relates' });
                    console.log(storyKey + ' relates to ' + otherKey + ' (integration)');
                } catch (e) {
                    console.warn('Failed to link integration ' + storyKey + ' <-> ' + otherKey + ':', e);
                }
            });
        });

        // 5. Read AI comment
        var aiComment = readCommentFile();

        // 6. Post combined comment to source ticket
        try {
            var finalComment = buildFinalComment(results, aiComment);
            jira_post_comment({
                key: ticketKey,
                comment: finalComment
            });
            console.log('Posted intake analysis comment to ' + ticketKey);
        } catch (commentError) {
            console.warn('Failed to post comment to ' + ticketKey + ':', commentError);
        }

        // 7. Add ai_intake label
        try {
            jira_add_label({
                key: ticketKey,
                label: LABELS.AI_INTAKE
            });
        } catch (labelError) {
            console.warn('Failed to add ' + LABELS.AI_INTAKE + ' label:', labelError);
        }

        // 8. Add ai_generated label
        try {
            jira_add_label({
                key: ticketKey,
                label: LABELS.AI_GENERATED
            });
        } catch (labelError) {
            console.warn('Failed to add ' + LABELS.AI_GENERATED + ' label:', labelError);
        }

        // 9. Assign to initiator
        try {
            jira_assign_ticket_to({
                key: ticketKey,
                accountId: initiatorId
            });
            console.log('Assigned ' + ticketKey + ' to initiator');
        } catch (assignError) {
            console.warn('Failed to assign ticket:', assignError);
        }

        // 10. Move to In Development (transition name is 'In Progress' in this Jira instance)
        try {
            jira_move_to_status({
                key: ticketKey,
                statusName: STATUSES.IN_PROGRESS
            });
            console.log('Moved ' + ticketKey + ' to In Development');
        } catch (statusError) {
            console.warn('Failed to move ticket to In Development:', statusError);
        }

        // 11. Remove WIP label if present
        if (wipLabel) {
            try {
                jira_remove_label({
                    key: ticketKey,
                    label: wipLabel
                });
                console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
            } catch (wipError) {
                console.warn('Failed to remove WIP label:', wipError);
            }
        }

        var successCount = results.filter(function(r) { return r.success; }).length;

        return {
            success: true,
            message: 'Intake complete for ' + ticketKey + ': created ' + successCount + ' ticket(s), moved to In Development',
            results: results
        };

    } catch (error) {
        console.error('Error in createIntakeTickets:', error);

        try {
            if (params && params.ticket && params.ticket.key) {
                jira_post_comment({
                    key: params.ticket.key,
                    comment: '*Intake Workflow Error:* ' + error.toString() + '. Please check server logs for details.'
                });
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
