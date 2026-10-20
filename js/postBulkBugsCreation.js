/**
 * Post Bulk Bugs Creation Action (postJSAction for bulk_bugs_creation agent)
 *
 * Reads outputs/bulk_bug_decisions.json written by the AI:
 * {
 *   "processed": ["TS-984", "TS-954", "TS-909"],
 *   "newBugs": [
 *     {
 *       "summary": "...",
 *       "priority": "Medium",
 *       "descriptionFile": "outputs/bug_001_description.md",
 *       "linkedTCs": ["TS-984", "TS-954"]
 *     }
 *   ],
 *   "links": [{ "tcKey": "TS-909", "bugKey": "TS-123" }],
 *   "skipped": [{ "tcKey": "TS-YYY", "reason": "..." }]
 * }
 *
 * Safety: ONLY TCs listed in "processed" are acted upon.
 * TCs not in "processed" are left untouched (stay in Failed, no label added).
 *
 * For newBugs:  create bug, link all linkedTCs, move linkedTCs to "Bug To Fix"
 * For links:    link TC to existing bug, move TC to "Bug To Fix"
 * For skipped:  move TC to Backlog so test automation can be re-automated/reworked
 */

const { LABELS } = require('./config.js');
var feedbackLoop = require('./common/feedbackLoop.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var configLoader = require('./configLoader.js');
var linkedIssuesReport = require('./common/linkedIssuesReport.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}
const { JIRA_FIELDS } = require('./config.js');

function readFile(path) {
    try {
        var content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        console.warn('Could not read file:', path, e);
        return null;
    }
}

function readDecisions() {
    try {
        var raw = readFile('outputs/bulk_bug_decisions.json');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse bulk_bug_decisions.json:', e);
        return null;
    }
}

function keyOrNull(key) {
    return key ? key : null;
}

function keyFromObjectResult(result) {
    if (!result) return null;
    return keyOrNull(result.key);
}

function parsedTicketKey(parsed) {
    if (!parsed) return null;
    return keyOrNull(parsed.key);
}

function keyFromJsonString(text) {
    try {
        return parsedTicketKey(JSON.parse(text));
    } catch (e) {
        return null;
    }
}

function keyFromBrowseUrl(text) {
    var match = text.match(/\/browse\/([A-Z]+-\d+)/);
    if (!match) return null;
    return match[1];
}

function keyFromStringResult(result) {
    var fromJson = keyFromJsonString(result);
    if (fromJson) return fromJson;
    return keyFromBrowseUrl(result);
}

function extractKeyFromResult(result) {
    if (typeof result === 'string') {
        return keyFromStringResult(result);
    }
    return keyFromObjectResult(result);
}

function linkBugToTC(tcKey, bugKey) {
    getTracker().linkIssues(tcKey, bugKey, 'Blocks');
    console.log('  ✅ Linked:', bugKey, 'blocks', tcKey);
}

function findLinkedStoryForTC(tcKey) {
    if (!tcKey) return null;
    try {
        // JQL text: provider-specific query (WIQL on ado)
        var result = getTracker().searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(getTracker().provider(), tcKey, 'issuetype = Story', { issueType: 'Story' }), {
            fields: ['key'],
            maxResults: 1
        });
        var tickets = extractTickets(result);
        return tickets.length > 0 ? (tickets[0].key || null) : null;
    } catch (e) {
        console.warn('  ⚠️ Could not find linked Story for', tcKey, e);
        return null;
    }
}

function linkBugToStory(storyKey, bugKey) {
    try {
        getTracker().linkIssues(bugKey, storyKey, 'relates to');
        console.log('  ✅ Linked bug', bugKey, 'to Story', storyKey);
    } catch (e) {
        console.warn('  ⚠️ Could not link bug', bugKey, 'to Story', storyKey, e);
    }
}

function linkBugToStories(bugKey, linkedTCs) {
    var seen = {};
    linkedTCs.forEach(function(tcKey) {
        var storyKey = findLinkedStoryForTC(tcKey);
        if (storyKey && !seen[storyKey]) {
            seen[storyKey] = true;
            linkBugToStory(storyKey, bugKey);
        }
    });
}

function extractTickets(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (typeof result === 'string') {
        try {
            var parsed = JSON.parse(result);
            return extractTickets(parsed);
        } catch (e) {
            return [];
        }
    }
    if (Array.isArray(result.issues)) return result.issues;
    if (Array.isArray(result.data)) return result.data;
    if (Array.isArray(result.results)) return result.results;
    return [];
}

function findLinkedNonDoneBug(tcKey) {
    if (!tcKey) return null;
    try {
        // JQL text: provider-specific query (WIQL on ado)
        var result = getTracker().searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(getTracker().provider(), tcKey, 'issuetype = Bug AND status not in (Done)', { issueType: 'Bug', statusNotIn: ['Done'] }), {
            fields: ['key', 'summary', 'status'],
            maxResults: 1
        });
        var tickets = extractTickets(result);
        return tickets.length > 0 ? (tickets[0].key || null) : null;
    } catch (e) {
        console.warn('  ⚠️ Could not live-check linked non-Done bugs for', tcKey, e);
        return null;
    }
}

function findAnyLinkedNonDoneBug(tcKeys) {
    for (var i = 0; i < tcKeys.length; i++) {
        var bugKey = findLinkedNonDoneBug(tcKeys[i]);
        if (bugKey) return bugKey;
    }
    return null;
}

function moveToBugToFix(tcKey, jiraConfig) {
    try {
        // gh-916: BUG_TO_FIX can be tag-only (restricted ADO workflows) — stage-label fallback.
        var moveResult = getTracker().moveToStatusOrMark(tcKey, jiraConfig.statuses.BUG_TO_FIX, 'BUG_TO_FIX');
        if (moveResult.moved || moveResult.marked) {
            console.log('  📋 Moved to Bug To Fix:', tcKey);
        }
    } catch (e) {
        console.warn('  ⚠️ Could not move to Bug To Fix:', tcKey, e);
    }
}

function addTriggerLabel(tcKey, label) {
    try {
        getTracker().addLabel(tcKey, label);
    } catch (e) {
        console.warn('  ⚠️ Could not add label', label, 'to', tcKey, e);
    }
}

function postComment(tcKey, comment) {
    try {
        getTracker().postComment(tcKey, comment);
    } catch (e) {
        console.warn('  ⚠️ Could not post comment to', tcKey, e);
    }
}

function getFailedReasonFieldName(config, customParams) {
    return (customParams && customParams.failedReasonField)
        || (config && config.jira && config.jira.fields && config.jira.fields.failedReason)
        || JIRA_FIELDS.FAILED_REASON
        || 'Failed Reason';
}

function getFailedReasonForTc(tcKey, fieldName) {
    if (!tcKey || !fieldName) return '';
    try {
        var result = getTracker().getIssue(tcKey);
        var fields = result && result.fields ? result.fields : {};
        var raw = fields[fieldName];
        if (typeof raw === 'string') return raw;
        if (raw && typeof raw.value === 'string') return raw.value;
        // Fallback: dmtools may transform customfield_12345 into "Name (customfield_12345)".
        if (fieldName.indexOf('customfield_') !== -1) {
            for (var key in fields) {
                if (fields.hasOwnProperty(key) && key.indexOf(fieldName) !== -1) {
                    var v = fields[key];
                    if (typeof v === 'string') return v;
                    if (v && typeof v.value === 'string') return v.value;
                }
            }
        }
        return '';
    } catch (e) {
        console.warn('Could not read Failed Reason for', tcKey, ':', e);
        return '';
    }
}

function attachFileToBug(bugKey, filePath) {
    if (!bugKey || !filePath) return false;
    try {
        getTracker().attachFile(bugKey, filePath.split('/').pop(), filePath, 'text/markdown');
        console.log('  ✅ Attached description file to bug', bugKey, ':', filePath);
        return true;
    } catch (e) {
        console.warn('  ⚠️ Could not attach description file to bug', bugKey, ':', e);
        return false;
    }
}

function removeTriggerLabel(ticketKey, label) {
    if (!ticketKey || !label) return;
    try {
        getTracker().removeLabel(ticketKey, label);
        console.log('  🏷️ Removed SM trigger label "' + label + '" from ' + ticketKey);
    } catch (e) {
        console.warn('  ⚠️ Could not remove label', label, 'from', ticketKey, e);
    }
}

function removeProcessingLabels(tcKey, labels) {
    labels.forEach(function(label) {
        removeTriggerLabel(tcKey, label);
    });
}

function markResolved(resolvedSet, tcKey) {
    if (tcKey) resolvedSet[tcKey] = true;
}

function moveSkippedTcToBacklog(tcKey, jiraConfig) {
    getTracker().moveToStatus(tcKey, jiraConfig.statuses.BACKLOG);
    console.log('  🔧 Moved to ' + jiraConfig.statuses.BACKLOG + ':', tcKey);
    try {
        getTracker().removeLabel(tcKey, 'sm_test_automation_triggered');
    } catch (e) {}
}

// ── Run context ────────────────────────────────────────────────────────────

function buildBulkContext(params) {
    var actualParams = params.jobParams || params;
    var customParams = actualParams.customParams || {};
    var projectConfig = configLoader.loadProjectConfig(actualParams);
    initTracker(projectConfig, customParams);
    return {
        params: params,
        actualParams: actualParams,
        customParams: customParams,
        triggerLabel: customParams.removeLabel || 'sm_bug_creation_triggered',
        smTriggerLabel: customParams.smTriggerLabel || 'sm_bulk_bugs_creation_triggered',
        jiraConfig: projectConfig.jira,
        failedReasonFieldName: getFailedReasonFieldName(projectConfig, customParams),
        decisions: readDecisions()
    };
}

function linkedResult(tcKey, bugKey, source) {
    var result = { tcKey: tcKey, bugKey: bugKey };
    if (source) result.source = source;
    return result;
}

function rejectFixedByBug(ctx, fixedByBug) {
    console.error('❌ fixedByBug is not supported for bulk bug creation; Done bugs are excluded from matching');
    fixedByBug.forEach(function(fixDef) {
        if (fixDef && fixDef.tcKey) {
            removeProcessingLabels(fixDef.tcKey, [ctx.triggerLabel, ctx.smTriggerLabel]);
        }
    });
    return {
        success: false,
        error: 'fixedByBug is not supported; create or link a non-Done bug, or skip only confirmed test-code issues'
    };
}

function recoverMissingDecisions(ctx) {
    console.error('❌ Could not read bulk_bug_decisions.json — attempting recovery');

    // Remove SM trigger label so SM can re-dispatch on next run
    var triggerTicketKey = (ctx.actualParams.ticket && ctx.actualParams.ticket.key) || null;
    removeTriggerLabel(triggerTicketKey, ctx.smTriggerLabel);

    // Try feedback loop resume — tell agent to produce the output file
    var resume = feedbackLoop.resumeAgent({
        ticketKey: triggerTicketKey || 'unknown',
        customParams: ctx.customParams,
        section: 'postAction',
        stage: 'bulk_bugs_output',
        error: 'The AI agent did not produce the required outputs/bulk_bug_decisions.json file. ' +
            'The file must be valid JSON with keys: processed (array of TC keys), ' +
            'newBugs (array of bug definitions with summary, priority, descriptionFile, linkedTCs), ' +
            'links (array of {tcKey, bugKey} for existing bugs), ' +
            'skipped (array of {tcKey, reason}). ' +
            'Read input/failed_tcs.json and input/open_bugs.json, then write the decisions file.'
    });

    if (resume.attempted) {
        console.log('🔄 Feedback loop resumed agent — re-running post-action');
        return action(ctx.params);
    }

    return { success: false, error: 'Missing bulk_bug_decisions.json, resume not attempted: ' + (resume.reason || 'unknown') };
}

// ── newBugs phase ──────────────────────────────────────────────────────────

function readBugDescriptionFile(descriptionFile) {
    if (!descriptionFile) return null;
    var description = readFile(descriptionFile);
    if (!description) {
        console.warn('  ⚠️ descriptionFile not found:', descriptionFile, '— using Failed Reason as fallback');
        return null;
    }
    return description;
}

function failedReasonOrSummary(ctx, summary, linkedTCs) {
    if (linkedTCs.length === 0) return summary;
    var failedReason = getFailedReasonForTc(linkedTCs[0], ctx.failedReasonFieldName);
    if (!failedReason) return summary;
    console.log('  ℹ️ Using Failed Reason from', linkedTCs[0], 'as bug description fallback');
    return failedReason;
}

function resolveBugDescription(ctx, bugDef, summary, linkedTCs) {
    var description = readBugDescriptionFile(bugDef.descriptionFile);
    if (description) return description;
    return failedReasonOrSummary(ctx, summary, linkedTCs);
}

function bulkCreatedKey(result) {
    if (typeof result === 'string' && /^[A-Za-z0-9_-]+$/.test(result)) return result;
    return extractKeyFromResult(result);
}

function tryCreateBulkBug(summary, description, linkedTCs) {
    var projectKey = (linkedTCs[0] || 'TS-1').split('-')[0];
    try {
        var result = getTracker().createTicket(projectKey, 'Bug', summary, description);
        return { ok: true, bugKey: bulkCreatedKey(result) };
    } catch (e) {
        console.error('  ❌ Failed to create bug:', e);
        return { ok: false, error: e.toString() };
    }
}

function linkTcToExistingBug(ctx, tcKey, bugKey, plan, source, commentText) {
    if (!plan.processedSet[tcKey]) {
        console.warn('  ⚠️ TC', tcKey, 'not in processed list — skipping (safety guard)');
        return;
    }
    try {
        linkBugToTC(tcKey, bugKey);
        moveToBugToFix(tcKey, ctx.jiraConfig);
        removeProcessingLabels(tcKey, [ctx.triggerLabel, ctx.smTriggerLabel]);
        postComment(tcKey, commentText);
        plan.results.linked.push(linkedResult(tcKey, bugKey, source));
        markResolved(plan.resolvedSet, tcKey);
    } catch (e) {
        console.error('  ❌ Failed to link', tcKey, '→', bugKey, ':', e);
        plan.results.errors.push({ tcKey: tcKey, bugKey: bugKey, error: e.toString() });
    }
}

function linkTcToNewBug(ctx, tcKey, bugKey, summary, plan) {
    if (!plan.processedSet[tcKey]) {
        console.warn('  ⚠️ TC', tcKey, 'not in processed list — skipping (safety guard)');
        return;
    }
    try {
        linkBugToTC(tcKey, bugKey);
        moveToBugToFix(tcKey, ctx.jiraConfig);
        removeProcessingLabels(tcKey, [ctx.triggerLabel, ctx.smTriggerLabel]);
        postComment(tcKey,
            'h3. 🐛 New Bug Created (Batch)\n\n' +
            'Created: *' + bugKey + '*\n' +
            '*Summary*: ' + summary
        );
        plan.results.created.push({ tcKey: tcKey, bugKey: bugKey });
        markResolved(plan.resolvedSet, tcKey);
    } catch (e) {
        console.error('  ❌ Failed to process TC', tcKey, ':', e);
        plan.results.errors.push({ tcKey: tcKey, bugKey: bugKey, error: e.toString() });
    }
}

function linkExistingBugForTcGroup(ctx, existingBugKey, linkedTCs, plan) {
    console.log('  🔁 Existing linked non-Done bug found during live re-check:', existingBugKey);
    linkedTCs.forEach(function(tcKey) {
        linkTcToExistingBug(ctx, tcKey, existingBugKey, plan, 'live_recheck',
            'h3. 🔗 Existing Bug Linked (Batch Live Re-check)\n\n' +
            'Linked to existing non-Done bug: *' + existingBugKey + '*'
        );
    });

    // Link the existing bug to the parent Story(ies) of the linked TCs
    linkBugToStories(existingBugKey, linkedTCs);
}

function createAndDistributeBug(ctx, bugDef, summary, linkedTCs, plan) {
    var description = resolveBugDescription(ctx, bugDef, summary, linkedTCs);
    console.log('  Creating bug:', summary, '| links to:', linkedTCs.join(', '));

    var created = tryCreateBulkBug(summary, description, linkedTCs);
    if (!created.ok) {
        plan.results.errors.push({ summary: summary, error: created.error });
        return;
    }

    if (!created.bugKey) {
        console.warn('  ⚠️ Bug created but key could not be extracted for:', summary);
        plan.results.errors.push({ summary: summary, error: 'key not extracted' });
        return;
    }

    console.log('  🐛 Created bug:', created.bugKey);

    // Attach the description file to the new bug if it exists
    if (bugDef.descriptionFile) {
        attachFileToBug(created.bugKey, bugDef.descriptionFile);
    }

    // Link each TC to the new bug
    linkedTCs.forEach(function(tcKey) {
        linkTcToNewBug(ctx, tcKey, created.bugKey, summary, plan);
    });

    // Also link the new bug to the parent Story(ies) of the linked TCs
    linkBugToStories(created.bugKey, linkedTCs);
}

function processNewBugDef(ctx, bugDef, idx, plan) {
    var summary = bugDef.summary;
    if (!summary) {
        console.warn('  ⚠️ Skipping newBug[' + idx + '] — no summary');
        return;
    }

    var linkedTCs = bugDef.linkedTCs || [];

    var existingBugKey = findAnyLinkedNonDoneBug(linkedTCs);
    if (existingBugKey) {
        linkExistingBugForTcGroup(ctx, existingBugKey, linkedTCs, plan);
        return;
    }

    createAndDistributeBug(ctx, bugDef, summary, linkedTCs, plan);
}

function createBugsFromDecisions(ctx, newBugs, plan) {
    newBugs.forEach(function(bugDef, idx) {
        processNewBugDef(ctx, bugDef, idx, plan);
    });
}

// ── links phase ────────────────────────────────────────────────────────────

function processLinkDef(ctx, linkDef, plan) {
    var tcKey = linkDef.tcKey;
    var bugKey = linkDef.bugKey;

    if (!tcKey || !bugKey) {
        console.warn('  ⚠️ Invalid link entry:', JSON.stringify(linkDef));
        return;
    }

    console.log('  Linking', tcKey, '→', bugKey);
    linkTcToExistingBug(ctx, tcKey, bugKey, plan, undefined,
        'h3. 🔗 Existing Bug Linked (Batch)\n\n' +
        'Linked to existing bug: *' + bugKey + '*'
    );

    // Ensure the existing bug is also linked to the parent Story of this TC
    linkBugToStories(bugKey, [tcKey]);
}

function linkDecidedBugs(ctx, links, plan) {
    links.forEach(function(linkDef) {
        processLinkDef(ctx, linkDef, plan);
    });
}

// ── skipped phase ──────────────────────────────────────────────────────────

function processSkippedTc(ctx, skipDef, plan) {
    var tcKey = skipDef.tcKey;
    if (!tcKey) return;
    if (!plan.processedSet[tcKey]) {
        console.warn('  ⚠️ TC', tcKey, 'not in processed list — skipping (safety guard)');
        return;
    }
    console.log('  Skipping', tcKey, '—', skipDef.reason || 'no reason given');
    moveSkippedTcToBacklog(tcKey, ctx.jiraConfig);
    try {
        removeProcessingLabels(tcKey, [ctx.triggerLabel, ctx.smTriggerLabel]);
        console.log('  🏷️ Removed trigger labels from', tcKey, '— eligible for re-automation');
    } catch (e) {}
    postComment(tcKey,
        'h3. ℹ️ No Bug Created (Batch) — Test Code Issue\n\n' +
        '*Reason*: ' + (skipDef.reason || 'AI determined this is a test code issue, not an application bug.') +
        '\n\n_TC moved to *Backlog* so the test automation can be reworked instead of staying in *Failed*._'
    );
    plan.results.skipped.push({ tcKey: tcKey, reason: skipDef.reason });
    markResolved(plan.resolvedSet, tcKey);
}

function skipTestCodeIssues(ctx, skipped, plan) {
    skipped.forEach(function(skipDef) {
        processSkippedTc(ctx, skipDef, plan);
    });
}

// ── post-batch recovery phase ──────────────────────────────────────────────

function recoverTcWithLinkedBug(ctx, tcKey, linkedBugKey, plan) {
    moveToBugToFix(tcKey, ctx.jiraConfig);
    removeProcessingLabels(tcKey, [ctx.triggerLabel, ctx.smTriggerLabel]);
    postComment(tcKey,
        'h3. 🔗 Existing Bug Found After Batch\n\n' +
        'Bulk bug creation did not produce a final decision for this TC, ' +
        'but a linked non-Done bug already exists: *' + linkedBugKey + '*.\n\n' +
        '_TC moved to *Bug To Fix* and stale bug-creation locks were removed._'
    );
    plan.results.linked.push(linkedResult(tcKey, linkedBugKey, 'post_batch_recovery'));
    markResolved(plan.resolvedSet, tcKey);
}

function releaseTcWithoutOutcome(ctx, tcKey, plan) {
    removeProcessingLabels(tcKey, [ctx.triggerLabel, ctx.smTriggerLabel]);
    postComment(tcKey,
        'h3. ⚠️ Bulk Bug Creation Released\n\n' +
        'Bulk bug creation processed this TC but did not create, link, or skip it. ' +
        'No linked non-Done bug was found during the post-action live check.\n\n' +
        '_Stale bug-creation locks were removed so the next bulk cycle can retry from Failed._'
    );
    plan.results.released.push({ tcKey: tcKey, reason: 'no bulk outcome and no linked non-Done bug' });
}

function recoverProcessedTc(ctx, tcKey, plan) {
    if (!tcKey || plan.resolvedSet[tcKey]) return;

    console.warn('  ⚠️ Processed TC has no successful bulk outcome:', tcKey);
    var linkedBugKey = findLinkedNonDoneBug(tcKey);
    if (linkedBugKey) {
        recoverTcWithLinkedBug(ctx, tcKey, linkedBugKey, plan);
        return;
    }

    releaseTcWithoutOutcome(ctx, tcKey, plan);
}

function recoverUnprocessedTcs(ctx, plan) {
    plan.processed.forEach(function(tcKey) {
        recoverProcessedTc(ctx, tcKey, plan);
    });
}

// ── summary ────────────────────────────────────────────────────────────────

function postBulkTokenUsage(ctx) {
    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run.
    try {
        tokenUsageComment.postTokenUsageComments((ctx.actualParams.ticket && ctx.actualParams.ticket.key) || null, { initiator: ctx.actualParams.initiator, customParams: tokenUsageComment.customParamsOf(ctx.params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function summarizeBulkRun(ctx, plan) {
    console.log('=== Bulk bug creation complete ===');
    console.log('  Created:', plan.results.created.length, 'bug links');
    console.log('  Linked:', plan.results.linked.length, 'to existing bugs');
    console.log('  Skipped:', plan.results.skipped.length);
    console.log('  Released:', plan.results.released.length, 'without outcome');
    console.log('  Errors:', plan.results.errors.length);
    postBulkTokenUsage(ctx);
    return { success: true, results: plan.results };
}

// ── orchestration ──────────────────────────────────────────────────────────

function buildBulkPlan(decisions) {
    var processed = decisions.processed || [];
    var plan = {
        processed: processed,
        processedSet: {},
        resolvedSet: {},
        results: { created: [], linked: [], skipped: [], released: [], errors: [] }
    };
    processed.forEach(function(k) { plan.processedSet[k] = true; });
    return plan;
}

function executeBulkDecisions(ctx) {
    var decisions = ctx.decisions;
    var fixedByBug = decisions.fixedByBug || [];

    if (fixedByBug.length > 0) {
        return rejectFixedByBug(ctx, fixedByBug);
    }

    var newBugs = decisions.newBugs || [];
    var links = decisions.links || [];
    var skipped = decisions.skipped || [];

    console.log('Decisions: ' + newBugs.length + ' new bugs, ' + links.length + ' links, ' +
        skipped.length + ' skipped');
    console.log('Processed TCs: ' + (decisions.processed || []).join(', '));

    var plan = buildBulkPlan(decisions);

    // ── 1. Create new bugs and link their TCs ─────────────────────────────
    createBugsFromDecisions(ctx, newBugs, plan);

    // ── 2. Link TCs to existing bugs ─────────────────────────────────────
    linkDecidedBugs(ctx, links, plan);

    // ── 3. Test-code issues → Backlog so they leave Failed and can be re-automated ─
    skipTestCodeIssues(ctx, skipped, plan);

    // ── 4. Recovery guard: processed TCs must never keep a stale bulk lock ──
    recoverUnprocessedTcs(ctx, plan);

    return summarizeBulkRun(ctx, plan);
}

function action(params) {
    try {
        var ctx = buildBulkContext(params);

        console.log('=== Processing bulk bug creation decisions ===');

        if (ctx.decisions === null) {
            return recoverMissingDecisions(ctx);
        }

        return executeBulkDecisions(ctx);
    } catch (e) {
        console.error('postBulkBugsCreation failed:', e);
        throw e;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, extractTickets: extractTickets };
}
