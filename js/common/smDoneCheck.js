/**
 * Shared helpers for the SM-cycle "done check" postJSActions
 * (checkSubtasksDoneForBA, checkTaskStoriesDone) — gh-1250.
 *
 * Both actions run on every SM cycle and, while the items they check are not
 * all Done, remove the SM idempotency label so the SM re-triggers the check
 * on the next cycle and return the same "waiting" result shape. Extracted so
 * the lock-release block lives in one place; callers parameterize the log
 * wording and the totals.
 */

function releaseSmLock(tracker, ticketKey, removeLabel) {
    if (!ticketKey || !removeLabel) return;
    try {
        tracker.removeLabel(ticketKey, removeLabel);
        console.log('Released SM label — will re-check next cycle');
    } catch (e) {
        console.warn('Failed to remove SM label:', e);
    }
}

/**
 * Log the caller's "not done yet" message, release the SM idempotency label
 * and return the shared "waiting" result both done-check actions report.
 */
function waitingResult(tracker, ticketKey, removeLabel, logMessage, total, notDone) {
    console.log(logMessage);
    releaseSmLock(tracker, ticketKey, removeLabel);
    return { success: true, action: 'waiting', total: total, notDone: notDone, ticketKey: ticketKey };
}

/**
 * Resolve the action context both done-check actions share: ticketKey,
 * removeLabel, the project config and the tracker built from it.
 */
function resolveActionContext(params, configLoader, trackersModule) {
    var customParams = params.jobParams && params.jobParams.customParams;
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    return {
        ticketKey: params.ticket && params.ticket.key,
        removeLabel: customParams && customParams.removeLabel,
        projectConfig: projectConfig,
        tracker: trackersModule.createTracker(projectConfig, customParams || {})
    };
}

/**
 * Shared action() skeleton for the SM done-check postJSActions: resolves the
 * action context, runs the caller's check and, on failure, releases the SM
 * lock and returns the standard failure shape. The caller's checkFn receives
 * (tracker, projectConfig, ticketKey, removeLabel, initiator).
 */
function runDoneCheckAction(params, checkFn, scriptName, configLoader, trackersModule) {
    var ctx = resolveActionContext(params, configLoader, trackersModule);
    try {
        if (!ctx.ticketKey) throw new Error('params.ticket.key is missing');
        return checkFn(ctx.tracker, ctx.projectConfig, ctx.ticketKey, ctx.removeLabel, params.initiator);
    } catch (error) {
        console.error('❌ Error in ' + scriptName + ':', error);
        releaseSmLock(ctx.tracker, ctx.ticketKey, ctx.removeLabel);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        releaseSmLock: releaseSmLock,
        waitingResult: waitingResult,
        resolveActionContext: resolveActionContext,
        runDoneCheckAction: runDoneCheckAction
    };
}
