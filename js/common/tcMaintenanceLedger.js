/**
 * tcMaintenanceLedger.js — the gh-1329 rolling TC-maintenance ledger (§5).
 *
 * "Nothing discarded": every test-side finding (stale guard, environment-
 * shifted TC, flaky, unfixable-in-rework, and the dev leg's structured
 * `test_suspected` claim) is appended — script, failed_description, error
 * class, SHA/fingerprint evidence — so automation findings are re-owned
 * instead of stranding bugs, and test debt is fixed in batched sweep PRs.
 *
 *   Identity    id = hash(tcKey + errorClass + script path). The same TC
 *               failing the same way refreshes its finding (occurrences++,
 *               latest evidence) instead of duplicating; a re-occurrence of
 *               a resolved finding REOPENS it (the sweep did not stick).
 *
 *   Lifecycle   open -> resolved (a sweep PR fixes the batch; resolvedVia
 *               names it) -> open again on re-occurrence. Append-only
 *               evidence is never rewritten; dispositions only flip status.
 *
 *   Storage     one machine-parseable marker comment per update on the bug
 *               ticket — the house `dmtools:` marker pattern (same family as
 *               the gh-1332 finding registry). The newest machine-authored
 *               marker wins; markers from any other identity are invisible.
 *               No configured machine identity → trust nothing.
 *
 *   Owner face  buildDigestComment renders the async digest (one section per
 *               open finding, explicit "no action required now" — humans
 *               meet a digest, never a blocking ask).
 *
 * Pure module — no dmtools globals; callers fetch comments and post the
 * built marker. GraalJS-clean (var + plain functions, JSON-safe data).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');

// The registry marker — one line, JSON payload, invisible in the rendered
// ticket (same protocol family as the gh-807 verdict / gh-1332 registry markers).
var MARKER_PREFIX = '<!-- dmtools:tc-maintenance-ledger ';
var MARKER_SUFFIX = ' -->';
var LEDGER_VERSION = 1;

var STATUS_OPEN = 'open';
var STATUS_RESOLVED = 'resolved';

var SOURCE_AUTOMATION = 'automation';
var SOURCE_DEV = 'dev';

// Marker-hygiene cap for free-text fields (agent-authored evidence can be
// arbitrarily large; the ledger carries pointers, not essays).
var MAX_NOTE_LENGTH = 500;

// ── identity ─────────────────────────────────────────────────────────────────

// FNV-1a (32-bit, Math.imul keeps the multiply exact) — same scheme as the
// gh-1332 finding registry; two bases concatenated → a 16-hex id.
function fnv1a(text, basis) {
    var h = basis >>> 0;
    for (var i = 0; i < text.length; i++) {
        h = h ^ text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

function hex8(n) {
    var s = (n >>> 0).toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
}

/**
 * The finding identity: hash(tcKey + errorClass + script path). NOT the SHA
 * (a re-run on a new build is the same finding) and NOT the verdict alone
 * (too coarse — one TC can flake AND misencode).
 */
function findingIdentity(tcKey, errorClass, testPath) {
    var key = String(tcKey || '') + '\n' + String(errorClass || 'unknown') + '\n' + String(testPath || '');
    return hex8(fnv1a(key, 0x811c9dc5)) + hex8(fnv1a(key, 0x811c9dc5 ^ 0x9e3779b9));
}

// ── shape ────────────────────────────────────────────────────────────────────

function emptyLedger() {
    return { v: LEDGER_VERSION, at: new Date().toISOString(), findings: [] };
}

function deepCopyLedger(l) {
    return JSON.parse(JSON.stringify(l || emptyLedger()));
}

function truncate(text) {
    var s = String(text || '');
    return s.length > MAX_NOTE_LENGTH ? s.substring(0, MAX_NOTE_LENGTH) : s;
}

function firstDefined(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
        if (obj[keys[i]] !== undefined && obj[keys[i]] !== null && obj[keys[i]] !== '') return obj[keys[i]];
    }
    return null;
}

// Free-form finding fields copied from the source payload. `sources` lists
// the accepted spellings in priority order; `truncate` fields are
// marker-hygiene capped; `fallback` applies when every source is absent.
var FINDING_FIELD_TABLE = [
    { key: 'failedDescriptionFile', sources: ['failedDescriptionFile'] },
    { key: 'failureSummary', sources: ['failureSummary', 'summary'], truncate: true, fallback: '' },
    // An automation finding carries only an EXPLICIT note (gh-1329 review:
    // reason and note stay distinct — no truncated reason copy in every
    // marker); the dev claim builds its own additive note.
    { key: 'note', sources: ['note'], truncate: true },
    { key: 'claimedVerdict', sources: ['claimedVerdict'] },
    { key: 'evidence', sources: ['evidence'] },
    { key: 'sha', sources: ['sha', 'buildSha'] },
    { key: 'envFingerprint', sources: ['envFingerprint'] },
    { key: 'lastGreenSha', sources: ['lastGreenSha'] },
    { key: 'lastGreenEnvFingerprint', sources: ['lastGreenEnvFingerprint'] }
];

function findingField(src, spec) {
    var value = firstDefined(src, spec.sources);
    if (value === null) return spec.fallback !== undefined ? spec.fallback : null;
    return spec.truncate ? truncate(value) : value;
}

/** The identity-bearing core fields (they feed the finding id hash). */
function findingCoreFields(src) {
    return {
        tcKey: String(firstDefined(src, ['tcKey', 'testCaseKey']) || ''),
        errorClass: String(firstDefined(src, ['errorClass', 'error_class']) || 'unknown'),
        testPath: String(firstDefined(src, ['testPath', 'script']) || '')
    };
}

/**
 * Normalizes any finding input into the canonical ledger shape. Unknown
 * errorClass stays visible as 'unknown' — a finding is never silently
 * dropped for missing metadata.
 */
function normalizeFinding(input, at) {
    var src = input || {};
    var core = findingCoreFields(src);
    var finding = {
        id: findingIdentity(core.tcKey, core.errorClass, core.testPath),
        tcKey: core.tcKey,
        role: src.role || null,
        verdict: src.verdict || 'maintenance',
        reason: src.reason || null,
        errorClass: core.errorClass,
        testPath: core.testPath,
        source: src.source || SOURCE_AUTOMATION,
        status: STATUS_OPEN,
        firstSeenAt: at,
        lastSeenAt: at,
        occurrences: 1,
        resolvedAt: null,
        resolvedVia: null
    };
    FINDING_FIELD_TABLE.forEach(function(spec) {
        finding[spec.key] = findingField(src, spec);
    });
    return finding;
}

function findById(l, id) {
    for (var i = 0; i < l.findings.length; i++) {
        if (l.findings[i].id === id) return l.findings[i];
    }
    return null;
}

function refreshFinding(existing, incoming, at) {
    existing.lastSeenAt = at;
    existing.occurrences = (existing.occurrences || 1) + 1;
    // Latest evidence wins — the ledger documents the most recent lap.
    ['verdict', 'reason', 'sha', 'envFingerprint', 'lastGreenSha', 'lastGreenEnvFingerprint',
     'failedDescriptionFile', 'failureSummary', 'note', 'claimedVerdict', 'evidence'].forEach(function(k) {
        if (incoming[k] !== null && incoming[k] !== undefined) existing[k] = incoming[k];
    });
    if (existing.status === STATUS_RESOLVED) {
        // A resolved finding that broke again: the sweep did not stick — reopen.
        existing.status = STATUS_OPEN;
        existing.resolvedAt = null;
        existing.resolvedVia = null;
    }
    return existing;
}

/**
 * Appends a finding into a deep-copied ledger: identity match refreshes,
 * otherwise a new entry is pushed. Returns the new ledger (never mutates
 * the input).
 */
function appendFinding(prev, input) {
    var at = (input && input.at) || new Date().toISOString();
    var l = deepCopyLedger(prev);
    l.at = at;
    var incoming = normalizeFinding(input, at);
    var existing = findById(l, incoming.id);
    if (existing) {
        refreshFinding(existing, incoming, at);
    } else {
        l.findings.push(incoming);
    }
    return l;
}

/**
 * Marks the listed identities resolved (the sweep leg's disposition).
 * Unknown ids are ignored — the ledger is append-only evidence.
 */
function resolveFindings(prev, ids, via) {
    var at = new Date().toISOString();
    var l = deepCopyLedger(prev);
    l.at = at;
    (ids || []).forEach(function(id) {
        var f = findById(l, id);
        if (!f) return;
        f.status = STATUS_RESOLVED;
        f.resolvedAt = at;
        f.resolvedVia = via || null;
    });
    return l;
}

function openFindings(l) {
    if (!l || !Array.isArray(l.findings)) return [];
    return l.findings.filter(function(f) { return f.status === STATUS_OPEN; });
}

// ── finding builders (the two machine sources) ───────────────────────────────

var VERDICT_FALLBACK_TABLE = [
    { key: 'tcKey', entryKey: 'tcKey', verdictKey: 'tcKey' },
    { key: 'role', entryKey: 'role', verdictKey: 'role' },
    { key: 'verdict', entryKey: 'verdict', verdictKey: 'action' },
    { key: 'reason', entryKey: 'reason', verdictKey: 'reason' }
];

var VERDICT_EVIDENCE_FIELDS = ['errorClass', 'testPath', 'failedDescriptionFile', 'failureSummary',
    'sha', 'envFingerprint', 'lastGreenSha', 'lastGreenEnvFingerprint'];

function firstNonEmptyValue(a, b) {
    return (a !== undefined && a !== null && a !== '') ? a : b;
}

function verdictLedgerEntry(v) {
    return (v && v.ledgerEntry) || {};
}

function verdictEvidence(v, entry) {
    return entry.evidence || (v && v.evidence) || {};
}

/**
 * A triage verdict (tcTriage.js) becomes an automation-sourced finding.
 * Every verdict except ACTION_NONE carries a ledgerEntry payload — this
 * builder consumes it.
 */
function findingFromVerdict(v, opts) {
    var at = (opts && opts.at) || new Date().toISOString();
    var entry = verdictLedgerEntry(v);
    var evidence = verdictEvidence(v, entry);
    var verdictLike = v || {};
    var src = { source: SOURCE_AUTOMATION, at: at };
    VERDICT_FALLBACK_TABLE.forEach(function(spec) {
        src[spec.key] = firstNonEmptyValue(entry[spec.entryKey], verdictLike[spec.verdictKey]);
    });
    VERDICT_EVIDENCE_FIELDS.forEach(function(k) {
        src[k] = evidence[k];
    });
    return normalizeFinding(src, at);
}

/** The dev claim's additive note: reason + evidence pointer (never a bare reason copy). */
function devClaimNote(src) {
    var noteParts = [];
    if (src.reason) noteParts.push(String(src.reason));
    if (src.evidence) noteParts.push('evidence: ' + String(src.evidence));
    return noteParts.join(' — ');
}

function devClaimCoreFields(src) {
    return {
        tcKey: firstDefined(src, ['tcKey', 'testCaseKey']) || '',
        claimedVerdict: firstDefined(src, ['claimedVerdict', 'verdict']) || null,
        errorClass: firstDefined(src, ['errorClass']) || 'unknown',
        testPath: firstDefined(src, ['testPath', 'script']) || '',
        sha: firstDefined(src, ['sha', 'buildSha']) || null
    };
}

/**
 * The dev leg's structured exit (§6): outputs/test_suspected.json — the
 * claimed test-side verdict + evidence + TC key — machine-routed into the
 * ledger. Free text is truncated (marker hygiene) and the source is 'dev'.
 */
function findingFromDevClaim(claim, opts) {
    var src = claim || {};
    var core = devClaimCoreFields(src);
    core.verdict = 'dev-test-suspected';
    core.note = devClaimNote(src);
    core.source = SOURCE_DEV;
    return normalizeFinding(core, (opts && opts.at) || new Date().toISOString());
}

// ── marker persistence (the house dmtools: marker pattern) ───────────────────

// Marker hygiene (escaping) and the parse walk live in reviewVerdicts — the
// shared dmtools: marker plumbing (gh-1329 rework, gh-1251 duplication
// ratchet): this module keeps only its MARKER_PREFIX and payload adapter.

function ledgerPayload(l) {
    return {
        v: l.v || LEDGER_VERSION,
        at: l.at || new Date().toISOString(),
        findings: l.findings || []
    };
}

function openCount(l) {
    return openFindings(l).length;
}

function ledgerNote(l) {
    return '\uD83E\uDDFC TC maintenance ledger (gh-1329) — ' + openCount(l) +
        ' open test-side finding' + (openCount(l) === 1 ? '' : 's') +
        ', ' + (Array.isArray(l.findings) ? l.findings.length : 0) + ' total. Machine-managed sweep queue; please do not edit or reply.';
}

/**
 * Builds the ledger marker comment for an update: the machine-parseable
 * one-line payload plus a short human note. Returns null for a non-postable
 * ledger (no findings array — a ledger without findings is not a ledger).
 */
function buildLedgerMarker(l) {
    if (!l || !Array.isArray(l.findings)) return null;
    return MARKER_PREFIX + JSON.stringify(ledgerPayload(l), reviewVerdicts.markerSafeReplacer) + MARKER_SUFFIX + '\n' + ledgerNote(l);
}

function ledgerFromPayload(parsed) {
    if (!parsed || !Array.isArray(parsed.findings)) return null;
    return {
        v: parseInt(parsed.v, 10) || LEDGER_VERSION,
        at: String(parsed.at || ''),
        findings: parsed.findings
    };
}

/**
 * Parses ALL ledger records from a ticket comments payload — comments:
 * [{body}] (author fields consulted only when opts.authorLogins is passed).
 * FAILS CLOSED: no configured machine-identity allowlist trusts nothing
 * (the machineAuthor doctrine — stricter than the shape-agnostic shared
 * parser, because a maintenance ledger re-routes bug verdicts).
 * Returns records oldest-first.
 */
function parseLedgerComments(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments, opts, MARKER_PREFIX, MARKER_SUFFIX,
        function(parsed) {
            var l = ledgerFromPayload(parsed);
            return l ? { ledger: l, at: l.at } : null;
        }, true);
}

/**
 * The newest trusted ledger record for a ticket, or null when none exists.
 */
function latestLedger(comments, opts) {
    var records = parseLedgerComments(comments, opts);
    return records.length ? records[records.length - 1] : null;
}

// ── the owner-facing digest (§7: async, never a blocking ask) ────────────────

function findingLine(f) {
    var src = f.source === SOURCE_DEV ? 'dev claim' : f.verdict;
    return '- ' + f.tcKey + ' — ' + src + (f.reason ? ' (' + f.reason.replace(/-/g, ' ') + ')' : '') +
        (f.testPath ? ' — `' + f.testPath + '`' : '') +
        (f.occurrences > 1 ? ' — seen ' + f.occurrences + 'x' : '') +
        (f.source === SOURCE_DEV && f.claimedVerdict ? ' — claimed: ' + f.claimedVerdict : '');
}

/**
 * The digest comment: one section per open finding plus the explicit
 * "no action required right now" — humans meet a digest, never a question.
 */
function buildDigestComment(l) {
    var open = openFindings(l);
    if (!open.length) {
        return '\uD83E\uDDFC TC maintenance ledger (gh-1329) — no open findings. Test-side debt is clear.';
    }
    var lines = ['\uD83E\uDDFC TC maintenance ledger digest (gh-1329) — ' + open.length +
        ' open test-side finding' + (open.length === 1 ? '' : 's') + ', queued for a batched sweep PR:'];
    open.forEach(function(f) {
        lines.push(findingLine(f));
    });
    lines.push('');
    lines.push('Findings are fixed in batched sweep PRs; tests re-enter validation afterwards. No action is required right now.');
    return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        LEDGER_VERSION: LEDGER_VERSION,
        STATUS_OPEN: STATUS_OPEN,
        STATUS_RESOLVED: STATUS_RESOLVED,
        SOURCE_AUTOMATION: SOURCE_AUTOMATION,
        SOURCE_DEV: SOURCE_DEV,
        findingIdentity: findingIdentity,
        emptyLedger: emptyLedger,
        appendFinding: appendFinding,
        resolveFindings: resolveFindings,
        openFindings: openFindings,
        findingFromVerdict: findingFromVerdict,
        findingFromDevClaim: findingFromDevClaim,
        buildLedgerMarker: buildLedgerMarker,
        parseLedgerComments: parseLedgerComments,
        latestLedger: latestLedger,
        buildDigestComment: buildDigestComment
    };
}
