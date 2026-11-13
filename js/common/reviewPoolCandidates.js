/**
 * reviewPoolCandidates.js — the gh-1471 candidates wiring: the specialist
 * legs' candidates-only output contract (the machine half of invariant 1)
 * and its transport.
 *
 * A specialist leg NEVER writes the verdict-shaped `outputs/pr_review.json`
 * (one census, one verdict — the posting leg mints the verdict). It writes
 *   outputs/pr_review_candidates.json
 *     { "reviewer": "security",
 *       "candidates": [{ "id", "path", "line", "severity", "claim" }] }
 * (the reviewPoolMerge docstring shape) and its post action stamps ONE
 * hidden machine marker carrying the same payload:
 *   <!-- dmtools:review-candidates {"reviewer","head","candidates",…} -->
 * The marker is the leg→aggregation transport: legs run as independent
 * dispatched runs (failure isolation) and share no workspace, so the round's
 * aggregation point reads the PR's marker comments — the same channel every
 * other machine record rides (verdicts, registries, ledgers).
 *
 * Trust: candidates markers parse ONLY from machine identities (the
 * machineAuthor allowlist via reviewVerdicts.parseMarkerComments, fail
 * closed) — an unconfigured allowlist trusts nothing. A forged candidates
 * marker can at worst inject a FINDING into the round (the filter pass
 * re-verifies every candidate before it posts); it can never approve,
 * merge, label or post a verdict.
 *
 * Bounds: the marker is a PR comment — the payload is capped (claims
 * truncated to CLAIM_MAX, at most CANDIDATE_LIMIT candidates, a `truncated`
 * flag set when the cap bit) so the transport can never overflow the
 * comment budget. Truncation is lossy by design and visible in the payload.
 *
 * Pure module — no dmtools globals. Requires hoisted (gh-823 pack-require
 * rule). GraalJS-clean (var + plain functions, JSON-safe data only).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');
var reviewPolicy = require('./reviewPolicy.js');

// The specialist legs' output file (a sibling artifact of pr_review.json).
var CANDIDATES_OUTPUT_FILE = 'pr_review_candidates.json';

// The marker family (the `dmtools:` head-carried shapes — §7 grammar,
// third member).
var CANDIDATES_MARKER_PREFIX = '<!-- dmtools:review-candidates ';
var MARKER_SUFFIX = ' -->';

// The transport caps (see header). A claim is one line of prose — 300 chars
// keep the finding readable in the packet and the marker far under the
// platform comment budget even at the candidate cap.
var CLAIM_MAX = 300;
var CANDIDATE_LIMIT = 100;

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}

// ── the candidates file (the model-written contract) ────────────────────────

/**
 * One normalized candidate from one raw file entry, or a note explaining the
 * drop. Severity must be a policy tier (normalized upper case); path and
 * claim must be non-empty strings; line is a number or null (digest
 * candidates — findings anchored outside the diff — ride with null).
 */
function candidateFromRaw(raw, fallbackId) {
    if (!raw || typeof raw !== 'object') {
        return { note: 'ignoring non-object candidate entry' };
    }
    var severity = String(raw.severity || '').trim().toUpperCase();
    if (reviewPolicy.TIERS.indexOf(severity) === -1) {
        return { note: 'dropping candidate ' + (raw.id === undefined ? '?' : raw.id) +
            ': unknown severity ' + JSON.stringify(raw.severity) };
    }
    if (!isNonEmptyString(raw.path)) {
        return { note: 'dropping candidate ' + (raw.id === undefined ? '?' : raw.id) + ': missing path' };
    }
    if (!isNonEmptyString(raw.claim)) {
        return { note: 'dropping candidate ' + raw.id + ': missing claim' };
    }
    var id = typeof raw.id === 'number' ? raw.id : parseInt(raw.id, 10);
    if (isNaN(id)) id = fallbackId;
    var claim = String(raw.claim).replace(/\s+/g, ' ').trim();
    if (claim.length > CLAIM_MAX) claim = claim.substring(0, CLAIM_MAX - 1) + '…';
    var line = (typeof raw.line === 'number' && isFinite(raw.line)) ? raw.line : null;
    return { candidate: { id: id, path: String(raw.path).trim(), line: line, severity: severity, claim: claim } };
}

/**
 * Parses the specialist leg's candidates file (raw text). FAIL-SOFT end to
 * end: a missing, empty or malformed file yields valid:false with notes and
 * the leg's post action degrades to a completion-without-candidates marker
 * (the round proceeds — availability is fail-open, §4). Returns
 * { reviewer, candidates, truncated, valid, notes }.
 */
function parseCandidatesFile(raw) {
    var notes = [];
    var out = { reviewer: '', candidates: [], truncated: false, valid: false, notes: notes };
    if (raw === null || raw === undefined || !String(raw).trim()) {
        notes.push('candidates file missing or empty: ' + CANDIDATES_OUTPUT_FILE);
        return out;
    }
    var parsed;
    try {
        parsed = JSON.parse(String(raw));
    } catch (eParse) {
        notes.push('candidates file is not valid JSON: ' + String(eParse.message || eParse));
        return out;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        notes.push('candidates file is not a JSON object');
        return out;
    }
    if (isNonEmptyString(parsed.reviewer)) out.reviewer = String(parsed.reviewer).trim();
    else notes.push('candidates file carries no reviewer name');
    var list = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    if (!Array.isArray(parsed.candidates)) notes.push('candidates carry no candidates array');
    for (var i = 0; i < list.length; i++) {
        if (out.candidates.length >= CANDIDATE_LIMIT) {
            out.truncated = true;
            notes.push('candidate cap ' + CANDIDATE_LIMIT + ' reached — the remainder is dropped (truncated flag set)');
            break;
        }
        var one = candidateFromRaw(list[i], out.candidates.length + 1);
        if (one.note) notes.push(one.note);
        else out.candidates.push(one.candidate);
    }
    out.valid = out.reviewer !== '' && out.candidates.length > 0 && !out.truncated;
    if (out.truncated) out.valid = false;
    return out;
}

// ── the candidates marker (the transport) ────────────────────────────────────

/**
 * The candidates marker comment (head-carried): the machine record that the
 * reviewer's candidates for this head EXIST. The human note below the marker
 * names the reviewer and the count — the PR's round bookkeeping reads it;
 * the machine parses the hidden payload.
 */
function buildCandidatesMarkerComment(reviewer, headSha, candidates, nowIso) {
    var normalized = parseCandidatesFile(JSON.stringify({ reviewer: reviewer, candidates: candidates }));
    var payload = {
        reviewer: String(reviewer || ''),
        head: String(headSha || ''),
        candidates: normalized.candidates,
        count: normalized.candidates.length,
        truncated: normalized.truncated === true,
        at: String(nowIso || '')
    };
    return CANDIDATES_MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        MARKER_SUFFIX + '\n\uD83E\uDD13 Reviewer pool: `' + String(reviewer || '') +
        '` filed ' + payload.count + ' candidate finding(s) on head ' +
        String(headSha || '').substring(0, 7) +
        (payload.truncated ? ' (capped at ' + CANDIDATE_LIMIT + ' — full list lives in the leg run)' : '') + '.';
}

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

/**
 * The trusted candidates markers of a PR, oldest-first. opts =
 * { authorLogins: [...] } — the machineAuthor allowlist; an unconfigured
 * allowlist trusts NOTHING (fail closed).
 */
function parseCandidatesMarkers(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments || [], opts || {},
        CANDIDATES_MARKER_PREFIX, MARKER_SUFFIX, candidatesRecordFromPayload, true);
}

/** The newest same-head candidates record of one reviewer, or null. */
function newestCandidatesForHead(records, reviewer, headSha) {
    var list = Array.isArray(records) ? records : [];
    var newest = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].reviewer === reviewer && reviewVerdicts.sameHead(list[i].head, headSha)) newest = list[i];
    }
    return newest;
}

// ── the round collection (the aggregation point's input) ─────────────────────

/**
 * The round's candidate lists for the expected reviewers (§4 fail-open):
 * one list per reviewer that filed same-head candidates, and the
 * `unavailable` names for the rest — the packet lines name them ("X
 * unavailable this round") and the round proceeds. Order follows the
 * expected list (deterministic packets). A reviewer that completed on a
 * DIFFERENT head is unavailable for this round (stale candidates never
 * feed a newer head).
 */
function collectRoundCandidates(records, expectedNames, headSha) {
    var arrived = [];
    var unavailable = [];
    var lists = [];
    var names = Array.isArray(expectedNames) ? expectedNames : [];
    for (var i = 0; i < names.length; i++) {
        var record = newestCandidatesForHead(records, names[i], headSha);
        if (record) {
            arrived.push(names[i]);
            lists.push({ reviewer: record.reviewer, candidates: record.candidates });
        } else {
            unavailable.push(names[i]);
        }
    }
    return { arrived: arrived, unavailable: unavailable, lists: lists };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CANDIDATES_OUTPUT_FILE: CANDIDATES_OUTPUT_FILE,
        CANDIDATES_MARKER_PREFIX: CANDIDATES_MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        CLAIM_MAX: CLAIM_MAX,
        CANDIDATE_LIMIT: CANDIDATE_LIMIT,
        parseCandidatesFile: parseCandidatesFile,
        buildCandidatesMarkerComment: buildCandidatesMarkerComment,
        parseCandidatesMarkers: parseCandidatesMarkers,
        newestCandidatesForHead: newestCandidatesForHead,
        collectRoundCandidates: collectRoundCandidates
    };
}
