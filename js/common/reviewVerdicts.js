/**
 * reviewVerdicts.js — machine-parseable review-verdict records and their
 * reconciliation (gh-807).
 *
 * Live pathology (fa PR #1428, 2026-10-09 05:47:30Z + 05:47:40Z): two review
 * legs concluded on the SAME head 97 seconds apart with contradictory
 * verdicts; both side effects stuck (pr_approved + agent:rework coexisting)
 * and nothing ever reconciled them, because
 *   (a) verdicts were free-form comments with no head association — the
 *       headMovedSinceLastReview-style probes can never tie one to a head;
 *   (b) the SM tick had no verdict-reconciliation step;
 *   (c) the arming side (arm_rework) ignored the sticky-approval rule the
 *       rework side enforces (approved once → never re-review).
 *
 * The protocol: every review leg stamps ONE machine-parseable record on the
 * PR — a comment carrying the structured marker below. Everything else is
 * derived: newest record per head wins, a conflict WARNs (de-duplicated per
 * tick process), the loser label comes off with a comment citing both
 * verdict sources, and arming rework requires the effective verdict to not
 * be APPROVE (unless BLOCKING threads remain). Free-form comment text is
 * NEVER consulted — a comment that merely says "REQUEST_CHANGES" without
 * the marker does not exist for this module.
 *
 * One asymmetry (gh-807 review, BLOCKING thread): an APPROVE winner does
 * NOT invalidate every agent:rework arm. The label has non-review sources
 * that legitimately coexist with an APPROVE record on the SAME head —
 * red-CI rework on a sticky-approved PR (fail_validation), the sticky
 * dead-letter issue arm, conflict-rework on a DIRTY head, manual human
 * arms. The caller passes checksRed (the headHasRealFailure probe): a real
 * CI failure keeps the arm — the CI path owns the leg. Red CI never
 * legitimizes pr_approved, so a REQUEST_CHANGES/BLOCK winner always strips
 * it.
 *
 * Pure module — no dmtools globals; the tick actions and the query guards
 * feed it comment payloads and apply the decisions. Keep it GraalJS-clean
 * (var + plain functions, JSON-safe data only).
 */
'use strict';

// The machine marker: one line, JSON payload, invisible in the rendered PR.
// Human-written or legacy comments never carry it — that is the point (AC4):
// verdict head-matching keys on the marker's structured head sha, not on
// comment text.
var MARKER_PREFIX = '<!-- dmtools:review-verdict ';
var MARKER_SUFFIX = ' -->';

// Verdicts the protocol admits. APPROVE is the sticky winner; the other two
// block pr_approved-gated paths until re-review.
var VERDICTS = ['APPROVE', 'REQUEST_CHANGES', 'BLOCK'];

// The two machine-owned carriers the reconciliation de-conflicts.
var LABEL_APPROVED = 'pr_approved';
var LABEL_REWORK = 'agent:rework';

/**
 * Builds the verdict-record comment body for a review leg to post.
 * record: { head, verdict, blocking, important, suggestions, at, source }
 *   head     — full head sha the verdict was rendered on (REQUIRED; a
 *              verdict without a head is the pathology this fixes)
 *   verdict  — APPROVE | REQUEST_CHANGES | BLOCK (the EFFECTIVE verdict
 *              after the leg's own overrides, not the raw LLM token)
 *   blocking/important/suggestions — the thread census (issueCounts)
 *   at       — ISO timestamp of the verdict
 *   source   — where the verdict came from (e.g. 'pr_review.json')
 * Returns null when the record is not postable (no head / no verdict) —
 * callers skip the post; a head-less record must never exist.
 */
function buildVerdictComment(record) {
    if (!record || !record.head || !record.verdict) return null;
    if (VERDICTS.indexOf(String(record.verdict).toUpperCase()) === -1) return null;
    var payload = {
        head: String(record.head),
        verdict: String(record.verdict).toUpperCase(),
        blocking: Number(record.blocking || 0) || 0,
        important: Number(record.important || 0) || 0,
        suggestions: Number(record.suggestions || 0) || 0,
        at: record.at || new Date().toISOString(),
        source: record.source || 'pr_review.json'
    };
    return MARKER_PREFIX + JSON.stringify(payload) + MARKER_SUFFIX + '\n' +
        '🤖 Review verdict record (gh-807) — machine-parsed by the SM tick to ' +
        'reconcile contradictory review legs on one head. Do not edit or reply.';
}

/**
 * Extracts one record from a comment body, or null. Only the marker counts.
 */
function extractVerdictRecord(body) {
    var text = String(body || '');
    var start = text.indexOf(MARKER_PREFIX);
    if (start === -1) return null;
    start += MARKER_PREFIX.length;
    var end = text.indexOf(MARKER_SUFFIX, start);
    if (end === -1) return null;
    var raw = text.substring(start, end).trim();
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed || !parsed.head || !parsed.verdict) return null;
    var verdict = String(parsed.verdict).toUpperCase();
    if (VERDICTS.indexOf(verdict) === -1) return null;
    return {
        head: String(parsed.head),
        verdict: verdict,
        blocking: Number(parsed.blocking || 0) || 0,
        important: Number(parsed.important || 0) || 0,
        suggestions: Number(parsed.suggestions || 0) || 0,
        at: String(parsed.at || ''),
        source: String(parsed.source || 'unknown')
    };
}

/**
 * Parses all verdict records from a comments payload —
 * comments: [{body}] (author/created_at accepted but not required; ordering
 * rides the embedded `at`, falling back to payload order which is stable).
 * Returns records oldest-first, each with its payload index as the tiebreak.
 */
function parseVerdictRecords(comments) {
    var list = Array.isArray(comments) ? comments : [];
    var records = [];
    for (var i = 0; i < list.length; i++) {
        var rec = extractVerdictRecord(list[i] && list[i].body);
        if (!rec) continue;
        rec.order = i;
        records.push(rec);
    }
    records.sort(function(a, b) {
        var ta = Date.parse(a.at), tb = Date.parse(b.at);
        // Unparseable/absent timestamps sink to payload order — NaN
        // comparisons are always false, so handle them explicitly.
        var aTime = isNaN(ta) ? -1 : ta;
        var bTime = isNaN(tb) ? -1 : tb;
        if (aTime !== bTime) return aTime < bTime ? -1 : 1;
        return (a.order || 0) - (b.order || 0);
    });
    return records;
}

/**
 * Newest record for one head + conflict detection (AC1).
 * Returns null when the head has no records. When the head carries records
 * with DIFFERENT verdicts, the newest wins and the conflict is logged:
 *   ⚠️ verdict conflict on <head>: APPROVE vs REQUEST_CHANGES — newest wins
 * The WARN is de-duplicated per module instance (per tick process) keyed by
 * head + verdict pair: the tick's rules call the guards 5-6 times per PR
 * per tick (the reconcile rule, the notLatestVerdict lanes, the arm gate)
 * and records never expire, so an undeduped line would repeat identically
 * until the head moves or merges. The first evaluation of a pair WARNs (the
 * conflict stays observable in every tick); later calls stay SILENT
 * consumers of effective.conflict.
 */
var warnedConflicts = {};
var WARNED_CONFLICTS_CAP = 256;

function warnConflictOnce(key, message) {
    if (warnedConflicts[key]) return;
    // Bound the de-dup memory: a tick that somehow walks 256+ distinct
    // conflicting heads resets the set (worst case a repeat WARN — never a
    // missed one for a pair seen recently).
    var keys = Object.keys(warnedConflicts);
    if (keys.length >= WARNED_CONFLICTS_CAP) warnedConflicts = {};
    warnedConflicts[key] = true;
    console.warn(message);
}

function latestVerdictForHead(records, headSha) {
    if (!headSha) return null;
    var head = String(headSha);
    var forHead = [];
    for (var i = 0; i < (records || []).length; i++) {
        // Prefix match: legs may record the full sha while a probe passes a
        // short sha (and vice versa) — the marker carries the full sha, the
        // short form is its unambiguous prefix for conflict purposes.
        if (records[i].head === head ||
            (head.length >= 7 && records[i].head.indexOf(head) === 0) ||
            (records[i].head.length >= 7 && head.indexOf(records[i].head) === 0)) {
            forHead.push(records[i]);
        }
    }
    if (!forHead.length) return null;
    var newest = forHead[forHead.length - 1];
    var conflict = null;
    if (forHead.length > 1) {
        var prev = forHead[forHead.length - 2];
        if (prev.verdict !== newest.verdict) {
            conflict = { older: prev, newer: newest };
            warnConflictOnce(head + '|' + prev.verdict + '>' + newest.verdict,
                '⚠️ verdict conflict on ' + head + ': ' +
                prev.verdict + ' vs ' + newest.verdict + ' — newest wins');
        }
    }
    return { record: newest, conflict: conflict };
}

/**
 * The loser label for an effective verdict (AC2): an APPROVE head must not
 * keep a rework arm; a changes-requested head must not keep the approval.
 */
function resolveLoserLabel(verdict) {
    return verdict === 'APPROVE' ? LABEL_REWORK : LABEL_APPROVED;
}

/**
 * Human-readable reconciliation comment citing BOTH verdict sources (AC2).
 */
function buildReconciliationComment(effective, loserLabel, headSha) {
    var newer = effective.record;
    var lines = [];
    if (effective.conflict) {
        var older = effective.conflict.older;
        lines.push('⚖️ Verdict reconciliation (gh-807): two review verdicts on head `' + headSha + '` —');
        lines.push('- ' + older.verdict + ' at ' + (older.at || 'unknown time') + ' (source: ' + older.source + ')');
        lines.push('- ' + newer.verdict + ' at ' + (newer.at || 'unknown time') + ' (source: ' + newer.source + ')');
        lines.push('');
        lines.push('Newest wins: **' + newer.verdict + '** — removing `' + loserLabel + '`' +
            (loserLabel === LABEL_APPROVED
                ? ' until re-review (approval-gated paths blocked, gh-807).'
                : ' (suggestions do not justify a rework arm; the approval stands).'));
    } else {
        lines.push('⚖️ Verdict reconciliation (gh-807): the effective review verdict on head `' + headSha +
            '` is **' + newer.verdict + '** (at ' + (newer.at || 'unknown time') + ', source: ' + newer.source + ').');
        lines.push('');
        lines.push('Removing `' + loserLabel + '`' +
            (loserLabel === LABEL_APPROVED
                ? ' until re-review (approval-gated paths blocked, gh-807).'
                : ' (suggestions do not justify a rework arm; the approval stands).'));
    }
    return lines.join('\n');
}

/**
 * Reconciliation decision for one head (pure — AC2). state:
 * { prHasApproved, prHasRework, issueHasRework, checksRed } — the
 * coexisting machine labels on both carriers plus the head's CI verdict
 * (the caller's headHasRealFailure probe, fail-open true). Returns null
 * when there is nothing to reconcile (no records for the head, or the
 * loser label is nowhere present); otherwise
 * { loserLabel, removeFromPr, removeFromIssue, effective, comment }.
 *
 * gh-807 review fix (BLOCKING thread): an APPROVE winner does NOT
 * invalidate every agent:rework arm — the label has non-review sources
 * that legitimately coexist with an APPROVE record on the SAME head:
 *   - red-CI rework on a sticky-approved PR (fail_validation re-arms the
 *     linked issue; "pr_approved is STICKY — validation red post-approval
 *     re-arms rework only");
 *   - the sticky issue arm itself (the dead-letter recovery: a
 *     failed/never-started leg must be re-fireable);
 *   - conflict-rework arms (a DIRTY head carries no CI — the probe's
 *     fail-open red keeps the arm, killing the strip/re-add yo-yo).
 * When checksRed stands, the rework arm is CI-corroborated: the tick keeps
 * it and lets the CI path own the leg. A REQUEST_CHANGES/BLOCK winner
 * always strips pr_approved — red CI never legitimizes the approval.
 */
function reconcileDecision(records, headSha, state) {
    var effective = latestVerdictForHead(records, headSha);
    if (!effective) return null;
    var loser = resolveLoserLabel(effective.record.verdict);
    var st = state || {};
    if (loser === LABEL_REWORK && st.checksRed) return null;
    var removeFromPr = loser === LABEL_REWORK ? !!st.prHasRework : !!st.prHasApproved;
    var removeFromIssue = loser === LABEL_REWORK ? !!st.issueHasRework : false;
    if (!removeFromPr && !removeFromIssue) return null;
    return {
        loserLabel: loser,
        removeFromPr: removeFromPr,
        removeFromIssue: removeFromIssue,
        effective: effective,
        comment: buildReconciliationComment(effective, loser, headSha)
    };
}

/**
 * Arming-side sticky-approval gate (pure — AC3): may the tick arm
 * agent:rework on this head? Mirrors the rework side's rule (approved once →
 * never re-reviewed) plus the blocking-thread exception from the capability
 * surface: arming requires effective verdict != APPROVE, OR unresolved
 * BLOCKING threads (the record's census). Fail-OPEN when the head has no
 * verdict records (pre-gh-807 PRs keep today's behavior; reconciliation must
 * not strand them). Returns { arm, reason, effective }.
 */
function armReworkDecision(records, headSha) {
    var effective = latestVerdictForHead(records, headSha);
    if (!effective) {
        return { arm: true, reason: 'no-verdict-records', effective: null };
    }
    var rec = effective.record;
    if (rec.verdict === 'APPROVE') {
        var blocking = Number(rec.blocking || 0) || 0;
        if (blocking > 0) {
            return { arm: true, reason: 'blocking-threads', effective: effective };
        }
        return { arm: false, reason: 'approve-verdict', effective: effective };
    }
    return { arm: true, reason: 'changes-requested', effective: effective };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        VERDICTS: VERDICTS,
        LABEL_APPROVED: LABEL_APPROVED,
        LABEL_REWORK: LABEL_REWORK,
        buildVerdictComment: buildVerdictComment,
        extractVerdictRecord: extractVerdictRecord,
        parseVerdictRecords: parseVerdictRecords,
        latestVerdictForHead: latestVerdictForHead,
        resolveLoserLabel: resolveLoserLabel,
        buildReconciliationComment: buildReconciliationComment,
        reconcileDecision: reconcileDecision,
        armReworkDecision: armReworkDecision
    };
}
