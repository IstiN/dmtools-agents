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

/**
 * The gh-1345 deployment guard message: TC triage is fail-closed against the
 * machine-author allowlist — with no configured identity every registry /
 * ledger marker trusts nothing, so validated guards, streaks and parked
 * differential requests all read fresh and NO earned-bounce/escalation path
 * can ever trigger. Returns the warning text (log once per run) or null when
 * the deployment resolves a non-empty allowlist.
 */
function triageAllowlistWarning(params, config) {
    var logins = machineAuthor.machineAuthorLogins(
        machineAuthor.resolveMachineAuthor((params && params.jobParams) || params, config));
    if (logins.length > 0) return null;
    return 'gh-1345 deployment guard: TC triage is active but no machineAuthor allowlist is configured — ' +
        'the TC run registry and maintenance ledger parse fail-closed, so every bug reads fresh bookkeeping ' +
        'and no earned bounce / escalation / differential dispatch can trigger. ' +
        'Set params.jobParams.machineAuthor (factory setup) or config.machineAuthor (.dmtools/config.js) ' +
        'before enabling TC triage.';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        bugTrackedComments: bugTrackedComments,
        machineAuthorOptsOf: machineAuthorOptsOf,
        loadBugBookkeeping: loadBugBookkeeping,
        triageAllowlistWarning: triageAllowlistWarning
    };
}
