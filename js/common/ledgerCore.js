/**
 * ledgerCore.js — the shared ledger+sweep pattern (gh-1352 scope 4).
 *
 * The rolling-ledger machinery shipped in gh-1345/gh-1348
 * (js/common/tcMaintenanceLedger.js + the dispatcher + the suppression
 * anchors) carried the full append/refresh/reopen/resolve lifecycle and
 * the batched-sweep trigger as a TC-side singleton. gh-1352 adds the
 * REVIEW-side debt ledger consumer (deferred review findings) — the same
 * lifecycle, a different identity scheme — so the pattern is extracted
 * here and both consumers delegate. Nothing is duplicated a third time.
 *
 *   Identity    the consumer owns the id scheme (the TC ledger hashes
 *               tcKey+errorClass+script; the review ledger keys gh-1332
 *               finding identities). The core only matches on `id`.
 *   Lifecycle   open -> resolved (a sweep fixes the batch; resolvedVia
 *               names it) -> open again on re-occurrence. Append-only
 *               evidence is never rewritten; dispositions only flip
 *               status.
 *   Sweep       the batched-sweep trigger: open count >= sweepBatch
 *               (10) OR the oldest open item >= sweepMaxAgeDays (30)
 *               → ONE batched sweep leg → one PR fixing the batch; stale
 *               items are re-validated and dropped with a note.
 *
 * Pure module — no dmtools globals. GraalJS-clean (var + plain functions,
 * JSON-safe data).
 */
'use strict';

// ── shape ────────────────────────────────────────────────────────────────────

function emptyLedger(version) {
    return { v: version, at: new Date().toISOString(), findings: [] };
}

function deepCopyLedger(l) {
    return JSON.parse(JSON.stringify(l || emptyLedger(1)));
}

// Marker-hygiene cap for free-text fields (agent-authored evidence can be
// arbitrarily large; the ledger carries pointers, not essays).
function truncate(text, max) {
    var s = String(text || '');
    var limit = max || 500;
    return s.length > limit ? s.substring(0, limit) : s;
}

// The first present (non-null/non-'' /non-undefined) value of the named
// source keys, in priority order — the consumers' field tables share it.
function firstDefined(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
        if (obj[keys[i]] !== undefined && obj[keys[i]] !== null && obj[keys[i]] !== '') return obj[keys[i]];
    }
    return null;
}

function findById(l, id) {
    var findings = (l && Array.isArray(l.findings)) ? l.findings : [];
    for (var i = 0; i < findings.length; i++) {
        if (findings[i].id === id) return findings[i];
    }
    return null;
}

// ── the lifecycle: append / refresh / reopen / resolve ───────────────────────

/**
 * Evidence fields a refresh updates (latest evidence wins); a consumer's
 * `refreshKeys` names its own set. Status/lifecycle fields are core-owned.
 */
var CORE_REFRESH_KEYS = ['note', 'sha', 'envFingerprint', 'lastGreenSha',
    'lastGreenEnvFingerprint', 'failedDescriptionFile', 'failureSummary',
    'claimedVerdict', 'evidence', 'severity', 'threadUrl', 'originPr', 'threadId'];

/**
 * Refreshes an identity match in place: occurrences++, lastSeenAt moves,
 * the incoming evidence fields win, and a RESOLVED finding REOPENS (the
 * sweep did not stick — the re-occurrence is the evidence). `refreshKeys`
 * is the consumer's optional evidence slice (defaults to the core list).
 */
function refreshFinding(existing, incoming, at, refreshKeys) {
    var keys = Array.isArray(refreshKeys) ? refreshKeys : CORE_REFRESH_KEYS;
    existing.lastSeenAt = at;
    existing.occurrences = (existing.occurrences || 1) + 1;
    keys.forEach(function (k) {
        if (incoming[k] !== null && incoming[k] !== undefined) existing[k] = incoming[k];
    });
    if (existing.status === 'resolved') {
        existing.status = 'open';
        existing.resolvedAt = null;
        existing.resolvedVia = null;
        existing.dropNote = null;
    }
    return existing;
}

// A fresh entry carries the lifecycle defaults the core owns; the
// consumer's normalize (or the raw input) supplies identity + evidence
// fields on top.
function applyLifecycleDefaults(incoming, at) {
    if (incoming.status === undefined) incoming.status = 'open';
    if (incoming.firstSeenAt === undefined) incoming.firstSeenAt = at;
    if (incoming.lastSeenAt === undefined) incoming.lastSeenAt = at;
    if (incoming.occurrences === undefined) incoming.occurrences = 1;
    return incoming;
}

/**
 * Appends a finding into a deep-copied ledger: identity match refreshes,
 * otherwise the normalized entry is pushed. `normalize(input, at)` is the
 * consumer's optional shape builder (it stamps the id + the consumer
 * fields and returns the canonical entry); when absent the input itself is
 * the canonical entry. `refreshKeys` is the consumer's optional evidence
 * slice (see refreshFinding). Returns the NEW ledger (never mutates the
 * input).
 */
function appendFinding(prev, input, normalize, refreshKeys) {
    var at = (input && input.at) || new Date().toISOString();
    var l = deepCopyLedger(prev);
    l.at = at;
    var incoming = typeof normalize === 'function' ? normalize(input, at) : input;
    var existing = findById(l, incoming.id);
    if (existing) {
        refreshFinding(existing, incoming, at, refreshKeys);
    } else {
        l.findings.push(applyLifecycleDefaults(incoming, at));
    }
    return l;
}

/**
 * Marks the listed identities resolved (the sweep leg's disposition).
 * Unknown ids are ignored — the ledger is append-only evidence.
 */
function resolveFindings(prev, ids, via) {
    return applyResolve(prev, ids, via, null);
}

/**
 * Drops findings that failed re-validation against the current code
 * (the sweep's stale path): resolved with the drop receipt and the note
 * the re-validation produced — visible, never silent.
 */
function dropFindings(prev, ids, via, noteOf) {
    return applyResolve(prev, ids, via, typeof noteOf === 'function' ? noteOf : function () { return noteOf || null; });
}

// The shared resolve pipeline (gh-1352 dedup): copy, stamp, resolve each
// known id; `noteOf(f)` optionally attaches the drop receipt.
function applyResolve(prev, ids, via, noteOf) {
    var at = new Date().toISOString();
    var l = deepCopyLedger(prev);
    l.at = at;
    (ids || []).forEach(function (id) {
        var f = findById(l, id);
        if (!f) return;
        f.status = 'resolved';
        f.resolvedAt = at;
        f.resolvedVia = via || null;
        if (noteOf) f.dropNote = noteOf(f);
    });
    return l;
}

// The canonical marker payload shape (the single copy — the TC face and
// the review-debt face both parse through it; gh-1352 duplication gate).
function ledgerFromPayload(parsed) {
    if (!parsed || !Array.isArray(parsed.findings)) return null;
    return {
        v: parseInt(parsed.v, 10) || 1,
        at: String(parsed.at || ''),
        findings: parsed.findings
    };
}

// The marker-record adapter shared by both faces' parseMarkerComments
// closures ({ledger, at} — the shared parser stamps atMs from `at`).
function ledgerRecordOf(parsed) {
    var l = ledgerFromPayload(parsed);
    return l ? { ledger: l, at: l.at } : null;
}

function openFindings(l) {
    if (!l || !Array.isArray(l.findings)) return [];
    return l.findings.filter(function (f) { return f.status === 'open'; });
}

// ── the sweep trigger ────────────────────────────────────────────────────────

var DAY_MS = 24 * 60 * 60 * 1000;

function sweepBounds(bounds) {
    var b = bounds || {};
    return {
        sweepBatch: b.sweepBatch > 0 ? b.sweepBatch : 10,
        sweepMaxAgeDays: b.sweepMaxAgeDays > 0 ? b.sweepMaxAgeDays : 30
    };
}

/**
 * The oldest open finding's firstSeenAt as epoch-ms, or null.
 */
function oldestOpenAtMs(l) {
    var oldest = null;
    openFindings(l).forEach(function (f) {
        var t = Date.parse(f.firstSeenAt);
        if (!isNaN(t) && (oldest === null || t < oldest)) oldest = t;
    });
    return oldest;
}

/**
 * The open findings past the age bound (the sweep's stale-revalidation
 * candidates).
 */
function staleFindings(l, bounds, nowMs) {
    var b = sweepBounds(bounds);
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var cutoff = now - b.sweepMaxAgeDays * DAY_MS;
    return openFindings(l).filter(function (f) {
        var t = Date.parse(f.firstSeenAt);
        return !isNaN(t) && t <= cutoff;
    });
}

/**
 * The batched-sweep trigger (the epic §4 ledger): open >= sweepBatch OR
 * oldest open >= sweepMaxAgeDays. Returns
 * { due, reason, open, oldestAgeDays } — due=false carries a null reason.
 */
function sweepDecision(l, bounds, nowMs) {
    var b = sweepBounds(bounds);
    var open = openFindings(l);
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var oldest = oldestOpenAtMs(l);
    var oldestAgeDays = oldest === null ? 0 : Math.floor((now - oldest) / DAY_MS);
    if (open.length >= b.sweepBatch) {
        return {
            due: true,
            reason: open.length + ' open finding(s) — the batch trigger (' + b.sweepBatch + ') is met',
            open: open.length,
            oldestAgeDays: oldestAgeDays
        };
    }
    if (oldest !== null && oldestAgeDays >= b.sweepMaxAgeDays) {
        return {
            due: true,
            reason: 'the oldest open finding is ' + oldestAgeDays +
                ' days old — the age trigger (' + b.sweepMaxAgeDays + ') is met',
            open: open.length,
            oldestAgeDays: oldestAgeDays
        };
    }
    return { due: false, reason: null, open: open.length, oldestAgeDays: oldestAgeDays };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        emptyLedger: emptyLedger,
        deepCopyLedger: deepCopyLedger,
        truncate: truncate,
        firstDefined: firstDefined,
        findById: findById,
        appendFinding: appendFinding,
        refreshFinding: refreshFinding,
        resolveFindings: resolveFindings,
        dropFindings: dropFindings,
        openFindings: openFindings,
        staleFindings: staleFindings,
        sweepDecision: sweepDecision,
        oldestOpenAtMs: oldestOpenAtMs,
        // the canonical marker payload shape — both ledger faces parse
        // through this single guard (gh-1352 duplication gate).
        ledgerFromPayload: ledgerFromPayload,
        ledgerRecordOf: ledgerRecordOf
    };
}
