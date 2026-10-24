/**
 * Check Subtasks Done For BA — postJSAction for story_ba_check agent.
 *
 * Runs on every SM cycle for each Story in "PO Review".
 * Fetches subtasks via JQL (searchIssues returns a plain array).
 *
 * - If no clarification subtasks exist, or all subtasks are Done → moves the Story to "BA Analysis".
 * - Otherwise → removes the SM idempotency label so the SM re-triggers
 *   this check on the next cycle.
 *
 * Configurable via .dmtools/config.js:
 *   jira.questions.fetchJql     — JQL to find question subtasks ({ticketKey} placeholder)
 *   jira.statuses.BA_ANALYSIS   — target status name (default: 'BA Analysis')
 */

var configLoader = require('./configLoader.js');
var trackersModule = require('./common/trackers.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var linkedIssuesReport = require('./common/linkedIssuesReport.js');
var smDoneCheck = require('./common/smDoneCheck.js');

function subtaskHasStatus(item) {
    if (!item) return false;
    var fieldStatus = item.fields && item.fields.status && item.fields.status.name;
    return Boolean(fieldStatus || item.status);
}

function subtasksHaveStatus(subtasks) {
    return Array.isArray(subtasks) && subtasks.length > 0 && subtasks.every(subtaskHasStatus);
}

function shouldFilterSubtasksInMemory(tracker, subtasks, allQuery) {
    if (tracker.provider() === 'ado') return true;
    if (/^\s*SELECT\b/i.test(String(allQuery || ''))) return true;
    return subtasksHaveStatus(subtasks);
}

function countNotDoneSubtasks(tracker, subtasks, allQuery, doneStatus) {
    if (shouldFilterSubtasksInMemory(tracker, subtasks, allQuery)) {
        return subtasks.filter(function(st) {
            return !tracker.hasStage(st, 'DONE', doneStatus);
        }).length;
    }
    var notDone = tracker.searchIssues(
        allQuery.replace('ORDER BY created ASC', '') + ' AND status != "' + doneStatus + '"',
        { maxResults: 1 }
    ) || [];
    return notDone.length;
}

function moveStoryToBaAnalysis(tracker, ticketKey, baAnalysisStatus, commentBody, totalSubtasks, actionName) {
    tracker.moveToStatusOrMark(ticketKey, baAnalysisStatus, 'BA_ANALYSIS', 'PO_REVIEW');
    tracker.postComment(ticketKey, commentBody);
    return { success: true, action: actionName, total: totalSubtasks, ticketKey: ticketKey };
}

function runBaReadinessCheck(tracker, projectConfig, ticketKey, removeLabel, initiator) {
    console.log('=== BA readiness check for', ticketKey, '===');
    var baAnalysisStatus = projectConfig.jira.statuses.BA_ANALYSIS;
    var allQuery = linkedIssuesReport.buildChildrenQuery(
        tracker.provider(),
        ticketKey,
        projectConfig.jira.questions.fetchJql,
        projectConfig.jira.issueTypes.SUBTASK
    );
    var subtasks = tracker.searchIssues(allQuery, { maxResults: 100 }) || [];
    var totalSubtasks = subtasks.length;
    console.log('Total subtasks:', totalSubtasks);

    if (totalSubtasks === 0) {
        console.log('No subtasks found — no PO clarifications are required, moving', ticketKey, 'to', baAnalysisStatus);
        var noSubResult = moveStoryToBaAnalysis(
            tracker,
            ticketKey,
            baAnalysisStatus,
            'h3. ✅ PO Review Complete — Moving to ' + baAnalysisStatus + '\n\n' +
                'No clarification subtasks were created for this story, so there is nothing waiting for PO answers.\n\n' +
                'The story has been automatically moved to *' + baAnalysisStatus + '*.',
            totalSubtasks,
            'moved_to_ba_analysis_no_subtasks'
        );
        console.log('✅ Story', ticketKey, 'moved to BA Analysis (no subtasks required)');
        return noSubResult;
    }

    var notDoneCount = countNotDoneSubtasks(tracker, subtasks, allQuery, projectConfig.jira.statuses.DONE || 'Done');
    console.log('Subtasks not yet Done:', notDoneCount, '/', totalSubtasks);

    if (notDoneCount > 0) {
        return smDoneCheck.waitingResult(
            tracker,
            ticketKey,
            removeLabel,
            'Not all subtasks done — releasing lock, will re-check next cycle',
            totalSubtasks,
            notDoneCount
        );
    }

    console.log('All', totalSubtasks, 'subtask(s) done — moving', ticketKey, 'to', baAnalysisStatus);
    var doneResult = moveStoryToBaAnalysis(
        tracker,
        ticketKey,
        baAnalysisStatus,
        'h3. ✅ PO Review Complete — Moving to ' + baAnalysisStatus + '\n\n' +
            'All *' + totalSubtasks + '* subtask(s) are *Done*.\n\n' +
            'The story has been automatically moved to *' + baAnalysisStatus + '*.',
        totalSubtasks,
        'moved_to_ba_analysis'
    );
    console.log('✅ Story', ticketKey, 'moved to BA Analysis');
    tokenUsageComment.postTokenUsageCommentsSafely(ticketKey, { initiator: initiator, tracker: tracker });
    return doneResult;
}

function action(params) {
    return smDoneCheck.runDoneCheckAction(params, runBaReadinessCheck, 'checkSubtasksDoneForBA', configLoader, trackersModule);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        subtaskHasStatus: subtaskHasStatus,
        subtasksHaveStatus: subtasksHaveStatus,
        shouldFilterSubtasksInMemory: shouldFilterSubtasksInMemory,
        countNotDoneSubtasks: countNotDoneSubtasks
    };
}
