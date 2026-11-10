/**
 * findingRegistry.js — the finding-identity registry: deduplication of
 * review findings across review rounds (gh-1332).
 *
 * Live pathology (audit repro `s1c`): review rounds are stateless — round 1
 * raised 7 findings (REQUEST_CHANGES), the fix was reverted, and round 2
 * re-raised all 7 as brand-new. A naive matcher over path + line + claim
 * text found 0 duplicates: paraphrase ("nothing validates a token" ->
 * "sessions never expire") and line drift defeat any location- or
 * wording-based match. Each lap cost a full review leg and multiplied
 * duplicate threads; the machine could not tell a converging review from a
 * churning one.
 *
 * The protocol (all of it mechanical — creating/advancing the registry costs
 * the reviewer nothing beyond one-word candidate confirmations):
 *
 *   Identity    id = hash(file path + normalized behavior claim + severity
 *               class). NOT the line number (it drifts) and NOT the priority
 *               alone (too coarse). The claim is normalized (case,
 *               whitespace, punctuation) and its content words (stopwords
 *               dropped, light suffix stemming) drive similarity scoring.
 *
 *   Matching    Two stages — the machine proposes, the reviewer disposes.
 *               A false split (duplicate thread) is cheap; a false merge
 *               (masked defect) ships a bug, so the default is always NEW:
 *                 1. propose (mechanical): each new finding is compared
 *                    against OPEN registry items (same file + claim
 *                    similarity + severity class). Near-identical claims
 *                    auto-merge (surfaced); partial similarity becomes a
 *                    candidate ("possibly same as F3 — confirm or new"); no
 *                    candidate means unconditionally new.
 *                 2. confirm (reviewer, one word per candidate): "same as
 *                    F3" or "new". Unconfirmed candidates are NEW.
 *               Splits after the fact are the promoted/withdrawn lifecycle.
 *
 *   Lifecycle   open -> fixed (fixing hunk cited)     | resolved identities
 *               open -> withdrawn (reason REQUIRED)   | LEAVE the dedup
 *               open -> re-introduced (re-raise case) | space: candidates
 *               are drawn only from OPEN items, so a new finding at a
 *               resolved location is independent even in the worst matching
 *               bug (the canonical counter-example).
 *
 *   Invariants  (hard-coded — resolveIdentityPolicy never accepts knobs for
 *               them; the config-shaped gaming path stays closed):
 *                 1. auto-merge only on near-identical normalized claims
 *                    (AUTO_MERGE_SIMILARITY) in the SAME file — everything
 *                    else is a candidate, and unconfirmed candidates are new;
 *                 2. merges can only ESCALATE severity, never de-escalate —
 *                    a BLOCKING-class claim confirmed into an IMPORTANT
 *                    identity raises that identity to BLOCKING;
 *                 3. withdrawals require a reason; BLOCKING withdrawals
 *                    surface in the escalation packet (visible, never silent);
 *                 4. per-PR scope — the marker lives on the PR.
 *
 *   Tunables    reviewPolicy.identity: claimSimilarityThreshold
 *               (high|medium|aggressive|number — how much overlap a
 *               candidate needs), candidateScope (same-file|diff),
 *               candidatesPerFinding. Retuning mid-PR is safe: candidates
 *               recompute per round; the registry is append-only evidence
 *               and is never rewritten by a config change.
 *
 *   Storage     one machine-parseable marker comment per round on the PR —
 *   the house `dmtools:` marker pattern (same family as review-verdict,
 *   rework-consume). The newest machine-authored marker wins; markers from
 *   any other identity are invisible (the format is public). Free-form
 *   comment text is never consulted.
 *
 *   Convergence the safe signal is NEW-identity count per round (never the
 *               raw finding count — a converge instruction would Goodhart
 *               the review). buildEscalationPacket renders the per-round
 *               new-identity series plus the BLOCKING withdrawal reasons for
 *               the owner escalation packets.
 *
 * Similarity honesty: lexical matching starts STRICT (the confirm step
 * exists precisely for what the words miss — a zero-overlap paraphrase
 * simply stays a new identity, which is the cheap error direction).
 *
 * Pure module — no dmtools globals; the callers fetch PR comments and post
 * the built marker. GraalJS-clean (var + plain functions, JSON-safe data).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');

// The registry marker — one line, JSON payload, invisible in the rendered PR
// (same protocol family as the gh-807 verdict marker).
var MARKER_PREFIX = '<!-- dmtools:finding-registry ';
var MARKER_SUFFIX = ' -->';
var REGISTRY_VERSION = 1;

// The severity classes of the machine review marker convention
// (🚨 BLOCKING / ⚠️ IMPORTANT / 💡 SUGGESTION) — the identity's third
// component and the escalation direction's ruler (invariant 2).
var SEVERITIES = ['BLOCKING', 'IMPORTANT', 'SUGGESTION'];
var SEVERITY_RANK = { 'BLOCKING': 2, 'IMPORTANT': 1, 'SUGGESTION': 0 };
var SEVERITY_ALIASES = {
    'BLOCKING': 'BLOCKING', 'BLOCK': 'BLOCKING', 'CRITICAL': 'BLOCKING', 'SEVERE': 'BLOCKING',
    'IMPORTANT': 'IMPORTANT', 'MAJOR': 'IMPORTANT', 'WARNING': 'IMPORTANT', 'WARN': 'IMPORTANT',
    'SUGGESTION': 'SUGGESTION', 'SUGGEST': 'SUGGESTION', 'MINOR': 'SUGGESTION', 'STYLE': 'SUGGESTION', 'INFO': 'SUGGESTION'
};

// Invariant 1: auto-merge ONLY on near-identical normalized claims. NOT
// tunable — resolveIdentityPolicy ignores any attempt to widen it.
var AUTO_MERGE_SIMILARITY = 0.92;
var SEVERITY_ON_MERGE = 'escalate';

// The candidate-proposal bar per the claimSimilarityThreshold knob: how much
// overlap justifies ASKING the reviewer (never merging on its own).
var CANDIDATE_THRESHOLDS = { 'high': 0.7, 'medium': 0.55, 'aggressive': 0.4 };
var DEFAULT_CANDIDATE_THRESHOLD_NAME = 'high';
var MIN_CANDIDATE_THRESHOLD = 0.3;

// Lifecycle statuses. OPEN_STATUSES form the dedup space; RESOLVED_STATUSES
// leave it (candidates are drawn only from OPEN items).
var STATUS_OPEN = 'open';
var STATUS_REINTRODUCED = 're-introduced';
var STATUS_FIXED = 'fixed';
var STATUS_WITHDRAWN = 'withdrawn';
var OPEN_STATUSES = [STATUS_OPEN, STATUS_REINTRODUCED];

// ── claim normalization + similarity ─────────────────────────────────────────

// Function words only — negations and content words carry defect signal.
var STOPWORDS = {
    'the': 1, 'a': 1, 'an': 1, 'and': 1, 'or': 1, 'but': 1, 'if': 1, 'then': 1, 'else': 1,
    'when': 1, 'while': 1, 'this': 1, 'that': 1, 'these': 1, 'those': 1,
    'is': 1, 'are': 1, 'was': 1, 'were': 1, 'be': 1, 'been': 1, 'being': 1, 'am': 1,
    'to': 1, 'of': 1, 'in': 1, 'on': 1, 'at': 1, 'by': 1, 'for': 1, 'with': 1, 'from': 1, 'as': 1,
    'it': 1, 'its': 1, 'you': 1, 'your': 1, 'yours': 1, 'we': 1, 'our': 1, 'they': 1, 'their': 1, 'them': 1,
    'he': 1, 'she': 1, 'his': 1, 'her': 1, 'here': 1, 'there': 1, 'nothing': 1, 'none': 1, 'nobody': 1,
    'has': 1, 'have': 1, 'had': 1, 'having': 1, 'do': 1, 'does': 1, 'did': 1, 'doing': 1,
    'can': 1, 'could': 1, 'should': 1, 'would': 1, 'may': 1, 'might': 1, 'must': 1, 'will': 1, 'shall': 1,
    'into': 1, 'onto': 1, 'over': 1, 'under': 1, 'out': 1, 'up': 1, 'down': 1,
    'all': 1, 'any': 1, 'some': 1, 'such': 1, 'than': 1, 'too': 1, 'very': 1, 'per': 1, 'via': 1,
    'about': 1, 'above': 1, 'after': 1, 'before': 1, 'again': 1, 'further': 1, 'once': 1,
    'only': 1, 'own': 1, 'same': 1, 'so': 1, 'nor': 1, 'what': 1, 'which': 1, 'who': 1, 'whom': 1,
    'why': 1, 'how': 1, 'where': 1, 'both': 1, 'each': 1, 'few': 1, 'more': 1, 'most': 1,
    'other': 1, 'off': 1, 'between': 1, 'because': 1, 'until': 1, 'during': 1
};

/**
 * Normalizes a behavior claim: lowercase; punctuation (anything that is not
 * a letter, a digit or whitespace — non-ASCII letters kept) becomes a space;
 * whitespace collapses. Case-, whitespace- and punctuation-insensitive.
 */
function normalizeClaim(text) {
    var s = String(text || '').toLowerCase();
    var out = [];
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (/[a-z0-9\s]/.test(c) || s.charCodeAt(i) > 127) out.push(c);
        else out.push(' ');
    }
    return out.join('').replace(/\s+/g, ' ').trim();
}

// Light suffix stemming — 'validates'/'validated' meet at 'validat'. Starts
// strict by design (gh-1332 failure modes: relax only with the confirm step
// attached). Table-driven so every guard is explicit data: the FIRST matching
// rule wins, and `min` is the strict minimum length the rule requires —
// 'ties' (length 4) misses the ies rule and falls through to the es rule.
var STEMMING_RULES = [
    { suffix: 'ies', min: 4, cut: 3, append: 'y' },
    { suffix: 'es', min: 3, cut: 2 },
    { suffix: 's', min: 3, cut: 1 },
    { suffix: 'ing', min: 4, cut: 3 },
    { suffix: 'ed', min: 3, cut: 2 }
];

function stemWord(w) {
    for (var i = 0; i < STEMMING_RULES.length; i++) {
        var rule = STEMMING_RULES[i];
        if (w.length > rule.min && w.substring(w.length - rule.suffix.length) === rule.suffix) {
            return w.substring(0, w.length - rule.cut) + (rule.append || '');
        }
    }
    return w;
}

/**
 * Content words of a normalized claim: length >= 3, stopwords dropped,
 * light-stemmed, first occurrence order preserved.
 */
function contentWords(normalizedClaim) {
    var words = [];
    var seen = {};
    String(normalizedClaim || '').split(' ').forEach(function(w) {
        if (w.length < 3 || STOPWORDS[w]) return;
        var stemmed = stemWord(w);
        if (seen[stemmed]) return;
        seen[stemmed] = true;
        words.push(stemmed);
    });
    return words;
}

function wordSet(normalizedClaim) {
    var set = {};
    contentWords(normalizedClaim).forEach(function(w) { set[w] = true; });
    return set;
}

/**
 * Similarity in [0,1]: the mean of Jaccard (|A∩B|/|A∪B|) and the overlap
 * coefficient (|A∩B|/min(|A|,|B|)). Jaccard alone punishes subset
 * paraphrases; the overlap coefficient alone overrates tiny sets.
 */
function claimSimilarity(claimA, claimB) {
    var a = wordSet(normalizeClaim(claimA));
    var b = wordSet(normalizeClaim(claimB));
    var inter = 0, sizeA = 0, sizeB = 0, key;
    for (key in a) { sizeA++; if (b[key]) inter++; }
    for (key in b) sizeB++;
    if (!sizeA || !sizeB) return 0;
    var union = sizeA + sizeB - inter;
    var jaccard = inter / union;
    var overlap = inter / Math.min(sizeA, sizeB);
    return (jaccard + overlap) / 2;
}

// ── severity classes ─────────────────────────────────────────────────────────

function severityClassOf(raw) {
    var key = String(raw || '').toUpperCase().trim();
    return SEVERITY_ALIASES[key] || 'SUGGESTION';
}

function severityRank(severityClass) {
    return SEVERITY_RANK[severityClass] || 0;
}

// Invariant 2: merges can only escalate, never de-escalate.
function maxSeverity(classA, classB) {
    return severityRank(classA) >= severityRank(classB) ? classA : classB;
}

// ── identity ─────────────────────────────────────────────────────────────────

// FNV-1a (32-bit, Math.imul keeps the multiply exact). Two bases concatenated
// → a 16-hex id; the file+severity partitioning keeps per-PR collision space
// negligible. The hash helpers are the marker families' shared plumbing
// (reviewVerdicts — gh-1329 rework, gh-1251 duplication ratchet).

/**
 * The finding identity: hash(file path + normalized claim + severity class).
 * The line number is deliberately NOT an input (it drifts across rounds).
 */
function findingIdentity(file, claim, severityClass) {
    var normalized = normalizeClaim(claim);
    var key = String(file || '') + '\n' + normalized + '\n' + severityClassOf(severityClass);
    return reviewVerdicts.hex8(reviewVerdicts.fnv1a(key, 0x811c9dc5)) + reviewVerdicts.hex8(reviewVerdicts.fnv1a(key, 0x811c9dc5 ^ 0x9e3779b9));
}

// ── registry shape ───────────────────────────────────────────────────────────

function emptyRegistry() {
    return { v: REGISTRY_VERSION, next: 1, items: [], pending: [], rounds: [] };
}

// The list-or-nothing shape used by payloads, round inputs and comment lists.
function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
}

function isOpenStatus(status) {
    return OPEN_STATUSES.indexOf(status) !== -1;
}

// The dedup space: resolved identities (fixed/withdrawn) are not candidates.
function openItems(registry) {
    if (!registry || !Array.isArray(registry.items)) return [];
    return registry.items.filter(function(i) { return isOpenStatus(i.status); });
}

function nextRoundOf(registry) {
    var rounds = (registry && Array.isArray(registry.rounds)) ? registry.rounds : [];
    return rounds.length + 1;
}

// The PR label mirroring the CI's rework-round-N (the review-round counter).
function reviewRoundLabel(round) {
    return 'review-round-' + round;
}

function itemById(registry, n) {
    var want = parseInt(n, 10);
    if (!want) return null;
    var items = (registry && Array.isArray(registry.items)) ? registry.items : [];
    for (var i = 0; i < items.length; i++) {
        if (items[i].n === want) return items[i];
    }
    return null;
}

// ── finding input shapes ─────────────────────────────────────────────────────

function fileOf(finding) {
    return String((finding && (finding.file || finding.path || finding.filename)) || '').trim();
}

function claimOf(finding) {
    return (finding && (finding.claim || finding.body)) || '';
}

function lineOf(finding) {
    var n = parseInt(finding && finding.line, 10);
    return n > 0 ? n : null;
}

function blankClaim(claim) {
    return normalizeClaim(claim) === '';
}

// ── two-stage matching: propose (mechanical), confirm (reviewer) ─────────────

/**
 * Stage-1 scoring: every OPEN item in scope (same-file unless diff scope),
 * ranked by claim similarity (ties by item n — stable, oldest identity wins).
 */
function rankedOpenMatches(registry, claim, file, policy) {
    var ranked = [];
    openItems(registry).forEach(function(item) {
        if (policy.candidateScope !== 'diff' && item.file !== file) return;
        var sim = claimSimilarity(claim, item.claim);
        if (sim <= 0) return;
        ranked.push({ item: item, similarity: sim });
    });
    ranked.sort(function(a, b) {
        if (b.similarity !== a.similarity) return b.similarity - a.similarity;
        return (a.item.n || 0) - (b.item.n || 0);
    });
    return ranked;
}

// Invariant 1, stage-1 scope: auto-merge needs a near-identical claim in
// the SAME file at the SAME severity class. Cross-file or cross-class
// matches (the reviewer may have re-classed the defect) can only become
// candidates — the reviewer disposes, and the merge escalates (invariant 2).
function isAutoMerge(best, file, severity) {
    return !!best &&
        best.similarity >= AUTO_MERGE_SIMILARITY &&
        best.item.file === file &&
        severityClassOf(best.item.severity) === severity;
}

// The ranked proposals the reviewer is ASKED about (never merges on its own).
function topProposals(ranked, policy) {
    var proposed = [];
    ranked.forEach(function(r) {
        if (proposed.length >= policy.candidatesPerFinding) return;
        if (r.similarity < policy.candidateThreshold) return;
        proposed.push(r);
    });
    return proposed;
}

/**
 * Stage 1 for one new finding against the OPEN items. Returns
 *   { outcome: 'auto-merge', target, similarity, ranked }  — near-identical
 *       claim, same file, same severity class (invariant 1; the best match);
 *   { outcome: 'candidate', ranked, bestSimilarity }       — partial
 *       similarity: top candidatesPerFinding ranked proposals for the
 *       reviewer (stage 2); cross-file and cross-class matches can ONLY land
 *       here, never in the auto-merge outcome;
 *   { outcome: 'new', ranked }                             — no candidate:
 *       unconditionally a new identity.
 */
function matchFinding(registry, finding, policy) {
    var file = fileOf(finding);
    var claim = normalizeClaim(claimOf(finding));
    var severity = severityClassOf(finding && finding.severity);
    var ranked = rankedOpenMatches(registry, claim, file, policy);
    var best = ranked[0] || null;
    if (isAutoMerge(best, file, severity)) {
        return { outcome: 'auto-merge', target: best.item, similarity: best.similarity, ranked: ranked };
    }
    var proposed = topProposals(ranked, policy);
    if (proposed.length) {
        return { outcome: 'candidate', ranked: proposed, bestSimilarity: proposed[0].similarity };
    }
    return { outcome: 'new', ranked: ranked };
}

// ── round application (the mechanical half of the protocol) ──────────────────

function deepCopyRegistry(registry) {
    return JSON.parse(JSON.stringify(registry || emptyRegistry()));
}

function historyEntry(round, action, via) {
    var entry = { round: round, action: action };
    if (via) entry.via = via;
    return entry;
}

// Invariant 2: merges can only escalate, never de-escalate.
function escalateSeverity(item, finding, round) {
    var severity = severityClassOf(finding && finding.severity);
    if (severityRank(severity) > severityRank(item.severity)) {
        item.severity = severity;
        item.history.push(historyEntry(round, 'severity-escalated'));
    }
}

// The lazy line re-anchor keeps the newest known location.
function reanchorLine(item, finding) {
    var line = lineOf(finding);
    if (line) item.lastLine = line;
}

// gh-1334: the spec-claim guard stamps demotions ({reason, claimMatchedTicket}).
// The first demotion provenance sticks — the identity is known demoted-from-
// BLOCKING from then on, so later rounds re-elevate it WITH a citation
// instead of treating it as news.
function recordDemotionProvenance(item, finding, round) {
    if (!finding || !finding.demotion || item.demotion) return;
    item.demotion = {
        reason: String(finding.demotion.reason || 'missing-citation'),
        claimMatchedTicket: String(finding.demotion.claimMatchedTicket || 'inconclusive')
    };
    item.history.push(historyEntry(round, 'demotion-recorded'));
}

// Merges a re-raised/confirmed finding into an open identity: severity can
// only escalate (invariant 2), a later-round re-raise of an open identity is
// the re-introduced transition.
function mergeIntoItem(item, finding, round, at, note) {
    var via = note || 're-raise';
    recordDemotionProvenance(item, finding, round);
    escalateSeverity(item, finding, round);
    if (round > (item.raisedRound || 0) && item.status === STATUS_OPEN) {
        item.status = STATUS_REINTRODUCED;
        item.history.push(historyEntry(round, 're-introduced', via));
    } else {
        item.history.push(historyEntry(round, 're-raised', via));
    }
    item.lastSeenAt = at;
    reanchorLine(item, finding);
    return item;
}

function createIdentity(registry, finding, round, at) {
    var severity = severityClassOf(finding && finding.severity);
    var claim = normalizeClaim(claimOf(finding));
    var item = {
        n: registry.next++,
        id: findingIdentity(fileOf(finding), claim, severity),
        file: fileOf(finding),
        claim: claim,
        severity: severity,
        status: STATUS_OPEN,
        raisedRound: round,
        firstSeenAt: at,
        lastSeenAt: at,
        lastLine: lineOf(finding),
        fixHunk: null,
        withdrawReason: null,
        resolvedAt: null,
        demotion: (finding && finding.demotion) ? {
            reason: String(finding.demotion.reason || 'missing-citation'),
            claimMatchedTicket: String(finding.demotion.claimMatchedTicket || 'inconclusive')
        } : null,
        history: [historyEntry(round, 'raised')]
    };
    registry.items.push(item);
    return item;
}

function applyFixedDisposition(item, disposition, round, at) {
    item.status = STATUS_FIXED;
    item.fixHunk = disposition.hunk || null;
    item.resolvedAt = at;
    item.history.push(historyEntry(round, 'fixed'));
    return item;
}

// Invariant 3: a reasonless withdrawal is REJECTED — silently dropping a
// defect is not allowed.
function applyWithdrawnDisposition(item, disposition, round, at, outcome) {
    if (!disposition.reason || !String(disposition.reason).trim()) {
        outcome.rejectedWithdrawals.push({ n: item.n, reasonMissing: true });
        return null;
    }
    item.status = STATUS_WITHDRAWN;
    item.withdrawReason = String(disposition.reason).trim();
    item.resolvedAt = at;
    item.history.push(historyEntry(round, 'withdrawn'));
    return item;
}

// Open items only — a resolved identity cannot be re-opened by a disposition.
function applyReintroducedDisposition(item, round) {
    if (!isOpenStatus(item.status)) return null;
    item.status = STATUS_REINTRODUCED;
    item.history.push(historyEntry(round, 're-introduced', 'reviewer'));
    return item;
}

// One disposition: 'fixed' (hunk cited), 'withdrawn' (reason REQUIRED), or
// 're-introduced' (open items only). Returns null when nothing applied.
function applyDisposition(item, disposition, round, at, outcome) {
    var status = String(disposition.status || '').toLowerCase();
    if (status === STATUS_FIXED) return applyFixedDisposition(item, disposition, round, at);
    if (status === STATUS_WITHDRAWN) return applyWithdrawnDisposition(item, disposition, round, at, outcome);
    if (status === STATUS_REINTRODUCED) return applyReintroducedDisposition(item, round);
    outcome.unknownDispositions.push({ n: disposition.n, status: disposition.status || null });
    return null;
}

/**
 * Resolves the previous round's pending candidates against this round's
 * confirmations, then applies dispositions, then registers this round's
 * findings. Returns the outcome + the advanced registry, or null when the
 * round is a no-op (nothing proposed, confirmed, disposed or pending).
 *
 * roundInput: {
 *   at             — ISO timestamp of the round
 *   round          — explicit round number (default: nextRoundOf(registry))
 *   findings       — [{file|path, claim|body, severity, line}]
 *   dispositions   — [{n, status: fixed|withdrawn|re-introduced, hunk?, reason?}]
 *   confirmations  — [{proposedFor: n, same: true|false}]
 * }
 */

// The reviewer's one-word verdict for a pending candidate (null = unconfirmed).
function confirmationFor(confirmations, proposedFor) {
    var found = null;
    confirmations.forEach(function(c) {
        if (parseInt(c && c.proposedFor, 10) === proposedFor) found = c;
    });
    return found;
}

// Confirmed candidates merge into their proposed identity (severity
// escalates — invariant 2); declined AND unconfirmed candidates are NEW
// (invariant 1). A candidate whose proposed identity is missing or resolved
// meanwhile promotes too — resolved items are not merge targets.
function resolveConfirmedCandidate(reg, candidate, confirmed, round, at, outcome) {
    var target = (confirmed && confirmed.same === true) ? itemById(reg, candidate.proposedFor) : null;
    if (target && isOpenStatus(target.status)) {
        mergeIntoItem(target, candidate, round, at, 'confirmed');
        outcome.confirmedMerges.push({ n: target.n, similarity: candidate.similarity });
        return;
    }
    var promotedItem = createIdentity(reg, candidate, candidate.round || round, candidate.at || at);
    promotedItem.history.push(historyEntry(round, 'promoted-candidate'));
    outcome.promoted.push(promotedItem.n);
}

function resolvePreviousPending(reg, previousPending, confirmations, round, at, outcome) {
    previousPending.forEach(function(candidate) {
        resolveConfirmedCandidate(
            reg, candidate, confirmationFor(confirmations, candidate.proposedFor), round, at, outcome);
    });
}

function applyDispositions(reg, dispositions, round, at, outcome) {
    dispositions.forEach(function(d) {
        var item = itemById(reg, d && d.n);
        if (!item) {
            outcome.unknownDispositions.push({ n: d && d.n, status: (d && d.status) || null });
            return;
        }
        applyDisposition(item, d, round, at, outcome);
    });
}

function queueCandidate(reg, f, ranked, round, at) {
    var claim = normalizeClaim(claimOf(f));
    ranked.forEach(function(r) {
        reg.pending.push({
            file: fileOf(f), claim: claim, severity: severityClassOf(f.severity),
            line: lineOf(f), similarity: r.similarity, proposedFor: r.item.n,
            demotion: (f && f.demotion) ? {
                reason: String(f.demotion.reason || 'missing-citation'),
                claimMatchedTicket: String(f.demotion.claimMatchedTicket || 'inconclusive')
            } : null,
            round: round, at: at
        });
    });
}

// Stage 1 for one finding: skip blanks, auto-merge, queue candidates, or mint
// a new identity (the default — the cheap error direction).
function registerFinding(reg, f, round, at, policy, outcome) {
    if (!f || !fileOf(f) || blankClaim(claimOf(f))) {
        outcome.skippedFindings.push({ file: f ? fileOf(f) : null });
        return;
    }
    var match = matchFinding(reg, f, policy);
    if (match.outcome === 'auto-merge') {
        mergeIntoItem(match.target, f, round, at, 'auto-merge');
        outcome.autoMerged.push({ n: match.target.n, similarity: match.similarity });
        return;
    }
    if (match.outcome === 'candidate') {
        queueCandidate(reg, f, match.ranked, round, at);
        outcome.candidates.push({ proposedFor: match.ranked[0].item.n, similarity: match.ranked[0].similarity });
        return;
    }
    var item = createIdentity(reg, f, round, at);
    outcome.newIdentities.push(item.n);
}

function registerFindings(reg, findings, round, at, policy, outcome) {
    findings.forEach(function(f) {
        registerFinding(reg, f, round, at, policy, outcome);
    });
}

// A round that proposed, confirmed, disposed or skipped anything stamps its
// rounds[] entry; complete silence is a no-op (null).
function roundActed(findings, dispositions, confirmations, hadPending, outcome) {
    return findings.length > 0 || dispositions.length > 0 || confirmations.length > 0 ||
        hadPending || outcome.skippedFindings.length > 0;
}

function emptyOutcome(reg, round) {
    return {
        registry: reg,
        round: round,
        newIdentities: [],
        autoMerged: [],
        candidates: [],
        confirmedMerges: [],
        promoted: [],
        rejectedWithdrawals: [],
        unknownDispositions: [],
        skippedFindings: []
    };
}

function applyRound(prev, roundInput, policy) {
    var input = roundInput || {};
    var at = input.at || new Date().toISOString();
    var reg = deepCopyRegistry(prev);
    var findings = arrayOrEmpty(input.findings);
    var dispositions = arrayOrEmpty(input.dispositions);
    var confirmations = arrayOrEmpty(input.confirmations);
    var round = parseInt(input.round, 10) || nextRoundOf(reg);
    var outcome = emptyOutcome(reg, round);

    var hadPending = Array.isArray(reg.pending) && reg.pending.length > 0;
    var previousPending = arrayOrEmpty(reg.pending);
    reg.pending = [];

    resolvePreviousPending(reg, previousPending, confirmations, round, at, outcome);
    applyDispositions(reg, dispositions, round, at, outcome);
    registerFindings(reg, findings, round, at, policy, outcome);

    if (!roundActed(findings, dispositions, confirmations, hadPending, outcome)) return null;

    reg.rounds.push({
        round: round, at: at, raised: findings.length,
        newIdentities: outcome.newIdentities.length,
        autoMerged: outcome.autoMerged.length,
        candidates: outcome.candidates.length,
        confirmedMerges: outcome.confirmedMerges.length,
        promoted: outcome.promoted.length
    });
    return outcome;
}

// ── marker persistence (the house dmtools: marker pattern) ───────────────────

// Marker hygiene (escaping) and the parse walk live in reviewVerdicts — the
// shared dmtools: marker plumbing (gh-1329 rework, gh-1251 duplication
// ratchet): this module keeps only its MARKER_PREFIX and payload adapter.
// The registry keeps the SHAPE-AGNOSTIC walk (no fail-closed gate): its
// callers pass the machine-author allowlist when one is configured, and a
// missing allowlist degrades to "read every registry marker" — context
// injection only, never a verdict re-route.

function registryPayload(registry) {
    return {
        v: registry.v || REGISTRY_VERSION,
        at: registry.at || new Date().toISOString(),
        next: registry.next || 1,
        items: registry.items,
        pending: arrayOrEmpty(registry.pending),
        rounds: arrayOrEmpty(registry.rounds)
    };
}

function openItemCount(items) {
    var open = 0;
    items.forEach(function(i) {
        if (isOpenStatus(i.status)) open++;
    });
    return open;
}

function registryNote(open, pendingCount) {
    return '\uD83E\uDD16 Finding-identity registry — ' + open +
        ' open finding identit' + (open === 1 ? 'y' : 'ies') + ', ' + pendingCount +
        ' candidate(s) pending confirmation. Machine-managed review-round bookkeeping; please do not edit or reply.';
}

/**
 * Builds the registry marker comment for a round: the machine-parseable
 * one-line payload plus a short provider-independent human note. Returns null
 * for a non-postable registry (no items array — a registry without items is
 * not a registry).
 */
function buildRegistryComment(registry) {
    if (!registry || !Array.isArray(registry.items)) return null;
    var payload = registryPayload(registry);
    var note = registryNote(openItemCount(payload.items), payload.pending.length);
    return MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) + MARKER_SUFFIX + '\n' + note;
}

// The machine-author trust gate (allowlist, '[bot]'-normalized login match)
// and the trusted-marker walk live in reviewVerdicts (gh-1196, gh-1343
// rework) — parseRegistryComments below delegates to them. The marker format
// is public, so only allowlisted identities' registries are trusted: no
// configured identity → trust nothing.

function normalizeOpenStatuses(items) {
    items.forEach(function(i) {
        if (!isOpenStatus(i.status)) return;
        if (!i.status) i.status = STATUS_OPEN;
    });
}

function registryFromPayload(parsed) {
    if (!parsed || !Array.isArray(parsed.items)) return null;
    var reg = {
        v: parseInt(parsed.v, 10) || REGISTRY_VERSION,
        at: String(parsed.at || ''),
        next: parseInt(parsed.next, 10) || (parsed.items.length + 1),
        items: parsed.items,
        pending: arrayOrEmpty(parsed.pending),
        rounds: arrayOrEmpty(parsed.rounds)
    };
    normalizeOpenStatuses(reg.items);
    return reg;
}

// The atMs-based records order is the reviewVerdicts marker-convention one
// (payload order as the tiebreak, unparseable timestamps sink to the front).

/**
 * The PR comments list shape shared by both wiring sites (the post-review
 * stamping and the context-prep injection): a JSON string payload parses,
 * {comments}/{items} envelopes unwrap, anything else is []. Throws on a
 * broken JSON string — the error policy (catch-and-null vs caller-handled)
 * stays at each call site.
 */
function normalizePrCommentList(raw) {
    var obj = (typeof raw === 'string') ? JSON.parse(raw) : (raw || []);
    return Array.isArray(obj) ? obj : (obj.comments || obj.items || []);
}

/**
 * Parses ALL registry records from a PR comments payload — comments: [{body}]
 * (author fields consulted only when opts.authorLogins is passed). Returns
 * records oldest-first.
 */
function parseRegistryComments(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments, opts, MARKER_PREFIX, MARKER_SUFFIX,
        function(parsed) {
            var reg = registryFromPayload(parsed);
            return reg ? { registry: reg, at: reg.at } : null;
        }, false);
}

/**
 * The newest trusted registry record for a PR, or null when none exists.
 */
function latestRegistry(comments, opts) {
    var records = parseRegistryComments(comments, opts);
    return records.length ? records[records.length - 1] : null;
}

// ── policy: proposals tunable, decisions invariant ───────────────────────────

function namedThreshold(value) {
    var key = String(value || '').toLowerCase().trim();
    return CANDIDATE_THRESHOLDS.hasOwnProperty(key) ? CANDIDATE_THRESHOLDS[key] : null;
}

function numericThreshold(value) {
    var n = parseFloat(value);
    if (isNaN(n)) return null;
    if (n < MIN_CANDIDATE_THRESHOLD) return MIN_CANDIDATE_THRESHOLD;
    if (n > AUTO_MERGE_SIMILARITY) return AUTO_MERGE_SIMILARITY;
    return n;
}

function positiveIntOr(value, fallback) {
    var n = parseInt(value, 10);
    return n > 0 ? n : fallback;
}

/**
 * Resolves reviewPolicy.identity knobs (customParams win over project
 * config). The invariant decisions (auto-merge near-identical only,
 * escalate-on-merge) are NOT knobs — they are carried as constants so a
 * config-shaped gaming path cannot exist.
 */
function identityKnob(customParams, config) {
    var fromParams = customParams && customParams.reviewPolicy && customParams.reviewPolicy.identity;
    var fromConfig = config && config.reviewPolicy && config.reviewPolicy.identity;
    return fromParams || fromConfig || {};
}

function candidateThresholdOf(knob) {
    var threshold = namedThreshold(knob.claimSimilarityThreshold);
    if (threshold === null) threshold = numericThreshold(knob.claimSimilarityThreshold);
    if (threshold === null) threshold = CANDIDATE_THRESHOLDS[DEFAULT_CANDIDATE_THRESHOLD_NAME];
    return threshold;
}

function resolveIdentityPolicy(customParams, config) {
    var knob = identityKnob(customParams, config);
    return {
        candidateThreshold: candidateThresholdOf(knob),
        candidateScope: knob.candidateScope === 'diff' ? 'diff' : 'same-file',
        candidatesPerFinding: positiveIntOr(knob.candidatesPerFinding, 1),
        autoMergeSimilarity: AUTO_MERGE_SIMILARITY,
        severityOnMerge: SEVERITY_ON_MERGE
    };
}

// ── AC6: the escalation packet (convergence census + withdrawal visibility) ──

/**
 * The packet an owner escalation carries: the per-round NEW-identity series
 * (the safe convergence signal — distinguishes reviewer instability from
 * genuine churn without ever Goodharting the review) and every BLOCKING
 * withdrawal with its reason (invariant 3: visible, never silent).
 */
function blockingWithdrawals(items) {
    return items.filter(function(i) {
        return i.status === STATUS_WITHDRAWN && severityClassOf(i.severity) === 'BLOCKING';
    }).map(function(i) {
        return {
            n: i.n, id: i.id, file: i.file, severity: i.severity,
            claim: i.claim, reason: i.withdrawReason || '', at: i.resolvedAt || ''
        };
    });
}

// gh-1334: OPEN identities carrying demotion provenance — the owner sees the
// re-elevation path alongside the per-round new-identity counts. Resolved
// identities (fixed/withdrawn) are excluded: "(gh-1334; a cited re-raise
// re-elevates it)" is an instruction that no longer applies to a resolved
// item, and this is the same open-status space buildFindingsInjection
// renders its demotion guidance from — the two renders agree.
function demotionRecords(items) {
    return items.filter(function(i) {
        return !!i.demotion && isOpenStatus(i.status);
    }).map(function(i) {
        return {
            n: i.n, id: i.id, file: i.file, severity: i.severity, claim: i.claim,
            reason: i.demotion.reason || 'missing-citation',
            claimMatchedTicket: i.demotion.claimMatchedTicket || 'inconclusive',
            status: i.status
        };
    });
}

function buildEscalationPacket(registry) {
    var rounds = arrayOrEmpty(registry && registry.rounds);
    var items = arrayOrEmpty(registry && registry.items);
    return {
        rounds: rounds.map(function(r) {
            return { round: r.round, newIdentities: r.newIdentities || 0 };
        }),
        blockingWithdrawals: blockingWithdrawals(items),
        demotions: demotionRecords(items)
    };
}

/**
 * Renders the packet as a visible comment section; null when there is
 * nothing to report (no rounds — the registry never ran here). Withdrawal
 * reasons are marker-safe — reviewer text is echoed, never protocol.
 */
function buildEscalationPacketComment(registry) {
    var packet = buildEscalationPacket(registry);
    if (!packet.rounds.length) return null;
    var lines = ['\uD83D\uDD0D Finding-identity census — new identities per review round: ' +
        packet.rounds.map(function(r) { return 'round ' + r.round + ': ' + r.newIdentities; }).join(', ') + '.'];
    packet.blockingWithdrawals.forEach(function(w) {
        lines.push('\uD83D\uDEA8 F' + w.n + ' (' + w.severity + ') ' + w.file +
            ' \u2014 withdrawn: "' + reviewVerdicts.markerSafe(w.reason) + '" (no fixing hunk cited)');
    });
    packet.demotions.forEach(function(d) {
        lines.push('\u26A0\uFE0F F' + d.n + ' (' + d.file + ') demoted from BLOCKING \u2014 ' +
            d.reason + ', claimMatchedTicket: ' + d.claimMatchedTicket +
            ' (a cited re-raise re-elevates it)');
    });
    return lines.join('\n');
}

// ── next-round input-prep injection ──────────────────────────────────────────

/**
 * The context-prep injection for the next review round: the previously raised
 * findings (claim, file, status), the pending candidates for one-word
 * confirmation, and the structured answer contract. Null when there is
 * nothing open and nothing pending — a resolved registry injects nothing.
 */
/** The protocol header of the injection (what the reviewer must do per row). */
function injectionHeaderLines() {
    return [
        '## Previously raised findings (review-round registry)',
        '',
        'These defects were raised on earlier review rounds of this PR. For each finding below: ' +
            'verify fixed (cite the fixing hunk), withdraw (reason required), or mark re-introduced. ' +
            'New claims need new evidence — a claim already on this list is answered, not re-raised.',
        '',
        '| id | status | severity | file | claim |',
        '|----|--------|----------|------|-------|'
    ];
}

/** One markdown table row per open identity (stable F-labels). */
function findingTableRows(items) {
    return items.map(function(i) {
        return '| F' + i.n + ' | ' + i.status + ' | ' + i.severity + ' | ' + i.file + ' | ' + i.claim + ' |';
    });
}

// gh-1334: re-elevation guidance under the table — one block per demoted
// identity; the reviewer closes the gh-1332 amnesia loop by re-raising WITH
// a citation and confirming "same as F<n>" (merges only escalate).
function demotionGuidanceLines(items) {
    var lines = [];
    items.forEach(function(i) {
        if (!i.demotion) return;
        lines.push('');
        lines.push('- F' + i.n + ' was demoted from BLOCKING (' + (i.demotion.reason || 'missing-citation') +
            ', claimMatchedTicket: ' + (i.demotion.claimMatchedTicket || 'inconclusive') + '). If your new finding ' +
            'is this same defect, locate the requirement in the ticket and cite it (e.g. `ticket.md:3`), then confirm ' +
            '"same as F' + i.n + '" \u2014 a confirmed merge re-elevates the identity to BLOCKING (merges only escalate).');
    });
    return lines;
}

/** One line per pending candidate awaiting one-word confirmation. */
function pendingCandidateLines(pending) {
    return pending.map(function(c) {
        return '- Round ' + c.round + ' finding "' + c.claim + '" (' + c.file +
            (c.line ? ':' + c.line : '') + ') is possibly same as F' + c.proposedFor +
            ' \u2014 confirm ("same as F' + c.proposedFor + '") or mark it "new".';
    });
}

/** The structured findingReview answer contract the next round must follow. */
function findingAnswerContractLines() {
    return [
        '',
        '### How to answer',
        '',
        'Add a `findingReview` block to `outputs/pr_review.json` (alongside `inlineComments`):',
        '',
        '```json',
        '{"findingReview": {',
        '  "dispositions": [',
        '    {"n": 1, "status": "fixed", "hunk": "<file:lines \\u2014 the fixing hunk>"},',
        '    {"n": 2, "status": "withdrawn", "reason": "<why this is not a defect>"},',
        '    {"n": 3, "status": "re-introduced"}',
        '  ],',
        '  "confirmations": [',
        '    {"proposedFor": 1, "same": true}',
        '  ]',
        '}}',
        '```',
        '',
        'Unconfirmed candidates become new identities (the merge bias is confirm-only); ' +
            'a genuinely new finding on a resolved item is expected to be raised again with new evidence.'
    ];
}

function buildFindingsInjection(registry) {
    var open = openItems(registry);
    var pending = (registry && Array.isArray(registry.pending)) ? registry.pending : [];
    if (!open.length && !pending.length) return null;
    var lines = [].concat(injectionHeaderLines(), findingTableRows(open), demotionGuidanceLines(open));
    if (pending.length) {
        lines = lines.concat(['', '### Candidates pending confirmation'], pendingCandidateLines(pending));
    }
    return lines.concat(findingAnswerContractLines()).join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        REGISTRY_VERSION: REGISTRY_VERSION,
        SEVERITIES: SEVERITIES,
        AUTO_MERGE_SIMILARITY: AUTO_MERGE_SIMILARITY,
        CANDIDATE_THRESHOLDS: CANDIDATE_THRESHOLDS,
        OPEN_STATUSES: OPEN_STATUSES,
        normalizeClaim: normalizeClaim,
        contentWords: contentWords,
        claimSimilarity: claimSimilarity,
        severityClassOf: severityClassOf,
        severityRank: severityRank,
        maxSeverity: maxSeverity,
        findingIdentity: findingIdentity,
        emptyRegistry: emptyRegistry,
        openItems: openItems,
        nextRoundOf: nextRoundOf,
        reviewRoundLabel: reviewRoundLabel,
        itemById: itemById,
        matchFinding: matchFinding,
        applyRound: applyRound,
        buildRegistryComment: buildRegistryComment,
        normalizePrCommentList: normalizePrCommentList,
        parseRegistryComments: parseRegistryComments,
        latestRegistry: latestRegistry,
        resolveIdentityPolicy: resolveIdentityPolicy,
        buildEscalationPacket: buildEscalationPacket,
        buildEscalationPacketComment: buildEscalationPacketComment,
        buildFindingsInjection: buildFindingsInjection
    };
}
