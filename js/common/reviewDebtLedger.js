/**
 * reviewDebtLedger.js — the review-side debt ledger (gh-1352 scope 4, the
 * second consumer of the shared ledger+sweep pattern).
 *
 * Scope 2's triage path can close a machine-owned thread WITHOUT a fix by
 * tagging `deferred: <id>` (the canonical reviewDispositions.TAGS spelling,
 * two r's; <id> is the stamped ledger finding id)
 * — a fix-worthy observation on code the leg
 * must not touch (not this PR's diff, needs an owner decision, comment-only
 * fix). Those deferrals become finding-level entries HERE so review debt
 * gets the same lifecycle the TC side shipped in #1345/#1348: nothing
 * discarded, debt fixed in batched sweep PRs, stale items re-validated and
 * dropped with a note.
 *
 *   Identity    id = hash(file + normalized behavior claim + severity
 *               class) — the #1332 findingRegistry identity. The same
 *               observation re-raised on a later head refreshes its entry
 *               (occurrences++, latest thread pointer) instead of
 *               duplicating; a re-occurrence of a resolved (swept) finding
 *               REOPENS it.
 *   Lifecycle   open -> resolved (the batched sweep PR; resolvedVia names
 *               it) | resolved (re-validation dropped it — with a note).
 *   Sweep       >= 10 open items or the oldest open item >= 30 days → ONE
 *               batched test/comment-fix PR. The trigger lives in the
 *               shared ledger core; this module pins the review-side bounds.
 *   Storage     the house dmtools: marker pattern (one machine-authored
 *               marker per update), parsed with the gh-728 machineAuthor
 *               allowlist — fails closed.
 *   Owner face  buildDebtDigest — the async digest (never a blocking ask).
 *
 * Pure module — no dmtools globals. GraalJS-clean (var + plain functions).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');
var findingRegistry = require('./findingRegistry.js');
var ledgerCore = require('./ledgerCore.js');

var MARKER_PREFIX = '<!-- dmtools:review-debt-ledger ';
var MARKER_SUFFIX = ' -->';
var LEDGER_VERSION = 1;

// gh-1352 scope 4: the review-side sweep bounds (epic §4: >=10 items or
// oldest >=30 days; one batched test/comment-fix PR).
var SWEEP_BOUNDS = { sweepBatch: 10, sweepMaxAgeDays: 30 };

// The review-side evidence slice: what a refresh updates (latest pointer
// wins). Lifecycle fields stay core-owned.
var DEBT_REFRESH_KEYS = ['file', 'claim', 'severityClass', 'tier', 'threadUrl',
    'originThread', 'originPr', 'note'];

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * The debt identity: the #1332 findingRegistry identity over the file,
 * the normalized behavior claim and the severity class.
 */
function debtIdentity(file, claim, severityClass) {
    return findingRegistry.findingIdentity(
        String(file || ''),
        findingRegistry.normalizeClaim(String(claim || '')),
        findingRegistry.severityClassOf(String(severityClass || 'SUGGESTION')));
}

// ── payload picking ──────────────────────────────────────────────────────────

// A value the payload genuinely carries (not absent, not an explicit null,
// not the empty string — the alias tables skip those).
function present(v) {
    return v !== undefined && v !== null && v !== '';
}

// The first present value of the named payload keys (primary + legacy
// alias), else the fallback.
function firstOf(src, k1, k2, fallback) {
    if (present(src[k1])) return src[k1];
    if (present(src[k2])) return src[k2];
    return fallback;
}

/**
 * Normalizes a deferred-thread payload into the canonical ledger entry
 * (the ledgerCore.appendFinding normalize builder).
 */
function normalizeDebtFinding(input, at) {
    var src = input || {};
    var file = String(firstOf(src, 'path', 'file', ''));
    var claim = String(firstOf(src, 'claim', 'body', ''));
    var severityClass = findingRegistry.severityClassOf(
        String(firstOf(src, 'severityClass', 'tier', 'SUGGESTION')));
    return {
        id: debtIdentity(file, claim, severityClass),
        file: file,
        claim: ledgerCore.truncate(claim),
        severityClass: severityClass,
        tier: String(src.tier || severityClass),
        originThread: firstOf(src, 'threadId', 'originThread', null),
        threadUrl: src.threadUrl || null,
        originPr: src.originPr || null,
        note: ledgerCore.truncate(src.note),
        deferredAt: at,
        status: 'open',
        firstSeenAt: at,
        lastSeenAt: at,
        occurrences: 1,
        resolvedAt: null,
        resolvedVia: null,
        dropNote: null
    };
}

/**
 * Appends a deferred finding: identity match refreshes, otherwise pushed.
 * Returns the new ledger (never mutates the input).
 */
function appendDebtFinding(prev, input) {
    return ledgerCore.appendFinding(prev, input, normalizeDebtFinding, DEBT_REFRESH_KEYS);
}

/**
 * Marks identities resolved (the batched sweep PR's disposition).
 * Unknown ids are ignored — the ledger is append-only evidence.
 */
function resolveDebtFindings(prev, ids, via) {
    return ledgerCore.resolveFindings(prev, ids, via);
}

/**
 * Drops findings that failed re-validation against HEAD (the sweep's
 * stale path) — resolved WITH the re-validation note; never silent.
 */
function dropDebtFindings(prev, ids, via, noteOf) {
    return ledgerCore.dropFindings(prev, ids, via, noteOf);
}

function openDebtFindings(l) {
    return ledgerCore.openFindings(l);
}

/**
 * The batched-sweep trigger, review bounds pinned: { due, reason, open,
 * oldestAgeDays }. `nowIso` is optional (tests/dry-run determinism).
 */
function sweepDue(l, nowIso) {
    var nowMs = nowIso ? Date.parse(nowIso) : Date.now();
    return ledgerCore.sweepDecision(l, SWEEP_BOUNDS, nowMs);
}

/**
 * The re-validation candidates: open findings at or past the age bound.
 */
function staleDebtFindings(l, nowIso) {
    var nowMs = nowIso ? Date.parse(nowIso) : Date.now();
    return ledgerCore.staleFindings(l, SWEEP_BOUNDS, nowMs);
}

// ── marker persistence (the house dmtools: marker pattern) ───────────────────

function buildDebtMarker(l) {
    if (!l || !Array.isArray(l.findings)) return null;
    var payload = { v: l.v || LEDGER_VERSION, at: l.at || new Date().toISOString(), findings: l.findings };
    return MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) + MARKER_SUFFIX;
}

function ledgerFromPayload(parsed) {
    // the canonical shape guard lives in the ledger core (gh-1352 dedup)
    return ledgerCore.ledgerFromPayload(parsed);
}

/**
 * Parses all debt-ledger records from a PR comments payload, oldest-first.
 * FAILS CLOSED: no configured machine identity trusts nothing.
 */
function parseDebtComments(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments, opts, MARKER_PREFIX, MARKER_SUFFIX,
        ledgerCore.ledgerRecordOf, true);
}

function latestDebtLedger(comments, opts) {
    var records = parseDebtComments(comments, opts);
    return records.length ? records[records.length - 1].ledger : null;
}

// ── the async owner digest (never a blocking ask) ────────────────────────────

function ageDaysOf(f, nowMs) {
    var t = Date.parse(f.firstSeenAt);
    if (isNaN(t)) return null;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    return Math.max(0, Math.floor((now - t) / (24 * 60 * 60 * 1000)));
}

// One digest line: file, claim, tier label, age/occurrence/thread suffixes.
function digestLineOf(f, nowMs) {
    var line = '- `' + (f.file || '?') + '` — ' + (f.claim || '(no claim)') +
        ' [' + (f.tier || f.severityClass || 'SUGGESTION') + ']';
    var age = ageDaysOf(f, nowMs);
    if (age !== null) line += ' — ' + age + 'd old';
    if (f.occurrences > 1) line += ' — seen ' + f.occurrences + 'x';
    if (f.threadUrl) line += ' — [thread](' + f.threadUrl + ')';
    return line;
}

// The digest headline: counts, the sweep-queue verdict.
function digestHeader(openCount, total, sweepDueNow) {
    return '\uD83E\uDDFF Review debt ledger digest — ' + openCount + ' deferred review finding' +
        (openCount === 1 ? '' : 's') + ' (' + total + ' total), ' +
        (sweepDueNow ? 'the batched sweep PR is due now' : 'queued for a batched sweep PR') + ':';
}

/**
 * The digest comment: one line per open deferred finding (file, claim, age,
 * occurrences), the sweep queue status and the explicit "no action
 * required" — humans meet a digest, never a blocking ask.
 */
function buildDebtDigest(l, nowIso) {
    var nowMs = nowIso ? Date.parse(nowIso) : Date.now();
    var open = openDebtFindings(l);
    var total = Array.isArray(l && l.findings) ? l.findings.length : 0;
    if (!open.length) {
        return '\uD83E\uDDFF Review debt ledger — no deferred review findings. Review-side debt is clear.';
    }
    var lines = [digestHeader(open.length, total, sweepDue(l, nowIso).due)];
    open.forEach(function (f) {
        lines.push(digestLineOf(f, nowMs));
    });
    lines.push('');
    lines.push('Deferred findings are fixed in one batched test/comment-fix PR; stale items are re-validated and dropped with a note. No action is required right now.');
    return lines.join('\n');
}

function emptyLedger() {
    return ledgerCore.emptyLedger(LEDGER_VERSION);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        LEDGER_VERSION: LEDGER_VERSION,
        SWEEP_BOUNDS: SWEEP_BOUNDS,
        debtIdentity: debtIdentity,
        emptyLedger: emptyLedger,
        appendDebtFinding: appendDebtFinding,
        resolveDebtFindings: resolveDebtFindings,
        dropDebtFindings: dropDebtFindings,
        openDebtFindings: openDebtFindings,
        sweepDue: sweepDue,
        staleDebtFindings: staleDebtFindings,
        buildDebtMarker: buildDebtMarker,
        parseDebtComments: parseDebtComments,
        latestDebtLedger: latestDebtLedger,
        buildDebtDigest: buildDebtDigest
    };
}
