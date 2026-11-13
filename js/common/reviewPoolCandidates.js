/**
 * reviewPoolCandidates.js — the gh-1406/gh-1471 candidates record: the
 * strict schema every pool reviewer's findings ride. In the in-job shape
 * (gh-1471 rework) the record is a FILE —
 * outputs/pr_review_candidates-<reviewer>.json, written by the specialist
 * child session and validated here through candidatesRecordFromPayload
 * ({reviewer, head, candidates[], count, truncated, at}; head must match
 * the round head — stale files never feed a newer head).
 *
 * The dmtools marker grammar's MARKER_SUFFIX is re-exported for the sibling
 * marker modules (verdict/pool-outcome/pass families). CLAIM_MAX stays the
 * canonical claim-length cap (the merge/packet prose keeps findings
 * readable).
 */

'use strict';

// The transport caps (see header). A claim is one line of prose — 300 chars
// keep the finding readable in the packet far under the platform comment
// budget. MARKER_SUFFIX stays: the dmtools marker grammar (§7) is shared
// with the verdict/pool-outcome/pass families.
var MARKER_SUFFIX = ' -->';
var CLAIM_MAX = 300;

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}

// ── the candidates file (the model-written contract) ────────────────────────



// ── the candidates marker (the transport) ────────────────────────────────────


function candidatesRecordFromPayload(parsed) {
    if (!parsed || !isNonEmptyString(parsed.reviewer) || !isNonEmptyString(parsed.head)) return null;
    var list = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    return {
        reviewer: String(parsed.reviewer),
        head: String(parsed.head),
        candidates: list,
        count: typeof parsed.count === 'number' ? parsed.count : list.length,
        truncated: parsed.truncated === true,
        at: String(parsed.at || '')
    };
}



// ── the round collection (the aggregation point's input) ─────────────────────


if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_SUFFIX: MARKER_SUFFIX,
        CLAIM_MAX: CLAIM_MAX,
        candidatesRecordFromPayload: candidatesRecordFromPayload
    };
}
