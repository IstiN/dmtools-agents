/**
 * terminalDelivery.js — the gh-1493 terminal-signal delivery contract shared
 * by the bug leg's terminal paths (developBugAndCreatePR.js
 * completeBlockedPath / completeAlreadyFixedPath).
 *
 * A terminal path's signal IS its tracker writes: the comment plus the
 * status transition are what stop the SM from re-arming the ticket. A
 * silently failed write left the leg green and the SM re-armed the same
 * finished work forever (fah#2182: 40 dev legs / 12h on an already-fixed
 * issue whose first leg had gone green at minute 41). attemptDelivery
 * records every failed write; the caller turns the collection into a
 * failing outcome via deliveryOutcome so an undelivered signal fails the
 * leg and the existing failure semantics (unassign → kicker skip →
 * human-visible) apply. Label cleanup stays non-fatal — labels are not the
 * signal.
 *
 * Pure helpers — no tracker access here; callers own every tracker call.
 * GraalJS-clean (var + plain functions, JSON-safe data); no requires.
 */
'use strict';

/**
 * One terminal-signal delivery step: runs the tracker write, logs the
 * success line when one is given, or records the failure in deliveryErrors
 * (pinned prefix shape '<op>(<arg>) failed: <error>') with a loud
 * console.error. Never throws — delivery failures are reported through the
 * outcome, not through the control flow.
 */
function attemptDelivery(deliveryErrors, errorPrefix, notDeliveredMessage, successMessage, step) {
    try {
        step();
        if (successMessage) console.log(successMessage);
    } catch (e) {
        deliveryErrors.push(errorPrefix + ': ' + e);
        console.error(notDeliveredMessage, e);
    }
}

/**
 * The terminal outcome for a delivery-error collection: any recorded error
 * makes the leg fail ({success:false, delivered:false, error}) so the
 * breakage is visible; a clean collection delivers
 * ({success:true, delivered:true}).
 */
function deliveryOutcome(path, ticketKey, deliveryErrors) {
    if (deliveryErrors.length) {
        console.error('❌ Terminal signal undelivered for', ticketKey, '— failing the leg so the breakage is visible');
        return { success: false, path: path, ticketKey: ticketKey, delivered: false, error: deliveryErrors.join('; ') };
    }
    return { success: true, path: path, ticketKey: ticketKey, delivered: true };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        attemptDelivery: attemptDelivery,
        deliveryOutcome: deliveryOutcome
    };
}
