/**
 * Create planned follow-up stories from outputs/stories.json.
 *
 * Reusable post-action helper for workflows where the CLI agent produces an
 * intake-compatible story plan that should be materialized in Jira.
 */

const { ISSUE_TYPES, STATUSES } = require('./config.js');
const trackersModule = require('./common/trackers.js');
const { setTicketPriority } = require('./common/jiraHelpers.js');
const { buildSummary } = require('./common/aiResponseParser.js');
const linkedIssuesReport = require('./common/linkedIssuesReport.js');
var configLoader = null;
try { configLoader = require('./configLoader.js'); } catch (e) {}

// Tracker for the current action() run (built inside action(), never at module load).
var tracker = null;

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

    // JQL text: provider-specific query (WIQL on ado)
    var issues = tracker.searchIssues(linkedIssuesReport.buildChildrenQuery(tracker.provider(), parentKey, 'parent = ' + parentKey + ' AND issuetype = "' + issueTypeName + '" ORDER BY created ASC', issueTypeName), {
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
    var projectKey = config.projectKey || resolvedParentKey.split('-')[0];
    var priority = resolveStoryPriority(entry, params, config);
    var issueTypeName = getJiraIssueTypeName(config);

    var fieldsJson = {
        summary: summary,
        description: description,
        issuetype: { name: issueTypeName },
        parent: { key: resolvedParentKey }
    };

    if (priority) {
        fieldsJson.priority = { name: priority };
    }

    var createdKey = tracker.createTicketWithFields(projectKey, fieldsJson);
    if (!createdKey) {
        throw new Error('Could not extract Jira key from create response');
    }

    if (priority) {
        setTicketPriority(createdKey, priority, tracker);
    }

    if (entry.storyPoints != null && !isNaN(entry.storyPoints)) {
        tracker.updateField(createdKey, 'Story Points', Number(entry.storyPoints));
    }

    return createdKey;
}

function linkToSource(createdKey, sourceKey, relationship) {
    if (!createdKey || !sourceKey || !relationship) return;

    tracker.linkIssues(createdKey, sourceKey, relationship);
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

// ── Run context and guards ─────────────────────────────────────────────────

function firstObject(a, b) {
    return a ? a : b;
}

function firstOf3(a, b, c) {
    return firstObject(firstObject(a, b), c);
}

function hasSkipLabel(config, labels) {
    if (!config.skipIfLabel) return false;
    return labels.indexOf(config.skipIfLabel) !== -1;
}

function logSkipLabelReuse(plan) {
    if (!plan.skipLabelReuse) return;
    console.log('Story plan label "' + plan.config.skipIfLabel + '" is present on ' + plan.sourceTicketKey + ', continuing in reuse mode');
}

function prepareStoryPlan(params) {
    var jobParams = firstObject(params.jobParams, {});
    var customParams = firstOf3(params.customParams, jobParams.customParams, {});
    var config = firstObject(customParams.storyPlanCreation, {});
    var projectConfig = null;
    try { projectConfig = configLoader ? configLoader.loadProjectConfig(params.jobParams || params) : null; } catch (e) {}
    tracker = trackersModule.createTracker(projectConfig, customParams);
    var sourceTicketKey = params.ticket && params.ticket.key;
    var sourceLabels = getSourceLabels(params);
    var plan = {
        params: params,
        config: config,
        customParams: customParams,
        tracker: tracker,
        sourceTicketKey: sourceTicketKey,
        sourceLabels: sourceLabels,
        skipLabelPresent: hasSkipLabel(config, sourceLabels),
        skipLabelMode: firstObject(config.skipIfLabelMode, 'strict'),
        outputFile: firstObject(config.outputFile, 'outputs/stories.json'),
        keyMap: {}
    };
    plan.skipLabelReuse = plan.skipLabelPresent && plan.skipLabelMode === 'reuse';
    logSkipLabelReuse(plan);
    return plan;
}

function planGuardResult(plan) {
    if (plan.config.enabled === false) {
        return { result: { success: true, skipped: true, message: 'storyPlanCreation disabled' } };
    }
    return sourceKeyGuardResult(plan);
}

function sourceKeyGuardResult(plan) {
    if (plan.sourceTicketKey) return null;
    return { result: { success: false, error: 'Missing source ticket key' } };
}

function skipLabelGuardResult(plan) {
    if (!plan.skipLabelPresent) return null;
    if (plan.skipLabelMode !== 'reuse') {
        console.log('Story plan creation skipped for ' + plan.sourceTicketKey + ' because label "' + plan.config.skipIfLabel + '" is present');
        return { result: { success: true, skipped: true, message: 'Skip label present' } };
    }
    return null;
}

function earlyPlanResult(plan) {
    var guard = planGuardResult(plan);
    if (guard) return guard;
    return skipLabelGuardResult(plan);
}

function fileGuardResult(plan, parsed) {
    if (parsed.error) {
        return { result: { success: false, error: parsed.error } };
    }
    return filePresenceResult(plan, parsed);
}

function filePresenceResult(plan, parsed) {
    if (parsed.found) return null;
    return missingFileResult(plan);
}

function missingFileResult(plan) {
    if (plan.config.required) {
        return { result: { success: false, error: plan.outputFile + ' not found or empty' } };
    }
    console.log(plan.outputFile + ' not found — skipping planned story creation');
    return { result: { success: true, skipped: true, message: 'No story plan file found' } };
}

function storiesEmptyResult(plan, stories) {
    if (stories.length > 0) return null;
    console.log(plan.outputFile + ' contains no planned stories');
    return { result: { success: true, createdTickets: [], message: 'No planned stories to create' } };
}

// ── Story entry processing ─────────────────────────────────────────────────

function unsupportedEntryResult(entry, summary) {
    return {
        type: entry.type || 'Unknown',
        summary: summary,
        key: null,
        success: false,
        error: 'Unsupported entry type for story plan: ' + (entry.type || '(missing)')
    };
}

function missingParentResult(summary) {
    return {
        type: ISSUE_TYPES.STORY,
        summary: summary,
        key: null,
        success: false,
        error: 'No parent key resolved for story'
    };
}

function createdEntryResult(summary, createdKey) {
    return {
        type: ISSUE_TYPES.STORY,
        summary: summary,
        key: createdKey,
        success: true,
        existing: false
    };
}

function failedEntryResult(summary, error) {
    return {
        type: ISSUE_TYPES.STORY,
        summary: summary,
        key: null,
        success: false,
        error: error.toString()
    };
}

function parentStoryMap(existingByParent, resolvedParentKey, issueTypeName) {
    if (existingByParent[resolvedParentKey]) return existingByParent[resolvedParentKey];
    var map = fetchExistingStoriesByParent(resolvedParentKey, issueTypeName);
    existingByParent[resolvedParentKey] = map;
    return map;
}

function recordCreatedKey(plan, entry, summary, parentMap, createdKey) {
    entry._createdKey = createdKey;
    parentMap[summary] = createdKey;
    if (entry.tempId) plan.keyMap[entry.tempId] = createdKey;
    plan.keyMap[createdKey] = createdKey;
}

function reuseExistingStory(plan, entry, summary, existingKey, results) {
    entry._createdKey = existingKey;
    if (entry.tempId) plan.keyMap[entry.tempId] = existingKey;
    plan.keyMap[existingKey] = existingKey;
    linkStory(existingKey, plan.params, plan.config, true);
    results.push({
        type: ISSUE_TYPES.STORY,
        summary: summary,
        key: existingKey,
        success: true,
        existing: true
    });
}

function createStoryEntry(plan, entry, summary, resolvedParentKey, parentMap, results) {
    try {
        var createdKey = createStory(entry, resolvedParentKey, plan.params, plan.config);
        recordCreatedKey(plan, entry, summary, parentMap, createdKey);
        linkStory(createdKey, plan.params, plan.config, false);
        results.push(createdEntryResult(summary, createdKey));
    } catch (error) {
        entry._createdKey = null;
        results.push(failedEntryResult(summary, error));
    }
}

function reuseOrCreateStory(plan, entry, summary, resolvedParentKey, existingByParent, parentMap, existingKey, results) {
    if (existingKey) {
        reuseExistingStory(plan, entry, summary, existingKey, results);
        return;
    }
    createStoryEntry(plan, entry, summary, resolvedParentKey, parentMap, results);
}

function createOrReuseStory(plan, entry, summary, resolvedParentKey, existingByParent, results) {
    if (!resolvedParentKey) {
        results.push(missingParentResult(summary));
        return;
    }
    var parentMap = parentStoryMap(existingByParent, resolvedParentKey, plan.issueTypeName);
    var existingKey = firstObject(parentMap[summary], null);
    reuseOrCreateStory(plan, entry, summary, resolvedParentKey, existingByParent, parentMap, existingKey, results);
}

function processStoryEntry(plan, stories, i, existingByParent, results) {
    var entry = firstObject(stories[i], {});
    var summary = buildSummary(entry.summary, i);
    var resolvedParentKey = firstObject(entry.parent, plan.defaultParentKey);
    if (!isStoryEntry(entry)) {
        results.push(unsupportedEntryResult(entry, summary));
        return;
    }
    createOrReuseStory(plan, entry, summary, resolvedParentKey, existingByParent, results);
}

function processStoryEntries(plan, stories) {
    var existingByParent = {};
    var results = [];
    for (var i = 0; i < stories.length; i++) {
        processStoryEntry(plan, stories, i, existingByParent, results);
    }
    return results;
}

// ── blockedBy / integrates links ───────────────────────────────────────────

function resolvePlanKey(plan, ref) {
    return plan.keyMap[ref] || null;
}

function attemptBlockerLink(trackerInst, blockedKey, blockerKey, anyBlocked, relationship) {
    try {
        trackerInst.linkIssues(blockedKey, blockerKey, relationship);
        return true;
    } catch (e) {
        console.warn('Failed to create ' + relationship + ' link between ' + blockerKey + ' and ' + blockedKey + ':', e);
        return anyBlocked;
    }
}

function tryBlockerLink(plan, blockedKey, ref, anyBlocked) {
    var blockerKey = resolvePlanKey(plan, ref);
    if (!blockerKey) return anyBlocked;
    var relationship = firstObject(plan.config.blockedByRelationship, 'Blocks');
    return attemptBlockerLink(plan.tracker, blockedKey, blockerKey, anyBlocked, relationship);
}

function linkAllBlockers(plan, story) {
    var anyBlocked = false;
    var refs = story.blockedBy;
    for (var b = 0; b < refs.length; b++) {
        anyBlocked = tryBlockerLink(plan, story._createdKey, refs[b], anyBlocked);
    }
    return anyBlocked;
}

function tryMoveToBlocked(trackerInst, blockedKey, blockedStatusName) {
    try {
        trackerInst.moveToStatus(blockedKey, blockedStatusName);
    } catch (statusError) {
        console.warn('Failed to move ' + blockedKey + ' to Blocked:', statusError);
    }
}

function moveToBlockedStatus(trackerInst, blockedKey, config) {
    if (config.blockedStatusName === false) return;
    tryMoveToBlocked(trackerInst, blockedKey, firstObject(config.blockedStatusName, STATUSES.BLOCKED));
}

function moveBlockedStory(plan, blockedKey, anyBlocked) {
    if (!anyBlocked) return;
    moveToBlockedStatus(plan.tracker, blockedKey, plan.config);
}

function linkBlockedStory(plan, story) {
    if (!story._createdKey) return;
    if (!Array.isArray(story.blockedBy)) return;
    var anyBlocked = linkAllBlockers(plan, story);
    moveBlockedStory(plan, story._createdKey, anyBlocked);
}

function processBlockedByLinks(plan, stories) {
    for (var j = 0; j < stories.length; j++) {
        linkBlockedStory(plan, stories[j]);
    }
}

function attemptRelatesLink(trackerInst, storyKey, otherKey) {
    try {
        trackerInst.linkIssues(storyKey, otherKey, 'Relates');
    } catch (e) {
        console.warn('Failed to create Relates link between ' + storyKey + ' and ' + otherKey + ':', e);
    }
}

function tryIntegratesLink(plan, storyKey, ref) {
    var otherKey = resolvePlanKey(plan, ref);
    if (!otherKey) return;
    if (otherKey === storyKey) return;
    attemptRelatesLink(plan.tracker, storyKey, otherKey);
}

function linkAllIntegrations(plan, story) {
    var refs = story.integrates;
    for (var l = 0; l < refs.length; l++) {
        tryIntegratesLink(plan, story._createdKey, refs[l]);
    }
}

function linkIntegratesStory(plan, story) {
    if (!story._createdKey) return;
    if (!Array.isArray(story.integrates)) return;
    linkAllIntegrations(plan, story);
}

function processIntegratesLinks(plan, stories) {
    for (var k = 0; k < stories.length; k++) {
        linkIntegratesStory(plan, stories[k]);
    }
}

// ── Finalize: summary comment + label + result ─────────────────────────────

function isSuccessful(item) {
    return item.success;
}

function countSuccessful(results) {
    return results.filter(isSuccessful).length;
}

function tryPostSummary(plan, results) {
    try {
        tracker.postComment(plan.sourceTicketKey, buildSummaryComment(results, firstObject(plan.config.summaryCommentTitle, 'Planned Follow-up Stories')));
    } catch (commentError) {
        console.warn('Failed to post story plan summary comment to ' + plan.sourceTicketKey + ':', commentError);
    }
}

function postSummaryComment(plan, results) {
    if (plan.config.postSummaryComment === false) return;
    tryPostSummary(plan, results);
}

function tryTrackerAddLabel(trackerInst, key, label) {
    try {
        trackerInst.addLabel(key, label);
    } catch (labelError) {
        console.warn('Failed to add label "' + label + '" to ' + key + ':', labelError);
    }
}

function tryAddPlanLabel(plan) {
    if (!plan.config.addLabel) return;
    tryTrackerAddLabel(tracker, plan.sourceTicketKey, plan.config.addLabel);
}

function addPlanLabel(plan, results) {
    if (countSuccessful(results) === 0) return;
    tryAddPlanLabel(plan);
}

function finalizeStoryPlan(plan, results) {
    postSummaryComment(plan, results);
    addPlanLabel(plan, results);
}

function storyPlural(count) {
    return count === 1 ? 'y' : 'ies';
}

function failureSuffix(failureCount) {
    return failureCount ? ', ' + failureCount + ' failed' : '';
}

function buildPlanMessage(successfulCount, failureCount) {
    return 'Processed ' + successfulCount + ' planned stor' + storyPlural(successfulCount) + failureSuffix(failureCount);
}

function planResultMessage(results) {
    var successfulCount = countSuccessful(results);
    var failureCount = results.length - successfulCount;
    return {
        success: failureCount === 0,
        createdTickets: results,
        message: buildPlanMessage(successfulCount, failureCount)
    };
}

// ── Orchestration ──────────────────────────────────────────────────────────

function action(params) {
    try {
        var plan = prepareStoryPlan(params);
        var early = earlyPlanResult(plan);
        if (early) return early.result;

        var parsed = readStoriesJson(plan.outputFile);
        var fileResult = fileGuardResult(plan, parsed);
        if (fileResult) return fileResult.result;

        var stories = firstObject(parsed.stories, []);
        var emptyResult = storiesEmptyResult(plan, stories);
        if (emptyResult) return emptyResult.result;

        plan.defaultParentKey = getDefaultParentKey(plan.params, plan.config);
        plan.issueTypeName = getJiraIssueTypeName(plan.config);

        var results = processStoryEntries(plan, stories);
        processBlockedByLinks(plan, stories);
        processIntegratesLinks(plan, stories);
        finalizeStoryPlan(plan, results);
        return planResultMessage(results);
    } catch (error) {
        console.error('Error in createPlannedStoriesFromOutput:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
