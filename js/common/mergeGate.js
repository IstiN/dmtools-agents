/**
 * mergeGate.js — the classification-independent merge gate (gh-1417).
 *
 * Live pathology (PR #1410, 2026-11-09): the PR squash-merged with an open
 * IMPORTANT machine review thread that the merge-trigger funnel
 * misclassified as human (empty machineAuthor allowlist — fixed upstream,
 * IstiN/dmtools-agentic-workflows#91). Until #1417 only machine-owned
 * threads participated in the gh-1370 merge gate, human threads never
 * gated (gh-744 delegated them to branch protection), and an empty
 * allowlist gated nothing. The factory runs on arbitrary repositories
 * where branch protection / conversation-resolution settings will NOT be
 * enabled (owner directive 2026-11-10: the engine must be
 * self-sufficient) — so "open discussion ⇒ no merge" is enforced by the
 * pipeline itself, for every thread author.
 *
 * The gate extends the backstop's merge decision to a two-stage rule and
 * is the ONE shared helper for all three merge funnels (js/mergeTrigger.js
 * runStateMachine, js/sm/mergeBot.js mergeApprovedHead, the retry lane
 * js/retryMergeGithubPR.js — shared helper, not three copies):
 *
 *   Stage 1 — machine threads reach terminal disposition (gh-1353/gh-1370,
 *   unchanged): mergeBackstop.runBackstopForPr digests + resolves the
 *   >=IMPORTANT machine threads, ack-resolves the below-threshold ones the
 *   resolved review policy DEFERS (gh-1418 — mandatory-fix/lap-gated tiers
 *   and over-budget deferrable buckets hold + re-arm the polish lap), and
 *   THROWS on any record-keeping or resolve/ack failure or policy hold
 *   (today's semantics — hold, retry next tick). The throw propagates
 *   through runForPr — each caller keeps its own failure handling (the
 *   mergeTrigger per-item isolation fails the job = the escalation
 *   surface; mergeBot and the retry lane absorb it as a defer).
 *
 *   Stage 2 — the classification-independent gate (this module): AFTER
 *   stage 1, count the remaining unresolved review threads — ANY author,
 *   resolved and machine-notice threads excluded (the gh-808 doctrine:
 *   the machine's own bookkeeping comments must never deadlock a PR —
 *   threads whose root body carries a harness notice marker or a hidden
 *   dmtools marker read as notices; bot-authored threads still count —
 *   ANY author gates, see censusOf):
 *     - 0 → merge proceeds;
 *     - > 0 → HOLD: the merge defers to the next tick and a
 *       machine-parseable hold marker is stamped on the PR
 *         <!-- dmtools:merge-hold {"reason":"open-threads","total":N,
 *              "human":H,"machine":M,"head":"<sha>","at":...} -->
 *       one comment per head, refreshed in place (an existing same-head
 *       marker is reused — the bridge has no comment-update primitive;
 *       never a new comment per tick — the gh-808/gh-1392
 *       comment-reduction doctrine).
 *
 * Knobs (per-repo, the .dmtools/config.js `mergeGate` object; a
 * `mergeGate` block on jobParams overrides field-by-field):
 *   - mergeGate.holdOnHumanThreads — default TRUE (strict; owner
 *     directive). false restores gh-744 delegation for human threads
 *     while keeping machine-thread gating (stage 1 + the machine counts
 *     here still gate).
 *   - mergeGate.humanHoldHours — default 24. A human thread holding the
 *     merge longer than this WITHOUT MOVEMENT → escalate: the
 *     `needs-human` label is added and the hold marker names the
 *     escalated state (escalated:true) so the automatic merge lanes skip
 *     the PR (the gh-957 escalation pattern). "Without movement" is
 *     measured on the HEAD's hold: the oldest same-head open-threads
 *     marker's `at` timestamp — a rework lap landing a new head restarts
 *     the clock (a fresh marker budget per head, gh-1416 parity), a
 *     resolved thread clears the hold entirely. Escalation never fires on
 *     a machine-only hold (machine threads are stage 1's business — their
 *     repeated failures escalate through the funnel job surface), and
 *     never while human threads are delegated (holdOnHumanThreads=false —
 *     they are not holding the merge). A human can always merge manually
 *     via the UI — the always-available override.
 *
 * Fail-closed census (the #1319 pathology rule, extended to stage 2): a
 * broken threads or comments read THROWS through — hold, never
 * "classified as no threads". A MISSING threads primitive (no bridge
 * tool) is a capability miss, not a blind hold: the gate skips (the
 * backstop's skip shape). A missing comments primitive or a missing head
 * sha still HOLDS (the census is real) but cannot stamp a dedup-safe
 * marker — the stamp is skipped, the defer stands (the marker is
 * observability, the hold is the decision).
 *
 * Human threads are never machine-resolved (gh-744 unchanged) — the gate
 * only WAITS for them.
 *
 * IO contract: runGate(io, owner, name, input) — `io` maps the raw bridge
 * primitives (or test mocks): getThreads (github_get_pr_review_threads),
 * getComments (github_get_pr_comments), createComment
 * (github_create_comment), addLabels (github_add_labels). The merge paths
 * call runForPr / runGateForPr instead (githubBridgeIo() enumerates the
 * engine's bridge tools — the SUPERSET view: the backstop's keys plus
 * addLabels). Payload normalization rides mergeBackstop.threadRowsOf /
 * mergeVerdictGate.prCommentList (the ONE readers).
 *
 * Pure module — no dmtools globals (the io is injected). GraalJS-clean
 * (var + plain functions, JSON-safe data). Requires hoisted (gh-823).
 */
'use strict';

var mcpParse = require('./mcpParse.js');
var reviewVerdicts = require('./reviewVerdicts.js');
var machineAuthor = require('./machineAuthor.js');
var machineNotice = require('./machineNotice.js');
var configLoader = require('../configLoader.js');
var mergeBackstop = require('./mergeBackstop.js');
var mergeVerdictGate = require('./mergeVerdictGate.js');
// gh-1406 §7 (hoisted, never lazy — the gh-823 pack-require rule): the
// reviewer-pool marker family + the required-reviewer hold state.
var reviewPoolMarkers = require('./reviewPoolMarkers.js');

// Delegates: the marker family (the dmtools:merge-hold prefix this gate
// shares with the gh-1416 verdict holds), the comment reader and the
// shared merge-path wiring ceremony live on the sibling modules — the
// gate never grows a second copy (gh-1248 lesson: byte-identical copies
// grow and diverge).
var MARKER_PREFIX = mergeVerdictGate.MARKER_PREFIX;
var MARKER_SUFFIX = mergeVerdictGate.MARKER_SUFFIX;

// The escalation label (the gh-957 pattern — the same label the SM's
// rework-exhaustion escalation uses; machineSmAgent skips items carrying
// it entirely).
var ESCALATION_LABEL = 'needs-human';

// The reason constant of THIS gate's hold markers — the dedup filter key
// that keeps the verdict-freshness holds (reason "verdict"), the open-thread
// holds (reason "open-threads") and the gh-1406 required-reviewer holds
// (reason "required-reviewer") in separate marker budgets.
var MARKER_REASON = 'open-threads';

// The knob defaults (the ticket: strict by default — owner directive
// 2026-11-10 — with a 24h human-hold escalation valve).
var DEFAULT_HOLD_ON_HUMAN_THREADS = true;
var DEFAULT_HUMAN_HOLD_HOURS = 24;
var HOUR_MS = 3600000;

// ── the knobs ────────────────────────────────────────────────────────────────

// The effective holdOnHumanThreads: explicit false wins (boolean or the
// string spelling a config round-trip may carry); anything else is the
// strict default.
function holdOnHumanThreadsOf(knobs, jobKnobs) {
    var v = (jobKnobs && jobKnobs.holdOnHumanThreads !== undefined)
        ? jobKnobs.holdOnHumanThreads : knobs.holdOnHumanThreads;
    return !(v === false || v === 'false');
}

// The effective humanHoldHours: a finite non-negative number wins; any
// junk (string junk, negative, NaN) falls back to the default.
function humanHoldHoursOf(knobs, jobKnobs) {
    var v = (jobKnobs && jobKnobs.humanHoldHours !== undefined)
        ? jobKnobs.humanHoldHours : knobs.humanHoldHours;
    var n = (typeof v === 'number') ? v : Number(v);
    return (isFinite(n) && n >= 0) ? n : DEFAULT_HUMAN_HOLD_HOURS;
}

/**
 * The per-repo merge-gate knobs: `.dmtools/config.js` `mergeGate` object,
 * field-overridden by a `mergeGate` block on jobParams. A config load
 * failure falls back to defaults (never throws — the gate's knobs must
 * not break the merge funnel).
 */
function mergeGateSettingsOf(jobParams) {
    var config = null;
    try {
        config = configLoader.loadProjectConfig(jobParams || {});
    } catch (eConfig) {
        config = null;
    }
    var knobs = (config && config.mergeGate) || {};
    var jobKnobs = (jobParams && jobParams.mergeGate) || {};
    return {
        holdOnHumanThreads: holdOnHumanThreadsOf(knobs, jobKnobs),
        humanHoldHours: humanHoldHoursOf(knobs, jobKnobs)
    };
}

// ── the census ───────────────────────────────────────────────────────────────

/**
 * The open-thread rows of a github_get_pr_review_threads payload — the
 * backstop's ONE normalization (threadRowsOf) minus the resolved rows.
 */
function openThreadRowsOf(raw) {
    var rows = mergeBackstop.threadRowsOf(mcpParse.parseMcp(raw));
    return rows.filter(function (row) { return row && row.resolved !== true; });
}

/**
 * The classification-independent census: unresolved, non-notice review
 * threads split by author class. Resolved threads and machine notices
 * (the gh-808 doctrine — threads whose ROOT BODY carries a harness notice
 * marker or a hidden dmtools marker) never count: the machine's own
 * bookkeeping comments must never deadlock a PR. Everything else counts —
 * ANY AUTHOR gates (the ticket's rule). Bot-AUTHORED threads deliberately
 * still count: a [bot]-suffixed login is exactly how GitHub reports App
 * identities (gh-1025), so excluding them would swallow the machine's own
 * review threads the moment the allowlist is unresolvable — the precise
 * "nothing gates at all" pathology gh-1417 fixes (AC4). The split is
 * machine (the machineAuthor allowlist) or human; an EMPTY allowlist
 * reads every open thread as human — misclassification may only affect
 * WHICH auto-disposition runs, never whether the merge is blocked.
 */
function censusOf(rows, logins) {
    var c = { total: 0, human: 0, machine: 0, notices: 0, resolved: 0 };
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
        var t = row || {};
        if (t.resolved === true) { c.resolved++; return; }
        if (machineNotice.isMachineNoticeBody(t.body)) { c.notices++; return; }
        c.total++;
        if (machineAuthor.loginMatchesList(t.author, logins)) c.machine++;
        else c.human++;
    });
    return c;
}

/**
 * Does this census hold the merge? Machine threads ALWAYS gate here
 * (stage 2 catches survivors of stage 1 — a race arrival, a no-id
 * thread); human threads gate unless delegated away
 * (holdOnHumanThreads=false restores gh-744 for them).
 */
function censusHolds(census, holdOnHumanThreads) {
    if (!census || !census.total) return false;
    if (census.machine > 0) return true;
    return holdOnHumanThreads !== false && census.human > 0;
}

// ── the hold markers ─────────────────────────────────────────────────────────

/**
 * The machine-parseable hold marker for one held head (the ticket's
 * payload: reason open-threads + total/human/machine/head; at/escalated/
 * heldSince ride along for the audit trail — the gh-1416 precedent). The
 * sentence below is only for a human who opens the PR.
 */
function buildHoldMarker(census, headSha, nowIso, escalated, heldSince, humanHoldHours) {
    var payload = {
        reason: MARKER_REASON,
        total: census.total,
        human: census.human,
        machine: census.machine,
        head: String(headSha || ''),
        at: nowIso || '',
        escalated: escalated === true
    };
    if (heldSince) payload.heldSince = heldSince;
    var note = escalated
        ? '\uD83E\uDD16 Merge hold ESCALATED (gh-1417): the open review thread(s) have held' +
          ' this PR beyond mergeGate.humanHoldHours (' + humanHoldHours + 'h, held since ' +
          (heldSince || 'an unknown time') + ') — needs-human; the automatic merge lanes' +
          ' skip this PR until a human resolves the discussion (manual merge via the UI' +
          ' stays available).'
        : '\uD83E\uDD16 Merge hold (gh-1417): ' + census.total + ' unresolved review thread(s)' +
          ' (human ' + census.human + ', machine ' + census.machine + ') — the merge is deferred' +
          ' until every discussion reaches resolution (machine notices excluded).' +
          ' A human can always merge manually via the UI.';
    return MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        MARKER_SUFFIX + '\n' + note;
}

/**
 * The open-threads hold record of one dmtools:merge-hold payload — null
 * for every other reason (the verdict-freshness holds are a separate
 * marker budget) and for headless payloads (no dedup key).
 */
function holdRecordFromPayload(parsed) {
    if (!parsed || String(parsed.reason || '') !== MARKER_REASON || !parsed.head) return null;
    return {
        head: String(parsed.head),
        at: String(parsed.at || ''),
        escalated: parsed.escalated === true,
        total: parsed.total,
        human: parsed.human,
        machine: parsed.machine
    };
}

/**
 * The open-threads hold markers already on the PR, oldest-first. ANY
 * author counts: the dedup exists to prevent comment spam (gh-808/gh-1392),
 * not to gate trust — a hold never enables a merge, it only documents one.
 */
function existingHolds(comments) {
    return reviewVerdicts.parseMarkerComments(comments || [], {},
        MARKER_PREFIX, MARKER_SUFFIX, holdRecordFromPayload, false);
}

// The FIRST (oldest) same-head hold, or null — the escalation clock reads it.
function holdForHead(holds, headSha) {
    for (var i = 0; i < holds.length; i++) {
        if (reviewVerdicts.sameHead(holds[i].head, headSha)) return holds[i];
    }
    return null;
}

// The oldest same-head ESCALATED hold, or null (the escalation dedup key).
function escalatedHoldForHead(holds, headSha) {
    for (var i = 0; i < holds.length; i++) {
        if (holds[i].escalated && reviewVerdicts.sameHead(holds[i].head, headSha)) return holds[i];
    }
    return null;
}

/**
 * Is the head's hold due for escalation? The hold duration is the age of
 * the OLDEST same-head marker's `at` (the head's hold started when the
 * marker was first stamped). An unparseable/absent `at` reads as DUE —
 * the escalation exists so the automatic FIFO cannot stall forever on an
 * abandoned PR, and an age-less hold is exactly an unmeasurable stall.
 * An unset knob reads as the default valve (24h).
 */
function escalationDue(hold, nowIso, humanHoldHours) {
    if (!hold) return false;
    var start = Date.parse(hold.at);
    var now = Date.parse(nowIso);
    if (isNaN(start) || isNaN(now)) return true;
    var hours = (typeof humanHoldHours === 'number' && isFinite(humanHoldHours) &&
        humanHoldHours >= 0) ? humanHoldHours : DEFAULT_HUMAN_HOLD_HOURS;
    return (now - start) >= hours * HOUR_MS;
}

// ── the stamp ────────────────────────────────────────────────────────────────

/**
 * The deduped hold stamp (soft, gh-1416 parity): an existing same-head
 * plain marker is reused in place (never a new comment per tick), a
 * fresh head gets its own marker, and a failed post never throws — the
 * defer already stands, the marker is observability. The escalation is a
 * bounded state transition: the escalated marker is a SECOND comment for
 * the head (the plain one cannot be edited — no comment-update primitive
 * on the bridge), deduped by its own escalated flag, so repeated
 * escalation-state ticks grow nothing. `holds` is the pre-parsed
 * existing-hold list (ONE comments read per gate run — the caller owns it).
 */
function stampHold(io, owner, name, input, out, census, holds, escalated, heldSince) {
    try {
        if (escalated) {
            if (escalatedHoldForHead(holds, out.head)) {
                out.escalationDeduped = true;
                return;
            }
        } else if (holdForHead(holds, out.head)) {
            out.holdDeduped = true;
            return;
        }
        if (!io || typeof io.createComment !== 'function') {
            out.markerSkipped = true; // hold stands — the marker is observability
            return;
        }
        io.createComment({
            workspace: owner, repository: name, number: input.prNumber,
            body: buildHoldMarker(census, out.head, input.nowIso, escalated,
                heldSince, input.humanHoldHours)
        });
        if (escalated) out.escalationPosted = true;
        else out.holdPosted = true;
    } catch (ePost) {
        out.holdPostFailed = true; // soft — the merge stays deferred regardless
    }
}

/**
 * The needs-human escalation label (gh-957 pattern), best-effort: a
 * failed add never throws (the escalated marker already names the state;
 * the label speeds the lanes' skip, it does not gate).
 */
function stampEscalationLabel(io, owner, name, input, out) {
    try {
        if (!io || typeof io.addLabels !== 'function') return;
        io.addLabels({
            workspace: owner, repository: name, number: input.prNumber,
            labels: [ESCALATION_LABEL]
        });
        out.labelPosted = true;
    } catch (eLabel) {
        out.labelFailed = true; // soft
    }
}

// ── the gh-1406 required-reviewer clause (§7) ────────────────────────────────

/**
 * The pool-outcome hold stamp for one head (the required-reviewer budget):
 * deduped per head like every hold marker; the escalation valve is the
 * same hold-age clock (mergeGate.humanHoldHours) — a required leg that
 * keeps failing retries every merge tick until the valve fires
 * (needs-human — never silent merge, never silent approval, gh-957).
 */
function requiredReviewerEscalates(state, inp) {
    return !!state.hold && escalationDue(state.hold, inp.nowIso, inp.humanHoldHours);
}

/**
 * The per-head dedup decision for the pool hold stamp: an already-stamped
 * hold of the SAME kind is never re-posted (one marker per head; the
 * escalation valve is the only transition). Returns the outcome field to
 * set, or null when a fresh stamp is due.
 */
function requiredHoldDedupOf(state, escalate) {
    if (escalate && state.hold && state.hold.escalated) return 'escalationDeduped';
    if (!escalate && state.hold) return 'holdDeduped';
    return null;
}

/**
 * The marker post (observability — never the decision): a missing
 * createComment primitive skips the stamp while the hold stands; a BROKEN
 * post throws through to the caller's soft catch.
 */
function postRequiredReviewerHoldMarker(io, owner, name, inp, out, state, escalate) {
    if (!io || typeof io.createComment !== 'function') {
        out.markerSkipped = true; // hold stands — the marker is observability
        return;
    }
    io.createComment({
        workspace: owner, repository: name, number: inp.prNumber,
        body: reviewPoolMarkers.buildRequiredReviewerHoldMarker(
            out.poolMissing, out.head, inp.nowIso, escalate, escalate ? state.hold.at : null)
    });
    if (escalate) {
        out.escalationPosted = true;
        stampEscalationLabel(io, owner, name, inp, out);
    } else {
        out.holdPosted = true;
    }
}

function stampRequiredReviewerHold(io, owner, name, inp, out, state) {
    try {
        var escalate = requiredReviewerEscalates(state, inp);
        var deduped = requiredHoldDedupOf(state, escalate);
        if (deduped) {
            out[deduped] = true;
            return;
        }
        postRequiredReviewerHoldMarker(io, owner, name, inp, out, state, escalate);
    } catch (ePost) {
        out.holdPostFailed = true; // soft — the merge stays withheld regardless
    }
}

/**
 * The comment list for the pool clause (ONE read per gate run): the
 * caller's already-read list wins; the direct-call shape reads its own.
 * A missing getComments primitive is a capability-miss skip (null).
 */
function poolCommentListOf(io, owner, name, inp, out, comments) {
    if (comments !== undefined) return comments;
    if (!io || typeof io.getComments !== 'function') {
        out.poolSkipped = true; // capability miss — the skip shape
        return null;
    }
    return mergeVerdictGate.prCommentList(io.getComments, owner, name, inp.prNumber);
}

/**
 * Phase 0 — the required-reviewer pool clause (gh-1406 §7): when the
 * CURRENT head's pool outcome names required reviewers and one of them
 * lacks a same-head PASS marker, the merge is withheld (like red CI —
 * a PR must not merge with no security review because a leg 429'd).
 * `comments` is the caller's already-read list (ONE comments round-trip
 * per gate run — shared with the open-threads dedup); when it arrives
 * undefined the phase reads its own (direct-call shape). Fail-open exactly:
 * no pool outcome on this head (legacy single-leg PRs, validation-only
 * flows) → proceed — a missing head sha proceeds the same way, since an
 * outcome only ever matches a real head (sameHead's falsy guard); no
 * getComments primitive → capability-miss skip; a BROKEN read throws
 * through (fail-closed, like every census in this gate). Returns true when
 * the gate HELD on this clause (the caller skips the thread work — the
 * hold stands).
 */
function poolPhase(io, owner, name, inp, out, comments) {
    var list = poolCommentListOf(io, owner, name, inp, out, comments);
    if (list === null) return false;
    var state = reviewPoolMarkers.requiredReviewerHoldState(list, inp.logins || [], out.head, inp.nowIso);
    if (!state.applicable) return false;
    out.poolMissing = state.missing;
    if (state.missing.length === 0) return false;
    out.held = true;
    out.holdReason = reviewPoolMarkers.HOLD_REASON;
    stampRequiredReviewerHold(io, owner, name, inp, out, state);
    return true;
}

// ── the gate ─────────────────────────────────────────────────────────────────

/**
 * The stage-2 gate for one PR about to merge (runs AFTER the backstop).
 * Throws (fail-closed) when the threads census read or the marker-dedup
 * comments read breaks — hold, never "classified as no threads" (the
 * #1319 pathology rule); the caller defers THAT merge to the next tick.
 * Returns the outcome — `held` is the caller's defer signal.
 *
 * io:    { getThreads, getComments, createComment, addLabels }.
 * input: { prNumber, headSha, logins, nowIso, holdOnHumanThreads?,
 *          humanHoldHours? } — logins is the machine allowlist (an EMPTY
 *          one reads every open thread as human — the hold survives);
 *          the knobs default strict (true / 24h).
 */
// The fresh outcome record — every observable flag the gate can set, in
// one place (all false/empty until a phase sets them).
function gateOutcomeOf(inp) {
    return {
        prNumber: inp.prNumber,
        held: false,
        escalated: false,
        holdReason: null,
        total: 0,
        human: 0,
        machine: 0,
        notices: 0,
        poolMissing: [],
        head: inp.headSha || null,
        holdPosted: false,
        holdDeduped: false,
        holdPostFailed: false,
        markerSkipped: false,
        escalationPosted: false,
        escalationDeduped: false,
        labelPosted: false,
        labelFailed: false,
        threadsSkipped: false,
        poolSkipped: false,
        commentsSkipped: false
    };
}

// Phase 1 — the census. Returns the census when it holds the merge;
// null when the gate stops here (capability miss, or the census lets
// the merge proceed — the outcome carries which).
function censusPhase(io, owner, name, inp, out) {
    if (!io || typeof io.getThreads !== 'function') {
        out.threadsSkipped = true; // capability miss — the backstop's skip shape
        return null;
    }
    // Fail-closed census: a broken read throws through (hold) — it must
    // never classify as "no threads" (the #1319 pathology rule).
    var census = censusOf(openThreadRowsOf(io.getThreads({
        workspace: owner, repository: name, pullRequestId: String(inp.prNumber)
    })), inp.logins || []);
    out.total = census.total;
    out.human = census.human;
    out.machine = census.machine;
    out.notices = census.notices;
    if (!censusHolds(census, inp.holdOnHumanThreads)) return null; // merge proceeds
    return census;
}

// Phase 2 — the hold. Runs only once the census holds the merge:
// the dedup-safe stamp, the escalation valve and its label transition.
function holdPhase(io, owner, name, inp, out, census, escalate, comments) {
    out.held = true;
    if (!out.head) {
        out.markerSkipped = true; // hold stands — no dedup key, no marker
        return out;
    }
    if (typeof io.getComments !== 'function') {
        out.commentsSkipped = true; // hold stands — no dedup-safe marker
        return out;
    }
    // Fail-closed dedup read: posting without it would comment-spam. ONE
    // comments read per gate run — runGate reads it once for the gh-1406
    // pool clause and threads the SAME list here (the hold lookup, the
    // escalation clock and the stamp share it).
    var list = comments;
    if (list === undefined) {
        list = mergeVerdictGate.prCommentList(io.getComments, owner, name, inp.prNumber);
    }
    var holds = existingHolds(list);
    var existing = holdForHead(holds, out.head);
    if (existing && escalate && escalationDue(existing, inp.nowIso, inp.humanHoldHours)) {
        out.holdDeduped = true;
        out.escalated = true;
        stampHold(io, owner, name, inp, out, census, holds, true, existing.at);
        if (out.escalationPosted) {
            // The label rides the state TRANSITION only — a deduped
            // marker means the escalation already stood (no label spam).
            stampEscalationLabel(io, owner, name, inp, out);
        }
        return out;
    }
    stampHold(io, owner, name, inp, out, census, holds, false, null);
    return out;
}

function runGate(io, owner, name, input) {
    var inp = input || {};
    var out = gateOutcomeOf(inp);
    // ONE comments read per gate run: the gh-1406 required-reviewer pool
    // clause and the open-threads hold dedup parse the SAME list.
    var comments;
    if (typeof io.getComments === 'function') {
        comments = mergeVerdictGate.prCommentList(io.getComments, owner, name, inp.prNumber);
        // Phase 0 — the gh-1406 pool clause: a required reviewer without a
        // same-head PASS marker holds the merge before any thread work
        // (a PR never merges with no security review because a leg 429'd).
        if (poolPhase(io, owner, name, inp, out, comments)) return out;
    } else {
        out.poolSkipped = true; // capability miss — the skip shape
    }
    var census = censusPhase(io, owner, name, inp, out);
    if (!census) return out; // capability miss, or the merge proceeds
    // The escalation valve keys on HUMAN threads actually holding the
    // merge (a machine-only hold waits on stage 1's retry loop — its
    // repeated failures escalate through the funnel job surface, never
    // through needs-human).
    var escalate = inp.holdOnHumanThreads !== false && census.human > 0;
    return holdPhase(io, owner, name, inp, out, census, escalate, comments);
}

// ── caller-facing log lines ──────────────────────────────────────────────────

// The marker-state fragment of the held line (gh-1416 parity).
function holdStampLine(out) {
    if (out.escalationPosted) return 'hold ESCALATED (needs-human) — escalated marker posted';
    if (out.escalationDeduped) return 'hold ESCALATED (needs-human) — escalated marker deduped';
    if (out.holdPosted) return 'hold marker posted (one per head)';
    if (out.holdDeduped) return 'hold marker deduped per head (existing marker reused in place)';
    if (out.holdPostFailed) return 'hold marker post failed — fail-open';
    if (out.markerSkipped || out.commentsSkipped) return 'hold marker skipped (no dedup-safe primitive)';
    return 'hold marker skipped';
}

/**
 * One observable line per probe shape — the callers say() these verbatim.
 * The held line is the defer record; every non-held shape names why the
 * merge proceeds (the fail-open audit trail — the census reads themselves
 * fail closed by throwing).
 */
function outcomeLines(out) {
    if (!out) return [];
    if (out.held && out.holdReason === reviewPoolMarkers.HOLD_REASON) {
        return ['\uD83E\uDD16 merge hold on PR #' + out.prNumber + ': required reviewer(s) ' +
            (out.poolMissing || []).join(', ') + ' missing a PASS marker on the current head — merge deferred ' +
            '(a failed required review leg never merges); resolution: the reviewer leg completes ' +
            '(retry with backoff, needs-human past the hold valve); ' + holdStampLine(out)];
    }
    if (out.held) {
        return ['\uD83E\uDD16 merge hold on PR #' + out.prNumber + ': ' + out.total +
            ' unresolved review thread(s) (human ' + out.human + ', machine ' + out.machine +
            ') — merge deferred (gh-1417), next tick retries; ' + holdStampLine(out) +
            '; resolution: the threads resolve (or, past mergeGate.humanHoldHours,' +
            ' a human takes it — manual merge via the UI stays available)'];
    }
    if (out.threadsSkipped) {
        return ['⏭️ merge gate skipped on PR #' + out.prNumber +
            ' (no threads primitive — capability miss) — merge proceeds (gh-1417)'];
    }
    return ['🧵 merge gate on PR #' + out.prNumber + ': ' + out.total +
        ' unresolved review thread(s) (human ' + out.human + ', machine ' + out.machine +
        ') — merge proceeds (gh-1417)'];
}

// ── the merge-path wiring (the ONE shared helper for the three funnels) ──────

/**
 * The dmtools github-bridge globals → the io bag the two-stage gate
 * consumes: the SUPERSET VIEW of the backstop's naming place (gh-1416
 * duplication ratchet) plus the escalation label primitive. Each
 * identifier is typeof-guarded, so a runtime without a primitive maps
 * null (capability miss — the path skips degraded) instead of throwing a
 * ReferenceError in a harness that did not declare it. Absent = null,
 * never a stub.
 */
function githubBridgeIo() {
    var io = mergeBackstop.githubBridgeIo();
    io.addLabels = (typeof github_add_labels === 'function') ? github_add_labels : null;
    return io;
}

/**
 * The stage-2 wiring for a merge path (gh-1417): the shared ceremony
 * (mergeBackstop.runProbeForPr) builds the input from the PR payload +
 * jobParams (the knobs ride the extra hook), runs the gate and says the
 * outcome lines verbatim. Throws on a broken census/dedup read
 * (fail-closed — the CALLER defers THAT merge); returns the outcome.
 *
 *   bridges — the io bag (githubBridgeIo() in production; test mocks).
 *   job     — the caller's jobParams (the machineAuthor allowlist and the
 *             mergeGate knobs live there).
 *   pr      — the parsed get_pr payload (either shape).
 */
function runGateForPr(bridges, owner, name, job, prNumber, pr, say) {
    return mergeBackstop.runProbeForPr(runGate, outcomeLines, bridges, owner, name, job,
        prNumber, pr, say, function (input) {
            var knobs = mergeGateSettingsOf(job);
            input.holdOnHumanThreads = knobs.holdOnHumanThreads;
            input.humanHoldHours = knobs.humanHoldHours;
        });
}

/**
 * The one-call two-stage merge gate for a merge path about to
 * squash-merge (gh-1417) — the shared helper ALL THREE funnels call
 * (js/mergeTrigger.js runStateMachine, js/sm/mergeBot.js
 * mergeApprovedHead, js/retryMergeGithubPR.js):
 *
 *   Stage 1 — mergeBackstop.runBackstopForPr: machine threads reach
 *   terminal disposition. THROWS THROUGH on any record-keeping or
 *   resolve/ack failure (gh-1370 semantics — hold, retry next tick; each
 *   caller keeps its own throw handling).
 *
 *   Stage 2 — runGateForPr (this module): the classification-independent
 *   hold. Returns the outcome — `held` is the caller's defer signal.
 *   Throws (fail-closed) on a broken census/dedup read.
 */
function runForPr(bridges, owner, name, job, prNumber, pr, say) {
    var backstop = mergeBackstop.runBackstopForPr(bridges, owner, name, job, prNumber, pr, say);
    var gate = runGateForPr(bridges, owner, name, job, prNumber, pr, say);
    // gh-1420: the backstop outcome rides the returned outcome — the funnel
    // that squash-merges posts the residue merge-note from it (and renders
    // the merged MERGE-DECISION line's machine/human counts). Purely
    // additive: every existing consumer reads held/total/human/machine.
    gate.backstop = backstop;
    return gate;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_REASON: MARKER_REASON,
        ESCALATION_LABEL: ESCALATION_LABEL,
        DEFAULT_HOLD_ON_HUMAN_THREADS: DEFAULT_HOLD_ON_HUMAN_THREADS,
        DEFAULT_HUMAN_HOLD_HOURS: DEFAULT_HUMAN_HOLD_HOURS,
        mergeGateSettingsOf: mergeGateSettingsOf,
        openThreadRowsOf: openThreadRowsOf,
        censusOf: censusOf,
        censusHolds: censusHolds,
        buildHoldMarker: buildHoldMarker,
        existingHolds: existingHolds,
        holdForHead: holdForHead,
        escalatedHoldForHead: escalatedHoldForHead,
        escalationDue: escalationDue,
        runGate: runGate,
        poolPhase: poolPhase,
        outcomeLines: outcomeLines,
        githubBridgeIo: githubBridgeIo,
        runGateForPr: runGateForPr,
        runForPr: runForPr
    };
}
