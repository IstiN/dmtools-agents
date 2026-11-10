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
 * gh-1334 — verify the claim against the ticket before demoting: the
 * gh-1053 rule checked whether the claim is FORMATTED (cited), not whether
 * it is TRUE. An uncited true claim ("According to the ticket, invalid
 * login must return 401") was mechanically demoted and real spec drift
 * could merge. The demotion path now compares the claim against the ticket
 * text the review run already has (opts.ticketText):
 *   - requirement verifiably present  → KEEP BLOCKING + auto-append the
 *     matched citation (e.g. `ticket.md:3`) — a well-formed BLOCKING for
 *     downstream triage, census untouched;
 *   - absent / contradicted           → demote as today;
 *   - inconclusive (thin claim, anchor detached, no ticket text) → demote
 *     as today. Never auto-escalate on a mismatch.
 * Every demotion stamps the posted body and the inline entry with a
 * machine-parsed provenance marker (`dmtools:demoted-from-BLOCKING
 * {round, reason: missing-citation, claimMatchedTicket}`) — the
 * finding-identity registry (gh-1332) and the escalation packets surface
 * it so a later round re-elevates WITH a citation instead of treating a
 * known defect as news. The module's own doctrine rules the bias: a wrong
 * "keep BLOCKING" costs one rework lap; a missed real BLOCKING ships a
 * defect.
 *
 * Pure module — no dmtools globals. Keep it GraalJS-clean (var + plain
 * functions, JSON-safe data only).
 */
'use strict';

// Claim normalization/content-word extraction is the gh-1332 registry's
// (#1332) — the same style the ticket mandates for the match heuristics,
// so the two consumers never drift apart.
var findingRegistry = require('./findingRegistry.js');

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
    // module-level /g regex — reset lastIndex so early returns cannot
    // leak scan position into the next call.
    DOC_URL_HOST_RE.lastIndex = 0;
    var m = DOC_URL_HOST_RE.exec(text);
    while (m !== null) {
        if (hostIsTrusted(m[1], hosts)) {
            DOC_URL_HOST_RE.lastIndex = 0;
            return true;
        }
        m = DOC_URL_HOST_RE.exec(text);
    }
    DOC_URL_HOST_RE.lastIndex = 0;
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

// The first line of the machine-appended demotion tail (downgradeNote's
// head, after the '\n' separator downgradeBody joins it with). Exported so
// consumers that must strip the annotation from a claim (the gh-1332
// registry identity, js/postPRReviewComments.js registryClaimOf) cut at
// exactly this point — the generic '\n---\n' separator would truncate
// reviewer prose that legitimately contains a markdown horizontal rule.
var DEMOTION_NOTE_HEAD = '---\n' + '\u26A0\uFE0F **Severity demoted';

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
    return DEMOTION_NOTE_HEAD + ': unverified external-spec claim** \u2014 this ' +
        'finding asserts what an external spec/reference says without quoting the ' +
        'exact source (file:line, `#L` anchor, or trusted doc URL) read during the ' +
        'review. Please confirm against ' + target + '; if confirmed, re-raise with ' +
        'a verifiable citation and it regains blocking force.';
}

// ── gh-1334: ticket-grounded claim verification ──────────────────────────────
//
// Cheap, deterministic, no LLM call: normalize the claim (gh-1332 style) and
// scan the ticket text line by line. Strong anchors get priority — status
// codes (401, 403) and quoted strings survive paraphrase; the paraphrase
// tolerance comes from the anchors plus requirement-word overlap, not from
// any semantic understanding.

// Anchor = a status-code-grade number (2+ digits — 401, 503, 30) or a
// quoted string. Single digits are noise (list indexes, footnote marks).
var TICKET_ANCHOR_NUMBER_RE = /\d{2,}/g;
var TICKET_QUOTED_RE = /"([^"]{2,120})"/g;

// An anchor match still needs requirement-word company (overlap coefficient
// on the claim's content words) — a bare "401" in an unrelated line must not
// confirm a claim. A line that shares ≥60% of the smaller word set matches
// without anchors (near-identical requirement text).
var TICKET_ANCHOR_MIN_WORD_OVERLAP = 0.2;
var TICKET_WORD_MATCH_MIN_OVERLAP = 0.6;

// Below this many content words (and without anchors) a claim is too thin
// to declare confidently absent — the mechanical match abstains. The same
// floor gates the anchor-free LINE match (gh-1334 rework): a ticket line
// shorter than this is not requirement-shaped and must not confirm a claim
// on words alone (the overlap coefficient's min() denominator would let a
// heading/bullet whose few words appear in the claim score 1.0 — a
// fabricated citation).
var TICKET_MIN_CLAIM_WORDS = 3;

// Attribution vocabulary of the spec-claim phrase itself — it says WHERE the
// requirement is claimed to live, not what the requirement is. Left in, it
// would inflate overlap against ticket lines mentioning the ticket.
var CLAIM_SOURCE_NOISE = {
    'spec': 1, 'specs': 1, 'specification': 1, 'specifications': 1,
    'ticket': 1, 'tickets': 1, 'doc': 1, 'docs': 1, 'documentation': 1,
    'reference': 1, 'standard': 1, 'source': 1,
    'according': 1, 'says': 1, 'states': 1, 'stating': 1, 'saying': 1
};

function inconclusiveMatch() {
    return { outcome: 'inconclusive', line: null, citation: null };
}

/** The claim's requirement words: attribution phrase and source nouns dropped. */
function claimWordsForMatch(claim) {
    var text = String(claim || '');
    var phrase = findSpecClaimPhrase(text);
    if (phrase) text = text.replace(phrase, '');
    var words = findingRegistry.contentWords(findingRegistry.normalizeClaim(text));
    return words.filter(function(w) { return !CLAIM_SOURCE_NOISE[w]; });
}

// Anchor tokens of one text: 2+ digit numbers and normalized quoted strings,
// keyed (quoted strings keep spaces — they are matched by containment).
function anchorTokensOf(text) {
    var t = String(text || '');
    var anchors = {};
    var m;
    TICKET_ANCHOR_NUMBER_RE.lastIndex = 0;
    while ((m = TICKET_ANCHOR_NUMBER_RE.exec(t)) !== null) anchors[m[0]] = true;
    TICKET_QUOTED_RE.lastIndex = 0;
    while ((m = TICKET_QUOTED_RE.exec(t)) !== null) {
        var q = findingRegistry.normalizeClaim(m[1]);
        if (q) anchors[q] = 'quoted';
    }
    TICKET_ANCHOR_NUMBER_RE.lastIndex = 0;
    TICKET_QUOTED_RE.lastIndex = 0;
    return anchors;
}

function numberTokensOf(normalizedText) {
    var numbers = {};
    var m;
    TICKET_ANCHOR_NUMBER_RE.lastIndex = 0;
    while ((m = TICKET_ANCHOR_NUMBER_RE.exec(normalizedText)) !== null) numbers[m[0]] = true;
    TICKET_ANCHOR_NUMBER_RE.lastIndex = 0;
    return numbers;
}

function anchorCountOnLine(claimAnchors, normalizedLine, lineNumbers) {
    var count = 0;
    for (var a in claimAnchors) {
        if (claimAnchors[a] === 'quoted') {
            if (normalizedLine.indexOf(a) !== -1) count++;
        } else if (lineNumbers[a]) {
            count++;
        }
    }
    return count;
}

/** Overlap coefficient between the claim's requirement words and one line's. */
function wordOverlap(claimWords, lineWords) {
    var lineSet = {};
    for (var i = 0; i < lineWords.length; i++) lineSet[lineWords[i]] = true;
    var inter = 0;
    for (var j = 0; j < claimWords.length; j++) {
        if (lineSet[claimWords[j]]) inter++;
    }
    return (claimWords.length && lineWords.length)
        ? inter / Math.min(claimWords.length, lineWords.length) : 0;
}

/**
 * One ticket line's match quality for the claim — null when the line misses
 * (anchor matches gated by requirement-word overlap, plus the near-identical
 * word-overlap match without anchors).
 */
function claimLineMatch(claimWords, normalizedLine, lineNo, anchorCount) {
    var lineWords = findingRegistry.contentWords(normalizedLine);
    var overlap = wordOverlap(claimWords, lineWords);
    var matched = (anchorCount > 0 && overlap >= TICKET_ANCHOR_MIN_WORD_OVERLAP) ||
        anchorFreeLineMatch(claimWords, lineWords, overlap);
    if (!matched) return null;
    return { anchorCount: anchorCount, overlap: overlap, line: lineNo };
}

/**
 * The anchor-free confirmation (near-identical requirement text) — gated on
 * the LINE being requirement-shaped: the overlap coefficient divides by
 * min(claimWords, lineWords), so a 1–2-word ticket line (markdown heading,
 * bullet) whose few content words all appear in the claim would score 1.0
 * and mint a fabricated "requirement verified" citation. Anchored matches
 * keep the low bar — the anchor is claim-specific evidence (a status code /
 * quoted string the claim itself asserts), not shared prose.
 */
function anchorFreeLineMatch(claimWords, lineWords, overlap) {
    return overlap >= TICKET_WORD_MATCH_MIN_OVERLAP &&
        lineWords.length >= TICKET_MIN_CLAIM_WORDS;
}

/** Is the candidate a better citation source than the incumbent best? */
function betterTicketLineMatch(candidate, best) {
    if (!best) return true;
    if (candidate.anchorCount !== best.anchorCount) {
        return candidate.anchorCount > best.anchorCount;
    }
    return candidate.overlap > best.overlap;
}

/**
 * Scans every ticket line: the best match and whether a claim anchor was
 * seen anywhere (matched or not — an anchor detached from the requirement
 * is exactly the inconclusive case).
 */
function scanTicketLines(claimWords, claimAnchors, lines) {
    var best = null;
    var anchorSeen = false;
    for (var i = 0; i < lines.length; i++) {
        var norm = findingRegistry.normalizeClaim(lines[i]);
        if (!norm) continue;
        var anchorCount = anchorCountOnLine(claimAnchors, norm, numberTokensOf(norm));
        if (anchorCount > 0) anchorSeen = true;
        var m = claimLineMatch(claimWords, norm, i + 1, anchorCount);
        if (m && betterTicketLineMatch(m, best)) best = m;
    }
    return { best: best, anchorSeen: anchorSeen };
}

function hasAnyAnchor(anchors) {
    for (var a in anchors) return true;
    return false;
}

/** The tail verdict of the mechanical comparison (gh-1334 bias: demote). */
function ticketMatchVerdict(scan, claimWords, claimAnchors, file) {
    if (scan.best) {
        return { outcome: 'yes', line: scan.best.line, citation: file + ':' + scan.best.line };
    }
    if (scan.anchorSeen) return inconclusiveMatch();
    if (claimWords.length >= TICKET_MIN_CLAIM_WORDS || hasAnyAnchor(claimAnchors)) {
        return { outcome: 'no', line: null, citation: null };
    }
    return inconclusiveMatch();
}

/**
 * gh-1334: is the claim's asserted requirement verifiably present in the
 * ticket text? outcome 'yes' — a line matched (line = 1-based, citation =
 * '<ticketFile>:<line>'); 'no' — the ticket text was available and the
 * mechanical comparison confidently misses (no anchor anywhere, requirement
 * words without a near-identical line); 'inconclusive' — no ticket text,
 * thin claim, or the claim's anchors exist in the ticket detached from the
 * requirement (never auto-escalate on a mismatch).
 */
function matchClaimInTicket(claim, ticketText, opts) {
    var text = ticketText == null ? '' : String(ticketText);
    var file = (opts && opts.ticketFile) || 'ticket.md';
    if (!text.trim()) return inconclusiveMatch();
    var claimWords = claimWordsForMatch(claim);
    var claimAnchors = anchorTokensOf(String(claim || ''));
    var scan = scanTicketLines(claimWords, claimAnchors, text.split('\n'));
    return ticketMatchVerdict(scan, claimWords, claimAnchors, file);
}

// ── gh-1334: demotion provenance marker (consumed by the gh-1332 registry) ───

var DEMOTION_MARKER_PREFIX = '<!-- dmtools:demoted-from-BLOCKING ';
var DEMOTION_MARKER_SUFFIX = ' -->';

/**
 * The machine-parsed provenance stamp: the reason and whether the claim
 * matched the ticket, so the registry can re-elevate a demoted finding with
 * a citation later instead of treating a known defect as news. Round is
 * included only when the caller knows it (the sanitizer runs before the
 * registry round is numbered).
 */
function demotionMarker(provenance) {
    var payload = {};
    var round = provenance ? parseInt(provenance.round, 10) : NaN;
    if (round > 0) payload.round = round;
    payload.reason = 'missing-citation';
    payload.claimMatchedTicket = (provenance && provenance.claimMatchedTicket) || 'inconclusive';
    return DEMOTION_MARKER_PREFIX + JSON.stringify(payload) + DEMOTION_MARKER_SUFFIX;
}

function downgradeBody(body, provenance) {
    var text = String(body || '');
    var out = text.replace(/\uD83D\uDEA8/g, '\u26A0\uFE0F');
    out = out.replace(/(^|[^\w-])BLOCKING\b/gi, '$1IMPORTANT');
    return out + '\n' + downgradeNote(text) + '\n' + demotionMarker(provenance);
}

/** The verified-keep / demoted-with-provenance split of the gh-1334 check. */
function verifiedOrDemotedVerdict(text, opts) {
    var match = matchClaimInTicket(coreClaimText(text), opts && opts.ticketText, opts);
    if (match.outcome === 'yes') {
        return {
            severity: 'blocking', blocking: true, downgraded: false,
            claimVerified: true, citation: match.citation
        };
    }
    return {
        severity: 'important', blocking: false, downgraded: true,
        claimMatchedTicket: match.outcome
    };
}

/**
 * Classifies one finding's effective severity (pure — gh-1053 AC2–AC4,
 * gh-1334 verification). severity — the structured severity field
 * ('BLOCKING'/'IMPORTANT'/...), may be absent: the 🚨 marker / BLOCKING word
 * in the body carries blocking force on its own (that is what the machine
 * cross-checks per instructions/pr_review/review_verdict_rules.md).
 * opts.ticketText / opts.ticketFile — the ticket text the review run has
 * (input/TICKET/); when present, an uncited claim is verified against it
 * BEFORE the demotion.
 *
 * Returns { severity, blocking, downgraded } plus, on the gh-1334 paths:
 *   - claim present in the ticket → { ..., claimVerified: true, citation }
 *     (KEEP BLOCKING — the caller auto-appends the citation);
 *   - demoted → { ..., claimMatchedTicket: 'no'|'inconclusive' }
 *     ('no' — the ticket text was available and the requirement is
 *     confidently absent; 'inconclusive' — thin claim, the claim's anchor
 *     seen detached from the requirement, or no ticket text. 'yes' is
 *     UNREACHABLE on this branch: a verifiable line match maps to the
 *     keep-BLOCKING branch above, so a demotion never claims verification —
 *     it only ever carries the two mismatch outcomes. The demotion marker
 *     payload and the gh-1332 registry consume these values verbatim.)
 */
function classifyFindingSeverity(body, severity, opts) {
    var text = String(body || '');
    var sev = String(severity || '').toLowerCase();
    var blocking = sev === 'blocking' || BLOCKING_MARKER_RE.test(text);
    if (blocking && isUncitedSpecClaim(text, opts)) {
        return verifiedOrDemotedVerdict(text, opts);
    }
    return { severity: blocking ? 'blocking' : sev, blocking: blocking, downgraded: false };
}

/**
 * Resolves the effective body of one inlineComments entry: the inline
 * `body` wins; otherwise a file-referenced comment (`comment` path) is read
 * through readText when provided.
 */
function resolveCommentBody(c, readText) {
    var body = typeof c.body === 'string' ? c.body : '';
    if (body) return { body: body, inline: true, fromFile: false };
    if (c.comment && typeof readText === 'function') {
        return { body: readText(c.comment) || '', inline: false, fromFile: true };
    }
    return { body: body, inline: true, fromFile: false };
}

/** First demotion of a comment file wins; later same-file entries reuse it. */
function planRewrite(out, commentPath, content) {
    for (var i = 0; i < out.rewrites.length; i++) {
        if (out.rewrites[i].path === commentPath) return false;
    }
    out.rewrites.push({ path: commentPath, content: content });
    return true;
}

/** The gh-1334 provenance stamped on a demotion (defaults: inconclusive). */
function demotionProvenanceOf(provenance) {
    return {
        reason: 'missing-citation',
        claimMatchedTicket: (provenance && provenance.claimMatchedTicket) || 'inconclusive'
    };
}

/** The finding's path reference — path, then file, then '?' (unknown). */
function targetRefOf(c) {
    return String(c.path || c.file || '?');
}

/** Census move for one demoted PHYSICAL comment (file rewrites may dedupe). */
function demotionCensusMove(c, resolved, out, newBody) {
    if (resolved.inline) {
        if (resolved.body) c.body = newBody;
        return true;
    }
    if (resolved.fromFile && c.comment) return planRewrite(out, c.comment, newBody);
    return false;
}

function applyDemotion(c, resolved, out, provenance) {
    var demotion = demotionProvenanceOf(provenance);
    var target = targetRefOf(c);
    c.severity = 'IMPORTANT';
    c.demotion = demotion;
    if (demotionCensusMove(c, resolved, out, downgradeBody(resolved.body, provenance))) out.census++;
    out.demotions.push({
        path: target, line: c.line || null,
        claimMatchedTicket: demotion.claimMatchedTicket, reason: 'missing-citation'
    });
    out.notes.push('inline comment on ' + target +
        ' downgraded BLOCKING → IMPORTANT: uncited external-spec claim (gh-1053)' +
        ' [gh-1334 claimMatchedTicket: ' + demotion.claimMatchedTicket + ']');
}

/**
 * gh-1334 AC1: the uncited claim's requirement is verifiably present in the
 * ticket — the finding keeps BLOCKING force and gets the matched citation
 * appended so the posted thread is well-formed for downstream triage and
 * the census cross-check stays clean (no census move).
 */
function applyCitationAppend(c, resolved, citation, out) {
    var target = String(c.path || c.file || '?');
    if (resolved.inline && resolved.body) {
        c.body = appendCitationToBody(resolved.body, citation);
    } else if (resolved.fromFile && c.comment) {
        planRewrite(out, c.comment, appendCitationToBody(resolved.body, citation));
    }
    out.citations.push({ path: target, line: c.line || null, citation: citation });
    out.notes.push('inline comment on ' + target +
        ' kept BLOCKING: claim verified against ' + citation +
        ' (gh-1334) — citation auto-appended');
}

function sanitizeOneComment(c, readText, opts, out) {
    var entry = c || {};
    var resolved = resolveCommentBody(entry, readText);
    var verdict = classifyFindingSeverity(resolved.body, entry.severity, opts);
    if (verdict.claimVerified) {
        applyCitationAppend(entry, resolved, verdict.citation, out);
        return;
    }
    if (!verdict.downgraded) return;
    out.downgrades++;
    applyDemotion(entry, resolved, out, {
        claimMatchedTicket: verdict.claimMatchedTicket,
        round: opts && opts.round
    });
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

function appendCitationToBody(body, citation) {
    var text = String(body || '');
    return text + '\nSource: ' + citation +
        ' — requirement verified against the ticket text (citation auto-append).';
}

/**
 * Sanitizes an agent's pr_review.json BEFORE the machine derives verdicts,
 * census, or posted bodies from it (gh-1053 machine-side guard, extended by
 * gh-1334).
 *
 * reviewData — the parsed pr_review.json object; mutated in place.
 * readText — OPTIONAL resolver for comment-file references
 *   (inlineComment.comment → markdown text); when omitted, file-referenced
 *   comments are inspected by their reference string only.
 * opts — OPTIONAL { trustedDocHosts: [...], ticketText, ticketFile, round }:
 *   trustedDocHosts overrides the default doc URL hosts accepted as
 *   citations; ticketText/ticketFile carry the ticket text the review run
 *   has (input/TICKET/) for gh-1334 verification; round (when known) is
 *   stamped into the demotion provenance marker.
 *
 * For every inline finding whose core claim is an uncited external-spec
 * assertion:
 *   - gh-1334: the claim verified against the ticket text — requirement
 *     present → severity kept BLOCKING and the matched citation (e.g.
 *     `ticket.md:3`) appended to the body (inline) or planned as a rewrite
 *     (comment file); census UNTOUCHED;
 *   - absent / inconclusive → severity field demoted to IMPORTANT;
 *   - every demotion stamps the body with the `dmtools:demoted-from-BLOCKING`
 *     marker and the inline entry with the structured `demotion` field;
 *   - inline bodies rewritten in place; file-referenced comments are NOT
 *     written here (pure module) — a rewrite { path, content } is returned
 *     for the caller to apply (once per physical comment file);
 *   - issueCounts rebalanced once per demoted comment (blocking −1,
 *     important +1, floor 0);
 *   - when no cited blocking finding remains, REQUEST_CHANGES/BLOCK
 *     collapses to APPROVE — matching the verdict-mapping table (no 🚨
 *     BLOCKING ⇒ APPROVE) so an uncited claim cannot arm rework.
 *
 * Returns { downgrades, census, notes, rewrites, demotions, citations } —
 * downgrades counts demoted findings, census the census moves applied
 * (≤ downgrades when one file is referenced twice), demotions the per-entry
 * provenance records, citations the keep-BLOCKING auto-appends; notes are
 * human-readable, observable in the workflow log.
 */
function sanitizeReviewData(reviewData, readText, opts) {
    var out = { downgrades: 0, census: 0, notes: [], rewrites: [], demotions: [], citations: [] };
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
        matchClaimInTicket: matchClaimInTicket,
        demotionMarker: demotionMarker,
        DEMOTION_MARKER_PREFIX: DEMOTION_MARKER_PREFIX,
        DEMOTION_NOTE_HEAD: DEMOTION_NOTE_HEAD,
        classifyFindingSeverity: classifyFindingSeverity,
        downgradeBody: downgradeBody,
        sanitizeReviewData: sanitizeReviewData
    };
}
