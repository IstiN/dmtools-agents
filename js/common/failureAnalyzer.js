/**
 * failureAnalyzer.js — gh-136, the AI failure-analyzer leg (pure half).
 *
 * The machine SM used to re-dispatch failed legs unconditionally. That is
 * correct for transient causes (network outages, runner glitches, API
 * quota — retrying IS the resilience), but a deterministic failure (repo
 * state, pipeline config, setup code) burns a runner every tick forever.
 * A dumb signature-count circuit breaker is explicitly rejected (owner
 * decision): identical-looking failures can be transient, so a counter
 * must never stop the loop — only an agent that READS the failures and
 * UNDERSTANDS the cause may.
 *
 * This module is the SM-side contract of that analyzer:
 *
 *   1. config — `failureAnalysis` in the SM config. Missing → the feature
 *      is disabled silently (today's blind-retry behavior until the owner
 *      enables it); malformed → a hard validation error at SM start
 *      (resolveFailureAnalysisConfig throws — the house rule).
 *   2. streak — the trailing same-signature failure run, derived from the
 *      gh-1363 machine-readable `failure-signature:` lines (the issue-01
 *      normalizer is REUSED here — no second implementation). Analysis is
 *      due at the EXACT threshold crossing: streak-minus-consumed equals
 *      `afterFailures`. The strict equality is the fail-safe: when the
 *      analyzer leg itself crashed (no verdict, nothing consumed), the
 *      streak moves past the threshold and blind retries continue — a
 *      broken analyzer must never stop retries nor retry itself every tick.
 *   3. verdict — the analyzer leg stamps ONE machine-parseable marker
 *      comment on the issue (the reviewVerdicts house protocol):
 *      `<!-- dmtools:failure-verdict {...} -->` carrying
 *      { classification: transient | deterministic-infra, confidence,
 *        suspected_root_cause, evidence, suggested_fix, analyzedAtCount,
 *        signature, at, source }. Trusted only from machine identities
 *        (the gh-807 rule — a forged marker must never park an issue).
 *   4. park — the SM applies a `deterministic-infra` verdict: label the
 *      issue (name configurable) and post ONE diagnostic comment (root
 *      cause + evidence + suggested fix), then stop re-dispatching. The
 *      ONE-comment idempotency keys on the machine marker, never on text.
 *      Re-dispatch resumes when a human removes the label (or re-assigns
 *      the issue — the assigned event wakes the leg directly).
 *
 * Everything here is pure and GraalJS-clean (var + plain functions,
 * JSON-safe data) — the SM decision core feeds it comment payloads and the
 * analyzer leg (factory side) reuses the same builders to stamp its
 * verdict.
 */

'use strict';

// The issue-01 failure report surface: the normalizer, the signature
// shape and the machine-readable signature lines live there — one
// implementation per the ticket ("Signature counting reuses the
// normalizer from issue 01 — no second implementation").
var legFailureReport = require('./legFailureReport.js');
// The marker plumbing (extractMarkerJson / parseMarkerComments /
// markerSafeReplacer) is the reviewVerdicts house pattern for
// machine-validated structured AI output.
var reviewVerdicts = require('./reviewVerdicts.js');

// ── config (gh-136 AC7) ──────────────────────────────────────────────────

var DEFAULT_AFTER_FAILURES = 4;
var DEFAULT_BLOCKED_LABEL = 'sm:leg-blocked';
var DEFAULT_BACKOFF = 1;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value) {
    return typeof value === 'number' && isFinite(value) &&
        Math.floor(value) === value && value >= 1;
}

/**
 * Resolves the `failureAnalysis` SM-config block.
 *   undefined / null            → { enabled: false }  (silently disabled)
 *   a plain object              → validated + defaulted knobs
 *   anything else               → THROWS (hard validation error at SM start)
 * Knob validation (when present): afterFailures a positive integer,
 * blockedLabel a non-empty string, backoff a number >= 1 (1 = off).
 * Unknown keys are ignored (forward-compatible).
 */
function resolveFailureAnalysisConfig(block) {
    if (block === undefined || block === null) return { enabled: false };
    if (!isPlainObject(block)) {
        throw new Error('machineSm: failureAnalysis must be an object ' +
            '(missing config disables the feature silently; a malformed one is a hard error)');
    }
    var cfg = {
        enabled: true,
        afterFailures: DEFAULT_AFTER_FAILURES,
        blockedLabel: DEFAULT_BLOCKED_LABEL,
        backoff: DEFAULT_BACKOFF
    };
    if (block.afterFailures !== undefined && block.afterFailures !== null) {
        if (!isPositiveInt(block.afterFailures)) {
            throw new Error('machineSm: failureAnalysis.afterFailures must be a positive integer, got: ' +
                JSON.stringify(block.afterFailures));
        }
        cfg.afterFailures = block.afterFailures;
    }
    if (block.blockedLabel !== undefined && block.blockedLabel !== null) {
        if (typeof block.blockedLabel !== 'string' || !block.blockedLabel.trim()) {
            throw new Error('machineSm: failureAnalysis.blockedLabel must be a non-empty string, got: ' +
                JSON.stringify(block.blockedLabel));
        }
        cfg.blockedLabel = block.blockedLabel.trim();
    }
    if (block.backoff !== undefined && block.backoff !== null) {
        if (typeof block.backoff !== 'number' || !isFinite(block.backoff) || block.backoff < 1) {
            throw new Error('machineSm: failureAnalysis.backoff must be a number >= 1 (1 = off), got: ' +
                JSON.stringify(block.backoff));
        }
        cfg.backoff = block.backoff;
    }
    return cfg;
}

// ── streak (reuses the issue-01 normalizer) ──────────────────────────────

/**
 * The trailing same-signature failure streak from comment bodies, in
 * order of appearance. Delegates the signature-line parsing and the
 * consecutive counting to the gh-1363 module — one normalizer, one
 * streak definition (the SM and the failure reports can never drift).
 * Returns { signature, count } or null when the issue has no failure
 * history at all.
 */
function failureStreak(bodies) {
    var signatures = legFailureReport.parseSignatureLines(bodies);
    if (!signatures.length) return null;
    var signature = signatures[signatures.length - 1];
    // consecutiveRepeatCount counts 1 + the trailing PRIORS sharing the
    // signature — the current failure is the trailing entry of the parsed
    // history, so it is excluded from the priors it is counted against.
    var priors = signatures.slice(0, signatures.length - 1);
    return {
        signature: signature,
        count: legFailureReport.consecutiveRepeatCount(signature, priors)
    };
}

// ── verdict consumption (gh-136 AC2) ─────────────────────────────────────

/**
 * How much of `signature`'s streak an analyzer verdict already consumed:
 * the deepest analyzedAtCount among THIS signature's verdicts (0 when
 * none). Verdicts for other signatures never consume. A transient
 * verdict consumes its analyzed prefix, so retries continue and a NEW
 * identical streak re-triggers analysis only after the threshold again.
 */
function consumedCount(verdicts, signature) {
    var list = verdicts || [];
    var consumed = 0;
    for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (!v || v.signature !== signature) continue;
        if (isPositiveInt(v.analyzedAtCount) && v.analyzedAtCount > consumed) {
            consumed = v.analyzedAtCount;
        }
    }
    return consumed;
}

/** The un-analyzed tail of the streak (never negative). */
function effectiveStreakCount(streakCount, consumed) {
    var effective = (streakCount || 0) - (consumed || 0);
    return effective > 0 ? effective : 0;
}

/**
 * The analysis trigger — EXACTLY the threshold crossing. Strict equality
 * is the fail-safe (gh-136 AC5): when the analyzer leg crashes (no
 * verdict → nothing consumed), the streak moves past the threshold,
 * analysisDue goes false, and blind retries continue — a broken analyzer
 * is never re-dispatched every tick and never stops retries.
 */
function analysisDue(streakCount, consumed, afterFailures) {
    if (!isPositiveInt(afterFailures)) return false;
    return effectiveStreakCount(streakCount, consumed) === afterFailures;
}

// ── analyzer verdict marker (reviewVerdicts house protocol) ──────────────

var VERDICT_MARKER_PREFIX = '<!-- dmtools:failure-verdict ';
var VERDICT_MARKER_SUFFIX = ' -->';
var CLASSIFICATIONS = ['transient', 'deterministic-infra'];
var ANALYZE_LEG = 'analyze';
var VERDICT_SOURCE = 'failure-analyzer';
// The park-diagnostic machine marker — the ONE-comment idempotency key.
var PARK_MARKER_PREFIX = '<!-- dmtools:failure-block ';
var PARK_MARKER_SUFFIX = ' -->';

/**
 * Builds the analyzer verdict comment body. record:
 *   signature           — the analyzed failure signature (REQUIRED)
 *   classification      — transient | deterministic-infra (REQUIRED)
 *   confidence          — 0..1 (optional)
 *   suspected_root_cause, suggested_fix — free text (optional)
 *   evidence            — [log lines] (optional)
 *   analyzedAtCount     — the streak count the analysis consumed (optional;
 *                         absent → no consumption discount for transient)
 *   at, source          — timestamp / origin (defaults filled)
 * Returns null when the record is not postable — a head-less verdict must
 * never exist, same rule as the review verdicts.
 */
function buildFailureVerdictComment(record) {
    if (!record || !record.signature || typeof record.signature !== 'string') return null;
    var classification = record.classification;
    if (CLASSIFICATIONS.indexOf(classification) === -1) return null;
    var evidence = Array.isArray(record.evidence)
        ? record.evidence.map(function (line) { return String(line == null ? '' : line); })
        : [];
    var payload = {
        signature: record.signature,
        classification: classification,
        confidence: typeof record.confidence === 'number' ? record.confidence : null,
        suspected_root_cause: record.suspected_root_cause || '',
        evidence: evidence,
        suggested_fix: record.suggested_fix || '',
        analyzedAtCount: isPositiveInt(record.analyzedAtCount) ? record.analyzedAtCount : null,
        at: record.at || new Date().toISOString(),
        source: record.source || VERDICT_SOURCE
    };
    var note = '\uD83E\uDD16 Automated failure analysis. Please do not edit or reply.';
    return VERDICT_MARKER_PREFIX +
        JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        VERDICT_MARKER_SUFFIX + '\n' + note;
}

/** One marker payload → the verdict record, or null (strict admission). */
function verdictFromPayload(parsed) {
    if (!isPlainObject(parsed)) return null;
    if (CLASSIFICATIONS.indexOf(parsed.classification) === -1) return null;
    if (!parsed.signature || typeof parsed.signature !== 'string') return null;
    return {
        signature: parsed.signature,
        classification: parsed.classification,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
        suspected_root_cause: typeof parsed.suspected_root_cause === 'string' ? parsed.suspected_root_cause : '',
        evidence: Array.isArray(parsed.evidence)
            ? parsed.evidence.map(function (line) { return String(line == null ? '' : line); })
            : [],
        suggested_fix: typeof parsed.suggested_fix === 'string' ? parsed.suggested_fix : '',
        analyzedAtCount: isPositiveInt(parsed.analyzedAtCount) ? parsed.analyzedAtCount : null,
        at: parsed.at || null,
        source: parsed.source || VERDICT_SOURCE
    };
}

/**
 * Parses ALL failure-verdict records from a provider comment payload —
 * comments: [{body}] with author fields (user.login / author.login) when
 * an allowlist is passed. Fail closed: without a machine-identity
 * allowlist NOTHING is trusted (gh-807 — a forged marker must never park
 * an issue). Malformed payloads are dropped, never thrown. Returns
 * records oldest-first (atMs order, payload order as the tiebreak).
 */
function parseFailureVerdicts(comments, opts) {
    var records = reviewVerdicts.parseMarkerComments(comments, opts,
        VERDICT_MARKER_PREFIX, VERDICT_MARKER_SUFFIX, verdictFromPayload, true);
    // parseMarkerComments stamps atMs/order for sorting; the consumers
    // (consumedCount / latestVerdictForSignature) only read protocol
    // fields — keep the ordering metadata too, the machineSm tests pin it.
    return records;
}

/** The newest verdict for one signature, or null. Newest = list order
 *  (parseFailureVerdicts returns oldest-first). */
function latestVerdictForSignature(verdicts, signature) {
    var list = verdicts || [];
    var latest = null;
    for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (v && v.signature === signature) latest = v;
    }
    return latest;
}

// ── the park diagnostic (gh-136 AC3) ─────────────────────────────────────

var PARK_EVIDENCE_MAX_LINES = 10;

/** Evidence tail for the diagnostic — bounded, machine-marker-safe. */
function parkEvidenceBlock(evidence, m) {
    var lines = (Array.isArray(evidence) ? evidence : [])
        .map(function (line) { return String(line == null ? '' : line); })
        .filter(function (line) { return line.trim(); })
        .slice(-PARK_EVIDENCE_MAX_LINES);
    if (!lines.length) return '';
    return '\n' + m.bold('Evidence (last ' + lines.length + ' lines):') + '\n' +
        m.code(lines.join('\n')) + '\n';
}

/**
 * The ONE park-diagnostic comment: root cause + evidence + suggested fix
 * + the resume gesture. The machine marker is the first line — the
 * SM's ONE-comment idempotency counts these markers, never text.
 * `m` is a commentMarkup-style flavor bag.
 */
function parkDiagnosticComment(verdict, blockedLabel, m) {
    var v = verdict || {};
    var label = blockedLabel || DEFAULT_BLOCKED_LABEL;
    var confidence = (typeof v.confidence === 'number')
        ? ' (confidence ' + v.confidence + ')'
        : '';
    var body = PARK_MARKER_PREFIX +
        JSON.stringify({ signature: v.signature || '', at: v.at || null }) +
        PARK_MARKER_SUFFIX + '\n' +
        m.h(3, '\uD83D\uDED1 AI failure analyzer — leg parked (deterministic infrastructure failure)') + '\n\n' +
        'The failure analyzer read ' + m.bold(String(v.analyzedAtCount || 'repeated') +
        ' consecutive identical failure(s)') + ' and classified the cause as ' +
        m.bold('deterministic-infra') + confidence + ': re-dispatching would fail the same way again, ' +
        'so re-dispatch is STOPPED for this issue.\n\n' +
        m.bold('Failure signature:') + ' ' + m.inline(v.signature || 'unknown') + '\n' +
        (v.suspected_root_cause ? m.bold('Suspected root cause:') + ' ' + v.suspected_root_cause + '\n' : '') +
        parkEvidenceBlock(v.evidence, m) +
        (v.suggested_fix ? m.bold('Suggested fix:') + ' ' + v.suggested_fix + '\n' : '') +
        '\nRe-dispatch resumes when a human removes the ' + m.inline(label) +
        ' label (or re-assigns the issue) — e.g. after applying the suggested fix.';
    return body;
}

/** How many park diagnostics this issue already carries (marker-counted). */
function countParkComments(comments) {
    var list = Array.isArray(comments) ? comments : [];
    var count = 0;
    for (var i = 0; i < list.length; i++) {
        var body = String((list[i] && (list[i].body || list[i])) || '');
        var start = body.indexOf(PARK_MARKER_PREFIX);
        if (start !== -1 && body.indexOf(PARK_MARKER_SUFFIX, start) !== -1) count++;
    }
    return count;
}

module.exports = {
    DEFAULT_AFTER_FAILURES: DEFAULT_AFTER_FAILURES,
    DEFAULT_BLOCKED_LABEL: DEFAULT_BLOCKED_LABEL,
    DEFAULT_BACKOFF: DEFAULT_BACKOFF,
    CLASSIFICATIONS: CLASSIFICATIONS,
    ANALYZE_LEG: ANALYZE_LEG,
    VERDICT_MARKER_PREFIX: VERDICT_MARKER_PREFIX,
    VERDICT_MARKER_SUFFIX: VERDICT_MARKER_SUFFIX,
    PARK_MARKER_PREFIX: PARK_MARKER_PREFIX,
    PARK_MARKER_SUFFIX: PARK_MARKER_SUFFIX,
    resolveFailureAnalysisConfig: resolveFailureAnalysisConfig,
    failureStreak: failureStreak,
    consumedCount: consumedCount,
    effectiveStreakCount: effectiveStreakCount,
    analysisDue: analysisDue,
    buildFailureVerdictComment: buildFailureVerdictComment,
    parseFailureVerdicts: parseFailureVerdicts,
    latestVerdictForSignature: latestVerdictForSignature,
    parkDiagnosticComment: parkDiagnosticComment,
    countParkComments: countParkComments
};
