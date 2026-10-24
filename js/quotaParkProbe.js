/**
 * quotaParkProbe.js — gh-1087 AC3: bounded self-lift for the provider-quota park.
 *
 * Local-execution SM job (skipAIProcessing — pure JS, no AI CLI). Every SM
 * tick the rule's JQL returns tickets carrying the park label (default
 * `provider_quota`). This handler:
 *
 *   1. Reads the ticket's `quota-park-tick: <n>` marker comments — the
 *      durable TICK clock. Every tick records exactly one tick marker, so the
 *      completed-tick count advances even between probes (an attempts-only
 *      counter deadlocks after the first failed probe — gh-1087 review
 *      thread 1).
 *   2. Records this tick's marker, then probes only when the completed tick
 *      count is a multiple of jobParams.quotaProbeEveryNTicks (default 3) —
 *      one CHEAP provider ping per N ticks, never a full leg.
 *   3. Probe success (exit 0) → the quota window has reset or the provider
 *      was reconfigured: remove the park label, remove the dev/rework
 *      trigger labels so the dispatch lane re-fires, move the ticket back to
 *      Ready For Development and post an un-park comment.
 *   4. Probe failure → keep the park, post a `quota-probe: <n>` marker (the
 *      durable probe counter, used for probe numbering only).
 *
 * The probe command is logged REDACTED (jobParams.quotaProbeCommand is a
 * free-form shell string — an inline operator credential must never land in
 * the SM job logs or CI artifacts; gh-1087 review thread 2).
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
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;

// The same SM trigger labels recoverStuckDevelopment clears — after the park
// lifts, the dev/rework lanes must be able to re-fire.
var DISPATCH_TRIGGER_LABELS = ['sm_story_development_triggered', 'sm_bug_development_triggered', 'sm_story_rework_triggered'];

// The ticket reference + jobParams/customParams resolution from the head of
// action() — kept tiny so action() itself stays inside the CRAP ratchet.
function resolveInputs(params) {
    var actualParams = params.ticket ? params : (params.jobParams || params);
    var jobParams = params.jobParams || {};
    return {
        ticketKey: actualParams.ticket && actualParams.ticket.key,
        jobParams: jobParams,
        customParams: jobParams.customParams || actualParams.customParams || {}
    };
}

function readCommentBodies(ticketKey) {
    try {
        return getTracker().getComments(ticketKey) || [];
    } catch (e) {
        console.warn('Could not read ticket comments — treating as zero prior ticks:', e);
        return [];
    }
}

// One durable tick marker per SM tick — this is what keeps the cadence clock
// moving between probes (gh-1087 review thread 1).
function recordTickMarker(ticketKey, tick) {
    try {
        getTracker().postComment(ticketKey, quotaBreaker.tickMarkerLine(tick));
    } catch (e) {
        console.warn('Failed to post quota-park tick marker:', e);
    }
}

function runProbeCommand(command) {
    try {
        cli_execute_command({ command: command });
        return { ok: true, detail: null };
    } catch (e) {
        return { ok: false, detail: String((e && e.message) || e).replace(/\s+/g, ' ').trim().substring(0, 200) };
    }
}

function handleProbeFailure(ticketKey, parkLabel, probeCount, everyN, detail, tick) {
    console.log('Probe #' + probeCount + ' still blocked' + (detail ? ' (' + detail + ')' : '') + ' — park stays.');
    try {
        getTracker().postComment(ticketKey,
            quotaBreaker.probeFailureComment(commentMarkup.forTicket(ticketKey), parkLabel, probeCount, everyN, detail) +
            '\n' + quotaBreaker.probeMarkerLine(probeCount));
    } catch (e) {
        console.warn('Failed to post probe marker comment:', e);
    }
    return { success: true, action: 'probe_failed', ticketKey: ticketKey, probes: probeCount, detail: detail, tick: tick };
}

function removeLabelQuietly(ticketKey, label, what) {
    try {
        getTracker().removeLabel(ticketKey, label);
        console.log('✅ Removed', what, label);
    } catch (e) {
        console.warn('Failed to remove ' + what + ' ' + label + ':', e);
    }
}

function moveToReadyQuietly(ticketKey, statuses) {
    try {
        getTracker().moveToStatus(ticketKey, statuses.READY_FOR_DEVELOPMENT);
        console.log('✅ Moved', ticketKey, 'to', statuses.READY_FOR_DEVELOPMENT, '— development retries resume on the next SM tick.');
    } catch (e) {
        console.warn('Failed to move ticket to ' + statuses.READY_FOR_DEVELOPMENT + ':', e);
    }
}

// Probe succeeded — the quota window has reset. Lift the park.
function liftPark(ticketKey, parkLabel, probeCount, statuses) {
    console.log('✅ Probe #' + probeCount + ' succeeded — lifting the', parkLabel, 'park.');
    var m = commentMarkup.forTicket(ticketKey);
    removeLabelQuietly(ticketKey, parkLabel, 'park label');
    DISPATCH_TRIGGER_LABELS.forEach(function (label) {
        removeLabelQuietly(ticketKey, label, 'trigger label');
    });
    moveToReadyQuietly(ticketKey, statuses);
    try {
        getTracker().postComment(ticketKey, quotaBreaker.unparkComment(m, parkLabel, probeCount));
    } catch (e) {
        console.warn('Failed to post un-park comment:', e);
    }
    return { success: true, action: 'unparked', ticketKey: ticketKey, probes: probeCount };
}

function action(params) {
    var inputs = resolveInputs(params);
    var ticketKey = inputs.ticketKey;
    if (!ticketKey) {
        console.error('No ticket key found');
        return { success: false, error: 'missing ticket key' };
    }
    var jobParams = inputs.jobParams;
    var config = configLoader.loadProjectConfig(jobParams || params);
    var statuses = resolveStatuses(inputs.customParams, config.jira && config.jira.statuses);
    initTracker(config, inputs.customParams);

    var parkLabel = quotaBreaker.parkLabelOf(jobParams);
    var everyN = quotaBreaker.probeEveryOf(jobParams);
    console.log('Quota park probe for', ticketKey, '— label', parkLabel + ', cadence every', everyN, 'tick(s)');

    var bodies = readCommentBodies(ticketKey);
    var priorTicks = quotaBreaker.countTickMarkers(bodies);
    var tick = priorTicks + 1;
    recordTickMarker(ticketKey, tick);
    if (!quotaBreaker.probeDue(priorTicks, everyN)) {
        console.log('Probe not due (completed park ticks: ' + priorTicks + ', cadence ' + everyN + ') — park stays.');
        return { success: true, action: 'probe_not_due', ticketKey: ticketKey, tick: tick };
    }

    var probeCount = quotaBreaker.countProbeMarkers(bodies) + 1;
    var command = quotaBreaker.probeCommandOf(jobParams);
    console.log('Running probe #' + probeCount + ':', quotaBreaker.redactCommand(command));
    var outcome = runProbeCommand(command);
    if (!outcome.ok) {
        return handleProbeFailure(ticketKey, parkLabel, probeCount, everyN, outcome.detail, tick);
    }
    return liftPark(ticketKey, parkLabel, probeCount, statuses);
}

module.exports = { action: action, DISPATCH_TRIGGER_LABELS: DISPATCH_TRIGGER_LABELS };
