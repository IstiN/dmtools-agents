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
 *         read during the run (file:line / `#L` anchor / trusted doc URL);
 *   AC2 — an uncited spec claim is downgraded to a non-blocking question
 *         ("please confirm against <source>");
 *   AC4 — verified findings WITH citations keep full BLOCKING force — this
 *         is not a strictness cut.
 *
 * Precision guards (review feedback on the first cut):
 *   - the spec-claim phrase must be the finding's CORE claim — the first
 *     sentence after the severity marker. An incidental "the spec says …"
 *     mention in a body whose core claim is a code-level defect (verified
 *     example: a real SQL-injection blocker with a parenthetical spec
 *     mention) must NOT be demoted: a missed real BLOCKING ships a defect,
 *     which is worse than a false BLOCKING costing rework cycles;
 *   - a doc URL counts as a citation only on a host the deployment trusts
 *     (default: public source hosts; override via opts.trustedDocHosts) —
 *     an arbitrary pasted URL must not satisfy the guard;
 *   - a comment file referenced by two inline entries is demoted and
 *     rewritten once — the census moves once per physical comment.
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
// ticket.md:12) or a `#L`-style line anchor (Policy.java#L61,
// Policy.java#L61-L66). A bare filename or a bare "the spec" mention
// is NOT a citation — the reader cannot check the claim against it.
var FILE_CITATION_RE = new RegExp(
    '[A-Za-z0-9_.\\-/]+\\.(?:java|kt|kts|js|jsx|ts|tsx|dart|py|go|rs|rb|cs|cpp|c|h|hpp' +
    '|swift|m|md|markdown|json|ya?ml|xml|gradle|toml|sh|sql|log)' +
    '(?::\\d+(?:-\\d+)?|#[LA]?\\d+(?:-[LA]?\\d+)?)');

// A doc URL counts only when its host is trusted (see trustedDocHosts) —
// an arbitrary pasted link is not evidence the source was read.
var DOC_URL_HOST_RE = /https?:\/\/([^\s\/)<>\]]+)/g;

// Hosts whose URLs are accepted as doc citations by default: public
// source-forge hosts a review can actually point at a spec/reference with.
// Deployments with internal doc hosts pass opts.trustedDocHosts through
// sanitizeReviewData / classifyFindingSeverity / hasVerifiableCitation.
var DEFAULT_TRUSTED_DOC_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

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

// Leading "🚨 BLOCKING"-style marker of a finding body (bold-tolerant).
var LEADING_MARKER_RES = [
    /^\s*\uD83D\uDEA8\s*/,
    /^\s*\**\s*BLOCKING\b\**\s*[:\-–—.)]?\s*/i
];

function trustedDocHosts(opts) {
    var list = Array.isArray(opts) ? opts : (opts && opts.trustedDocHosts);
    if (Array.isArray(list) && list.length > 0) return list;
    return DEFAULT_TRUSTED_DOC_HOSTS;
}

function hostIsTrusted(host, hosts) {
    var h = String(host || '').toLowerCase();
    if (!h) return false;
    for (var i = 0; i < hosts.length; i++) {
        var t = String(hosts[i]).toLowerCase();
        if (h === t || h.substring(h.length - t.length - 1) === '.' + t) return true;
    }
    return false;
}

function hasTrustedDocUrl(text, hosts) {
    var m = DOC_URL_HOST_RE.exec(text);
    while (m !== null) {
        if (hostIsTrusted(m[1], hosts)) return true;
        m = DOC_URL_HOST_RE.exec(text);
    }
    return false;
}

/**
 * A verifiable citation: a `file:line` / `#L`-anchor reference anywhere in
 * the text, or a doc URL on a trusted host. opts.trustedDocHosts (array or
 * { trustedDocHosts: [...] }) overrides the default host list.
 */
function hasVerifiableCitation(body, opts) {
    var text = String(body || '');
    if (!text) return false;
    if (FILE_CITATION_RE.test(text)) return true;
    return hasTrustedDocUrl(text, trustedDocHosts(opts));
}

/**
 * The finding's core claim: the first sentence after the leading severity
 * marker. A spec-claim phrase buried in a later sentence / parenthetical
 * is context, not the claim under review (see module header — an
 * incidental spec mention must not demote a code-level defect blocker).
 */
function coreClaimText(body) {
    var text = String(body || '');
    for (var i = 0; i < LEADING_MARKER_RES.length; i++) {
        text = text.replace(LEADING_MARKER_RES[i], '');
    }
    var m = /[^.!?\n]+/.exec(text);
    return m ? m[0] : '';
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
 * gh-1053 core predicate: the finding's CORE claim asserts external-spec
 * behavior AND quotes no source the reader can check.
 */
function isUncitedSpecClaim(body, opts) {
    var text = String(body || '');
    if (!text) return false;
    if (!isExternalSpecClaim(coreClaimText(text))) return false;
    return !hasVerifiableCitation(text, opts);
}

/** The spec-claim phrase that matched (trimmed) — '' when none. */
function findSpecClaimPhrase(text) {
    for (var i = 0; i < SPEC_CLAIM_RES.length; i++) {
        var m = SPEC_CLAIM_RES[i].exec(text);
        if (m) return m[0].trim();
    }
    return '';
}

/**
 * Rewrites a downgraded comment body: 🚨 → ⚠, the BLOCKING word → IMPORTANT
 * (hyphen/word-boundary safe), original claim text preserved, and a note
 * appended that asks the author to confirm against the source the finding
 * actually references and to re-raise with a citation if confirmed.
 */
function downgradeNote(originalBody) {
    var phrase = findSpecClaimPhrase(coreClaimText(originalBody));
    var target = phrase
        ? 'the source the finding references ("' + phrase + '")'
        : 'the source the finding references';
    return '---\n' +
        '\u26A0\uFE0F **Severity demoted: unverified external-spec claim (gh-1053)** \u2014 this ' +
        'finding asserts what an external spec/reference says without quoting the ' +
        'exact source (file:line, `#L` anchor, or trusted doc URL) read during the ' +
        'review. Please confirm against ' + target + '; if confirmed, re-raise with ' +
        'a verifiable citation and it regains blocking force.';
}

function downgradeBody(body) {
    var text = String(body || '');
    var out = text.replace(/\uD83D\uDEA8/g, '\u26A0\uFE0F');
    out = out.replace(/(^|[^\w-])BLOCKING\b/gi, '$1IMPORTANT');
    return out + '\n' + downgradeNote(text);
}

/**
 * Classifies one finding's effective severity (pure — gh-1053 AC2–AC4).
 * severity — the structured severity field ('BLOCKING'/'IMPORTANT'/...),
 * may be absent: the 🚨 marker / BLOCKING word in the body carries blocking
 * force on its own (that is what the machine cross-checks per
 * instructions/pr_review/review_verdict_rules.md).
 *
 * Returns { severity, blocking, downgraded }:
 *   - uncited external-spec claim as the core claim → severity
 *     'important', blocking false, downgraded true (AC2/AC3);
 *   - anything else → unchanged (AC4 — cited spec claims and ordinary
 *     findings keep full BLOCKING force; incidental spec mentions in a
 *     code-level defect finding keep blocking force too).
 */
function classifyFindingSeverity(body, severity, opts) {
    var text = String(body || '');
    var sev = String(severity || '').toLowerCase();
    var blocking = sev === 'blocking' || BLOCKING_MARKER_RE.test(text);
    if (blocking && isUncitedSpecClaim(text, opts)) {
        return { severity: 'important', blocking: false, downgraded: true };
    }
    return { severity: blocking ? 'blocking' : sev, blocking: blocking, downgraded: false };
}

/**
 * Resolves the effective body of one inlineComments entry: the inline
 * `body` wins; otherwise a file-referenced comment (`comment` path) is read
 * through readText when provided.
 */
function resolveCommentBody(c, readText) {
    if (typeof c.body === 'string' && c.body) {
        return { body: c.body, inline: true, fromFile: false };
    }
    if (c.comment && typeof readText === 'function') {
        return { body: readText(c.comment) || '', inline: false, fromFile: true };
    }
    if (typeof c.body === 'string') return { body: c.body, inline: true, fromFile: false };
    return { body: '', inline: false, fromFile: false };
}

/** First demotion of a comment file wins; later same-file entries reuse it. */
function planRewrite(out, commentPath, content) {
    for (var i = 0; i < out.rewrites.length; i++) {
        if (out.rewrites[i].path === commentPath) return false;
    }
    out.rewrites.push({ path: commentPath, content: content });
    return true;
}

function applyDemotion(c, resolved, out) {
    var newBody = downgradeBody(resolved.body);
    c.severity = 'IMPORTANT';
    var censusMove = false;
    if (resolved.inline) {
        if (resolved.body) c.body = newBody;
        censusMove = true;
    } else if (resolved.fromFile && c.comment) {
        censusMove = planRewrite(out, c.comment, newBody);
    }
    if (censusMove) out.census++;
    out.notes.push('inline comment on ' + String(c.path || c.file || '?') +
        ' downgraded BLOCKING → IMPORTANT: uncited external-spec claim (gh-1053)');
}

function sanitizeOneComment(c, readText, opts, out) {
    var entry = c || {};
    var resolved = resolveCommentBody(entry, readText);
    var verdict = classifyFindingSeverity(resolved.body, entry.severity, opts);
    if (!verdict.downgraded) return;
    out.downgrades++;
    applyDemotion(entry, resolved, out);
}

function collapseVerdictIfClean(reviewData, counts, out) {
    if (counts.blocking !== 0) return;
    if (!/^(REQUEST_CHANGES|BLOCK)$/.test(String(reviewData.recommendation || ''))) return;
    out.notes.push('recommendation ' + reviewData.recommendation +
        ' → APPROVE: no cited BLOCKING finding remains after gh-1053 downgrade');
    reviewData.recommendation = 'APPROVE';
}

/** Rebalances the census once per demoted PHYSICAL comment (not per entry). */
function rebalanceReviewData(reviewData, out) {
    if (out.census <= 0) return;
    var counts = reviewData.issueCounts ||
        (reviewData.issueCounts = { blocking: 0, important: 0, suggestions: 0 });
    counts.blocking = Math.max(0, (Number(counts.blocking) || 0) - out.census);
    counts.important = (Number(counts.important) || 0) + out.census;
    out.notes.push('issueCounts rebalanced: blocking=' + counts.blocking +
        ', important=' + counts.important + ' (gh-1053)');
    collapseVerdictIfClean(reviewData, counts, out);
}

/**
 * Sanitizes an agent's pr_review.json BEFORE the machine derives verdicts,
 * census, or posted bodies from it (gh-1053 machine-side guard).
 *
 * reviewData — the parsed pr_review.json object; mutated in place.
 * readText — OPTIONAL resolver for comment-file references
 *   (inlineComment.comment → markdown text); when omitted, file-referenced
 *   comments are inspected by their reference string only.
 * opts — OPTIONAL { trustedDocHosts: [...] } overriding the default doc
 *   URL hosts accepted as citations.
 *
 * For every inline finding whose core claim is an uncited external-spec
 * assertion:
 *   - severity field demoted to IMPORTANT;
 *   - inline bodies rewritten in place; file-referenced comments are NOT
 *     written here (pure module) — a rewrite { path, content } is returned
 *     for the caller to apply (once per physical comment file);
 *   - issueCounts rebalanced once per demoted comment (blocking −1,
 *     important +1, floor 0);
 *   - when no cited blocking finding remains, REQUEST_CHANGES/BLOCK
 *     collapses to APPROVE — matching the verdict-mapping table (no 🚨
 *     BLOCKING ⇒ APPROVE) so an uncited claim cannot arm rework.
 *
 * Returns { downgrades, census, notes, rewrites } — downgrades counts
 * demoted findings, census the census moves applied (≤ downgrades when one
 * file is referenced twice); notes are human-readable, observable in the
 * workflow log.
 */
function sanitizeReviewData(reviewData, readText, opts) {
    var out = { downgrades: 0, census: 0, notes: [], rewrites: [] };
    if (!reviewData) return out;
    var list = Array.isArray(reviewData.inlineComments) ? reviewData.inlineComments : [];
    for (var i = 0; i < list.length; i++) {
        sanitizeOneComment(list[i], readText, opts, out);
    }
    rebalanceReviewData(reviewData, out);
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        hasVerifiableCitation: hasVerifiableCitation,
        isExternalSpecClaim: isExternalSpecClaim,
        isUncitedSpecClaim: isUncitedSpecClaim,
        coreClaimText: coreClaimText,
        classifyFindingSeverity: classifyFindingSeverity,
        downgradeBody: downgradeBody,
        sanitizeReviewData: sanitizeReviewData
    };
}
