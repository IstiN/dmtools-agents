/**
 * Bug-Fix Batch Coordinator — postJSAction for bug_fix_batch_coordinator.
 *
 * Runs as a local (no-AI) SM step for each Story in "Bug To Fix" status.
 *
 * Goal: group the Story's still-relevant open bugs into a single Epic container
 * so they can be fixed, reviewed and merged together instead of one at a time.
 *
 * What it does:
 *   1. Finds linked Bugs that are NOT Done and NOT already in a batch
 *      (label bug_fix_batch).
 *   2. Keeps only bugs that still block at least one failing Test Case
 *      (status Failed or Bug To Fix).
 *   3. Looks for an existing open batch Epic for this Story;
 *      if none exists, creates one.
 *   4. Links the selected Bugs to the Epic, labels them bug_fix_batch,
 *      and moves the Epic to Ready For Development.
 *   5. Removes the SM trigger label so the coordinator can re-run next cycle
 *      and add any newly created bugs to the same (or a new) batch.
 *
 * Bugs with the bug_fix_batch label are intentionally excluded from the
 * individual bug_development rule, so the batch agent owns them.
 */

const { LABELS } = require('./config.js');
const { extractTicketKey } = require('./common/jiraHelpers.js');
const configLoader = require('./configLoader.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;


var BUG_FIX_BATCH_LABEL = LABELS.BUG_FIX_BATCH || 'bug_fix_batch';

// ── Run context ────────────────────────────────────────────────────────────

function getProjectKey(ticketKey) {
    return (ticketKey && ticketKey.split('-')[0]) || 'TS';
}

function buildCoordinatorContext(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var customParams = (params.jobParams && params.jobParams.customParams) || {};
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    initTracker(projectConfig, customParams);
    var jiraConfig = projectConfig.jira;
    return {
        params: params,
        ticketKey: ticketKey,
        customParams: customParams,
        removeLabel: customParams.removeLabel,
        batchSize: customParams.batchSize || 5,
        projectConfig: projectConfig,
        jiraConfig: jiraConfig,
        projectKey: getProjectKey(ticketKey),
        batchStatus: jiraConfig.statuses.READY_FOR_DEVELOPMENT,
        doneStatus: jiraConfig.statuses.DONE
    };
}

// ── Tracker wrappers ───────────────────────────────────────────────────────

function releaseLock(ctx) {
    if (ctx.ticketKey && ctx.removeLabel) {
        try {
            getTracker().removeLabel(ctx.ticketKey, ctx.removeLabel);
            console.log('Released SM lock label', ctx.removeLabel, 'from', ctx.ticketKey);
        } catch (e) {
            console.warn('Failed to remove SM lock label:', e);
        }
    }
}

function extractIssues(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (typeof result === 'string') {
        try {
            return extractIssues(JSON.parse(result));
        } catch (e) {
            return [];
        }
    }
    if (Array.isArray(result.issues)) return result.issues;
    if (Array.isArray(result.results)) return result.results;
    if (Array.isArray(result.data)) return result.data;
    return [];
}

function searchIssues(jql, fields, maxResults) {
    try {
        var result = getTracker().searchIssues(jql, { maxResults: maxResults || 50, fields: fields || ['key', 'status', 'summary', 'labels'] });
        return extractIssues(result);
    } catch (e) {
        console.warn('JQL search failed:', jql, e);
        return [];
    }
}

function findCandidateBugs(storyKey, jiraConfig) {
    // Only group bugs that have not been individually picked up yet.
    // In Development / In Progress bugs are left for the single-bug pipeline.
    // JQL text: provider-specific query (WIQL on ado)
    var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = Bug ' +
        'AND status in ("' + jiraConfig.statuses.BACKLOG + '", "' + jiraConfig.statuses.TODO + '", "' + jiraConfig.statuses.READY_FOR_DEVELOPMENT + '") ' +
        'AND (labels is EMPTY OR labels NOT IN ("' + BUG_FIX_BATCH_LABEL + '")) ' +
        'ORDER BY created ASC';
    return searchIssues(jql, ['key', 'status', 'summary', 'labels']);
}

function findExistingBatchEpic(storyKey, doneStatus) {
    // JQL text: provider-specific query (WIQL on ado)
    var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = Epic ' +
        'AND labels in ("' + BUG_FIX_BATCH_LABEL + '") ' +
        'AND status != "' + doneStatus + '" ' +
        'ORDER BY created ASC';
    var epics = searchIssues(jql, ['key', 'status', 'summary', 'labels'], 1);
    return epics.length > 0 ? epics[0] : null;
}

function bugStillRelevant(ctx, bugKey) {
    // JQL text: provider-specific query (WIQL on ado)
    // gh-916: 'Failed' / 'Bug To Fix' can be tag-only on Test Case (restricted ADO workflows).
    // 'label' mode widens each status to (status OR stage label) through the shared
    // {stage.KEY:Literal} placeholder (configLoader.interpolateStagePlaceholders, agents#855) in the
    // syntax of the tracker in use; the 'none' default sends the exact status-only clause as before.
    var failedName = ctx.jiraConfig.statuses.FAILED;
    var bugToFixName = ctx.jiraConfig.statuses.BUG_TO_FIX;
    var statusClause = 'status in ("' + failedName + '", "' + bugToFixName + '")';
    if (getTracker().stageFallback() === 'label') {
        statusClause = configLoader.interpolateStagePlaceholders(
            '({stage.FAILED:' + failedName + '} OR {stage.BUG_TO_FIX:' + bugToFixName + '})',
            ctx.projectConfig, getTracker().provider());
    }
    var jql = 'issue in linkedIssues("' + bugKey + '") AND issuetype = "Test Case" AND ' + statusClause;
    var tcs = searchIssues(jql, ['key', 'status'], 1);
    return tcs.length > 0;
}

// ── Batch Epic construction ────────────────────────────────────────────────

function buildBatchSummary(storyKey, bugCount) {
    var suffix = bugCount === 1 ? '' : 's';
    return 'Bug-fix batch for ' + storyKey + ' (' + bugCount + ' bug' + suffix + ')';
}

function bugSummary(bug) {
    var fields = bug.fields;
    if (!fields) return '';
    return fields.summary || '';
}

function bugListLine(bug) {
    return '* ' + bug.key + ' — ' + bugSummary(bug);
}

function buildBatchDescription(storyKey, bugs) {
    return 'h3. 🐛 Bug-fix batch container\n\n' +
        'This Epic groups open bugs linked to *' + storyKey + '* that block failing Test Cases. ' +
        'They will be fixed, reviewed and merged in a single cycle.\n\n' +
        'h4. Linked bugs\n\n' +
        bugs.map(bugListLine).join('\n') + '\n\n' +
        '_Bugs are excluded from individual bug_development while they are in this batch._';
}

function batchEpicFields(storyKey, bugs, jiraConfig) {
    return {
        summary: buildBatchSummary(storyKey, bugs.length),
        description: buildBatchDescription(storyKey, bugs),
        issuetype: { name: jiraConfig.issueTypes.EPIC || 'Epic' },
        labels: [BUG_FIX_BATCH_LABEL]
    };
}

function bareResultKey(result) {
    if (typeof result !== 'string') return null;
    var trimmed = result.trim();
    return trimmed ? trimmed : null;
}

function resolveEpicKey(result) {
    var key = extractTicketKey(result);
    if (key) return key;
    // tracker.createTicketWithFields already returns the bare key on some providers
    return bareResultKey(result);
}

function linkEpicToStorySafely(ctx, epicKey, storyKey) {
    // Relate the batch Epic to the parent Story so it is visible on both sides.
    try {
        getTracker().linkIssues(epicKey, storyKey, 'Relates');
        console.log('Linked Epic', epicKey, 'to Story', storyKey);
    } catch (e) {
        console.warn('Failed to link Epic to Story:', e);
    }
}

function createBatchEpic(ctx, storyKey, bugs) {
    var fieldsJson = batchEpicFields(storyKey, bugs, ctx.jiraConfig);
    var result = getTracker().createTicketWithFields(ctx.projectKey, fieldsJson);
    var epicKey = resolveEpicKey(result);
    if (!epicKey) {
        throw new Error('Epic was created but key could not be extracted from result: ' + JSON.stringify(result));
    }
    console.log('Created batch Epic:', epicKey);

    linkEpicToStorySafely(ctx, epicKey, storyKey);

    return epicKey;
}

function findOrCreateBatchEpic(ctx, storyKey, relevantBugs) {
    var existingEpic = findExistingBatchEpic(storyKey, ctx.doneStatus);
    if (existingEpic) {
        console.log('Using existing batch Epic:', existingEpic.key);
        return { epicKey: existingEpic.key, isNew: false };
    }
    return { epicKey: createBatchEpic(ctx, storyKey, relevantBugs), isNew: true };
}

function linkBugToEpic(bugKey, epicKey) {
    getTracker().linkIssues(epicKey, bugKey, 'Relates');
    console.log('Linked bug', bugKey, 'to Epic', epicKey);
}

function labelBugAsBatched(bugKey) {
    getTracker().addLabel(bugKey, BUG_FIX_BATCH_LABEL);
    console.log('Added label', BUG_FIX_BATCH_LABEL, 'to', bugKey);
}

function moveEpicToReady(epicKey, batchStatus) {
    getTracker().moveToStatus(epicKey, batchStatus);
    console.log('Moved Epic', epicKey, 'to', batchStatus);
}

function linkOneBugToEpic(bugKey, epicKey) {
    try {
        linkBugToEpic(bugKey, epicKey);
    } catch (e) {
        console.warn('Failed to link bug', bugKey, 'to Epic', epicKey, ':', e);
        // Continue with the rest; don't fail the whole batch for one link error.
    }
    try {
        labelBugAsBatched(bugKey);
    } catch (e) {
        console.warn('Failed to label bug', bugKey, ':', e);
    }
}

function linkBugsToEpic(bugs, epicKey) {
    for (var j = 0; j < bugs.length; j++) {
        linkOneBugToEpic(bugs[j].key, epicKey);
    }
}

function moveEpicToReadySafely(epicKey, batchStatus) {
    try {
        moveEpicToReady(epicKey, batchStatus);
    } catch (e) {
        console.warn('Failed to move Epic to Ready For Development:', e);
    }
}

function postComments(storyKey, epicKey, bugs, isNew, batchStatus) {
    var bugList = bugs.map(function(b) { return '* ' + b.key; }).join('\n');
    var epicComment = 'h3. ' + (isNew ? '📦 New Bug-fix Batch Created' : '📦 Bugs Added to Existing Batch') + '\n\n' +
        'Container: *' + epicKey + '*\n' +
        'Linked bugs from *' + storyKey + '*:\n' + bugList + '\n\n' +
        'These bugs are now labeled *' + BUG_FIX_BATCH_LABEL + '* and will be handled as a single batch.';
    try {
        getTracker().postComment(epicKey, epicComment);
    } catch (e) {
        console.warn('Failed to comment on Epic:', e);
    }

    var storyComment = 'h3. 📦 Bug-fix Batch ' + (isNew ? 'Created' : 'Updated') + '\n\n' +
        'Container: *' + epicKey + '*\n' +
        'Bugs added to batch:\n' + bugList + '\n\n' +
        'The Epic has been moved to *' + batchStatus + '*.';
    try {
        getTracker().postComment(storyKey, storyComment);
    } catch (e) {
        console.warn('Failed to comment on Story:', e);
    }
}

// ── Selection ──────────────────────────────────────────────────────────────

function filterRelevantBugs(ctx, candidateBugs) {
    var relevantBugs = [];
    for (var i = 0; i < candidateBugs.length; i++) {
        var bug = candidateBugs[i];
        if (bugStillRelevant(ctx, bug.key)) {
            relevantBugs.push(bug);
        } else {
            console.log('Skipping', bug.key, '- no linked failing Test Case');
        }
    }
    return relevantBugs;
}

function limitBatchSize(relevantBugs, batchSize) {
    if (relevantBugs.length > batchSize) {
        console.log('Limiting batch to first', batchSize, 'of', relevantBugs.length, 'relevant bugs');
        return relevantBugs.slice(0, batchSize);
    }
    return relevantBugs;
}

// ── Orchestration ──────────────────────────────────────────────────────────

function runCoordinator(ctx) {
    if (!ctx.ticketKey) {
        throw new Error('params.ticket.key is missing');
    }
    console.log('=== Bug-fix batch coordinator for Story', ctx.ticketKey, '===');

    var candidateBugs = findCandidateBugs(ctx.ticketKey, ctx.jiraConfig);
    console.log('Found', candidateBugs.length, 'candidate bug(s) not yet batched');

    if (candidateBugs.length === 0) {
        console.log('No unbatched open bugs — nothing to do');
        releaseLock(ctx);
        return { success: true, action: 'no_candidates', ticketKey: ctx.ticketKey };
    }

    // Respect batch size so the PR stays reviewable.
    var relevantBugs = limitBatchSize(filterRelevantBugs(ctx, candidateBugs), ctx.batchSize);

    if (relevantBugs.length === 0) {
        console.log('No relevant bugs to batch — nothing to do');
        releaseLock(ctx);
        return { success: true, action: 'no_relevant_bugs', ticketKey: ctx.ticketKey };
    }

    console.log('Selected', relevantBugs.length, 'bug(s) for batch:', relevantBugs.map(function(b) { return b.key; }).join(', '));

    var epic = findOrCreateBatchEpic(ctx, ctx.ticketKey, relevantBugs);

    linkBugsToEpic(relevantBugs, epic.epicKey);
    moveEpicToReadySafely(epic.epicKey, ctx.batchStatus);
    postComments(ctx.ticketKey, epic.epicKey, relevantBugs, epic.isNew, ctx.batchStatus);
    releaseLock(ctx);

    console.log('✅ Bug-fix batch coordinator complete for', ctx.ticketKey, '-> Epic', epic.epicKey);
    return {
        success: true,
        action: epic.isNew ? 'batch_created' : 'batch_updated',
        storyKey: ctx.ticketKey,
        epicKey: epic.epicKey,
        batchedBugs: relevantBugs.map(function(b) { return b.key; })
    };
}

function action(params) {
    var ctx = buildCoordinatorContext(params);
    try {
        return runCoordinator(ctx);
    } catch (error) {
        console.error('❌ Error in createBugFixBatchEpic:', error);
        releaseLock(ctx);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, extractIssues: extractIssues };
}
