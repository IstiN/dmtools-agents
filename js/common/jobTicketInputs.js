/**
 * jobTicketInputs.js — the shared SM-job ticket inputs (gh-1345 rework).
 *
 * js/quotaParkProbe.js and js/tcDifferentialDispatcher.js both open action()
 * with the same block: resolve the ticket reference / jobParams shape into
 * { ticketKey, jobParams, customParams }, then fail structured when the
 * params carry no ticket key. This module is that block, extracted once so
 * the action files stay free of cross-file clones (gh-1250's
 * actionTicketContext pattern) — the quality.yml duplication ratchet fails
 * on any NEW file over 1% duplicated lines, and the dispatcher's verbatim
 * copy of the quotaParkProbe shapes put both files over the bar.
 *
 * IMPORTANT: this module runs inside the DMTools GraalJS bridge — keep data
 * structures JSON-safe; no requires needed (pure functions over params).
 */

'use strict';

/**
 * The ticket reference + jobParams/customParams resolution from the head of
 * an SM job's action() — kept tiny so action() itself stays inside the CRAP
 * ratchet. The triggering params arrive in three shapes:
 *   - teammate: params.ticket.key + params.jobParams (jobParams wins for
 *     customParams — the Teammate path patches them there);
 *   - bare: params.ticket.key + top-level params.customParams;
 *   - jobParams-only: params.jobParams carries everything.
 */
function resolveInputs(params) {
    var actualParams = params.ticket ? params : (params.jobParams || params);
    var jobParams = params.jobParams || {};
    return {
        ticketKey: actualParams.ticket && actualParams.ticket.key,
        jobParams: jobParams,
        customParams: jobParams.customParams || actualParams.customParams || {}
    };
}

/**
 * The shared missing-ticket-key guard: null when the resolved inputs carry a
 * key (the caller proceeds), otherwise the structured failure every local
 * job returns — logged once here so the callers stay clone-free.
 */
function missingTicketKeyResult(inputs) {
    if (inputs.ticketKey) return null;
    console.error('No ticket key found');
    return { success: false, error: 'missing ticket key' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        resolveInputs: resolveInputs,
        missingTicketKeyResult: missingTicketKeyResult
    };
}
