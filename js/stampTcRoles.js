/**
 * Stamp TC Roles (postJSAction for bug_test_cases_generator — gh-1345)
 *
 * The gh-1329 triage attributes TC failures by ROLE, but the role marker
 * (`Verifies: <BUG-KEY>` / `Regression guard: <scope>`) was written by the
 * generating agent into the TC description as guidance-only prose. This
 * post-action stamps the marker MECHANICALLY onto each created TC of the
 * bug — the agent-memory dependency is gone and unmarked TCs can no longer
 * silently default to own-oracle:
 *
 *   - only BUG parents are stamped (roles are a bug-TC concept);
 *   - TCs that already carry a marker keep it (agent prose respected);
 *   - among the unmarked linked TCs exactly ONE becomes the bug's oracle
 *     (the lowest key — the mandatory regression test is rule-listed first),
 *     every other unmarked TC becomes `Regression guard: <bug summary>`;
 *   - stamping is best-effort: a failing TC update warns and never breaks
 *     the leg — the generator leg's existing moveToDone behavior always runs.
 *
 * The automation setup leg reads the stamped first line back into structured
 * role fields (tcRoleStamp.annotateWithRoles), so the automation leg parses
 * the machine stamp, not agent prose.
 */

var configLoader = require('./configLoader.js');
var trackersModule = require('./common/trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;
var tcRoleStamp = require('./common/tcRoleStamp.js');
var linkedIssuesReport = require('./common/linkedIssuesReport.js');
var moveToDoneModule = require('./moveToDone.js');

/** Custom params: jobParams wins (Teammate path), then top-level, then {}. */
function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/** The ticket's `fields` — null/undefined normalize to {} (one accessor). */
function ticketFields(ticketDetails) {
    return (ticketDetails && ticketDetails.fields) || {};
}

function issueTypeName(ticketDetails) {
    var fields = ticketFields(ticketDetails);
    return (fields.issuetype && fields.issuetype.name) || null;
}

function summaryOf(ticketDetails) {
    return ticketFields(ticketDetails).summary || null;
}

/** The linked TCs of the parent — key, summary and description in one query. */
function linkedTestCases(ticketKey, testCaseType) {
    try {
        var query = linkedIssuesReport.buildLinkedQuery(
            ticketKey, 'issuetype = "' + testCaseType + '"', getTracker().provider(), { issueType: testCaseType });
        var results = getTracker().searchIssues(query, { maxResults: 100, fields: ['key', 'summary', 'description'] });
        return Array.isArray(results) ? results : [];
    } catch (e) {
        console.warn('Could not fetch linked Test Cases for role stamping (skipping):', e);
        return [];
    }
}

/** The description a search result already carries (null when it carries none). */
function fieldsDescriptionOf(tc) {
    var fields = (tc && tc.fields) || {};
    if (fields.description === undefined || fields.description === null) return null;
    return fields.description;
}

/** A search result without a description falls back to the TC ticket read. */
function fetchedDescriptionOf(tc) {
    try {
        var details = getTracker().getIssue(tc.key);
        return ((details && details.fields && details.fields.description) || '');
    } catch (e) {
        console.warn('Could not read the description of', tc.key, '(stamping without it):', e);
        return '';
    }
}

function descriptionOf(tc) {
    var own = fieldsDescriptionOf(tc);
    if (own !== null) return own;
    return fetchedDescriptionOf(tc);
}

function stampOne(tc, marker) {
    var current = descriptionOf(tc);
    var stamped = tcRoleStamp.stampedDescription(current, marker);
    if (stamped === current) return false;
    getTracker().updateDescription(tc.key, stamped);
    console.log('✅ Stamped role marker onto', tc.key, ':', marker);
    return true;
}

/** The plan applied TC by TC — a tracker hiccup on one never blocks the rest. */
function applyStampPlan(plan, linked) {
    var byKey = {};
    linked.forEach(function(tc) { if (tc && tc.key) byKey[tc.key] = tc; });
    var stampedKeys = [];
    plan.forEach(function(step) {
        var tc = byKey[step.tcKey];
        if (!tc) return;
        try {
            if (stampOne(tc, step.marker)) stampedKeys.push(step.tcKey);
        } catch (e) {
            console.warn('Failed to stamp', step.tcKey, '(non-fatal):', e);
        }
    });
    return stampedKeys;
}

/**
 * The mechanical stamping pass. Returns the stamped TC keys (best-effort —
 * a tracker hiccup on one TC never blocks the others nor the leg).
 */
function stampRoles(tracker, ticketKey, ticketDetails, testCaseType) {
    if (issueTypeName(ticketDetails) !== 'Bug') return [];
    var bugSummary = summaryOf(ticketDetails);
    var linked = linkedTestCases(ticketKey, testCaseType);
    if (!linked.length) return [];
    var plan = tcRoleStamp.stampPlan(linked, ticketKey, bugSummary);
    if (!plan.length) {
        console.log('All linked Test Cases already carry role markers — nothing to stamp');
        return [];
    }
    return applyStampPlan(plan, linked);
}

/** The stamping phase — non-fatal by contract: [] on any tracker failure. */
function stampPhase(tracker, ticketKey, projectConfig) {
    try {
        var details = tracker.getIssue(ticketKey);
        var testCaseType = (projectConfig.jira.issueTypes && projectConfig.jira.issueTypes.TEST_CASE) || 'Test Case';
        return stampRoles(tracker, ticketKey, details, testCaseType);
    } catch (e) {
        console.warn('Role stamping skipped (non-fatal):', e);
        return [];
    }
}

function action(params) {
    try {
        var ticketKey = params.ticket && params.ticket.key;
        if (!ticketKey) {
            return moveToDoneModule.action(params);
        }
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var jiraConfig = projectConfig.jira;
        initTracker(projectConfig, customParamsOf(params));
        var tracker = getTracker();

        console.log('=== Stamping TC role markers for', ticketKey, '===');

        var stampedKeys = stampPhase(tracker, ticketKey, projectConfig);

        // The generator leg's existing hand-off is preserved unchanged.
        var result = moveToDoneModule.action(params);
        if (stampedKeys.length) {
            result = Object.assign({}, result, { stampedRoleTestCases: stampedKeys });
        }
        return result;
    } catch (error) {
        console.error('❌ Error in stampTcRoles:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
