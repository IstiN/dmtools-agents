/**
 * recoverStuckDevelopment.js
 *
 * Local-execution recovery for Story/Bug tickets stuck in the "actively being
 * developed" status (statuses.IN_DEVELOPMENT).
 *
 * preCliDevelopmentSetup.js / preCliReworkSetup.js (opt-in via
 * config.jira.markReworkInDevelopment) move the ticket to statuses.IN_DEVELOPMENT
 * before the CLI agent starts coding or reworking. If the job crashes/times out/gets
 * interrupted after that transition but before the postJSAction
 * (developTicketAndCreatePR.js / developBugAndCreatePR.js / pushReworkChanges.js) runs,
 * the ticket is left stuck with no SM rule able to pick it up again.
 *
 * This is an opt-in agent: it is NOT wired into the default agents/sm.json rule set,
 * since not every project uses a distinct "actively being developed" status. Projects
 * that need it should add a rule for it in their own .dmtools/config.js smRules
 * (see .dmtools/config.js in this repo for an example).
 *
 * This handler:
 *  1. Looks for an open PR matching the ticket key.
 *  2. If an open PR exists → move to statuses.IN_REVIEW so pr_review picks it up
 *     (the branch/PR already reflects whatever work was pushed).
 *  3. If no open PR exists → move back to statuses.READY_FOR_DEVELOPMENT and remove the
 *     sm_story_development_triggered / sm_bug_development_triggered / sm_story_rework_triggered
 *     labels so the normal development or rework flow re-triggers from scratch.
 */

var configLoader = require('./configLoader.js');
var prLookup = require('./common/prLookup.js');
const { resolveStatuses } = require('./config.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;


// ── gh-1229: small helpers extracted from action so it stays well under the
//    CRAP gate; behavior is byte-identical to the previous inline flow. ──

/** Custom params: jobParams wins (Teammate path), then the top-level bag. */
function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams;
}

/** Labels the SM may have armed the leg with — all stale once recovery re-routes. */
var RECOVERY_LABELS = ['sm_story_development_triggered', 'sm_bug_development_triggered', 'sm_story_rework_triggered'];

/** Best-effort status move with the shared outcome logs. */
function moveTicketReportingOutcome(ticketKey, status) {
    try {
        getTracker().moveToStatus(ticketKey, status);
        console.log('✅ Moved', ticketKey, 'to', status);
    } catch (e) {
        console.error('Failed to move to ' + status + ':', e);
    }
}

/** Stale-label removal is best-effort — a tracker hiccup must not stop recovery. */
function removeRecoveryLabelsQuietly(ticketKey) {
    RECOVERY_LABELS.forEach(function(label) {
        try { getTracker().removeLabel(ticketKey, label); } catch (e) {}
    });
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var config = configLoader.loadProjectConfig(params.jobParams || params || {});
    var customParams = customParamsOf(params);
    var statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);
    initTracker(config, customParams);

    if (!ticketKey) {
        console.error('No ticket key found');
        return { success: false, error: 'missing ticket key' };
    }

    console.log('Recovering stuck Story/Bug development:', ticketKey);

    var scm = configLoader.createScm(config);
    var pr = prLookup.findOpenPrForTicket(scm, ticketKey);

    if (!pr) {
        console.log('No open PR found for', ticketKey, '— moving back to', statuses.READY_FOR_DEVELOPMENT);
        moveTicketReportingOutcome(ticketKey, statuses.READY_FOR_DEVELOPMENT);
        removeRecoveryLabelsQuietly(ticketKey);
        getTracker().postComment(ticketKey, '🔄 *Recovery*: Ticket was stuck in "' + statuses.IN_DEVELOPMENT + '" with no open PR. Moved back to ' + statuses.READY_FOR_DEVELOPMENT + ' for re-automation.');
        return { success: true, action: 'moved_to_ready_for_development', ticketKey: ticketKey };
    }

    console.log('Found open PR #' + pr.number + ': ' + pr.title + ' — moving ticket to', statuses.IN_REVIEW);
    moveTicketReportingOutcome(ticketKey, statuses.IN_REVIEW);
    removeRecoveryLabelsQuietly(ticketKey);
    getTracker().postComment(ticketKey, '🔄 *Recovery*: Ticket was stuck in "' + statuses.IN_DEVELOPMENT + '" with open PR #' + pr.number + '. Moved to ' + statuses.IN_REVIEW + ' for code review.');

    return { success: true, action: 'moved_to_review', ticketKey: ticketKey, prNumber: pr.number };
}

module.exports = { action: action, customParamsOf: customParamsOf };
