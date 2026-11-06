/**
 * failureAnalyzer.js — gh-1366, the AI failure-analyzer leg (pure half).
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
 *   0. pre-classifier (gh-1380) — BEFORE the analyzer dispatch, the SM
 *      runs the deterministic transient pre-classifier over the streak's
 *      normalized signature (the issue-01 normalizer, reused): a match on
 *      any `failureAnalysis.transientPatterns` regex stamps a machine
 *      transient verdict — the SAME marker protocol, source-tagged
 *      'transient-preclassifier' — WITHOUT any AI call. The consumed
 *      prefix resets the counter exactly like a transient analyzer
 *      verdict, the retry dispatch rides through (or waits out `backoff`
 *      SM ticks via the backoffTicks/ticksSoFar window), and the AI
 *      analyzer leg is dispatched ONLY for unrecognized signatures.
 *      Missing/empty patterns → the classifier is inert (every failure
 *      routes to the analyzer — AC3); DEFAULT_TRANSIENT_PATTERNS ships
 *      the common HTTP classes as data to copy per deployment.
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

// ── config (gh-1366 AC7) ──────────────────────────────────────────────────

var DEFAULT_AFTER_FAILURES = 4;
var DEFAULT_BLOCKED_LABEL = 'sm:leg-blocked';
var DEFAULT_BACKOFF = 1;

// gh-1380: the DEFAULT known-transient pattern list — shipped as DATA (one
// regex source per entry, matched case-insensitively against the gh-1363
// normalized signature). It is never auto-applied: a deployment opts in by
// listing patterns in `failureAnalysis.transientPatterns` (missing/empty →
// the pre-classifier is inert and every failure routes to the AI analyzer,
// gh-1380 AC3). Copy this list and extend it per deployment.
var DEFAULT_TRANSIENT_PATTERNS = [
    '\\b429\\b',                                  // HTTP 429 Too Many Requests
    'rate limit',                                 // rate-limit phrases
    'too many requests',
    'quota',                                      // quota exceeded / exhausted / insufficient
    '\\b5\\d\\d\\b',                              // 5xx server errors (500..599)
    'timed out|timeout|etimedout',                // timeouts
    'connection refused|econnrefused',            // connection refused
    'connection reset|econnreset'                 // connection reset
];

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value) {
    return typeof value === 'number' && isFinite(value) &&
        Math.floor(value) === value && value >= 1;
}

// Per-knob validators — each a small linear function; an explicit null
// knob means unset (JSON-friendly) and takes the default.
function afterFailuresOf(block) {
    if (block.afterFailures === undefined || block.afterFailures === null) {
        return DEFAULT_AFTER_FAILURES;
    }
    if (!isPositiveInt(block.afterFailures)) {
        throw new Error('machineSm: failureAnalysis.afterFailures must be a positive integer, got: ' +
            JSON.stringify(block.afterFailures));
    }
    return block.afterFailures;
}

function blockedLabelOf(block) {
    if (block.blockedLabel === undefined || block.blockedLabel === null) {
        return DEFAULT_BLOCKED_LABEL;
    }
    if (typeof block.blockedLabel !== 'string' || !block.blockedLabel.trim()) {
        throw new Error('machineSm: failureAnalysis.blockedLabel must be a non-empty string, got: ' +
            JSON.stringify(block.blockedLabel));
    }
    return block.blockedLabel.trim();
}

// gh-1380 rework (review, migration note): gh-1366 validated `backoff` as
// "a number >= 1" while the knob was still reserved — a fractional
// pre-config (e.g. 2.5) parsed fine back then and is a HARD SM-start
// error since gh-1380 (the knob now counts SM ticks; a fractional tick
// count is meaningless). Check your deployment's failureAnalysis block
// when upgrading.
// gh-1380 rework (review, comment-growth note): the backoff window is
// stateless — its only persistence is the SM's own verdict-marker
// comments, so EVERY absorbed tick re-posts one full marker comment
// (backoff N ⇒ N-1 extra comments per episode). Keep the multiplier at
// SM-tick scale (small); a wall-clock-scale value floods the issue
// timeline without buying anything a small multiplier would not.
function backoffOf(block) {
    if (block.backoff === undefined || block.backoff === null) return DEFAULT_BACKOFF;
    if (typeof block.backoff !== 'number' || !isFinite(block.backoff) || block.backoff < 1 ||
        Math.floor(block.backoff) !== block.backoff) {
        throw new Error('machineSm: failureAnalysis.backoff must be an integer >= 1 (1 = off), got: ' +
            JSON.stringify(block.backoff));
    }
    return block.backoff;
}

// gh-1380: ONE pattern-list entry validated (a non-empty string that
// compiles as a regex; the offending index is named). A malformed one is
// a hard validation error at SM start — the house rule.
function transientPatternSourceOf(source, index) {
    if (typeof source !== 'string' || !source.trim()) {
        throw new Error('machineSm: failureAnalysis.transientPatterns[' + index + '] must be a non-empty regex string, got: ' +
            JSON.stringify(source));
    }
    try { new RegExp(source, 'i'); } catch (eRegex) {
        throw new Error('machineSm: failureAnalysis.transientPatterns[' + index + '] is not a valid regex (' +
            eRegex.message + '): ' + JSON.stringify(source));
    }
    return source;
}

// gh-1380: the known-transient pattern list. Absent/null → [] (the
// pre-classifier is INERT — AC3: an empty or missing list keeps today's
// routing, every failure goes to the AI analyzer; the defaults above are
// data a deployment copies in). Present → an array of non-empty regex
// source strings, each validated through transientPatternSourceOf.
function transientPatternsOf(block) {
    if (block.transientPatterns === undefined || block.transientPatterns === null) return [];
    if (!Array.isArray(block.transientPatterns)) {
        throw new Error('machineSm: failureAnalysis.transientPatterns must be an array of regex strings, got: ' +
            JSON.stringify(block.transientPatterns));
    }
    var out = [];
    for (var i = 0; i < block.transientPatterns.length; i++) {
        out.push(transientPatternSourceOf(block.transientPatterns[i], i));
    }
    return out;
}

// gh-1380: the analyzer-leg dispatch knob. False turns OFF only the AI
// analyzer diversion — the pre-classifier still classifies matched
// signatures and paces their retries (no AI anywhere). Absent/null → true
// (the analyzer leg dispatches exactly as gh-1366 shipped it).
function analyzerEnabledOf(block) {
    if (block.analyzerEnabled === undefined || block.analyzerEnabled === null) return true;
    if (typeof block.analyzerEnabled !== 'boolean') {
        throw new Error('machineSm: failureAnalysis.analyzerEnabled must be a boolean, got: ' +
            JSON.stringify(block.analyzerEnabled));
    }
    return block.analyzerEnabled;
}

/**
 * Resolves the `failureAnalysis` SM-config block.
 *   undefined / null            → { enabled: false }  (silently disabled)
 *   a plain object              → validated + defaulted knobs
 *   anything else               → THROWS (hard validation error at SM start)
 * Knob validation (when present): afterFailures a positive integer,
 * blockedLabel a non-empty string, backoff an integer >= 1 (1 = off),
 * transientPatterns an array of non-empty compilable regex strings
 * (missing/empty → [] — the pre-classifier is inert), analyzerEnabled a
 * boolean (missing → true).
 * Unknown keys are ignored (forward-compatible).
 */
function resolveFailureAnalysisConfig(block) {
    if (block === undefined || block === null) return { enabled: false };
    if (!isPlainObject(block)) {
        throw new Error('machineSm: failureAnalysis must be an object ' +
            '(missing config disables the feature silently; a malformed one is a hard error)');
    }
    return {
        enabled: true,
        afterFailures: afterFailuresOf(block),
        blockedLabel: blockedLabelOf(block),
        backoff: backoffOf(block),
        transientPatterns: transientPatternsOf(block),
        analyzerEnabled: analyzerEnabledOf(block)
    };
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

// ── the deterministic transient pre-classifier (gh-1380) ─────────────────

var TRANSIENT_SOURCE = 'transient-preclassifier';
var PRECLASSIFIER_ROOT_CAUSE = 'known-transient failure signature (matched the deployment transientPatterns)';

/**
 * ONE pattern entry against the signature text. Entries arrive from
 * config and are validated (compilable, non-empty) at SM start — but a
 * hand-built config may bypass that, so a non-string entry or a compile
 * failure fails safe here to no-match: the failure routes to the AI
 * analyzer, the loop is never wedged by a bad pattern.
 */
function transientPatternMatches(source, text) {
    var re = compiledTransientPattern(source);
    return !!re && re.test(text);
}

// gh-1380 rework (review NIT): the source → RegExp memo. Config entries
// are proven compilable at SM start, and `transientPatternMatches` runs
// per pattern per evaluation — recompiling the same source each call is
// waste the memo removes. Bounded by the configured sources (config
// data, small); a compile failure memoizes null — the fail-safe no-match
// that routes to the AI analyzer (only a hand-built bypass config can
// carry an uncompilable entry, and re-deriving null stays harmless).
// The keys are PREFIXED ('p:' + source): a plain object inherits
// Object.prototype, so a bare source key collides with inherited keys
// ('constructor', 'toString', 'valueOf', … — all valid regex strings the
// config admits) and the lookup would hand back the inherited value
// instead of a RegExp (re.test then throws and kills the whole SM tick).
// A bare '__proto__' source is worse still: the assignment would go
// through the Object.prototype.__proto__ SETTER and corrupt the cache
// object itself. Prefixed keys are own-only by construction — no
// inherited key starts with 'p:' and 'p:__proto__' is a plain data
// property.
var TRANSIENT_PATTERN_CACHE = {};

function compiledTransientPattern(source) {
    if (typeof source !== 'string' || !source) return null;
    var key = 'p:' + source;
    if (TRANSIENT_PATTERN_CACHE[key] === undefined) {
        var re = null;
        try { re = new RegExp(source, 'i'); } catch (eRegex) { re = null; }
        TRANSIENT_PATTERN_CACHE[key] = re;
    }
    return TRANSIENT_PATTERN_CACHE[key];
}

/**
 * gh-1380 AC4 — the deterministic transient pre-classifier: a pure
 * function over the gh-1363-normalized failure signature. True when ANY
 * configured pattern matches (case-insensitive — machine log text varies
 * in case). A match IS the diagnosis: known provider signatures need no
 * AI to be understood.
 */
function matchesTransientPattern(signature, patterns) {
    var text = String(signature == null ? '' : signature);
    var list = Array.isArray(patterns) ? patterns : [];
    for (var i = 0; i < list.length; i++) {
        if (transientPatternMatches(list[i], text)) return true;
    }
    return false;
}

/**
 * The shared record shaper for the SM's own transient stamps — the
 * classification stamp at a threshold crossing and the backoff tick
 * re-stamps share ONE defaults ladder.
 */
function transientVerdictRecordOf(signature, analyzedAtCount) {
    return {
        signature: signature,
        classification: 'transient',
        confidence: 1,
        suspected_root_cause: PRECLASSIFIER_ROOT_CAUSE,
        evidence: [],
        suggested_fix: '',
        analyzedAtCount: analyzedAtCount,
        source: TRANSIENT_SOURCE
    };
}

/**
 * The pre-classifier verdict record for one threshold crossing — null
 * when the signature matches nothing (the AI analyzer leg handles it,
 * gh-1366 as today). The record rides the SAME failure-verdict marker
 * protocol: the SM stamps itself (machine-authored, zero AI calls), and
 * analyzedAtCount consumes the streak prefix exactly like a transient
 * analyzer verdict — the effective counter resets, and a NEW identical
 * streak re-triggers classification only after the threshold again.
 * backoff > 1 additionally opens the retry-backoff window (backoffTicks)
 * starting at the classification tick (ticksSoFar = 1).
 */
function transientPreClassifierVerdict(signature, patterns, streakCount, backoff) {
    if (!signature || !matchesTransientPattern(signature, patterns)) return null;
    var record = transientVerdictRecordOf(signature, streakCount);
    if (backoff > 1) {
        record.backoffTicks = backoff;
        record.ticksSoFar = 1;
    }
    return record;
}

/**
 * The latest trusted PRE-CLASSIFIER verdict for the signature (the SM's
 * own stamps carry the transient-preclassifier source tag). AI analyzer
 * verdicts never open a backoff window — gh-1380 paces only the
 * deterministic path.
 */
/**
 * ONE shared "newest verdict for this signature" scan (the gh-1380
 * rework de-duplication — the two wrappers below were token-identical
 * apart from the source filter, the file's first fresh clone over the
 * duplication ratchet). `source` filters to one marker origin
 * (transient-preclassifier stamps vs the AI analyzer's); null/absent
 * accepts any source. Newest = list order (parseFailureVerdicts returns
 * oldest-first, so the last match wins).
 */
function latestVerdictOf(verdicts, signature, source) {
    var list = verdicts || [];
    var latest = null;
    for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (v && v.signature === signature && (!source || v.source === source)) latest = v;
    }
    return latest;
}

function latestPreClassifierVerdict(verdicts, signature) {
    return latestVerdictOf(verdicts, signature, TRANSIENT_SOURCE);
}

/**
 * The still-open retry-backoff window after a pre-classifier stamp:
 *   - the stamp is the LATEST for the streak signature,
 *   - it carries a window (positive-integer backoffTicks/ticksSoFar —
 *     a backoff <= 1 crossing stamps none),
 *   - no NEW failure arrived since the stamp (the stamp consumed that
 *     streak depth; a deeper streak means the retry leg already ran),
 *   - and ticks remain to absorb (the tick this gate evaluates would be
 *     number ticksSoFar + 1; the dispatch resumes when it reaches
 *     backoffTicks — `backoff` multiplies the one-tick retry interval).
 * Returns the pending stamp, or null (no window / expired → dispatch).
 */
function pendingTransientBackoff(verdicts, signature, streakCount) {
    var stamp = latestPreClassifierVerdict(verdicts, signature);
    if (!stamp || !isPositiveInt(stamp.backoffTicks) || !isPositiveInt(stamp.ticksSoFar)) return null;
    if (stamp.analyzedAtCount !== streakCount) return null;
    return (stamp.ticksSoFar + 1 < stamp.backoffTicks) ? stamp : null;
}

/**
 * The re-stamp record for one absorbed backoff tick: same consumed
 * prefix and window, ticksSoFar advanced by one. `at` stays open — the
 * marker builder stamps the render time.
 */
function backoffTickVerdictRecord(stamp) {
    var record = transientVerdictRecordOf(stamp.signature, stamp.analyzedAtCount);
    record.backoffTicks = stamp.backoffTicks;
    record.ticksSoFar = stamp.ticksSoFar + 1;
    return record;
}

// ── verdict consumption (gh-1366 AC2) ─────────────────────────────────────

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
 * is the fail-safe (gh-1366 AC5): when the analyzer leg crashes (no
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
var VERDICT_NOTE = '\uD83E\uDD16 Automated failure analysis. Please do not edit or reply.';
// The park-diagnostic machine marker — the ONE-comment idempotency key.
var PARK_MARKER_PREFIX = '<!-- dmtools:failure-block ';
var PARK_MARKER_SUFFIX = ' -->';

/** The postable shape: a string signature and an admitted classification. */
function isPostableVerdictRecord(record) {
    return !!record && !!record.signature && typeof record.signature === 'string' &&
        CLASSIFICATIONS.indexOf(record.classification) !== -1;
}

function evidenceLinesOf(evidence) {
    return Array.isArray(evidence)
        ? evidence.map(function (line) { return String(line == null ? '' : line); })
        : [];
}

/**
 * The optional/nullable verdict fields — ONE shaper shared by build and
 * parse (the CRAP-lap extraction: the four per-field ternaries live here
 * so both consumers stay under the complexity ratchet while mirroring a
 * single defaults ladder). GraalJS-safe copy — the callers spread nothing.
 */
function verdictOptionalFieldsOf(record) {
    return {
        confidence: typeof record.confidence === 'number' ? record.confidence : null,
        analyzedAtCount: isPositiveInt(record.analyzedAtCount) ? record.analyzedAtCount : null,
        // gh-1380: the pre-classifier's retry-backoff window — absent
        // (null) on every AI-analyzer verdict and on backoff-off stamps.
        backoffTicks: isPositiveInt(record.backoffTicks) ? record.backoffTicks : null,
        ticksSoFar: isPositiveInt(record.ticksSoFar) ? record.ticksSoFar : null
    };
}

/**
 * The shared payload shaper — build and parse mirror ONE defaults ladder
 * instead of two copies that can drift (the CRAP-lap extraction).
 */
function verdictPayloadOf(record) {
    var optional = verdictOptionalFieldsOf(record);
    return {
        signature: record.signature,
        classification: record.classification,
        confidence: optional.confidence,
        suspected_root_cause: typeof record.suspected_root_cause === 'string' ? record.suspected_root_cause : '',
        evidence: evidenceLinesOf(record.evidence),
        suggested_fix: typeof record.suggested_fix === 'string' ? record.suggested_fix : '',
        analyzedAtCount: optional.analyzedAtCount,
        backoffTicks: optional.backoffTicks,
        ticksSoFar: optional.ticksSoFar,
        at: record.at || null,
        source: record.source || VERDICT_SOURCE
    };
}

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
    if (!isPostableVerdictRecord(record)) return null;
    var payload = verdictPayloadOf(record);
    payload.at = payload.at || new Date().toISOString();
    return VERDICT_MARKER_PREFIX +
        JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        VERDICT_MARKER_SUFFIX + '\n' + VERDICT_NOTE;
}

/** One marker payload → the verdict record, or null (strict admission). */
function verdictFromPayload(parsed) {
    if (!isPostableVerdictRecord(parsed)) return null;
    return verdictPayloadOf(parsed);
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
    return latestVerdictOf(verdicts, signature, null);
}

// ── the park diagnostic (gh-1366 AC3) ─────────────────────────────────────

var PARK_EVIDENCE_MAX_LINES = 10;
// Markdown-hostile metacharacters: AI-derived free text is DATA, not
// protocol (the house rule). Every structural character is backslash-
// escaped so headings, links, emphasis or code spans cannot be smuggled
// into a machine-authored diagnostic; the rendered output stays verbatim
// (escapes are invisible) and copy-paste stays byte-faithful.
var PARK_MARKDOWN_METACHAR = /[\\`*_{}\[\]()#+\-.!|>~]/g;

function parkEscapedText(text) {
    return String(text == null ? '' : text).replace(PARK_MARKDOWN_METACHAR, '\\$&');
}

function fenceSafeEvidenceLine(line) {
    return /^`+$/.test(line) ? line.charAt(0) + '\u200b' + line.slice(1) : line;
}

/** Evidence tail for the diagnostic — bounded, machine-marker-safe. */
function parkEvidenceBlock(evidence, m) {
    var lines = (Array.isArray(evidence) ? evidence : [])
        .map(function (line) { return String(line == null ? '' : line); })
        .filter(function (line) { return line.trim(); })
        .map(fenceSafeEvidenceLine)
        .slice(-PARK_EVIDENCE_MAX_LINES);
    if (!lines.length) return '';
    return '\n' + m.bold('Evidence (last ' + lines.length + ' lines):') + '\n' +
        m.code(lines.join('\n')) + '\n';
}

/** The audit-reason confidence parenthetical — a missing confidence
 *  degrades to omission (never the literal string "confidence null"). */
function confidenceSuffix(confidence) {
    return (typeof confidence === 'number') ? ' (confidence ' + confidence + ')' : '';
}

function parkMarkerLine(v) {
    return PARK_MARKER_PREFIX +
        JSON.stringify({ signature: v.signature || '', at: v.at || null }) +
        PARK_MARKER_SUFFIX;
}

function parkHeadline(m) {
    return m.h(3, '\uD83D\uDED1 AI failure analyzer — leg parked (deterministic infrastructure failure)');
}

function parkSummarySection(v, m) {
    return 'The failure analyzer read ' + m.bold(String(v.analyzedAtCount || 'repeated') +
        ' consecutive identical failure(s)') + ' and classified the cause as ' +
        m.bold('deterministic-infra') + confidenceSuffix(v.confidence) +
        ': re-dispatching would fail the same way again, ' +
        'so re-dispatch is STOPPED for this issue.\n\n' +
        m.bold('Failure signature:') + ' ' + m.inline(v.signature || 'unknown');
}

function parkOptionalSections(v, m) {
    return (v.suspected_root_cause
        ? m.bold('Suspected root cause:') + ' ' + parkEscapedText(v.suspected_root_cause) + '\n'
        : '') +
        parkEvidenceBlock(v.evidence, m) +
        (v.suggested_fix
            ? m.bold('Suggested fix:') + ' ' + parkEscapedText(v.suggested_fix) + '\n'
            : '');
}

function parkResumeSection(label, m) {
    return '\nRe-dispatch resumes when a human removes the ' + m.inline(label) +
        ' label (or re-assigns the issue) — e.g. after applying the suggested fix.';
}

/**
 * The ONE park-diagnostic comment per episode: root cause + evidence +
 * suggested fix + the resume gesture. The machine marker is the first
 * line — the SM's episode idempotency keys on these markers, never text.
 * `m` is a commentMarkup-style flavor bag.
 */
function parkDiagnosticComment(verdict, blockedLabel, m) {
    var v = verdict || {};
    var label = blockedLabel || DEFAULT_BLOCKED_LABEL;
    return parkMarkerLine(v) + '\n' +
        parkHeadline(m) + '\n\n' +
        parkSummarySection(v, m) + '\n' +
        parkOptionalSections(v, m) +
        parkResumeSection(label, m);
}

// ── park markers: machine-gated, episode-scoped idempotency ──────────────

/**
 * One park-marker payload → the episode record: the parked signature and
 * the analysis identity (`at` — the parked verdict's analysis time). The
 * payload is written by parkDiagnosticComment; anything else is noise.
 */
function parkMarkerFromPayload(parsed) {
    if (!isPlainObject(parsed)) return null;
    if (!parsed.signature || typeof parsed.signature !== 'string') return null;
    return {
        signature: parsed.signature,
        at: typeof parsed.at === 'string' ? parsed.at : null
    };
}

/**
 * ALL trusted park markers from a provider comment payload. Fail closed
 * (the gh-807 rule, same discipline as the verdict markers): the marker
 * format is public, so a forged one-line marker from any comment-capable
 * identity must never influence the park gate — without a machine-identity
 * allowlist NOTHING is trusted. Malformed payloads are dropped, never
 * thrown. Returns records oldest-first (atMs stamped from `at`).
 */
function parkMarkersFrom(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments, opts,
        PARK_MARKER_PREFIX, PARK_MARKER_SUFFIX, parkMarkerFromPayload, true);
}

// The verdict's analysis identity in ms — an unparseable/absent `at`
// sinks to -1 (the markerRecordComparator convention): maximally stale,
// so any trusted machine marker of the signature covers it.
function verdictAtMs(verdict) {
    var t = Date.parse(verdict && verdict.at);
    return isNaN(t) ? -1 : t;
}

/**
 * Does this park marker cover the verdict — i.e. has the machine already
 * parked THIS episode? Same signature AND the marker's analysis time at
 * or after the verdict's: the marker was written in response to this
 * verdict or a superseding analysis of the same streak. A marker from an
 * OLDER analysis never covers a fresher verdict (the failed-human-fix
 * re-park case), and another signature's marker never covers at all.
 */
function parkMarkerCoversVerdict(marker, verdict) {
    if (!marker || !verdict || marker.signature !== verdict.signature) return false;
    return !isNaN(marker.atMs) && marker.atMs >= verdictAtMs(verdict);
}

/** The first marker covering the verdict, or null (episode not parked). */
function coveringParkMarker(markers, verdict) {
    var list = Array.isArray(markers) ? markers : [];
    for (var i = 0; i < list.length; i++) {
        if (parkMarkerCoversVerdict(list[i], verdict)) return list[i];
    }
    return null;
}

module.exports = {
    DEFAULT_AFTER_FAILURES: DEFAULT_AFTER_FAILURES,
    DEFAULT_BLOCKED_LABEL: DEFAULT_BLOCKED_LABEL,
    DEFAULT_BACKOFF: DEFAULT_BACKOFF,
    DEFAULT_TRANSIENT_PATTERNS: DEFAULT_TRANSIENT_PATTERNS,
    CLASSIFICATIONS: CLASSIFICATIONS,
    ANALYZE_LEG: ANALYZE_LEG,
    TRANSIENT_SOURCE: TRANSIENT_SOURCE,
    VERDICT_MARKER_PREFIX: VERDICT_MARKER_PREFIX,
    VERDICT_MARKER_SUFFIX: VERDICT_MARKER_SUFFIX,
    PARK_MARKER_PREFIX: PARK_MARKER_PREFIX,
    PARK_MARKER_SUFFIX: PARK_MARKER_SUFFIX,
    resolveFailureAnalysisConfig: resolveFailureAnalysisConfig,
    failureStreak: failureStreak,
    consumedCount: consumedCount,
    effectiveStreakCount: effectiveStreakCount,
    analysisDue: analysisDue,
    matchesTransientPattern: matchesTransientPattern,
    transientPreClassifierVerdict: transientPreClassifierVerdict,
    latestPreClassifierVerdict: latestPreClassifierVerdict,
    pendingTransientBackoff: pendingTransientBackoff,
    backoffTickVerdictRecord: backoffTickVerdictRecord,
    buildFailureVerdictComment: buildFailureVerdictComment,
    parseFailureVerdicts: parseFailureVerdicts,
    latestVerdictForSignature: latestVerdictForSignature,
    parkDiagnosticComment: parkDiagnosticComment,
    confidenceSuffix: confidenceSuffix,
    parkMarkersFrom: parkMarkersFrom,
    parkMarkerCoversVerdict: parkMarkerCoversVerdict,
    coveringParkMarker: coveringParkMarker
};
