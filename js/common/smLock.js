/**
 * SM idempotency-lock release, shared by the SM postJSAction check scripts
 * (gh-1250: the identical releaseLock block was copy-pasted into several
 * action scripts).
 *
 * Removes the SM idempotency label so the check re-runs on the next SM
 * cycle. A removal failure is swallowed (non-fatal, as in every original
 * copy): the label is only an idempotency optimization and a failed removal
 * merely delays the next check run.
 */

/**
 * Release the SM idempotency label so the check re-runs next cycle.
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        releaseLock: releaseLock
    };
}
