/**
 * Shared raw tracker-field read (gh-1250 dedup).
 *
 * The getIssue → fields-wrapper → rawValue unwrap appeared identically in
 * writeSolutionAndLabels.js (currentFieldValue) and writeSolutionAndDiagrams.js
 * (readExistingSolutionValue). Both callers keep their own ADF guard and
 * trimming/fallback semantics — this module owns only the raw read so the two
 * cannot drift apart.
 *
 * GraalJS-compatible: var declarations, plain functions, no arrow functions.
 */

/** Raw (untrimmed, unguarded) value of fieldName on ticketKey, or null. */
function readRawFieldValue(tracker, ticketKey, fieldName) {
    var freshTicket = tracker.getIssue(ticketKey, [fieldName]);
    var freshFields = (freshTicket && freshTicket.fields) ? freshTicket.fields : freshTicket;
    return freshFields ? freshFields[fieldName] : null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        readRawFieldValue: readRawFieldValue
    };
}
