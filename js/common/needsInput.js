/**
 * Shared inputs pre-flight (ask-mode) cluster — gh-1301 rework.
 *
 * The three development legs — story (developTicketAndCreatePR), bug
 * (developBugAndCreatePR) and bug-fix batch (developBugFixBatchAndCreatePR) —
 * share one bookkeeping cluster: the needs-input.md probe, the
 * ai_questions_asked label (add on the ask-mode exit, strip once a leg
 * proceeds past ask-mode), and the green needsInput outcome body. One module
 * means the ask-mode contract (label + green outcome, no PR, no reset) can
 * never drift between the legs.
 *
 * Pure functions with injected dependencies: each leg passes its own
 * outputFiles module, tracker and label name, so the legs keep their
 * production wiring and the tests keep their seams.
 *
 * IMPORTANT: runs inside the DMTools GraalJS bridge — no requires, JSON-safe
 * data only (see AGENTS.md).
 */

/**
 * True when the agent flagged missing ticket inputs (outputs/needs-input.md).
 * The probe failure reads as "not ask-mode" — a broken file read must never
 * turn an ask leg into an interrupted leg.
 */
function hasNeedsInputFile(outputFiles) {
    try {
        return !!outputFiles.hasOutputFile('needs-input.md');
    } catch (e) {
        return false;
    }
}

/** Best-effort ai_questions_asked label — the reviewer hand-off reads it. */
function markNeedsInputTicket(tracker, ticketKey, labelName) {
    try {
        tracker.addLabel(ticketKey, labelName);
    } catch (e) {
        console.warn('Could not add ' + labelName + ' label:', e);
    }
}

/**
 * Best-effort strip of a stale ai_questions_asked label — the inverse of
 * markNeedsInputTicket. A leg that proceeds past ask-mode (PR created /
 * status In Review) must not stay gated out of the reviewer hand-off by the
 * previous ask round-trip's label.
 */
function clearNeedsInputTicket(tracker, ticketKey, labelName) {
    try {
        tracker.removeLabel(ticketKey, labelName);
    } catch (e) {
        console.warn('Could not remove ' + labelName + ' label:', e);
    }
}

/**
 * The green outcome body shared by every ask-mode exit. When the leg's WIP
 * branch is known (pushed with the partial work before the ask-mode exit),
 * the message names it — the question comment is authored by the agent, so
 * this outcome is the only pointer to where the partial work lives.
 */
function needsInputOutcomeBody(ticketKey, branchName) {
    var message = 'Ticket ' + ticketKey + ' needs input from the reporter — question posted, no PR created';
    if (branchName) {
        message += ' (WIP preserved on ' + branchName + ')';
    }
    return {
        success: true,
        message: message,
        needsInput: true
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        hasNeedsInputFile: hasNeedsInputFile,
        markNeedsInputTicket: markNeedsInputTicket,
        clearNeedsInputTicket: clearNeedsInputTicket,
        needsInputOutcomeBody: needsInputOutcomeBody
    };
}
