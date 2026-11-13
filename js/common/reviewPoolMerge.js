/**
 * reviewPoolMerge.js — the gh-1406 §5 pool duties at the filter merge point:
 * the pure machinery that turns N reviewers' candidate lists into ONE
 * deduplicated census input for the gh-1403 filter leg.
 *
 * §5 duties (build with #1403 — reviewFilter.js stays the per-round filter
 * engine; this module is the pool layer around it):
 *   - cross-reviewer dedup: base and security flagging the same defect
 *     become ONE candidate identity (path + line + claim fingerprint);
 *     severity may only ESCALATE (the merged candidate carries the most
 *     severe of its sources) and the merged entry names every reviewer
 *     that raised it (census attribution + the packet);
 *   - weighted retention: filterWeight "high" candidates cannot be silently
 *     dropped — a drop/demote verdict for a high-weight candidate needs a
 *     stated reason (the gh-1403 contract already requires reasons; this is
 *     the pool-layer defense-in-depth) and every high-weight drop/demote
 *     surfaces explicitly in the packet;
 *   - availability is fail-open: an enabled reviewer whose candidate
 *     payload is missing is noted in the packet ("X unavailable this
 *     round") and the round proceeds (§4); required reviewers are the
 *     merge gate's business (reviewPoolMarkers — §7), never the filter's.
 *
 * Candidate payload shape (per reviewer, one file/record per reviewer):
 *   { reviewer: "security", candidates: [{ id, path, line, severity, claim }] }
 * The merged output feeds reviewFilter.buildFilterInputJson directly (id,
 * path, line, claim survive; reviewers/highWeight are pool metadata the
 * filter never sees — the finder's identity must not anchor it).
 *
 * Pure module — no dmtools globals; JSON-safe data only. Requires hoisted
 * (gh-823 pack-require rule). Keep it GraalJS-clean (var + plain functions).
 */
'use strict';

var reviewPolicy = require('./reviewPolicy.js');

// The claim fingerprint length for the dedup key — identical-defect claims
// from two reviewers rarely agree verbatim beyond this prefix after
// normalization; the identity is path+line anchored, so the prefix guards
// against false merges at the same spot, not against paraphrase misses
// (a paraphrased duplicate posts twice — the filter, not the merge, judges).
var CLAIM_FINGERPRINT_MAX = 120;

// ── claim fingerprint + identity ─────────────────────────────────────────────

/**
 * The normalized claim fingerprint: lowercase, whitespace-collapsed, claim
 * truncated to the fingerprint length. Two candidates merge only on
 * path+line+identical fingerprint.
 */
function claimFingerprint(claim) {
    var text = String(claim || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (text.length > CLAIM_FINGERPRINT_MAX) text = text.substring(0, CLAIM_FINGERPRINT_MAX);
    return text;
}

/** The candidate identity key (§5 cross-reviewer dedup). */
function candidateIdentity(path, line, claim) {
    return String(path || '') + ':' + String(line === undefined || line === null ? '' : line) + ':' +
        claimFingerprint(claim);
}

/** The severity rank (lower = more severe; unknown tiers rank last). */
function severityRank(severity) {
    var idx = reviewPolicy.TIERS.indexOf(String(severity || '').toUpperCase());
    return idx === -1 ? reviewPolicy.TIERS.length : idx;
}

/**
 * The more severe of two tiers (§5: "severity may only escalate"). Unknown
 * tiers lose to known ones.
 */
function mostSevere(a, b) {
    return severityRank(a) <= severityRank(b) ? String(a || '').toUpperCase() : String(b || '').toUpperCase();
}

// ── candidate merging ────────────────────────────────────────────────────────

function candidateListOf(list) {
    return list && Array.isArray(list.candidates) ? list.candidates : [];
}

function reviewerNameOf(list, index) {
    return (list && list.reviewer) || 'reviewer-' + index;
}

function filterWeightOf(list) {
    return list && list.filterWeight === 'high' ? 'high' : 'normal';
}

/**
 * One merged candidate entry — the pool metadata rides alongside the
 * filter-visible fields (id/path/line/severity/claim). `_baseIndex`
 * (gh-1471, optional) is the aggregation's provenance — the rebuilt inline
 * list reuses the ORIGINAL posting-leg entry for a base-provenanced
 * candidate; the filter input never sees it.
 */
function mergedCandidateOf(c, id, reviewer, highWeight) {
    var entry = {
        id: id,
        path: String((c && c.path) || ''),
        line: c ? c.line : undefined,
        severity: String((c && c.severity) || '').toUpperCase(),
        claim: String((c && c.claim) || ''),
        reviewers: [reviewer],
        highWeight: highWeight === true
    };
    if (c && c._baseIndex !== undefined) entry._baseIndex = c._baseIndex;
    return entry;
}

/**
 * ONE candidate against the merged identity map: first sight creates the
 * entry, a same-reviewer repeat is deduped (first wins, noted), a
 * cross-reviewer match merges in place (severity may only escalate, §5).
 */
function mergeOneCandidate(byIdentity, merged, notes, candidate, reviewer, highWeight) {
    var identity = candidateIdentity(candidate.path, candidate.line, candidate.claim);
    var existing = byIdentity[identity];
    if (!existing) {
        var entry = mergedCandidateOf(candidate, merged.length, reviewer, highWeight);
        byIdentity[identity] = entry;
        merged.push(entry);
        return;
    }
    if (existing.reviewers.indexOf(reviewer) !== -1) {
        notes.push('duplicate candidate from ' + reviewer + ' at ' + existing.path + ':' +
            existing.line + ' — first wins');
        return;
    }
    // Cross-reviewer match: one identity, severity escalates only.
    var before = existing.severity;
    existing.severity = mostSevere(existing.severity, candidate.severity);
    existing.highWeight = existing.highWeight || highWeight;
    existing.reviewers.push(reviewer);
    notes.push('cross-reviewer match at ' + existing.path + ':' + existing.line + ' — ' +
        existing.reviewers.join(' + ') +
        (existing.severity !== before ? '; severity escalated ' + before + ' → ' + existing.severity : ''));
}

/**
 * The pool merge (§5): N candidate lists → ONE deduplicated candidate list.
 * Identity = path + line + claim fingerprint. Same reviewer re-raising the
 * same identity is deduped (first wins, noted); two DIFFERENT reviewers on
 * one identity merge into a single candidate (severity may only escalate,
 * reviewers recorded). Returns { merged, notes }.
 */
function mergeCandidateLists(lists) {
    var byIdentity = {};
    var merged = [];
    var notes = [];
    var input = Array.isArray(lists) ? lists : [];
    for (var i = 0; i < input.length; i++) {
        var list = input[i] || {};
        var candidates = candidateListOf(list);
        for (var c = 0; c < candidates.length; c++) {
            mergeOneCandidate(byIdentity, merged, notes, candidates[c] || {},
                reviewerNameOf(list, i), filterWeightOf(list) === 'high');
        }
    }
    return { merged: merged, notes: notes };
}

// ── weighted retention (§5) ──────────────────────────────────────────────────

function mergedById(merged, id) {
    var list = Array.isArray(merged) ? merged : [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
    }
    return null;
}

/**
 * §5 weighted retention — the refusal predicate: a drop/demote of a
 * HIGH-WEIGHT candidate without a stated reason must be refused (the
 * reviewer cannot silently bury a high-weight finding).
 */
function highWeightRefusalOf(v, candidate) {
    if (!candidate || !candidate.highWeight) return false;
    if (v.decision !== 'drop' && v.decision !== 'demote') return false;
    return !v.reason || !String(v.reason).trim();
}

/** The note recorded for a refused weighted-retention suppression. */
function weightedRefusalNoteOf(v, candidate) {
    return 'weighted retention: ' + v.decision + ' refused for high-weight candidate ' + v.id +
        ' (' + candidate.reviewers.join(', ') + ') — demote/drop needs a stated reason';
}

/**
 * §5 weighted retention: the applied verdicts against the merged census.
 * A drop/demote of a HIGH-WEIGHT candidate without a stated reason is
 * refused to `keep` with a note — silence is never precision for a
 * high-weight source. Returns { verdicts (the retention-checked list),
 * refused, notes }.
 */
function applyWeightedRetention(merged, verdicts) {
    var out = [];
    var refused = [];
    var notes = [];
    var list = Array.isArray(verdicts) ? verdicts : [];
    for (var i = 0; i < list.length; i++) {
        var v = list[i] || {};
        var candidate = mergedById(merged, v.id);
        if (highWeightRefusalOf(v, candidate)) {
            refused.push({ id: v.id, reviewer: candidate.reviewers.join(', '), decision: v.decision });
            notes.push(weightedRefusalNoteOf(v, candidate));
            out.push({ id: v.id, decision: 'keep' });
            continue;
        }
        out.push(v);
    }
    return { verdicts: out, refused: refused, notes: notes };
}

/**
 * The high-weight outcomes of an applied verdict list — every drop/demote
 * of a high-weight candidate, with its stated reason. The packet surfaces
 * these explicitly (§5: "demote/drop requires a stated reason, surfaced in
 * the packet").
 */
function highWeightOutcomeRowOf(merged, a) {
    if (a.decision !== 'drop' && a.decision !== 'demote') return null;
    var candidate = mergedById(merged, a.id);
    if (!candidate || !candidate.highWeight) return null;
    return {
        id: a.id,
        decision: a.decision,
        reviewers: candidate.reviewers.slice(),
        path: candidate.path,
        line: candidate.line,
        reason: a.reason || null
    };
}

function highWeightOutcomesOf(merged, applied) {
    var out = [];
    var list = Array.isArray(applied) ? applied : [];
    for (var i = 0; i < list.length; i++) {
        var row = highWeightOutcomeRowOf(merged, list[i] || {});
        if (row) out.push(row);
    }
    return out;
}

// ── the availability + packet lines (§4 fail-open, §5 visibility) ───────────

/**
 * The availability packet lines for a round: one line per enabled reviewer
 * whose candidates did not arrive (fail-open — the round proceeds, the
 * packet notes it) and one summary line for what did.
 */
function availabilityPacketLines(arrived, unavailable, roundName) {
    var lines = [];
    var round = String(roundName || 'review');
    var arrivedNames = Array.isArray(arrived) ? arrived : [];
    var missingNames = Array.isArray(unavailable) ? unavailable : [];
    if (arrivedNames.length > 0) {
        lines.push('👥 Reviewer pool (' + round + '): candidates from ' + arrivedNames.join(', ') + '.');
    }
    for (var i = 0; i < missingNames.length; i++) {
        lines.push('👥 Reviewer pool (' + round + '): ' + missingNames[i] +
            ' unavailable this round — the round proceeds without its candidates (fail-open; ' +
            'required reviewers gate the merge, not the filter).');
    }
    return lines;
}

/** The `path[:line]` location fragment of a dropped candidate record. */
function poolCandidateLocOf(d) {
    var loc = String(d.path || 'unknown path');
    if (d.line !== undefined && d.line !== null) loc += ':' + d.line;
    return loc;
}

/** The whitespace-collapsed claim fragment (hard-wrapped at 160 chars). */
function poolCandidateClaimOf(d) {
    var claim = String(d.claim || '').replace(/\s+/g, ' ').trim();
    if (claim.length > 160) claim = claim.substring(0, 159) + '…';
    return claim;
}

/**
 * One digest line for a dropped pool candidate (reviewer-attributed — §5
 * drop visibility; the gh-1403 digest shape plus the source reviewers).
 */
function droppedPoolCandidateLine(drop) {
    var d = drop || {};
    var reviewers = Array.isArray(d.reviewers) ? d.reviewers : [];
    return '- `' + poolCandidateLocOf(d) + '` — ' + poolCandidateClaimOf(d) +
        ' — 🧯 filter drop [' + reviewers.join(', ') + ']: ' +
        String(d.reason || 'no reason given');
}

/**
 * The pool census line (sources = the union of candidate reviewers), or
 * null when the merged census is empty.
 */
function poolCensusLineOf(merged) {
    if (merged.length === 0) return null;
    var reviewers = {};
    for (var m = 0; m < merged.length; m++) {
        var rs = merged[m].reviewers || [];
        for (var r = 0; r < rs.length; r++) reviewers[rs[r]] = true;
    }
    return '👥 Pool census: ' + merged.length + ' candidate(s) after cross-reviewer dedup (sources: ' +
        Object.keys(reviewers).sort().join(', ') + ').';
}

/** One ⚖️ weighted-retention packet line for an applied drop/demote. */
function highWeightPacketLineOf(o) {
    var loc = String(o.path) + (o.line === undefined || o.line === null ? '' : ':' + o.line);
    return '⚖️ Weighted retention: ' + o.decision + ' of high-weight candidate #' + o.id +
        ' from ' + (o.reviewers || []).join(', ') + ' at ' + loc +
        ' — reason: ' + String(o.reason || '(stated in the filter verdict)');
}

/** The drop record's path/line pair, enriched from the merged census entry. */
function droppedPoolLocOf(drop, candidate) {
    return {
        path: drop.path || (candidate && candidate.path),
        line: drop.line !== undefined ? drop.line : (candidate && candidate.line)
    };
}

/** One 🧯 drop packet line: the drop record enriched from the merged census. */
function droppedPoolPacketLineOf(drop, merged) {
    var candidate = mergedById(merged, drop.id);
    var loc = droppedPoolLocOf(drop, candidate);
    return droppedPoolCandidateLine({
        path: loc.path,
        line: loc.line,
        claim: drop.claim || (candidate && candidate.claim),
        reviewers: candidate ? candidate.reviewers : [],
        reason: drop.reason
    });
}

/** Push mapper(item) for each item of list; null/undefined results skipped. */
function pushMappedLines(lines, list, mapper) {
    for (var i = 0; i < list.length; i++) {
        var line = mapper(list[i]);
        if (line !== null && line !== undefined) lines.push(line);
    }
}

/**
 * The pool packet (§5): availability lines + the high-weight outcomes +
 * the merged-candidate census line. Empty array when there is nothing to
 * say (a single-reviewer round with everything kept says nothing).
 */
function buildPoolPacket(ctx) {
    var c = ctx || {};
    var lines = availabilityPacketLines(c.arrived, c.unavailable, c.roundName);
    // Partial coverage (the gh-1471 truncated flag): a specialist that
    // finished under the cap but flagged incomplete review — the merge
    // consumer deserves to know the coverage was partial, not silent.
    var partial = Array.isArray(c.partialCoverage) ? c.partialCoverage : [];
    for (var p = 0; p < partial.length; p++) {
        lines.push('⚠️ ' + partial[p] + ': partial coverage — the specialist flagged truncated=true ' +
            '(its findings cover only what it reviewed before the cap)');
    }
    var notes = Array.isArray(c.coverageNotes) ? c.coverageNotes : [];
    for (var n = 0; n < notes.length; n++) {
        if (notes[n] && notes[n].reviewer && notes[n].text) {
            lines.push('🔁 ' + notes[n].reviewer + ': ' + notes[n].text);
        }
    }
    var merged = Array.isArray(c.merged) ? c.merged : [];
    var census = poolCensusLineOf(merged);
    if (census) lines.push(census);
    var high = Array.isArray(c.highWeightOutcomes) ? c.highWeightOutcomes : [];
    pushMappedLines(lines, high, highWeightPacketLineOf);
    var dropped = Array.isArray(c.dropped) ? c.dropped : [];
    pushMappedLines(lines, dropped, function(drop) { return droppedPoolPacketLineOf(drop, merged); });
    return lines;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CLAIM_FINGERPRINT_MAX: CLAIM_FINGERPRINT_MAX,
        claimFingerprint: claimFingerprint,
        candidateIdentity: candidateIdentity,
        severityRank: severityRank,
        mostSevere: mostSevere,
        mergeCandidateLists: mergeCandidateLists,
        applyWeightedRetention: applyWeightedRetention,
        highWeightOutcomesOf: highWeightOutcomesOf,
        availabilityPacketLines: availabilityPacketLines,
        droppedPoolCandidateLine: droppedPoolCandidateLine,
        buildPoolPacket: buildPoolPacket
    };
}
