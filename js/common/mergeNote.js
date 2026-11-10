/**
 * mergeNote.js — the merge-decision observability layer (gh-1420).
 *
 * The gh-1410 pathology: the only evidence a PR merged wrong was a runner
 * log line nobody watches. gh-1420 makes the merge decision observable at
 * the PR/repo level, in two artifacts both owned here:
 *
 * 1. The MERGE-DECISION structured log line (format v2) — ONE greppable
 *    line per decision, emitted by ALL THREE merge funnels
 *    (js/mergeTrigger.js runStateMachine, js/sm/mergeBot.js
 *    mergeApprovedHead, js/retryMergeGithubPR.js squashAndFinalize) via
 *    the shared say/logger seam (emitDecision):
 *
 *      MERGE-DECISION pr=1410 head=0c2732d action=merged|held|defered
 *        machineThreads=N humanThreads=H allowlist=len verdict=<word|none>
 *
 *    `allowlist=0` is the misclassification detector (the gh-1410 empty
 *    machineAuthor allowlist read machine threads as human); `action` is
 *    the canonical two-r spelling per the gh-1379 repo-wide invariant;
 *    `verdict` renders the newest verdict word for the head (or none).
 *    Every action=held decision (and every verdict hold — it stamps a
 *    dmtools:merge-hold marker too) additionally says a workflow-level
 *    `::warning::` annotation so the Actions UI surfaces the hold without
 *    reading logs (gh-1420 design d).
 *
 * 2. The funnel-side summary marker — when a merge happens DESPITE the
 *    backstop having counted anything ("merged with residue": >=IMPORTANT
 *    threads defered to a digest, below-threshold threads ack-resolved,
 *    human threads left open per gh-744 under a delegated-humans knob),
 *    the funnel posts ONE machine-parseable marker on the PR after the
 *    squash-merge:
 *
 *      <!-- dmtools:merge-note {"openThreadsAtMerge":N,"autoResolved":K,
 *            "machine":M,"human":H,"head":"<sha>","at":"..."} -->
 *
 *    Deduped per head (the gh-848/gh-1392 marker-family doctrine — never
 *    a new comment per replay; there is no comment-update primitive, so a
 *    same-head note is reused in place by NOT posting). A pure-clean
 *    merge — the backstop counted nothing — posts NOTHING (AC1: silent),
 *    and doesn't even spend the dedup read.
 *
 * The marker is observability, never a gate: the merge already happened
 * by the time it posts, so every fault inside (a broken dedup read, a
 * failed post) is fail-soft — named on the outcome, never thrown. The
 * residue payload derives from the gh-1353 backstop outcome the funnel
 * already holds (mergeGate.runForPr attaches it as `gate.backstop`), so
 * the note never re-reads or re-classifies threads.
 *
 * IO contract: runMergeNote(io, owner, name, input) — io = { getComments,
 * createComment } (the mergeVerdictGate.githubBridgeIo() subset view —
 * the ONE typeof-guarded naming place). The funnels call
 * runMergeNoteForPr instead. Comment reads ride mergeVerdictGate.prComment
 * List (the ONE payload normalizer). The decision line is pure —
 * emitDecision renders it from the funnel's parts and says it.
 *
 * Pure module — no dmtools globals (the io is injected). GraalJS-clean
 * (var + plain functions, JSON-safe data). Requires hoisted (gh-823).
 */
'use strict';

var mcpParse = require('./mcpParse.js');
var reviewVerdicts = require('./reviewVerdicts.js');
var mergeBackstop = require('./mergeBackstop.js');
var mergeVerdictGate = require('./mergeVerdictGate.js');

// The machine marker: one line, JSON payload, invisible in the rendered PR
// (the reviewVerdicts marker-family shape — dmtools:merge-hold parity).
var MARKER_PREFIX = '<!-- dmtools:merge-note ';
var MARKER_SUFFIX = ' -->';

// The canonical action words of the structured line (gh-1379: the deferred
// spelling has two r's — the stale one-r misspelling greps to zero hits).
var ACTION_MERGED = 'merged';
var ACTION_HELD = 'held';
var ACTION_DEFERED = 'defered';

// Delegates: the ONE head-sha derivation and the short-sha renderer live on
// the sibling merge-path module (gh-1248 lesson: no second copy).
var headShaOf = mergeBackstop.headShaOf;
var shortSha = mergeBackstop.shortSha;

// ── the residue payload ──────────────────────────────────────────────────────

/**
 * The residue counts of one gh-1353 backstop outcome — what the merge-note
 * payload and the merged/deferred MERGE-DECISION lines render. Every
 * missing field reads as 0; a null/skipped outcome (capability miss) is
 * zero residue (the backstop saw nothing — pure-clean parity, AC1).
 */
function residueCountsOf(bs) {
    if (!bs || bs.skipped) {
        return { openThreadsAtMerge: 0, autoResolved: 0, machine: 0, human: 0 };
    }
    var counted = Array.isArray(bs.counted) ? bs.counted.length : 0;
    var ack = Array.isArray(bs.ackThreads) ? bs.ackThreads.length : 0;
    var hold = Array.isArray(bs.holdThreads) ? bs.holdThreads.length : 0;
    var human = Array.isArray(bs.human) ? bs.human.length : 0;
    return {
        openThreadsAtMerge: counted + ack + hold + human,
        autoResolved: (bs.resolved || 0) + (bs.ackResolved || 0),
        machine: counted + ack + hold,
        human: human
    };
}

// ── the marker ───────────────────────────────────────────────────────────────

/**
 * The machine-parseable merge-note marker for one merged head: the payload
 * is the protocol (openThreadsAtMerge/autoResolved per gh-1420; machine/
 * human/head/at ride along for the audit trail), the sentence below is
 * only for a human who opens the PR.
 */
function buildMergeNoteMarker(residue, headSha, nowIso) {
    var payload = {
        openThreadsAtMerge: residue.openThreadsAtMerge,
        autoResolved: residue.autoResolved,
        machine: residue.machine,
        human: residue.human,
        head: String(headSha || ''),
        at: nowIso || ''
    };
    var note = '\uD83E\uDD9A Merged with residue (gh-1420): ' +
        residue.openThreadsAtMerge + ' review thread(s) were open at merge time — ' +
        residue.machine + ' machine-owned (auto-resolved by the merge backstop' +
        (residue.autoResolved ? ', findings ride the review debt ledger / digest issue' : '') +
        '), ' + residue.human + ' human (left open per gh-744).';
    return MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        MARKER_SUFFIX + '\n' + note;
}

// The note record of one dmtools:merge-note payload (dedup key: head).
function noteRecordFromPayload(parsed) {
    if (!parsed || !parsed.head) return null;
    return {
        head: String(parsed.head),
        at: String(parsed.at || ''),
        openThreadsAtMerge: parsed.openThreadsAtMerge,
        autoResolved: parsed.autoResolved
    };
}

/**
 * The merge-note markers already on the PR, oldest-first. ANY author counts:
 * the dedup exists to prevent comment spam (gh-808/gh-1392), not to gate
 * trust — a note never enables anything, it documents one merge.
 */
function existingNotes(comments) {
    return reviewVerdicts.parseMarkerComments(comments || [], {},
        MARKER_PREFIX, MARKER_SUFFIX, noteRecordFromPayload, false);
}

// Any note already stamped for THIS head (sameHead — prefix-tolerant)?
function hasNoteForHead(notes, headSha) {
    for (var i = 0; i < notes.length; i++) {
        if (reviewVerdicts.sameHead(notes[i].head, headSha)) return true;
    }
    return false;
}

// ── the stamp ────────────────────────────────────────────────────────────────

/**
 * The merge-note stamp for one squash-merged PR: zero residue → silent
 * (no read spent); residue → the dedup read, then ONE marker per head.
 * Never throws — every fault is named on the outcome (the merge already
 * happened; the note is observability).
 */
function runMergeNote(io, owner, name, input) {
    var inp = input || {};
    var out = {
        prNumber: inp.prNumber,
        head: inp.headSha || null,
        silent: false,
        posted: false,
        deduped: false,
        postFailed: false,
        commentsUnreadable: false
    };
    var residue = residueCountsOf(inp.backstop);
    if (!residue.openThreadsAtMerge && !residue.autoResolved) {
        out.silent = true; // pure-clean merges stay silent (AC1) — no read spent
        return out;
    }
    var comments;
    try {
        comments = mergeVerdictGate.prCommentList(io && io.getComments, owner, name, inp.prNumber);
    } catch (eRead) {
        out.commentsUnreadable = true; // soft — posting without the dedup read risks spam
        return out;
    }
    if (!comments) {
        out.commentsUnreadable = true; // capability miss — the marker is skipped
        return out;
    }
    if (hasNoteForHead(existingNotes(comments), out.head)) {
        out.deduped = true; // one comment per head (refresh-in-place by NOT posting)
        return out;
    }
    try {
        if (!io || typeof io.createComment !== 'function') {
            out.postFailed = true; // capability miss — named, never thrown
            return out;
        }
        io.createComment({
            workspace: owner, repository: name, number: inp.prNumber,
            body: buildMergeNoteMarker(residue, out.head, inp.nowIso)
        });
        out.posted = true;
    } catch (ePost) {
        out.postFailed = true; // soft — the merge stands, the residue lives in the log line
    }
    return out;
}

// ── caller-facing log lines ──────────────────────────────────────────────────

/**
 * One observable line per note shape (the funnel says these verbatim).
 * The silent shape says NOTHING — the pure-clean merge has no residue to
 * announce (AC1), the MERGE-DECISION line already records the merge.
 */
function outcomeLines(out) {
    if (!out || out.silent) return [];
    if (out.commentsUnreadable) {
        return ['\uD83E\uDD9A merge note on PR #' + out.prNumber +
            ': comments unreadable — residue marker skipped (fail-open)'];
    }
    if (out.deduped) {
        return ['\uD83E\uDD9A merge note on PR #' + out.prNumber +
            ': residue note deduped per head (existing marker reused in place)'];
    }
    if (out.postFailed) {
        return ['\uD83E\uDD9A merge note on PR #' + out.prNumber +
            ': residue marker post failed — fail-open (the MERGE-DECISION line carries the counts)'];
    }
    return ['\uD83E\uDD9A merge note on PR #' + out.prNumber +
        ': merged with residue — dmtools:merge-note marker posted (one per head)'];
}

// ── the structured decision line (format v2) ─────────────────────────────────

/**
 * The greppable MERGE-DECISION line for one merge decision (gh-1420
 * design b). Pure — the funnel renders + says it via emitDecision.
 * parts: { prNumber, headSha, action, machineThreads, humanThreads,
 *          allowlist, verdict } — every missing field rides its zero /
 * 'none' default, so a partially-informed decision still renders a
 * complete greppable line.
 */
function mergeDecisionLine(parts) {
    var p = parts || {};
    var head = p.headSha ? shortSha(p.headSha) : 'none';
    return 'MERGE-DECISION pr=' + (p.prNumber === undefined || p.prNumber === null
            ? '?' : p.prNumber) +
        ' head=' + head +
        ' action=' + (p.action || ACTION_DEFERED) +
        ' machineThreads=' + (p.machineThreads || 0) +
        ' humanThreads=' + (p.humanThreads || 0) +
        ' allowlist=' + (p.allowlist || 0) +
        ' verdict=' + (p.verdict || 'none');
}

/**
 * The shared say/logger seam for ALL THREE funnels (gh-1420 AC2): renders
 * the MERGE-DECISION line from the funnel's decision context and says it;
 * every hold (action=held, or an explicit warn — the verdict hold stamps a
 * dmtools:merge-hold marker too) additionally says a workflow-level
 * `::warning::` annotation on its OWN line so the Actions UI surfaces the
 * hold without reading logs (design d). Returns the line (pure seam — a
 * null say is absorbed and the line is still returned, unit-testable).
 *
 * parts: { prNumber, pr, job, action, machineThreads?, humanThreads?,
 *          verdict?, warn?, reason?, backstop? } — when `backstop` (the
 * gh-1353 outcome mergeGate.runForPr attaches) is present, the machine/
 * human counts render from its residue (the authoritative pre-resolution
 * census); otherwise the funnel's own numbers ride.
 */
function emitDecision(say, parts) {
    var p = parts || {};
    var residue = residueCountsOf(p.backstop);
    var line = mergeDecisionLine({
        prNumber: p.prNumber,
        headSha: headShaOf(p.pr),
        action: p.action,
        machineThreads: p.backstop ? residue.machine : (p.machineThreads || 0),
        humanThreads: p.backstop ? residue.human : (p.humanThreads || 0),
        allowlist: mergeBackstop.machineLoginsOf(p.job || null).length,
        verdict: p.verdict || 'none'
    });
    if (typeof say === 'function') {
        say(line);
        var warn = (p.action === ACTION_HELD) || p.warn === true;
        if (warn) {
            say('::warning:: merge ' + p.action + ' on PR #' + p.prNumber + ' (gh-1420)' +
                (p.reason ? ': ' + p.reason : ' — the merge gates hold it; see the MERGE-DECISION line'));
        }
    }
    return line;
}

// ── the funnel wiring ────────────────────────────────────────────────────────

/**
 * The one-call wiring for a funnel that just squash-merged (gh-1420 AC1):
 * posts the deduped residue marker (silent on a pure-clean merge) and says
 * the outcome lines verbatim. Never throws.
 *
 *   bridges  — the io bag (mergeVerdictGate.githubBridgeIo() in production;
 *              test mocks).
 *   job      — the caller's jobParams (unused today; the bag mirrors the
 *              other merge-path wirings for symmetry).
 *   backstop — the gh-1353 outcome the funnel's mergeGate.runForPr call
 *              attached (gate.backstop); null/skipped → silent.
 */
function runMergeNoteForPr(bridges, owner, name, job, prNumber, pr, backstop, say) {
    var input = {
        prNumber: prNumber,
        headSha: headShaOf(pr),
        nowIso: (new Date()).toISOString(),
        backstop: backstop || null
    };
    var out = runMergeNote(bridges, owner, name, input);
    outcomeLines(out).forEach(function (line) { if (say) say(line); });
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        ACTION_MERGED: ACTION_MERGED,
        ACTION_HELD: ACTION_HELD,
        ACTION_DEFERED: ACTION_DEFERED,
        residueCountsOf: residueCountsOf,
        buildMergeNoteMarker: buildMergeNoteMarker,
        existingNotes: existingNotes,
        hasNoteForHead: hasNoteForHead,
        runMergeNote: runMergeNote,
        outcomeLines: outcomeLines,
        mergeDecisionLine: mergeDecisionLine,
        emitDecision: emitDecision,
        runMergeNoteForPr: runMergeNoteForPr
    };
}
