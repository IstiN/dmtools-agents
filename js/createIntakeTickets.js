/**
 * Create Intake Tickets Post-Action
 * Reads AI-generated stories.json, creates Epics and Stories in the tracker (two-pass),
 * posts an analysis comment, labels the source ticket, and moves it to Done.
 *
 * Jira / ADO: Bugs, Epics and Stories are created with their issue types and fields,
 * linked to the source ticket, and blockedBy becomes Blocks links + Blocked status.
 *
 * GitHub: every entry becomes a SUB-ISSUE — of the source issue, or of its new epic
 * for a story with a parent. Issue types, Story Points, priority, attachments and
 * links do not exist there and are skipped. The blockedBy ordering is recorded in a
 * plan comment on each parent, which is then labeled issuePlanning.plannedLabel; the
 * SM rule plan-advance (common/planAdvance.js) starts the sub-issues in that order.
 * Creation is idempotent: a sub-issue a previous run created for an entry (matched by
 * its hidden entry marker, else by title) is reused, and a parent is labeled planned
 * only when every entry exists — so a failed run can simply be re-run.
 */

const trackersModule = require('./common/trackers.js');
const configLoader = require('./configLoader.js');
const issuePlan = require('./common/issuePlan.js');
const { buildSummary } = require('./common/aiResponseParser.js');
const { ISSUE_TYPES, LABELS, STATUSES } = require('./config.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const outputFiles = require('./common/outputFiles.js');

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
 * @param {Object} ctx - Action context from initActionContext()
 * @returns {string} Comment text
 */
function readCommentFile(ctx) {
    try {
        var content = file_read('outputs/comment.md');
        if (content && content.trim() !== '') {
            return content;
        }
    } catch (error) {
        console.warn('Could not read outputs/comment.md:', error);
    }
    if (ctx && ctx.github) return '### Intake Analysis\n\n_No analysis comment was generated._';
    return 'h3. *Intake Analysis*\n\n_No analysis comment was generated._';
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
            tracker.attachFile(key, fileName, filePath, issuePlan.getContentType(filePath));
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
 * Tracker-aware ticket creation (gh-1480):
 * On ADO, creates via createTicketWithParent and applies setPriority when priority is provided.
 * On Jira, calls createTicketWithFields with the Jira field bag unchanged.
 */
function createTicket(projectKey, fields) {
    if (tracker.provider && tracker.provider() === 'ado') {
        var parentKey = fields.parent ? fields.parent.key : null;
        var key = tracker.createTicketWithParent(projectKey, fields.issuetype.name, fields.summary, fields.description, parentKey);
        if (key && fields.priority) {
            try {
                tracker.setPriority(key, fields.priority.name);
            } catch (e) {
                console.warn('Failed to set priority on ' + key + ':', e);
            }
        }
        return key;
    }
    return tracker.createTicketWithFields(projectKey, fields);
}

/**
 * Create a Bug, Epic, or Story in Jira/ADO from an intake entry.
 */
function createTrackerTicket(entry, projectKey, issueType, resolvedParent, kindLabel) {
    var summary = buildSummary(entry.summary, 0);
    var description = outputFiles.readDescriptionFile(entry.description, summary);
    var underSuffix = resolvedParent ? (' under ' + resolvedParent) : '';

    try {
        var fields = {
            summary: summary,
            description: description,
            issuetype: { name: issueType }
        };
        if (resolvedParent) {
            fields.parent = { key: resolvedParent };
        }
        if (entry.priority) {
            fields.priority = { name: entry.priority };
        }
        var key = createTicket(projectKey, fields);
        console.log('Created ' + kindLabel + ': ' + (key || '(unknown key)') + underSuffix + ' - ' + summary);
        return key;
    } catch (error) {
        console.error('Failed to create ' + kindLabel + ' "' + summary + '"' + underSuffix + ':', error);
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
function buildFinalComment(results, aiComment, projectConfig) {
    var comment = aiComment + '\n\n';
    comment += 'h3. *Created Tickets*\n\n';

    var successes = results.filter(function(r) { return r.success; });
    var failures = results.filter(function(r) { return !r.success; });

    if (successes.length === 0 && failures.length === 0) {
        comment += '_No tickets were created (stories.json was empty)._\n';
    } else {
        successes.forEach(function(r) {
            comment += '* ' + issuePlan.formatIntakeTicketLink(r.key, projectConfig, configLoader) + ' (' + r.type + ') - ' + r.summary + '\n';
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
    if (!/^(?:[A-Z]+-\d+|\d+)$/.test(entry.parent)) {
        return { resolved: false, parent: null };
    }
    return { resolved: true, parent: String(entry.parent) };
}

/**
 * Build the per-run action context (pure — no tracker or file access).
 * @param {Object} params - action() params
 * @returns {{ticketKey: string, projectKey: string, initiatorId: *, wipLabel: string|null}}
 */
function initActionContext(params, projectConfig, customParams) {
    var ticketKey = params.ticket.key;
    var isAdo = Boolean(tracker.provider && tracker.provider() === 'ado');
    return {
        ticketKey: ticketKey,
        projectKey: issuePlan.resolveIntakeProjectKey(ticketKey, projectConfig, customParams, isAdo),
        initiatorId: params.initiator,
        wipLabel: params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null,
        github: tracker.provider() === 'github',
        ado: isAdo,
        projectConfig: projectConfig,
        customParams: customParams,
        issueTypes: issuePlan.resolveIntakeIssueTypes(ISSUE_TYPES, projectConfig, customParams, isAdo),
        planCfg: issuePlan.resolvePlanningConfig(projectConfig, customParams),
        children: {}
    };
}

// ── GitHub: entries as sub-issues ─────────────────────────────────────────

/**
 * The sub-issues a parent already has (listed once per run, then kept up to date
 * with the ones this run creates). Throws when they cannot be read: creating
 * without knowing them could duplicate what a previous run created.
 */
function childrenOf(ctx, parentKey) {
    if (!ctx.children[parentKey]) {
        ctx.children[parentKey] = tracker.listChildTickets(parentKey);
    }
    return ctx.children[parentKey];
}

/**
 * Create the entry as a sub-issue of parentKey, or reuse the sub-issue a
 * previous run created for it.
 * @returns {{key: (string|null), reused: boolean}}
 */
function createGithubItem(ctx, entry, parentKey) {
    var summary = buildSummary(entry.summary, 0);
    try {
        var existing = issuePlan.findExistingItem(childrenOf(ctx, parentKey), entry._itemId, summary);
        if (existing) {
            console.log('Reusing ' + existing.key + ' for "' + summary + '" (created by a previous run)');
            return { key: existing.key, reused: true };
        }
        var body = outputFiles.readDescriptionFile(entry.description, summary) + '\n\n' + issuePlan.itemMarker(entry._itemId);
        var key = tracker.createTicketWithParent(null, entry.type, summary, body, parentKey);
        if (key) ctx.children[parentKey].push({ key: key, title: summary, description: body });
        console.log('Created sub-issue ' + key + ' of ' + parentKey + ' - ' + summary);
        return { key: key || null, reused: false };
    } catch (error) {
        console.error('Failed to create sub-issue "' + summary + '" of ' + parentKey + ':', error);
        return { key: null, reused: false };
    }
}

/**
 * Create one entry: a sub-issue on GitHub, else the Jira/ADO ticket of its kind.
 * @param {string|null} parentKey - resolved parent (Stories only)
 * @returns {{key: (string|null), reused: boolean}}
 */
function createEntry(ctx, entry, kind, parentKey) {
    if (ctx.github) {
        entry._parentKey = parentKey || ctx.ticketKey;
        return createGithubItem(ctx, entry, entry._parentKey);
    }
    var types = ctx.issueTypes || ISSUE_TYPES;
    var typeMap = { Bug: types.BUG, Epic: types.EPIC, Story: types.STORY };
    return { key: createTrackerTicket(entry, ctx.projectKey, typeMap[kind], parentKey, kind), reused: false };
}

/**
 * Tracker extras on a created Jira/ADO ticket: attachments, the link to the source
 * and (optionally) Story Points. None of them exists on a GitHub issue.
 */
function decorateCreated(ctx, key, entry, withStoryPoints) {
    if (ctx.github) return;
    attachFilesToTicket(key, entry);
    linkToSource(key, ctx.ticketKey);
    if (withStoryPoints) setStoryPoints(key, entry);
}

function resultOf(type, summary, created) {
    return {
        type: type,
        summary: summary,
        key: created.key,
        success: !!created.key,
        reused: created.reused,
        error: created.key ? null : 'Creation failed (see logs)'
    };
}

/**
 * Move a created Bug to Ready For Development.
 * @param {string} key
 */
function moveBugToReady(key) {
    try {
        tracker.moveToStatus(key, STATUSES.READY_FOR_DEVELOPMENT);
        console.log('Moved Bug ' + key + ' to Ready For Development');
    } catch (e) {
        console.warn('Failed to move bug ' + key + ' to Ready For Development:', e);
    }
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

        var created = createEntry(ctx, entry, 'Bug', null);
        var key = created.key;
        var summary = buildSummary(entry.summary, 0);

        if (key) {
            if (entry.tempId) {
                state.tempIdMap[entry.tempId] = key;
                state.keyMap[entry.tempId] = key;
            }
            state.keyMap[key] = key;
            // Jira/ADO: Ready For Development so SM picks it up immediately (GitHub: the plan sequencer starts it)
            if (!ctx.github) moveBugToReady(key);
        }

        entry._createdKey = key;
        decorateCreated(ctx, key, entry, false);
        state.results.push(resultOf('Bug', summary, created));
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
            var created = createEntry(ctx, entry, 'Epic', null);
            var key = created.key;
            var summary = buildSummary(entry.summary, 0);
            if (key && entry.tempId) {
                state.tempIdMap[entry.tempId] = key;
                state.keyMap[entry.tempId] = key;
                console.log('Mapped tempId ' + entry.tempId + ' -> ' + key);
            }
            if (key) state.keyMap[key] = key;
            entry._createdKey = key; // track for pass 4
            decorateCreated(ctx, key, entry, true);
            state.results.push(resultOf('Epic', summary, created));
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

        var created = createEntry(ctx, entry, 'Story', parent.parent);
        var key = created.key;
        var summary = buildSummary(entry.summary, 0);
        if (key) {
            if (entry.tempId) state.keyMap[entry.tempId] = key;
            state.keyMap[key] = key;
        }
        entry._createdKey = key; // track for pass 4
        decorateCreated(ctx, key, entry, true);
        state.results.push(resultOf('Story', summary, created));
    });
}

/**
 * Create a single blockedBy Blocks link; returns true when linked.
 * @param {string} blockedKey - Created ticket that is blocked
 * @param {string} ref - Blocker ref (tempId or real key)
 * @param {Object} keyMap - Maps tempId OR real key -> actual tracker key
 * @returns {boolean}
 */
function linkBlockedByRef(blockedKey, ref, keyMap) {
    var blockerKey = keyMap[ref] || null;
    if (!blockerKey) {
        console.warn('Cannot resolve blockedBy ref "' + ref + '" for ' + blockedKey);
        return false;
    }
    try {
        tracker.linkIssues(blockedKey, blockerKey, 'Blocks');
        console.log(blockerKey + ' blocks ' + blockedKey);
        return true;
    } catch (e) {
        console.warn('Failed to link ' + blockerKey + ' blocks ' + blockedKey + ':', e);
        return false;
    }
}

/**
 * Move a blocked ticket to Blocked status.
 * @param {string} blockedKey
 */
function moveToBlocked(blockedKey) {
    try {
        tracker.moveToStatus(blockedKey, STATUSES.BLOCKED);
        console.log('Set ' + blockedKey + ' to Blocked');
    } catch (e) {
        console.warn('Failed to set Blocked status on ' + blockedKey + ':', e);
    }
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
            if (linkBlockedByRef(blockedKey, ref, keyMap)) anyLinked = true;
        });
        if (anyLinked) moveToBlocked(blockedKey);
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
            var otherKey = keyMap[ref] || null;
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
 * GitHub: record each parent's plan in a comment, then label it planned — in that
 * order, so the SM never sees a planned parent without its plan. The source issue
 * goes last. Nothing is labeled unless every entry exists.
 * @returns {boolean} true when the source issue was labeled planned
 */
function recordGithubPlans(stories, ctx, state) {
    var allCreated = state.results.length > 0 && state.results.every(function(r) { return r.success; });
    if (!allCreated) {
        console.warn('Not every entry exists - ' + ctx.ticketKey + ' is not labeled ' + ctx.planCfg.plannedLabel);
        return false;
    }
    var plans = issuePlan.collectGithubPlans(stories, state.keyMap);
    var parents = Object.keys(plans).filter(function(k) { return k !== ctx.ticketKey; }).concat([ctx.ticketKey]);
    try {
        parents.forEach(function(parentKey) {
            tracker.postComment(parentKey, 'Plan: ' + Object.keys(plans[parentKey].deps).length + ' sub-issue(s). ' +
                'Each starts (label `' + ctx.planCfg.devLabel + '`) once its blockers are closed; ' +
                'this issue closes when all of them are closed.\n\n' + issuePlan.renderPlanMarker(plans[parentKey]));
            tracker.addLabel(parentKey, ctx.planCfg.plannedLabel);
        });
        return true;
    } catch (e) {
        console.warn('Failed to record the plan of ' + ctx.ticketKey + ':', e);
        return false;
    }
}

/**
 * Post the combined AI analysis + created ticket list comment to the source ticket.
 * @param {Object} ctx - Action context from initActionContext()
 * @param {Array} results - Per-entry creation results
 * @param {boolean} planned - GitHub: true when the source issue was labeled planned
 */
function postFinalComment(ctx, results, planned) {
    try {
        var finalComment = ctx.github
            ? issuePlan.buildGithubFinalComment(results, readCommentFile(ctx), planned)
            : buildFinalComment(results, readCommentFile(ctx), ctx.projectConfig);
        tracker.postComment(ctx.ticketKey, finalComment);
        console.log('Posted intake analysis comment to ' + ctx.ticketKey);
    } catch (commentError) {
        console.warn('Failed to post comment to ' + ctx.ticketKey + ':', commentError);
    }
}

/**
 * Add the ai_intake and ai_generated labels to the source ticket.
 * @param {Object} ctx - Action context from initActionContext()
 */
function addIntakeLabels(ctx) {
    try {
        tracker.addLabel(ctx.ticketKey, LABELS.AI_INTAKE);
    } catch (labelError) {
        console.warn('Failed to add ' + LABELS.AI_INTAKE + ' label:', labelError);
    }

    try {
        tracker.addLabel(ctx.ticketKey, LABELS.AI_GENERATED);
    } catch (labelError) {
        console.warn('Failed to add ' + LABELS.AI_GENERATED + ' label:', labelError);
    }
}

/**
 * Assign the source ticket to the initiator and move it to In Development
 * (transition name is 'In Progress' in this Jira instance).
 * @param {Object} ctx - Action context from initActionContext()
 */
function assignAndMoveToInProgress(ctx) {
    try {
        tracker.assignTo(ctx.ticketKey, ctx.initiatorId);
        console.log('Assigned ' + ctx.ticketKey + ' to initiator');
    } catch (assignError) {
        console.warn('Failed to assign ticket:', assignError);
    }

    try {
        tracker.moveToStatus(ctx.ticketKey, STATUSES.IN_PROGRESS);
        console.log('Moved ' + ctx.ticketKey + ' to In Development');
    } catch (statusError) {
        console.warn('Failed to move ticket to In Development:', statusError);
    }
}

/**
 * Remove the WIP label from the source ticket if one was derived from the context.
 * @param {Object} ctx - Action context from initActionContext()
 */
function removeWipLabel(ctx) {
    if (!ctx.wipLabel) return;
    try {
        tracker.removeLabel(ctx.ticketKey, ctx.wipLabel);
        console.log('Removed WIP label "' + ctx.wipLabel + '" from ' + ctx.ticketKey);
    } catch (wipError) {
        console.warn('Failed to remove WIP label:', wipError);
    }
}

/**
 * Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
 * wrote outputs/*_usage.json during the agent run.
 * @param {Object} ctx - Action context from initActionContext()
 * @param {Object} params - action() params
 */
function postTokenUsage(ctx, params) {
    try {
        tokenUsageComment.postTokenUsageComments(ctx.ticketKey, { initiator: params.initiator, tracker: tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

/**
 * Finalize the source intake ticket: post combined comment, labels, assignee,
 * status move, WIP label removal and token usage comments.
 * @param {Object} ctx - Action context from initActionContext()
 * @param {Array} results - Per-entry creation results
 * @param {Object} params - action() params
 */
function finalizeIntakeTicket(ctx, results, params, planned) {
    postFinalComment(ctx, results, planned);
    addIntakeLabels(ctx);
    if (!planned) assignAndMoveToInProgress(ctx);
    removeWipLabel(ctx);
    postTokenUsage(ctx, params);
}

// ── Incomplete-run / missing-input guard (gh-1479) ──────────────────────────

function hasNonEmptyFile(path) {
    try {
        var content = file_read(path);
        return Boolean(content && String(content).trim() !== '');
    } catch (e) {
        return false;
    }
}

function isInputFolderTracked(inputFolder) {
    return hasNonEmptyFile(inputFolder + '/request.md') ||
        hasNonEmptyFile(inputFolder + '/ticket.json') ||
        hasNonEmptyFile(inputFolder + '/existing_epics.json') ||
        hasNonEmptyFile(inputFolder + '/existing_stories.json');
}

function checkExistingInputsMissing(ctx, params) {
    if (issuePlan.isIntakeSkipExistingFetch(ctx)) return null;
    var loc = issuePlan.resolveIntakeInputFolder(ctx, params);
    if (!loc.explicit && !isInputFolderTracked(loc.folder)) return null;
    var hasBoth = hasNonEmptyFile(loc.folder + '/existing_epics.json') &&
        hasNonEmptyFile(loc.folder + '/existing_stories.json');
    return hasBoth ? null : ('Missing required intake input file(s) in ' + loc.folder + ' (existing_epics.json / existing_stories.json)');
}

function checkIntakePrerequisites(ctx, params, stories) {
    if (issuePlan.isIntakeRequireCliOutput(ctx, params)) {
        if (!outputFiles.hasOutputFile('response.md', { ticketKey: ctx.ticketKey })) {
            return 'CLI output file (outputs/response.md) is missing while requireCliOutputFile=true';
        }
    }
    if (stories.length === 0) {
        return checkExistingInputsMissing(ctx, params);
    }
    return null;
}

function finalizeFailedIntake(ctx, params, reason) {
    console.error('Intake incomplete for ' + ctx.ticketKey + ': ' + reason);
    try {
        tracker.postComment(ctx.ticketKey, readCommentFile(ctx) + '\n\n*Intake Incomplete:* ' + reason +
            '. The ticket was not moved to In Development.');
    } catch (e) {
        console.warn('Failed to post incomplete intake comment:', e);
    }
    removeWipLabel(ctx);
    try {
        tracker.addLabel(ctx.ticketKey, LABELS.AI_CONCERNS);
    } catch (e) {
        console.warn('Failed to add ' + LABELS.AI_CONCERNS + ' label:', e);
    }
    postTokenUsage(ctx, params);
    return {
        success: false,
        error: reason,
        results: []
    };
}

function applyDependencyAndPlanPass(stories, ctx, state) {
    if (ctx.github) return recordGithubPlans(stories, ctx, state);
    linkBlockedByPass(stories, state.keyMap);
    linkIntegrationsPass(stories, state.keyMap);
    return false;
}

function postIntakeWorkflowError(params, error) {
    try {
        var key = params && params.ticket && params.ticket.key;
        if (key) {
            tracker.postComment(key, '*Intake Workflow Error:* ' + error.toString() + '. Please check server logs for details.');
        }
    } catch (commentError) {
        console.error('Failed to post error comment:', commentError);
    }
}

function action(params) {
    var customParams = issuePlan.resolveIntakeCustomParams(params);
    // The project config carries the repository that GitHub issue keys resolve against.
    var projectConfig = issuePlan.loadIntakeProjectConfig(configLoader, params);
    tracker = trackersModule.createTracker(projectConfig, customParams);
    try {
        var ctx = initActionContext(params, projectConfig, customParams);
        console.log('Processing intake ticket creation for:', ctx.ticketKey);

        // 1. Read stories.json
        var stories = readStoriesJson();
        console.log('Found ' + stories.length + ' entries in stories.json');

        var prereqError = checkIntakePrerequisites(ctx, params, stories);
        if (prereqError) {
            return finalizeFailedIntake(ctx, params, prereqError);
        }

        // Stable entry id for the GitHub sub-issue marker (a re-run reuses what exists).
        stories.forEach(function(entry, i) { entry._itemId = entry.tempId || ('item-' + (i + 1)); });

        var state = { results: [], tempIdMap: {}, keyMap: {} };

        // 2-4. Creation passes: Bugs -> Epics -> Stories (same tracker calls, same order)
        createBugsPass(stories, ctx, state);
        createEpicsPass(stories, ctx, state);
        createStoriesPass(stories, ctx, state);

        // 5. Dependency and integration links (GitHub: plan comments + planned labels)
        var planned = applyDependencyAndPlanPass(stories, ctx, state);

        // 6-11. Finalize the source ticket
        finalizeIntakeTicket(ctx, state.results, params, planned);

        var successCount = state.results.filter(function(r) { return r.success; }).length;
        return {
            success: true,
            message: 'Intake complete for ' + ctx.ticketKey + ': created ' + successCount + ' ticket(s), moved to In Development',
            results: state.results
        };
    } catch (error) {
        console.error('Error in createIntakeTickets:', error);
        postIntakeWorkflowError(params, error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
