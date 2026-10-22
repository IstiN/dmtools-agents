/**
 * Check WIP Label Pre-Action
 * Checks if ticket has a work-in-progress label and stops processing if found
 * Returns false to stop processing, true to continue
 */

/**
 * Pre-action function to check for WIP label
 * 
 * @param {Object} params - Parameters from Teammate job
 * @param {Object} params.ticket - Jira ticket object
 * @param {Object} params.metadata - Job metadata containing contextId
 * @returns {boolean} false to stop processing, true to continue
 */

var configLoader = require('./configLoader.js');
var gh = require('./common/githubHelpers.js');

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

// ── gh-1077 extracted pure helpers (parse/build/decide) ─────────────────────

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

function wipLabelFor(contextId) {
    return contextId + '_wip';
}

function labelsOf(ticket) {
    return ticket.fields && ticket.fields.labels ? ticket.fields.labels : [];
}

function requireTicket(ticket) {
    if (!ticket || !ticket.key) {
        throw new Error('Ticket not found or not provided: ensure inputJql targets a valid, existing Jira ticket');
    }
}

function hasContextId(ticket, metadata) {
    return !(!ticket || !metadata || !metadata.contextId);
}

function wipSkipComment(wipLabel) {
    return 'h3. *Processing Skipped*\n\n' +
        'This ticket has the *' + wipLabel + '* label indicating work is in progress.\n' +
        'Processing will be skipped until the label is removed.\n\n' +
        '_Remove the label to allow automated processing._';
}

function noOpenPrSkipComment() {
    return 'h3. *Processing Skipped*\n\n' +
        'No open Pull Request found for this ticket. The review/rework agent cannot run without an existing PR.\n\n' +
        '_Ticket will be processed again once a PR is available._';
}

// The ticket-not-found guard is a job-configuration error (inputJql matched
// nothing), not a transient tool failure — only that error is rethrown by
// action(); every other error keeps the continue-processing contract.
function isTicketNotFoundError(error) {
    return !!(error && error.message && error.message.indexOf('Ticket not found') === 0);
}

function logStart(ticket, metadata) {
    console.log('=== Running checkWipLabel pre-action ===');
    console.log('Ticket key:', ticket && ticket.key ? ticket.key : '(missing)');
    console.log('Context ID:', metadata && metadata.contextId ? metadata.contextId : '(missing)');
}

// Post a skip comment best-effort; successLog is only printed when provided.
function postSkipComment(ticketKey, comment, successLog) {
    try {
        getTracker().postComment(ticketKey, comment);
        if (successLog) {
            console.log(successLog);
        }
    } catch (commentError) {
        console.warn('Failed to post skip comment:', commentError);
    }
}

// The WIP-label gate: true when the ticket carries the context WIP label and
// processing must stop (the skip notification has been posted best-effort).
function wipLabelGate(ticket, wipLabel) {
    const ticketKey = ticket.key;
    const labels = labelsOf(ticket);
    console.log('Expected WIP label:', wipLabel);
    console.log('Ticket labels:', labels.length > 0 ? labels.join(', ') : '(none)');

    if (labels.includes(wipLabel)) {
        console.log('⏸️  Ticket ' + ticketKey + ' has WIP label "' + wipLabel + '" - skipping processing');
        postSkipComment(ticketKey, wipSkipComment(wipLabel), 'Posted skip notification comment to ' + ticketKey);
        console.log('checkWipLabel result: stop processing');
        return true;
    }

    console.log('✅ Ticket ' + ticketKey + ' does not have WIP label "' + wipLabel + '" - continuing with processing');
    return false;
}

function loadConfigBestEffort(params) {
    try {
        return configLoader.loadProjectConfig(params);
    } catch (e) {
        return null;
    }
}

// Optional: verify an open PR exists for review/rework agents. Returns the
// gate's decision ({skip: boolean}) when it applied, null when the guard is
// disabled or failed non-fatally (fail-open).
function openPrGuardResult(params, ticketKey) {
    var customParams = resolveCustomParams(params);
    if (!customParams.checkOpenPR) {
        return null;
    }
    try {
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = configLoader.createScm(config);
        var prSearchOptions = config.prSearchFn ? { prSearchFn: config.prSearchFn } : {};
        var pr = gh.findPRForTicket(scm, ticketKey, prSearchOptions);
        if (!pr) {
            console.log('⏸️  No open PR found for ' + ticketKey + ' - skipping processing');
            postSkipComment(ticketKey, noOpenPrSkipComment());
            console.log('checkWipLabel result: stop processing (no open PR)');
            return { skip: true };
        }
        console.log('✅ Found open PR #' + pr.number + ' for ' + ticketKey + ' - continuing');
        return { skip: false };
    } catch (prError) {
        console.warn('Failed to check open PR (non-fatal):', prError);
        return null;
    }
}

function action(params) {
    try {
        const ticket = params.ticket;
        const metadata = params.metadata;

        logStart(ticket, metadata);

        requireTicket(ticket);
        if (!hasContextId(ticket, metadata)) {
            console.log('No contextId in metadata, continuing with processing');
            return true;
        }

        // Dynamically generate WIP label from contextId
        const wipLabel = wipLabelFor(metadata.contextId);
        initTracker(loadConfigBestEffort(params), resolveCustomParams(params));

        if (wipLabelGate(ticket, wipLabel)) {
            return false; // Stop processing
        }

        var guard = openPrGuardResult(params, ticket.key);
        if (guard) {
            return !guard.skip;
        }

        console.log('checkWipLabel result: continue processing');
        return true; // Continue processing

    } catch (error) {
        // The ticket-not-found guard is a job-configuration error (inputJql
        // matched nothing), not a transient tool failure — rethrow it so the
        // job aborts instead of silently processing without a ticket. Every
        // other error keeps the continue-processing contract below.
        if (isTicketNotFoundError(error)) {
            throw error;
        }
        console.error('❌ Error in WIP label check:', error);
        // On error, continue processing to avoid blocking legitimate workflows
        console.warn('Continuing with processing despite error in WIP check');
        console.log('checkWipLabel result: continue processing after error');
        return true;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        wipLabelFor: wipLabelFor,
        labelsOf: labelsOf,
        requireTicket: requireTicket,
        hasContextId: hasContextId,
        wipSkipComment: wipSkipComment,
        noOpenPrSkipComment: noOpenPrSkipComment,
        isTicketNotFoundError: isTicketNotFoundError,
        resolveCustomParams: resolveCustomParams
    };
}
