/**
 * Check Bug To Fix Ready — postJSAction for bug_to_fix_check agent.
 *
 * Runs on every SM cycle for tickets in "Bug To Fix" status.
 *
 * Test Case:
 * - Finds all linked Bugs.
 * - If all linked Bugs are in "Done" → moves TC to "Backlog" (ready for re-automation).
 * - Otherwise → releases the SM idempotency label so the check re-runs next cycle.
 *
 * Story:
 * - Finds all linked Bugs AND all Bugs linked to linked Test Cases.
 * - If every linked Bug (direct or through a Test Case) is in "Done" → moves Story
 *   to "Ready For Testing" to trigger a full re-test of all linked Test Cases.
 * - Otherwise → releases the SM idempotency label so the check re-runs next cycle.
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const trackersModule = require('./common/trackers.js');
const linkedIssuesReport = require('./common/linkedIssuesReport.js');

/**
 * DMTools returns issue search results as host objects. In some runtime
 * environments (CI/GraalJS) direct property access (obj.key) returns
 * undefined; serialising to JSON and back gives a plain JS object we can
 * rely on.
 */
function toPlain(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    return JSON.parse(JSON.stringify(value));
}

/**
 * gh-1188: release the SM idempotency label so the check re-runs next cycle.
 * A removal failure is swallowed (non-fatal, as before).
 */
function releaseLock(tracker, ticketKey, removeLabel) {
    if (ticketKey && removeLabel) {
        try {
            tracker.removeLabel(ticketKey, removeLabel);
            console.log('Released SM label — will re-check next cycle');
        } catch (e) {
            console.warn('Failed to remove SM label:', e);
        }
    }
}

function findLinkedBugs(tracker, provider, entityKey) {
    // JQL text: provider-specific query (WIQL on ado)
    return toPlain(tracker.searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(provider, entityKey, 'issuetype = Bug', { issueType: 'Bug' }), { maxResults: 50 })) || [];
}

function findNotDoneBugs(tracker, provider, entityKey, doneStatus) {
    // JQL text: provider-specific query (WIQL on ado)
    return toPlain(tracker.searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(provider, entityKey, 'issuetype = Bug AND status != "' + doneStatus + '"', { issueType: 'Bug', statusNotEquals: doneStatus }), { maxResults: 50 })) || [];
}

function findLinkedTestCases(tracker, provider, ticketKey) {
    // JQL text: provider-specific query (WIQL on ado)
    return toPlain(tracker.searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(provider, ticketKey, 'issuetype = "Test Case"', { issueType: 'Test Case' }), { maxResults: 100 })) || [];
}

function findPendingBugsInLinkedTestCases(tracker, provider, ticketKey, doneStatus) {
    var testCases = findLinkedTestCases(tracker, provider, ticketKey);
    var pending = [];
    testCases.forEach(function(tcRaw) {
        var tc = toPlain(tcRaw);
        var tcKey = tc.key;
        if (!tcKey) {
            console.warn('Skipping Test Case without key:', tc);
            return;
        }
        var notDone = findNotDoneBugs(tracker, provider, tcKey, doneStatus);
        notDone.forEach(function(bugRaw) {
            var bug = toPlain(bugRaw);
            pending.push({ tcKey: tcKey, bugKey: bug.key, status: bug.fields && bug.fields.status && bug.fields.status.name });
        });
    });
    return pending;
}

/**
 * gh-1188: one '* BUG (status) via Test Case TC' line per pending bug.
 */
function formatPendingTcBugLines(pendingTcBugs) {
    return pendingTcBugs.map(function(item) {
        return '* ' + item.bugKey + ' (' + item.status + ') via Test Case ' + item.tcKey;
    }).join('\n');
}

/**
 * gh-1188: story completion — move the Story back to Ready For Testing for a
 * full re-test of all linked Test Cases.
 *
 * gh-916: READY_FOR_TESTING can be tag-only (restricted ADO workflows) —
 * stage-label fallback via moveToStatusOrMark. When neither the move nor the
 * mark happened, no side effects follow (as before).
 */
function moveStoryToReadyForTesting(tracker, ticketKey, totalBugs, statuses, removeLabel) {
    console.log('All', totalBugs, 'linked Bug(s) are Done — moving Story', ticketKey, 'to Ready For Testing');

    var rftMove = tracker.moveToStatusOrMark(ticketKey, statuses.READY_FOR_TESTING, 'READY_FOR_TESTING');
    if (rftMove.moved || rftMove.marked) {
        // Remove the story_done_check lock so it can re-run after the Story returns to In Testing
        try {
            tracker.removeLabel(ticketKey, 'sm_story_done_check_triggered');
            console.log('Removed sm_story_done_check_triggered — story_done_check will run after re-test');
        } catch (e) {
            console.warn('Failed to remove sm_story_done_check_triggered label:', e);
        }

        releaseLock(tracker, ticketKey, removeLabel);

        tracker.postComment(ticketKey, 'h3. 🔄 Story Ready for Re-test\n\n' +
                'All *' + totalBugs + '* linked Bug(s) are now in *Done* status.\n\n' +
                'The Story has been automatically moved back to *Ready For Testing* to re-run all linked Test Cases.');

        console.log('✅ Story', ticketKey, 'moved to Ready For Testing');
    }
}

/**
 * gh-1188: Test Case completion — move the TC back to Backlog so it is
 * re-automated against the fixed code.
 *
 * gh-916: on restricted ADO workflows the TC cannot carry a "Done" state at
 * all; Backlog is a real state on PBI workflows, so this move stays a direct
 * transition.
 */
function moveTestCaseToBacklog(tracker, ticketKey, totalBugs, statuses, removeLabel) {
    console.log('All', totalBugs, 'linked Bug(s) are Done — moving', ticketKey, 'to Backlog');

    tracker.moveToStatus(ticketKey, statuses.BACKLOG);

    // Remove test automation label so SM can re-trigger automation
    try {
        tracker.removeLabel(ticketKey, 'sm_test_automation_triggered');
        console.log('Removed sm_test_automation_triggered — TC will be re-automated next SM cycle');
    } catch (e) {
        console.warn('Failed to remove sm_test_automation_triggered label:', e);
    }

    releaseLock(tracker, ticketKey, removeLabel);

    tracker.postComment(ticketKey, 'h3. 🔄 Test Case Ready for Re-automation\n\n' +
            'All *' + totalBugs + '* linked Bug(s) are now in *Done* status.\n\n' +
            'This Test Case has been automatically moved back to *Backlog* to be re-automated against the fixed code.');

    console.log('✅ TC', ticketKey, 'moved to Backlog');
}

/**
 * gh-1188: token-usage summary step — a provider failure here must never
 * fail the ready check.
 */
function postTokenUsageSafely(ticketKey, params) {
    tokenUsageComment.postTokenUsageSafely(ticketKey, params);
}

/**
 * gh-1188: story branch of the ready check — all linked Bugs are Done here.
 * Also checks bugs linked to linked Test Cases before allowing the Story to
 * re-test; any pending TC bug keeps the Story in Bug To Fix.
 */
function completeStoryReady(params, tracker, provider, ticketKey, issueType, totalBugs, jiraConfig, removeLabel) {
    const pendingTcBugs = findPendingBugsInLinkedTestCases(tracker, provider, ticketKey, jiraConfig.statuses.DONE);
    if (pendingTcBugs.length > 0) {
        const details = formatPendingTcBugLines(pendingTcBugs);
        console.log('Found', pendingTcBugs.length, 'pending Bug(s) linked to linked Test Cases — keeping Story in Bug To Fix');
        console.log(details);
        releaseLock(tracker, ticketKey, removeLabel);
        return { success: true, action: 'waiting_for_tc_bugs', issueType: issueType, pendingTcBugs: pendingTcBugs, ticketKey: ticketKey };
    }

    // All linked Bugs are Done → move Story back to Ready For Testing for re-test
    moveStoryToReadyForTesting(tracker, ticketKey, totalBugs, jiraConfig.statuses, removeLabel);

    postTokenUsageSafely(ticketKey, params);

    return { success: true, action: 'moved_to_ready_for_testing', totalBugs: totalBugs, ticketKey: ticketKey };
}

/**
 * gh-1188: Test Case branch of the ready check — all linked Bugs are Done
 * here, so the TC goes back to Backlog.
 */
function completeTestCaseReady(params, tracker, ticketKey, issueType, totalBugs, jiraConfig, removeLabel) {
    // All linked Bugs are Done → move TC back to Backlog
    moveTestCaseToBacklog(tracker, ticketKey, totalBugs, jiraConfig.statuses, removeLabel);

    postTokenUsageSafely(ticketKey, params);

    return { success: true, action: 'moved_to_backlog', totalBugs: totalBugs, ticketKey: ticketKey };
}

/**
 * gh-1188: issue type of the ready-check ticket — defaults to Test Case.
 */
function issueTypeOf(ticketFields) {
    return (ticketFields && ticketFields.issuetype && ticketFields.issuetype.name) || 'Test Case';
}

/**
 * gh-1188: plain field resolution hoisted out of action — pure reads only,
 * so the config/tracker call order below is unchanged.
 */
function resolveReadyCheckInputs(params) {
    const customParams = params.jobParams && params.jobParams.customParams;
    return {
        ticketKey: params.ticket && params.ticket.key,
        issueType: issueTypeOf(params.ticket && params.ticket.fields),
        customParams: customParams,
        removeLabel: customParams && customParams.removeLabel
    };
}

function action(params) {
    const inputs = resolveReadyCheckInputs(params);
    const ticketKey = inputs.ticketKey;
    const issueType = inputs.issueType;
    const customParams = inputs.customParams;
    const removeLabel = inputs.removeLabel;
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const jiraConfig = projectConfig.jira;
    const tracker = trackersModule.createTracker(projectConfig, customParams || {});
    const provider = tracker.provider();

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Bug To Fix ready check for', ticketKey, '(' + issueType + ') ===');

        const linkedBugs = findLinkedBugs(tracker, provider, ticketKey);
        const totalBugs = linkedBugs.length;
        console.log('Linked Bugs:', totalBugs);

        if (totalBugs === 0) {
            console.log('No linked Bugs found — releasing lock, will re-check next cycle');
            releaseLock(tracker, ticketKey, removeLabel);
            return { success: true, action: 'no_linked_bugs', issueType: issueType, ticketKey: ticketKey };
        }

        const notDoneBugs = findNotDoneBugs(tracker, provider, ticketKey, jiraConfig.statuses.DONE);
        const notDoneCount = notDoneBugs.length;
        console.log('Linked Bugs not yet Done:', notDoneCount, '/', totalBugs);

        if (notDoneCount > 0) {
            console.log('Not all linked Bugs are Done — releasing lock, will re-check next cycle');
            releaseLock(tracker, ticketKey, removeLabel);
            return { success: true, action: 'waiting', issueType: issueType, total: totalBugs, notDone: notDoneCount, ticketKey: ticketKey };
        }

        if (issueType === jiraConfig.issueTypes.STORY) {
            return completeStoryReady(params, tracker, provider, ticketKey, issueType, totalBugs, jiraConfig, removeLabel);
        }

        return completeTestCaseReady(params, tracker, ticketKey, issueType, totalBugs, jiraConfig, removeLabel);

    } catch (error) {
        console.error('❌ Error in checkBugToFixReady:', error);
        releaseLock(tracker, ticketKey, removeLabel);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        // gh-1188: step helpers extracted from action — exported for direct
        // characterization tests.
        toPlain,
        releaseLock,
        findLinkedBugs,
        findNotDoneBugs,
        findLinkedTestCases,
        findPendingBugsInLinkedTestCases,
        formatPendingTcBugLines,
        moveStoryToReadyForTesting,
        moveTestCaseToBacklog,
        postTokenUsageSafely,
        completeStoryReady,
        completeTestCaseReady,
        issueTypeOf,
        resolveReadyCheckInputs
    };
}
