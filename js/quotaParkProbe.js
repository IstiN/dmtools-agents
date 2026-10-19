/**
 * quotaParkProbe.js — gh-1087 AC3: bounded self-lift for the provider-quota park.
 *
 * Local-execution SM job (skipAIProcessing — pure JS, no AI CLI). Every SM
 * tick the rule's JQL returns tickets carrying the park label (default
 * `provider_quota`). This handler:
 *
 *   1. Reads the ticket's `quota-probe: <n>` marker comments to find how many
 *      probes were already attempted.
 *   2. Probes only when the count is a multiple of jobParams
 *      .quotaProbeEveryNTicks (default 3) — one CHEAP provider ping per N
 *      ticks, never a full leg.
 *   3. Probe success (exit 0) → the quota window has reset or the provider
 *      was reconfigured: remove the park label, remove the dev/rework
 *      trigger labels so the dispatch lane re-fires, move the ticket back to
 *      Ready For Development and post an un-park comment.
 *   4. Probe failure → keep the park, post a one-line marker comment (the
 *      durable counter for the next tick's cadence decision).
 *
 * A human removing the park label un-parks immediately — the JQL stops
 * matching and the normal dispatch lanes resume on their own.
 */

var configLoader = require('./configLoader.js');
const { resolveStatuses } = require('./config.js');
var quotaBreaker = require('./common/quotaCircuitBreaker.js');
var commentMarkup = require('./common/commentMarkup.js');

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

// The same SM trigger labels recoverStuckDevelopment clears — after the park
// lifts, the dev/rework lanes must be able to re-fire.
var DISPATCH_TRIGGER_LABELS = ['sm_story_development_triggered', 'sm_bug_development_triggered', 'sm_story_rework_triggered'];

function action(params) {
    var actualParams = params.ticket ? params : (params.jobParams || params);
    var ticketKey = actualParams.ticket && actualParams.ticket.key;
    var jobParams = params.jobParams || {};
    var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams || {};
    var config = configLoader.loadProjectConfig(jobParams || params);
    var statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);
    initTracker(config, customParams);

    if (!ticketKey) {
        console.error('No ticket key found');
        return { success: false, error: 'missing ticket key' };
    }

    var parkLabel = quotaBreaker.parkLabelOf(jobParams);
    var everyN = quotaBreaker.probeEveryOf(jobParams);
    console.log('Quota park probe for', ticketKey, '— label', parkLabel + ', cadence every', everyN, 'tick(s)');

    var bodies = [];
    try {
        bodies = getTracker().getComments(ticketKey) || [];
    } catch (e) {
        console.warn('Could not read ticket comments — treating as zero prior probes:', e);
    }
    var priorCount = quotaBreaker.countProbeMarkers(bodies);
    if (!quotaBreaker.probeDue(priorCount, everyN)) {
        console.log('Probe not due (' + priorCount + ' prior probe(s), cadence ' + everyN + ') — park stays.');
        return { success: true, action: 'probe_not_due', ticketKey: ticketKey, priorProbes: priorCount };
    }

    var probeCount = priorCount + 1;
    var command = quotaBreaker.probeCommandOf(jobParams);
    console.log('Running probe #' + probeCount + ':', command);
    var ok = false;
    var detail = null;
    try {
        cli_execute_command({ command: command });
        ok = true;
    } catch (e) {
        detail = String((e && e.message) || e).replace(/\s+/g, ' ').trim().substring(0, 200);
    }

    var m = commentMarkup.forTicket(ticketKey);
    if (!ok) {
        console.log('Probe #' + probeCount + ' still blocked' + (detail ? ' (' + detail + ')' : '') + ' — park stays.');
        try {
            getTracker().postComment(ticketKey,
                quotaBreaker.probeFailureComment(m, parkLabel, probeCount, everyN, detail) +
                '\n' + quotaBreaker.probeMarkerLine(probeCount));
        } catch (e) {
            console.warn('Failed to post probe marker comment:', e);
        }
        return { success: true, action: 'probe_failed', ticketKey: ticketKey, probes: probeCount, detail: detail };
    }

    // Probe succeeded — the quota window has reset. Lift the park.
    console.log('✅ Probe #' + probeCount + ' succeeded — lifting the', parkLabel, 'park.');
    try {
        getTracker().removeLabel(ticketKey, parkLabel);
        console.log('✅ Removed park label', parkLabel);
    } catch (e) {
        console.warn('Failed to remove park label ' + parkLabel + ':', e);
    }
    DISPATCH_TRIGGER_LABELS.forEach(function (label) {
        try { getTracker().removeLabel(ticketKey, label); } catch (e) { }
    });
    try {
        getTracker().moveToStatus(ticketKey, statuses.READY_FOR_DEVELOPMENT);
        console.log('✅ Moved', ticketKey, 'to', statuses.READY_FOR_DEVELOPMENT, '— development retries resume on the next SM tick.');
    } catch (e) {
        console.warn('Failed to move ticket to ' + statuses.READY_FOR_DEVELOPMENT + ':', e);
    }
    try {
        getTracker().postComment(ticketKey, quotaBreaker.unparkComment(m, parkLabel, probeCount));
    } catch (e) {
        console.warn('Failed to post un-park comment:', e);
    }
    return { success: true, action: 'unparked', ticketKey: ticketKey, probes: probeCount };
}

module.exports = { action: action, DISPATCH_TRIGGER_LABELS: DISPATCH_TRIGGER_LABELS };
