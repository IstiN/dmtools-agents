/**
 * bugBookkeeping.js — the shared "load bug bookkeeping" helper (gh-1329
 * review, developBugAndCreatePR thread): both legs that consult the TC run
 * registry and the TC maintenance ledger from the bug ticket's marker
 * comments (postStoryTestAutomationResults.js and
 * developBugAndCreatePR.js) go through ONE loader instead of duplicated
 * comment-fetching IIFEs and machine-author plumbing.
 *
 *   - ONE getIssue call per load (the bug ticket is the marker storage);
 *   - ONE machine-author resolution (jobParams.machineAuthor →
 *     config.machineAuthor — the same order on both legs);
 *   - FAILS CLOSED: no configured machine identity trusts nothing, so both
 *     legs degrade to an empty registry/ledger (fresh bookkeeping);
 *   - a failing ticket read degrades to empty bookkeeping WITH a warning —
 *     a silently-empty bookkeeping would rebuild from scratch invisibly.
 *
 * Pure loader — no marker posting here; callers own every tracker write.
 * GraalJS-clean (var + plain functions, JSON-safe data); every require is
 * hoisted (gh-823).
 */
'use strict';

var tcRunRegistry = require('./tcRunRegistry.js');
var tcMaintenanceLedger = require('./tcMaintenanceLedger.js');
var machineAuthor = require('./machineAuthor.js');

/** The bug ticket's comments — the registry/ledger marker storage. */
function bugTrackedComments(tracker, storyKey) {
    try {
        var details = tracker.getIssue(storyKey);
        var fields = (details && details.fields) || {};
        // Jira/ADO/GitHub view shape: fields.comment.{comments}
        return (fields.comment && fields.comment.comments) || [];
    } catch (e) {
        console.warn('Could not read bug comments for TC bookkeeping (skipping):', e);
        return [];
    }
}

/** The machine-author trust gate for the registry/ledger markers. */
function machineAuthorOptsOf(params, config) {
    var source = (params && params.jobParams) || params || {};
    var logins = machineAuthor.machineAuthorLogins(
        machineAuthor.resolveMachineAuthor(source, config));
    return { authorLogins: logins };
}

/**
 * Loads the per-TC bookkeeping (validated guards, last-green fingerprints)
 * and the rolling maintenance ledger from the bug's marker comments.
 * Returns { comments, registry, ledger } — registry/ledger are the newest
 * trusted records, or the empty containers when none exist.
 */
function loadBugBookkeeping(tracker, storyKey, params, config) {
    var comments = bugTrackedComments(tracker, storyKey);
    var authorOpts = machineAuthorOptsOf(params, config);
    var registryRecord = tcRunRegistry.latestRegistry(comments, authorOpts);
    var ledgerRecord = tcMaintenanceLedger.latestLedger(comments, authorOpts);
    return {
        comments: comments,
        registry: registryRecord ? registryRecord.registry : tcRunRegistry.emptyRegistry(),
        ledger: ledgerRecord ? ledgerRecord.ledger : tcMaintenanceLedger.emptyLedger()
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        bugTrackedComments: bugTrackedComments,
        machineAuthorOptsOf: machineAuthorOptsOf,
        loadBugBookkeeping: loadBugBookkeeping
    };
}
