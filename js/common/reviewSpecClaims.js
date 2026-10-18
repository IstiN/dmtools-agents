/**
 * reviewSpecClaims.js — a BLOCKING finding whose core claim is an
 * external-spec assertion must carry a verifiable citation, else it is
 * classified non-blocking (gh-1053).
 *
 * Live pathology (dmtools-dart PR #423, 2026-10-18): a review leg posted a
 * 🚨 BLOCKING thread claiming "the spec (ticket, Java SomePolicy) exempts
 * only *_MAX_TOKENS and *_TOKEN_LIMIT" — without having read the referenced
 * source. The claim was false; the reviewed code was behaviorally identical
 * to the reference. The machine treats a BLOCKING thread as ground truth:
 * a rework arm fired on a validated PR, two leg dispatches were spent, and
 * a human had to disprove the claim by hand.
 *
 * The discipline (ticket ACs):
 *   AC1 — a finding may assert "spec/reference/tool X does/does not Y" at
 *         BLOCKING only when it quotes the exact source the leg actually
 *         read during the run (file:line / doc URL);
 *   AC2 — an uncited spec claim is downgraded to a non-blocking question
 *         ("please confirm against <source>");
 *   AC4 — verified findings WITH citations keep full BLOCKING force — this
 *         is not a strictness cut.
 *
 * This module is the machine-side half of that discipline (the prompt-side
 * rule lives in instructions/pr_review/general_guidelines.md). postPRReview
 * Comments sanitizes the agent's pr_review.json through sanitizeReviewData
 * BEFORE any verdict, census, or comment body is derived from it, so an
 * uncited spec claim can no longer arm rework or hold a green PR hostage.
 *
 * Pure module — no dmtools globals. Keep it GraalJS-clean (var + plain
 * functions, JSON-safe data only).
 */
'use strict';

// A verifiable citation: a file:line reference (Policy.java:61-66,
// ticket.md:12) or a doc URL. A bare filename or a bare "the spec" mention
// is NOT a citation — the reader cannot check the claim against it.
var CITATION_RES = [
    /[A-Za-z0-9_.\-\/]+\.(?:java|kt|kts|js|jsx|ts|tsx|dart|py|go|rs|rb|cs|cpp|c|h|hpp|swift|m|md|markdown|json|ya?ml|xml|gradle|toml|sh|sql|log):\d+/,
    /https?:\/\/[^\s)<>\]]+/
];

// External-spec assertion families: the finding's core claim is what some
// spec / documentation / reference implementation / external tool says or
// does — as opposed to what the reviewed code does. Kept deliberately
// specific (a verb of attribution follows the source noun) so plain code
// descriptions ("the new helper retries 3 times") are not caught.
var SPEC_CLAIM_RES = [
    /\b(?:the\s+)?(?:external\s+)?spec(?:ification|s)?\s+(?:says|states|requires|mandates|defines|exempts|allows|expects|forbids|prohibits|lists?)\b/i,
    /\baccording\s+to\s+(?:the\s+)?(?:spec|specification|specs|docs?|documentation|reference|standard|ticket|java\s+source)\b/i,
    /\bper\s+(?:the\s+)?(?:spec|specification|specs|docs?|documentation|reference|standard)\b/i,
    /\b(?:the\s+)?(?:java|reference\s+implementation|upstream|official\s+docs?|api\s+docs?)(?:\s+[\w$]+)?\s+(?:(?:say|state|require|use|do|exempt|allow|define|expect|support|forbid)s?)\b/i,
    /\b(?:the\s+)?(?:framework|library|tool)\s+(?:docs?|documentation)\s+(?:say|state|require|define|expect)s?\b/i
];

// The BLOCKING marker convention — the same boundary discipline as
// reviewVerdicts.js (gh-828): the word form requires a preceding boundary
// that is NOT a hyphen or word char, so "non-blocking" prose is untouched.
var BLOCKING_MARKER_RE = /(\uD83D\uDEA8)|((?:^|[^\w-])BLOCKING\b)/i;

function hasVerifiableCitation(body) {
    var text = String(body || '');
    if (!text) return false;
    for (var i = 0; i < CITATION_RES.length; i++) {
        if (CITATION_RES[i].test(text)) return true;
    }
    return false;
}

function isExternalSpecClaim(body) {
    var text = String(body || '');
    if (!text) return false;
    for (var i = 0; i < SPEC_CLAIM_RES.length; i++) {
        if (SPEC_CLAIM_RES[i].test(text)) return true;
    }
    return false;
}

/**
 * gh-1053 core predicate: the finding asserts external-spec behavior AND
 * quotes no source the reader can check.
 */
function isUncitedSpecClaim(body) {
    return isExternalSpecClaim(body) && !hasVerifiableCitation(body);
}

/**
 * Rewrites a downgraded comment body: 🚨 → ⚠, the BLOCKING word → IMPORTANT
 * (hyphen/word-boundary safe), original claim text preserved, and a note
 * appended that asks the author to confirm against the source and re-raise
 * with a citation if confirmed.
 */
var DOWNGRADE_NOTE = '---\n' +
    '\u26A0\uFE0F **Severity demoted: unverified external-spec claim (gh-1053)** \u2014 this ' +
    'finding asserts what an external spec/reference says without quoting the ' +
    'exact source (file:line or doc URL) read during the review. Please ' +
    'confirm against the cited source; if confirmed, re-raise with a ' +
    'verifiable citation and it regains blocking force.';

function downgradeBody(body) {
    var text = String(body || '');
    var out = text.replace(/\uD83D\uDEA8/g, '\u26A0\uFE0F');
    out = out.replace(/(^|[^\w-])BLOCKING\b/gi, '$1IMPORTANT');
    return out + '\n' + DOWNGRADE_NOTE;
}

/**
 * Classifies one finding's effective severity (pure — gh-1053 AC2–AC4).
 * severity — the structured severity field ('BLOCKING'/'IMPORTANT'/...),
 * may be absent: the 🚨 marker / BLOCKING word in the body carries blocking
 * force on its own (that is what the machine cross-checks per
 * instructions/pr_review/review_verdict_rules.md).
 *
 * Returns { severity, blocking, downgraded }:
 *   - uncited external-spec claim  → severity 'important', blocking false,
 *     downgraded true (AC2/AC3);
 *   - anything else                → unchanged (AC4 — cited spec claims and
 *     ordinary findings keep full BLOCKING force).
 */
function classifyFindingSeverity(body, severity) {
    var text = String(body || '');
    var sev = String(severity || '').toLowerCase();
    var blocking = sev === 'blocking' || BLOCKING_MARKER_RE.test(text);
    if (blocking && isUncitedSpecClaim(text)) {
        return { severity: 'important', blocking: false, downgraded: true };
    }
    return { severity: blocking ? 'blocking' : sev, blocking: blocking, downgraded: false };
}

/**
 * Sanitizes an agent's pr_review.json BEFORE the machine derives verdicts,
 * census, or posted bodies from it (gh-1053 machine-side guard).
 *
 * reviewData — the parsed pr_review.json object; mutated in place.
 * readText — OPTIONAL resolver for comment-file references
 *   (inlineComment.comment → markdown text); when omitted, file-referenced
 *   comments are inspected by their reference string only.
 *
 * For every inline finding whose body carries blocking force (severity
 * field or 🚨/BLOCKING marker) and whose core claim is an uncited
 * external-spec assertion:
 *   - severity field demoted to IMPORTANT;
 *   - inline bodies rewritten in place; file-referenced comments are NOT
 *     written here (pure module) — a rewrite { path, content } is returned
 *     for the caller to apply;
 *   - issueCounts rebalanced (blocking −1, important +1, floor 0);
 *   - when no cited blocking finding remains, REQUEST_CHANGES/BLOCK
 *     collapses to APPROVE — matching the verdict-mapping table (no 🚨
 *     BLOCKING ⇒ APPROVE) so an uncited claim cannot arm rework.
 *
 * Returns { downgrades, notes, rewrites } — notes are human-readable,
 * observable in the workflow log.
 */
function sanitizeReviewData(reviewData, readText) {
    var out = { downgrades: 0, notes: [], rewrites: [] };
    if (!reviewData) return out;
    var list = Array.isArray(reviewData.inlineComments) ? reviewData.inlineComments : [];
    for (var i = 0; i < list.length; i++) {
        var c = list[i] || {};
        var inlineBody = typeof c.body === 'string' ? c.body : '';
        var body = inlineBody;
        var fromFile = false;
        if (!body && c.comment && typeof readText === 'function') {
            body = readText(c.comment) || '';
            fromFile = true;
        }
        var verdict = classifyFindingSeverity(body, c.severity);
        if (!verdict.downgraded) continue;
        out.downgrades++;
        var newBody = downgradeBody(body);
        c.severity = 'IMPORTANT';
        if (inlineBody) {
            c.body = newBody;
        } else if (fromFile && c.comment) {
            out.rewrites.push({ path: c.comment, content: newBody });
        }
        out.notes.push('inline comment on ' + String(c.path || c.file || '?') +
            ' downgraded BLOCKING → IMPORTANT: uncited external-spec claim (gh-1053)');
    }
    if (out.downgrades > 0) {
        var counts = reviewData.issueCounts ||
            (reviewData.issueCounts = { blocking: 0, important: 0, suggestions: 0 });
        counts.blocking = Math.max(0, (Number(counts.blocking) || 0) - out.downgrades);
        counts.important = (Number(counts.important) || 0) + out.downgrades;
        out.notes.push('issueCounts rebalanced: blocking=' + counts.blocking +
            ', important=' + counts.important + ' (gh-1053)');
        if (counts.blocking === 0 &&
            /^(REQUEST_CHANGES|BLOCK)$/.test(String(reviewData.recommendation || ''))) {
            out.notes.push('recommendation ' + reviewData.recommendation +
                ' → APPROVE: no cited BLOCKING finding remains after gh-1053 downgrade');
            reviewData.recommendation = 'APPROVE';
        }
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        hasVerifiableCitation: hasVerifiableCitation,
        isExternalSpecClaim: isExternalSpecClaim,
        isUncitedSpecClaim: isUncitedSpecClaim,
        classifyFindingSeverity: classifyFindingSeverity,
        downgradeBody: downgradeBody,
        sanitizeReviewData: sanitizeReviewData
    };
}
