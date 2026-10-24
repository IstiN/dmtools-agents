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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        releaseSmLock: releaseSmLock,
        waitingResult: waitingResult
    };
}
