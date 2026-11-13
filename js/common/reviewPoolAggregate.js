/**
 * reviewPoolAggregate.js — the gh-1471 aggregation point's pure core: the
 * round's candidate lists and the posting leg's own findings become ONE
 * census (§5 merge), the merged census rebuilds the inline list, and the
 * gh-1403 filter verdicts go through the pool duties BEFORE they touch the
 * review. This is the "reviewFilter as the merge point" wiring — the duties
 * live on reviewPoolMerge (pure), the gh-1403 mechanics on reviewFilter
 * (pure); this module composes them.
 *
 * One census, one verdict (invariant 1): specialists contribute candidates;
 * the posting leg's findings join the SAME identity space so a
 * base+security match is ONE thread (severity escalates only) — never two.
 * The merged census replaces the review's inline list:
 *   - base-provenanced entries reuse the ORIGINAL entry objects (comment
 *     file references, startLine/side survive) with the merged severity;
 *   - specialist-only candidates synthesize inline bodies carrying the
 *     claim + the reviewer attribution;
 *   - base entries that produced no mergeable candidate (unresolvable
 *     claim) ride untouched at the tail — the merge never loses a finding.
 *
 * Pool duties at the apply (§5): verdicts pass weighted retention FIRST (a
 * reasonless drop/demote of a high-weight candidate is refused to keep),
 * drops come back reviewer-attributed, and the packet (availability +
 * census + drop visibility) renders from the round outcome.
 *
 * Pure module — no dmtools globals. Requires hoisted (gh-823 pack-require
 * rule). GraalJS-clean (var + plain functions, JSON-safe data only).
 */
'use strict';

var reviewFilter = require('./reviewFilter.js');
var reviewPoolMerge = require('./reviewPoolMerge.js');
var reviewVerdicts = require('./reviewVerdicts.js');

// ── the posting leg joins its own census ─────────────────────────────────────

/**
 * The base review's claim-bearing findings as a candidates list (ids are
 * inline positions; `_baseIndex` is the provenance the rebuilt list needs).
 * Claims resolve through the caller's resolver and strip BOTH severity-head
 * forms (the machine line + the prose header) — the claim is the substance;
 * the tier rides the severity field. An unresolvable claim contributes
 * nothing to the merge (an empty fingerprint would falsely match at the
 * same path+line) — the entry itself rides the rebuilt list untouched.
 */
function baseCandidatesFromReview(reviewData, resolveClaim) {
    var inline = reviewData && Array.isArray(reviewData.inlineComments) ? reviewData.inlineComments : [];
    var candidates = [];
    for (var i = 0; i < inline.length; i++) {
        var entry = inline[i] || {};
        var claim = resolveClaim ? resolveClaim(entry) : (typeof entry.body === 'string' ? entry.body : '');
        claim = reviewFilter.stripProseSeverityHead(reviewVerdicts.stripLeadingSeverityLine(String(claim || '')));
        if (!claim || !claim.trim()) continue;
        candidates.push({
            id: i,
            path: entry.path || entry.file || '',
            line: entry.line,
            severity: String(entry.severity || '').toUpperCase(),
            claim: claim.trim(),
            _baseIndex: i
        });
    }
    return { reviewer: 'base', candidates: candidates };
}

// ── the merge (one census) ───────────────────────────────────────────────────

function withWeight(list, weightsByName) {
    var weight = (weightsByName && weightsByName[list && list.reviewer]) ||
        (list && list.filterWeight) || 'normal';
    return Object.assign({}, list, { filterWeight: weight === 'high' ? 'high' : 'normal' });
}

/**
 * The round's census: the base candidates FIRST (first-sight wins ties for
 * the posting leg's own findings), then every arrived specialist list,
 * through the §5 merge. `weightsByName` ({reviewer: 'high'|'normal'}) is
 * the pool's filterWeight read — the weighted-retention flags ride the
 * merged entries.
 */
function mergePoolCensus(reviewData, round, resolveClaim, weightsByName) {
    var lists = (round && Array.isArray(round.lists)) ? round.lists : [];
    var input = [baseCandidatesFromReview(reviewData, resolveClaim)].concat(lists)
        .map(function(list) { return withWeight(list, weightsByName); });
    return reviewPoolMerge.mergeCandidateLists(input);
}

// ── the merged census → the inline list ──────────────────────────────────────

function escalationBodyOf(entry, merged) {
    var tail = '\n\uD83D\uDC65 Pool merge: severity escalated ' + entry.severity + ' → ' + merged.severity +
        ' (matched by ' + (merged.reviewers || []).join(', ') + ').';
    if (typeof entry.body !== 'string' || !entry.body.trim()) return tail.substring(1);
    // A body-as-comment-file path is NEVER appended: appending breaks the
    // exact-match path shape (isCommentFilePath) and the poster would
    // publish the literal path + note instead of the finding — the same
    // hazard reviewFilter.stampDemotionBody documents and guards. The
    // severity header itself carries the escalation for this shape.
    if (reviewFilter.isCommentFilePath(entry.body)) return entry.body;
    return entry.body.replace(/\s*$/, '') + tail;
}

/**
 * One inline entry from one merged candidate. Base-provenanced entries
 * reuse the ORIGINAL entry object (comment-file reference, startLine, side
 * survive) with the merged severity (escalation noted for inline bodies;
 * file-referenced bodies keep their exact path shape — the severity header
 * carries the escalation, appending would corrupt the reference).
 * Specialist-only candidates synthesize an inline body: claim + reviewer
 * attribution.
 */
function inlineEntryFromMerged(merged, baseInline) {
    var baseIdx = merged._baseIndex;
    if (baseIdx !== undefined && baseInline[baseIdx]) {
        var entry = Object.assign({}, baseInline[baseIdx]);
        if (String(entry.severity || '').toUpperCase() !== merged.severity) {
            entry.__poolEscalated = { from: entry.severity, to: merged.severity };
            entry.severity = merged.severity;
            if (typeof entry.body === 'string') entry.body = escalationBodyOf(entry, merged);
        }
        entry.__poolReviewers = (merged.reviewers || []).slice();
        return entry;
    }
    var attribution = (merged.reviewers || []).join(', ');
    return {
        path: merged.path,
        line: merged.line,
        severity: merged.severity,
        body: merged.claim + '\n\uD83D\uDC65 Raised by ' + attribution + '.'
    };
}

/**
 * The rebuilt inline list REPLACES the review's inlineComments in place —
 * the gh-1403 apply step (and the poster) then work on the merged census.
 * Returns the built list ({ entries, mergedCount, consumedBase }).
 */
function applyMergedInline(reviewData, merged) {
    var baseInline = reviewData && Array.isArray(reviewData.inlineComments) ? reviewData.inlineComments : [];
    var built = buildInlineFromMerged(merged, baseInline);
    if (reviewData) reviewData.inlineComments = built.entries;
    return built;
}

/**
 * The rebuilt inline list: every merged candidate in merged order (so the
 * array position equals the merged id — the filter verdict join key), then
 * the base entries that produced no mergeable candidate, untouched. Returns
 * { entries, mergedCount, consumedBase }.
 */
function buildInlineFromMerged(merged, baseInline) {
    var entries = [];
    var consumed = {};
    var list = Array.isArray(merged) ? merged : [];
    for (var i = 0; i < list.length; i++) {
        entries.push(inlineEntryFromMerged(list[i], baseInline || []));
        if (list[i]._baseIndex !== undefined) consumed[list[i]._baseIndex] = true;
    }
    for (var b = 0; b < (baseInline || []).length; b++) {
        if (!consumed[b]) entries.push(baseInline[b]);
    }
    return { entries: entries, mergedCount: list.length, consumedBase: consumed };
}

// ── the gh-1403 filter input (pool-shaped) ───────────────────────────────────

/**
 * The filter candidates from the MERGED census: filterable tiers only (the
 * resolved policy decides), ids are the merged ids, claims are already
 * resolved (the merge carried the text). The finder identity
 * (reviewers/highWeight/_baseIndex) never enters — buildFilterInputJson
 * maps id/path/line/claim only.
 */
function filterCandidatesFromMerged(merged, policy) {
    var list = Array.isArray(merged) ? merged : [];
    var candidates = [];
    for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!reviewFilter.isFilterableTier(m.severity, policy)) continue;
        candidates.push({ id: m.id, path: m.path, line: m.line, severity: m.severity, claim: m.claim });
    }
    return candidates;
}

// ── verdicts through the pool duties ─────────────────────────────────────────

function reviewersOfId(merged, id) {
    var list = Array.isArray(merged) ? merged : [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return (list[i].reviewers || []).slice();
    }
    return [];
}

/**
 * The round's verdicts applied to the review data: weighted retention
 * FIRST (the §5 refusal predicate — a reasonless high-weight drop/demote
 * rides as keep), then the gh-1403 apply on the rebuilt inline list
 * (positions equal merged ids). The drop records come back
 * reviewer-attributed. Returns { result, retention }.
 */
function applyPoolVerdicts(reviewData, merged, candidates, verdicts) {
    var retention = reviewPoolMerge.applyWeightedRetention(merged, verdicts || []);
    var result = reviewFilter.applyFilterVerdicts(reviewData, candidates, retention.verdicts);
    var dropped = (result.dropped || []).map(function(d) {
        var enriched = Object.assign({}, d);
        enriched.reviewers = reviewersOfId(merged, d.id);
        return enriched;
    });
    result.dropped = dropped;
    return { result: result, retention: retention };
}

// ── the packet ───────────────────────────────────────────────────────────────

/**
 * The round's pool packet (§4 availability + §5 visibility): availability
 * lines, the census line, the weighted-retention outcomes and the
 * reviewer-attributed drops. Empty when there is nothing to say.
 */
function poolPacketOf(outcome) {
    var o = outcome || {};
    return reviewPoolMerge.buildPoolPacket({
        arrived: o.arrived,
        unavailable: o.unavailable,
        roundName: o.roundName,
        merged: o.merged,
        highWeightOutcomes: reviewPoolMerge.highWeightOutcomesOf(o.merged, o.applied),
        dropped: o.dropped
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        baseCandidatesFromReview: baseCandidatesFromReview,
        mergePoolCensus: mergePoolCensus,
        buildInlineFromMerged: buildInlineFromMerged,
        filterCandidatesFromMerged: filterCandidatesFromMerged,
        applyPoolVerdicts: applyPoolVerdicts,
        applyMergedInline: applyMergedInline,
        poolPacketOf: poolPacketOf
    };
}
