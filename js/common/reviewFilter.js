/**
 * reviewFilter.js — the gh-1403 finding-filter leg (the ByteDance BitsAI-CR
 * ReviewFilter pattern): when `reviewPolicy.verification = filter`, a
 * FRESH-CONTEXT pass re-verifies each rework/polish-tier finding against the
 * code BEFORE it posts, so wrong or speculative findings never cost a
 * rework lap. The recall stage (the review leg) stays untouched — this
 * module is pure precision machinery around it:
 *
 *   select  — rework/polish-tier inlineComments become candidates. The
 *             policy decides (round `rework` | `polish`); round-`none`
 *             tiers (💡-digest lines are not threads at all, and 🪶 nits
 *             under the default preset) never go through. Each candidate
 *             carries the claim ONLY — the finder's severity line is
 *             stripped (anchoring / self-preference guard) and the
 *             severity/rationale fields never enter the filter input.
 *   parse   — outputs/pr_review_filter.json verdicts
 *             `keep | demote(<tier>) | drop`, each drop/demote with a
 *             one-line reason (the reason is the contract: a reasonless
 *             drop/demote is refused, fail-open to keep).
 *   apply   — keep → unchanged; demote → severity downgrade + the machine
 *             demotion provenance note (the gh-1053 head, so the gh-1332
 *             registry strips it from the claim); drop → the thread is
 *             removed from inlineComments and becomes a digest line
 *             (visible in the general comment, never a thread).
 *   census  — recomputed AFTER filtering from the posted-evidence set
 *             (threads by severity + the agent's digest lines + one digest
 *             line per dropped candidate). The gh-1351 verdict machinery
 *             then reads the recomputed census unchanged.
 *   stats   — drop rate per round; drop-rate 100% fires the
 *             anti-over-suppression warning: a filter that drops everything
 *             is misconfigured, not a better reviewer.
 *
 * Pure module — no dmtools globals; JSON-safe data only. Requires hoisted
 * (the gh-823 pack-require rule). Keep it GraalJS-clean (var + plain
 * functions).
 */
'use strict';

var reviewPolicy = require('./reviewPolicy.js');
var reviewVerdicts = require('./reviewVerdicts.js');
var reviewSpecClaims = require('./reviewSpecClaims.js');

// The filter's output contract (a sibling artifact of pr_review.json — the
// gh-1403 "sibling pr_review_filter.json leg" shape) and its input file.
var OUTPUT_FILE = 'pr_review_filter.json';
var INPUT_FILE = 'pr_review_filter_input.json';

// The verdict enum. demote carries a tier; drop/keep do not.
var VERDICT_DECISIONS = ['keep', 'demote', 'drop'];

// The claim truncation for digest lines — a digest line is one line.
var DIGEST_CLAIM_MAX = 160;

// ── Candidate selection ──────────────────────────────────────────────────────

/**
 * The inlineComments list of a review payload — [] for null payloads and
 * non-array fields (every caller needs the same empty-list read).
 */
function inlineListOf(reviewData) {
    return reviewData && Array.isArray(reviewData.inlineComments) ? reviewData.inlineComments : [];
}

/**
 * The tier order rank (lower = more severe). Unknown tiers rank last — a
 * demote target must rank strictly HIGHER (less severe) than the finding's
 * tier.
 */
function tierRank(tier) {
    var idx = reviewPolicy.TIERS.indexOf(String(tier || ''));
    return idx === -1 ? reviewPolicy.TIERS.length : idx;
}

/**
 * The filterable-tier read: the resolved policy decides (gh-1403 "only
 * rework/polish-tier candidates are filtered") — a tier whose round is
 * `rework` or `polish` goes through; round `none` never does.
 */
function isFilterableTier(severity, policy) {
    var p = policy || reviewPolicy.defaultPolicy();
    var sev = p.severities[String(severity || '')];
    return !!sev && (sev.round === 'rework' || sev.round === 'polish');
}

/**
 * The claim a filter candidate carries: the finder's text with the machine
 * severity line stripped (the anchoring/self-preference guard — the filter
 * never sees the finder's severity). resolveClaim mirrors the poster's
 * resolution (inline body, else the referenced comment file) and is
 * injected by the caller, keeping this module free of file access.
 */
function claimOf(inlineComment, resolveClaim) {
    var claim = resolveClaim(inlineComment);
    return reviewVerdicts.stripLeadingSeverityLine(String(claim || ''));
}

/**
 * One candidate from one inline comment, or null when the finding must not
 * go through the filter: not a filterable tier, or no resolvable claim —
 * there is nothing to verify.
 */
function filterCandidateOf(c, id, policy, resolveClaim) {
    if (!isFilterableTier(c.severity, policy)) return null;
    var claim = claimOf(c, resolveClaim);
    if (!claim || !claim.trim()) return null;
    return {
        id: id,
        path: c.path || c.file || '',
        line: c.line,
        severity: c.severity,
        claim: claim
    };
}

/**
 * The round's filter candidates: {id, path, line, severity, claim} where id
 * is the position in the ORIGINAL inlineComments array (the verdict file's
 * join key). Findings without a resolvable claim are skipped — there is
 * nothing to verify.
 */
function selectFilterCandidates(reviewData, policy, resolveClaim) {
    var inline = inlineListOf(reviewData);
    var candidates = [];
    for (var i = 0; i < inline.length; i++) {
        var candidate = filterCandidateOf(inline[i] || {}, i, policy, resolveClaim);
        if (candidate) candidates.push(candidate);
    }
    return candidates;
}

// ── Verdict parsing ──────────────────────────────────────────────────────────

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}

/**
 * The verdict id: numbers ride as-is, numeric strings fall back to parseInt
 * (the verdict file is model-written — ids may arrive quoted).
 */
function verdictIdOf(v) {
    return typeof v.id === 'number' ? v.id : parseInt(v.id, 10);
}

/**
 * The demote target tier, upper-cased and validated against the policy tier
 * list. null (with a note) when the tier is unknown — a demote to a
 * non-tier is structurally refused.
 */
function demoteTierOf(v, id, notes) {
    var tier = String(v.tier || '').trim().toUpperCase();
    if (reviewPolicy.TIERS.indexOf(tier) === -1) {
        notes.push('ignoring demote for candidate ' + id + ': unknown tier ' + JSON.stringify(v.tier));
        return null;
    }
    return tier;
}

/**
 * The verdict's one-line reason, or null. The reason is part of the output
 * contract for drop/demote (checked by the caller).
 */
function verdictReasonOf(v) {
    return isNonEmptyString(v.reason) ? v.reason.trim() : null;
}

/**
 * The structural head of one verdict — object shape, id, known decision,
 * not a duplicate — or null with a note.
 */
function parseVerdictHead(v, seenIds, notes) {
    if (!v || typeof v !== 'object') {
        notes.push('ignoring non-object verdict entry');
        return null;
    }
    var id = verdictIdOf(v);
    if (isNaN(id)) {
        notes.push('ignoring verdict without a numeric id');
        return null;
    }
    var decision = String(v.decision || '').trim().toLowerCase();
    if (VERDICT_DECISIONS.indexOf(decision) === -1) {
        notes.push('ignoring verdict ' + id + ': unknown decision ' + JSON.stringify(v.decision));
        return null;
    }
    if (seenIds[id]) {
        notes.push('ignoring duplicate verdict for candidate ' + id + ' — first wins');
        return null;
    }
    return { id: id, decision: decision };
}

/**
 * The contract tail of one verdict — the demote tier (when demote) and the
 * mandatory one-line reason for drop/demote — or null with a note.
 * Structural only — the downgrade check needs the candidate's own tier and
 * runs at apply time.
 */
function parseVerdictTail(v, id, decision, notes) {
    var tier = decision === 'demote' ? demoteTierOf(v, id, notes) : null;
    if (decision === 'demote' && tier === null) return null;
    var reason = verdictReasonOf(v);
    if (decision !== 'keep' && !reason) {
        // gh-1403: the one-line reason is part of the output contract — a
        // reasonless drop/demote is refused (fail-open to keep).
        notes.push('ignoring ' + decision + ' for candidate ' + id + ': missing one-line reason');
        return null;
    }
    return { id: id, decision: decision, tier: tier, reason: reason };
}

/**
 * One structural verdict, or null with a note. The seenIds mark lands only
 * after every check passes (a refused verdict never consumes its id).
 */
function parseOneVerdict(v, seenIds, notes) {
    var head = parseVerdictHead(v, seenIds, notes);
    if (!head) return null;
    var verdict = parseVerdictTail(v, head.id, head.decision, notes);
    if (!verdict) return null;
    seenIds[head.id] = true;
    return verdict;
}

/**
 * The verdicts array of a parsed payload, or null with a note when the
 * payload carries none.
 */
function verdictsListOf(parsed, notes) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.verdicts)) {
        notes.push('filter verdicts carry no verdicts array — running unfiltered');
        return null;
    }
    return parsed.verdicts;
}

/**
 * Parses the filter verdict payload (the raw file text or a parsed object)
 * into { verdicts, notes }. Malformed JSON, non-object payloads and
 * structurally invalid entries degrade to notes + fewer verdicts — the
 * filter can never make the posting leg fail (fail-open to keep).
 */
function parseFilterVerdicts(raw) {
    var notes = [];
    var parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            notes.push('filter verdicts are not valid JSON — running unfiltered');
            return { verdicts: [], notes: notes };
        }
    }
    var verdictList = verdictsListOf(parsed, notes);
    if (!verdictList) return { verdicts: [], notes: notes };
    var seenIds = {};
    var verdicts = [];
    for (var i = 0; i < verdictList.length; i++) {
        var verdict = parseOneVerdict(verdictList[i], seenIds, notes);
        if (verdict) verdicts.push(verdict);
    }
    return { verdicts: verdicts, notes: notes };
}

// ── Verdict application ──────────────────────────────────────────────────────

/**
 * The machine demotion provenance note for a filter demote — the gh-1053
 * demotion head (so the gh-1332 registry strips the machine tail from the
 * cross-round claim) with the filter's own provenance + reason.
 */
function demotionNote(reason) {
    return reviewSpecClaims.DEMOTION_NOTE_HEAD +
        ': review-filter demotion (gh-1403)** — fresh-context verification: ' + String(reason || '');
}

function candidateById(candidates, id) {
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].id === id) return candidates[i];
    }
    return null;
}

function inlineIndexOf(reviewData, id) {
    var inline = inlineListOf(reviewData);
    for (var i = 0; i < inline.length; i++) {
        if ((inline[i] || {}).__filterId === id) return i;
    }
    return -1;
}

/**
 * The one-shot identity tags that make a drop-by-id splice the right object
 * even when the array shifted under an earlier drop — and their cleanup
 * before the payload posts.
 */
function tagFilterIds(inline) {
    for (var t = 0; t < inline.length; t++) {
        inline[t].__filterId = t;
    }
}

function untagFilterIds(inline) {
    for (var u = 0; u < inline.length; u++) {
        delete inline[u].__filterId;
    }
}

/**
 * The machine demotion provenance note for a filter demote — the gh-1053
 * demotion head (so the gh-1332 registry strips the machine tail from the
 * cross-round claim) with the filter's own provenance + reason.
 */
function demotionNote(reason) {
    return reviewSpecClaims.DEMOTION_NOTE_HEAD +
        ': review-filter demotion (gh-1403)** — fresh-context verification: ' + String(reason || '');
}

/**
 * The demotion provenance appended to an INLINE body. File-referenced
 * findings get the note appended to their comment file by the runner (file
 * writes stay out of this module).
 */
function stampDemotionBody(entry, note) {
    if (typeof entry.body === 'string' && entry.body.trim()) {
        entry.body = entry.body.replace(/\s*$/, '') + '\n' + note;
    }
}

/**
 * The keep outcome: the finding posts unchanged.
 */
function applyKeepVerdict(v, applied) {
    applied.push({ id: v.id, decision: 'keep', reason: v.reason || null });
}

/**
 * A demote, or null when refused — a target that does not rank strictly
 * below the finding's tier is refused with a note (fail-open to keep), and
 * a thread that vanished under an earlier drop has nothing to demote.
 */
function demoteOutcomeOf(reviewData, candidate, v, notes) {
    if (tierRank(v.tier) <= tierRank(candidate.severity)) {
        notes.push('demote refused for candidate ' + v.id + ': ' + v.tier +
            ' does not rank below ' + candidate.severity);
        return null;
    }
    var idx = inlineIndexOf(reviewData, v.id);
    if (idx === -1) return null;
    var note = demotionNote(v.reason);
    var entry = inlineListOf(reviewData)[idx];
    entry.severity = v.tier;
    stampDemotionBody(entry, note);
    return {
        id: v.id, decision: 'demote', from: candidate.severity, to: v.tier,
        reason: v.reason, note: note,
        path: candidate.path, line: candidate.line
    };
}

/**
 * A drop: the thread is spliced out of inlineComments (it re-surfaces as a
 * digest line). A thread that vanished under an earlier drop has nothing to
 * drop.
 */
function applyDropVerdict(reviewData, candidate, v, dropped, applied) {
    var dropIdx = inlineIndexOf(reviewData, v.id);
    if (dropIdx === -1) return;
    inlineListOf(reviewData).splice(dropIdx, 1);
    dropped.push({
        id: v.id, path: candidate.path, line: candidate.line,
        severity: candidate.severity, claim: candidate.claim, reason: v.reason
    });
    applied.push({ id: v.id, decision: 'drop', reason: v.reason });
}

/**
 * One verdict dispatched to its decision handler. Unknown candidate ids and
 * vanished threads are noted/skipped — never fatal.
 */
function applyOneVerdict(reviewData, candidates, v, applied, dropped, notes) {
    var candidate = candidateById(candidates, v.id);
    if (!candidate) {
        notes.push('verdict for unknown candidate ' + v.id + ' ignored');
        return;
    }
    if (v.decision === 'keep') {
        applyKeepVerdict(v, applied);
        return;
    }
    if (v.decision === 'demote') {
        var demoted = demoteOutcomeOf(reviewData, candidate, v, notes);
        if (demoted) applied.push(demoted);
        return;
    }
    applyDropVerdict(reviewData, candidate, v, dropped, applied);
}

/**
 * Applies parsed verdicts to the review data IN PLACE: demote downgrades
 * the structured severity (the poster machine-stamps from it); drop
 * removes the thread (it re-surfaces as a digest line). Demote targets
 * must rank strictly lower than the finding's tier — anything else is
 * refused with a note (fail-open to keep). Returns
 * { applied, dropped, notes, changed }.
 */
function applyFilterVerdicts(reviewData, candidates, verdicts) {
    var inline = inlineListOf(reviewData);
    // Tag the live entries once so a drop-by-id splices the right object
    // even when the array shifted under an earlier drop.
    tagFilterIds(inline);
    var applied = [];
    var dropped = [];
    var notes = [];
    var list = Array.isArray(verdicts) ? verdicts : [];
    for (var i = 0; i < list.length; i++) {
        applyOneVerdict(reviewData, candidates, list[i] || {}, applied, dropped, notes);
    }
    untagFilterIds(inline);
    return {
        applied: applied,
        dropped: dropped,
        notes: notes,
        changed: applied.length > 0
    };
}

// ── Post-filter census recomputation ─────────────────────────────────────────

/**
 * The census bucket name for one thread severity. An unknown severity never
 * gates — it counts as a digest line (visible, never an approval gate).
 */
function censusSevKey(sev) {
    if (sev === 'BLOCKING') return 'blocking';
    if (sev === 'IMPORTANT') return 'important';
    if (sev === 'SUGGESTION') return 'suggestions';
    if (sev === 'NIT') return 'nits';
    return 'digest';
}

/**
 * The digest bucket: the agent's digest census preserved, plus one digest
 * line per dropped candidate.
 */
function digestCensusOf(reviewData, droppedCount) {
    var counts = (reviewData && reviewData.issueCounts) || {};
    return reviewVerdicts.censusCount(counts.digest) + reviewVerdicts.censusCount(droppedCount);
}

/**
 * The census recomputed AFTER filtering (gh-1403 machine semantics; the
 * gh-1351 verdict machinery reads it unchanged): threads counted by their
 * structured severity, the agent's digest census preserved, plus one digest
 * line per dropped candidate.
 */
function recomputeCensus(reviewData, droppedCount) {
    var inline = inlineListOf(reviewData);
    var census = {
        blocking: 0,
        important: 0,
        suggestions: 0,
        nits: 0,
        digest: digestCensusOf(reviewData, droppedCount)
    };
    for (var i = 0; i < inline.length; i++) {
        var sev = String((inline[i] || {}).severity || '').trim().toUpperCase();
        census[censusSevKey(sev)]++;
    }
    return census;
}

// ── Anti-over-suppression stats ──────────────────────────────────────────────

function roundRate(value) {
    return Math.round(value * 1000) / 1000;
}

/**
 * Per-round filter stats. decision entries carry 'keep' | 'demote' | 'drop'
 * (applyFilterVerdicts output).
 */
function filterStats(candidates, applied) {
    var list = Array.isArray(applied) ? applied : [];
    var kept = 0;
    var demoted = 0;
    var dropped = 0;
    for (var i = 0; i < list.length; i++) {
        if (list[i].decision === 'keep') kept++;
        else if (list[i].decision === 'demote') demoted++;
        else if (list[i].decision === 'drop') dropped++;
    }
    var total = candidates || 0;
    return {
        candidates: total,
        kept: kept,
        demoted: demoted,
        dropped: dropped,
        dropRate: total === 0 ? 0 : roundRate(dropped / total)
    };
}

/**
 * The anti-over-suppression warning (gh-1403): a filter that drops EVERY
 * candidate is misconfigured, not a better reviewer. Log + stamp signal —
 * never a behavior change. null when the round looks sane.
 */
function buildOverSuppressionWarning(stats) {
    if (!stats || stats.candidates === 0) return null;
    if (stats.dropped < stats.candidates) return null;
    return '🧯 review filter (gh-1403): drop rate ' + stats.dropped + '/' + stats.candidates +
        ' (100%) — a filter that drops everything is MISCONFIGURED, not a better reviewer. ' +
        'Check reviewPolicy.verification on this repo: the trial bar is fewer laps AND kept precision, not silence.';
}

// ── Digest lines + general-comment injection ─────────────────────────────────

function truncatedClaim(claim) {
    var text = String(claim || '').replace(/\s+/g, ' ').trim();
    if (text.length <= DIGEST_CLAIM_MAX) return text;
    return text.substring(0, DIGEST_CLAIM_MAX - 1) + '…';
}

/**
 * One digest line per dropped candidate (visible, never a thread) — the
 * anti-over-suppression listing: every drop stays auditable in the general
 * comment.
 */
function buildDroppedDigestLine(entry) {
    return '- `' + entry.path + ':' + entry.line + '` — ' + truncatedClaim(entry.claim) +
        ' — 🧯 filter drop: ' + String(entry.reason || 'no reason given');
}

function buildDroppedDigestLines(dropped) {
    var list = Array.isArray(dropped) ? dropped : [];
    var lines = [];
    for (var i = 0; i < list.length; i++) {
        lines.push(buildDroppedDigestLine(list[i]));
    }
    return lines;
}

/**
 * The general-comment section appended after filtering: the round's filter
 * stats + the dropped list (one line each). null when nothing was dropped —
 * a clean round adds nothing to the comment.
 */
function buildGeneralCommentInjection(stats, dropped) {
    var lines = buildDroppedDigestLines(dropped);
    if (lines.length === 0) return null;
    var out = [];
    out.push('## 🧯 Review filter (gh-1403)');
    out.push('');
    out.push(buildFilterStampLine(stats));
    out.push('');
    out.push('Dropped candidates — verified against the code by a fresh-context pass; ' +
        'visible here, never posted as threads:');
    out.push('');
    return out.concat(lines).join('\n');
}

/**
 * The one-line round summary (logs, tracker stamp): candidates → kept /
 * demoted / dropped with the drop-rate percentage.
 */
function buildFilterStampLine(stats) {
    var s = stats || filterStats(0, []);
    var percent = Math.round((s.dropRate || 0) * 100);
    return '🧯 Review filter (gh-1403): ' + s.candidates + ' candidate(s) → kept ' + s.kept +
        ' · demoted ' + s.demoted + ' · dropped ' + s.dropped + ' (drop rate ' + percent + '%)';
}

// ── Filter input + prompt builders ───────────────────────────────────────────

/**
 * The filter input payload — candidates WITHOUT the finder's severity or
 * rationale (the anchoring/self-preference guard): id, path, line, claim.
 */
function buildFilterInputJson(candidates) {
    var stripped = (candidates || []).map(function(c) {
        return { id: c.id, path: c.path, line: c.line, claim: c.claim };
    });
    return JSON.stringify({ candidates: stripped }, null, 2);
}

/**
 * The fresh-context filter prompt: verify each candidate against the diff
 * hunks + the interaction neighborhood (callers/callees of the changed
 * symbols — never whole files; over-broad context manufactures findings),
 * then write the verdict file. The prompt never mentions the finder's
 * severity — the input does not carry it either. codeRoot (optional) names
 * the checkout the PR branch lives in when config.workingDir is set.
 */
function buildFilterPrompt(diffPath, codeRoot) {
    var lines = [];
    lines.push('# Review Filter pass (gh-1403) — verify candidate findings before they are posted');
    lines.push('');
    lines.push('You are a SEPARATE verification pass, NOT the reviewer. A first-pass review of this PR ' +
        'produced the candidate findings below. Your job is to verify each candidate against the actual ' +
        'code and decide what should be posted. Maximize precision: a finding that costs a review thread ' +
        'must be real.');
    lines.push('');
    lines.push('## Inputs');
    lines.push('');
    lines.push('1. `' + 'outputs/' + INPUT_FILE + '` — the candidates (id, path, line, claim). ' +
        'The finder\'s severity and rationale are deliberately NOT included — judge each claim on its own ' +
        'merits, with no anchor to the finder\'s confidence.');
    lines.push('2. `' + diffPath + '` — the diff hunks under review. Findings live on these hunks.');
    if (codeRoot) {
        lines.push('   The PR branch is checked out at `' + codeRoot + '` — read code there.');
    }
    lines.push('3. The interaction neighborhood: callers/callees of the changed symbols ' +
        '(`codegraph_callers` / `codegraph_callees` when available, else a scoped `grep` for the symbol ' +
        'name). Do NOT read whole files beyond what verification needs — over-broad context manufactures ' +
        'findings.');
    lines.push('');
    lines.push('## Verdict rules');
    lines.push('');
    lines.push('For each candidate decide exactly one:');
    lines.push('');
    lines.push('- `keep` — the claim is correct and worth a review thread.');
    lines.push('- `demote(<tier>)` — the claim is real but overstated; tier is a strictly lower severity ' +
        '(BLOCKING > IMPORTANT > SUGGESTION > NIT).');
    lines.push('- `drop` — the claim is wrong, speculative, or not worth a thread.');
    lines.push('');
    lines.push('Every drop/demote REQUIRES a one-line reason (posted verbatim next to the finding — write ' +
        'it for a human author, not for a machine).');
    lines.push('');
    lines.push('## Output (mandatory)');
    lines.push('');
    lines.push('Write `' + 'outputs/' + OUTPUT_FILE + '`:');
    lines.push('');
    lines.push('```json');
    lines.push('{"verdicts": [');
    lines.push('  {"id": 1, "decision": "keep"},');
    lines.push('  {"id": 2, "decision": "demote", "tier": "SUGGESTION", "reason": "real but cosmetic — style-level"},');
    lines.push('  {"id": 3, "decision": "drop", "reason": "claim contradicted by the upstream guard at src/x.ts:40"}');
    lines.push(']}');
    lines.push('```');
    lines.push('');
    lines.push('Rules: one verdict per candidate id, every id in the input must appear; verify against the ' +
        'code you actually read, never against the claim\'s own confidence.');
    lines.push('');
    lines.push('Boundaries: do NOT write `outputs/response.md`; do NOT modify any product code or tests; ' +
        'do NOT post comments or replies; do NOT re-run the review — verify the given candidates only.');
    return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        OUTPUT_FILE: OUTPUT_FILE,
        INPUT_FILE: INPUT_FILE,
        VERDICT_DECISIONS: VERDICT_DECISIONS,
        DIGEST_CLAIM_MAX: DIGEST_CLAIM_MAX,
        tierRank: tierRank,
        isFilterableTier: isFilterableTier,
        selectFilterCandidates: selectFilterCandidates,
        parseFilterVerdicts: parseFilterVerdicts,
        demotionNote: demotionNote,
        applyFilterVerdicts: applyFilterVerdicts,
        recomputeCensus: recomputeCensus,
        filterStats: filterStats,
        buildOverSuppressionWarning: buildOverSuppressionWarning,
        buildDroppedDigestLine: buildDroppedDigestLine,
        buildDroppedDigestLines: buildDroppedDigestLines,
        buildGeneralCommentInjection: buildGeneralCommentInjection,
        buildFilterStampLine: buildFilterStampLine,
        buildFilterInputJson: buildFilterInputJson,
        buildFilterPrompt: buildFilterPrompt
    };
}
