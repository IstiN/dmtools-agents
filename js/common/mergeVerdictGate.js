/**
 * mergeVerdictGate.js — the merge-instant verdict-freshness probe (gh-1416).
 *
 * Live pathology (PR #1410, 2026-11-09): the newest machine verdict for the
 * merged head 0c2732d was REQUEST_CHANGES (marker 15:42:44Z), yet the PR
 * squash-merged 80 seconds later (15:44:04Z). The tick-level gh-807
 * reconciler that exists precisely for this contradiction ("a sticky
 * pr_approved whose newest verdict for the CURRENT head is
 * REQUEST_CHANGES/BLOCK — the approval is stale") runs in the 10-minute SM
 * tick, while the label-triggered merge funnel fired 19 seconds after the
 * stale pr_approved landed. An irreversible action (merge) protected by a
 * 10-minute cadence cleaner is a structural race.
 *
 * The gate runs AT the squash-merge decision — the same place the
 * gh-1353/gh-1370 backstop already rides (runStateMachine in
 * js/mergeTrigger.js, mergeApprovedHead in js/sm/mergeBot.js, and the
 * retry lane js/retryMergeGithubPR.js) — BEFORE the backstop (a held merge
 * skips the thread work entirely). It reads the PR's comments
 * (fetchPrCommentList normalization), parses dmtools:review-verdict
 * markers via js/common/reviewVerdicts.js, considers only records whose
 * head equals the PR's CURRENT head sha, and when the newest such record's
 * verdict is REQUEST_CHANGES or BLOCK it DEFERS the merge (the BEHIND
 * state's "skipped, next tick retries" path) and stamps a
 * machine-parseable hold marker on the PR:
 *
 *   <!-- dmtools:merge-hold {"reason":"verdict","verdict":"REQUEST_CHANGES","head":"<sha>"} -->
 *
 * The hold is deduped per head: an existing same-head hold is refreshed in
 * place (reused — never a new comment per tick; the gh-808/gh-1392
 * comment-reduction doctrine, ≤ 1 comment per head). The bridge carries no
 * comment-update primitive, so a MOVED head gets its own fresh hold — one
 * per head, exactly like the gh-848 ghost-guard markers. Resolution of the
 * hold is the normal flow: a rework lap lands a new head with a fresh
 * verdict (the stale head's records stop matching), or a human resolves
 * the discussion / merges manually. The gate never removes the hold —
 * stale holds are inert by construction (head-scoped).
 *
 * Fail-open, exactly:
 *   - no verdict record for the current head at all (validation-only
 *     flows, pre-gh-807 PRs) → proceed as today;
 *   - records exist only for OLDER heads (the head moved after the
 *     review) → proceed as today; head-scoped stickiness stays the SM's
 *     domain;
 *   - unreadable/garbage markers are treated as absent — a marker that
 *     does not parse does not exist for this module (reviewVerdicts
 *     doctrine); a BROKEN comment read is surfaced (commentsUnreadable)
 *     and ALSO fails open — the probe adds no new merge-blocking surface;
 *   - verdict records are trusted only from machine identities (the
 *     machineAuthor allowlist via mergeBackstop.machineLoginsOf, gh-807
 *     review round 3): unconfigured = the empty list = nothing trusted =
 *     proceed as today, so a forged REQUEST_CHANGES marker can never hold
 *     a merge.
 *
 * The gh-807 tick reconciler stays — it repairs the labels; this gate
 * protects the merge instant (gh-1416). The CAUSE of the contradiction
 * (the gh-71 REQUEST_CHANGES→approve downgrade in the review finisher) is
 * #1419 and stays out of scope here.
 *
 * IO contract: runGate(io, owner, name, input) — `io` maps the raw bridge
 * primitives (or test mocks): getComments (github_get_pr_comments),
 * createComment (github_create_comment). The merge paths call
 * runGateForPr instead (githubBridgeIo() enumerates the engine's bridge
 * tools). Payload normalization rides mcpParse (fetchPrCommentList parity).
 *
 * Pure module — no dmtools globals (the io is injected). GraalJS-clean
 * (var + plain functions, JSON-safe data). Requires hoisted (gh-823).
 */
'use strict';

var mcpParse = require('./mcpParse.js');
var reviewVerdicts = require('./reviewVerdicts.js');
var mergeBackstop = require('./mergeBackstop.js');

// The machine marker: one line, JSON payload, invisible in the rendered PR
// (reviewVerdicts marker-family shape).
var MARKER_PREFIX = '<!-- dmtools:merge-hold ';
var MARKER_SUFFIX = ' -->';

// The verdicts that hold a merge. APPROVE (and the absence of records)
// proceeds as today.
var HOLDING_VERDICTS = ['REQUEST_CHANGES', 'BLOCK'];

// Delegates: the ONE shared derivation of the head sha across payload
// shapes (gh-1371) and the gh-728 machine-logins resolution chain live on
// the sibling merge-path module (mergeBackstop) — the gate never grows a
// second copy (gh-1248 lesson: byte-identical copies grow and diverge).
var headShaOf = mergeBackstop.headShaOf;
var shortSha = mergeBackstop.shortSha;
var machineLoginsOf = mergeBackstop.machineLoginsOf;

// ── the comment read (fetchPrCommentList parity) ────────────────────────────

/**
 * The PR comment list, normalized through the ONE payload shape every
 * marker reader shares (js/smAgent.js fetchPrCommentList): string | object
 * | {comments|items} envelope → array. A missing primitive (capability
 * miss) reads as null — the caller's gate skips degraded, never blind-holds.
 */
function prCommentList(getComments, owner, name, prNumber) {
    if (typeof getComments !== 'function') return null;
    var raw = getComments({
        workspace: owner, repository: name, pullRequestId: String(prNumber)
    });
    var obj = mcpParse.parseMcp(raw);
    return Array.isArray(obj) ? obj : (obj.comments || obj.items || []);
}

// ── the hold marker ──────────────────────────────────────────────────────────

/**
 * The machine-parseable hold marker for one held head. The payload keys
 * are the protocol (reason/verdict/head per gh-1416; at/source ride along
 * for the audit trail); the sentence below is only for a human who opens
 * the PR (buildVerdictComment parity).
 */
function buildHoldMarker(record, headSha, nowIso) {
    var payload = {
        reason: 'verdict',
        verdict: String((record && record.verdict) || '').toUpperCase(),
        head: String(headSha || ''),
        at: nowIso || '',
        source: String((record && record.source) || 'unknown')
    };
    var note = '\uD83E\uDD16 Merge hold (gh-1416): the newest review verdict on head `' +
        shortSha(headSha) + '` is **' + payload.verdict + '** — the merge is deferred' +
        ' until a fresh verdict lands (rework lap on a new head) or a human resolves' +
        ' the discussion.';
    return MARKER_PREFIX + JSON.stringify(payload, reviewVerdicts.markerSafeReplacer) +
        MARKER_SUFFIX + '\n' + note;
}

// The hold-record shape of one dmtools:merge-hold payload (dedup key: head).
function holdRecordFromPayload(parsed) {
    if (!parsed || !parsed.head) return null;
    return {
        head: String(parsed.head),
        verdict: String(parsed.verdict || ''),
        reason: String(parsed.reason || ''),
        at: String(parsed.at || ''),
        source: String(parsed.source || '')
    };
}

/**
 * The hold markers already on the PR, oldest-first. ANY author counts:
 * the dedup exists to prevent comment spam (gh-808/gh-1392), not to gate
 * trust — a hold never enables a merge, it only documents one.
 */
function existingHolds(comments) {
    return reviewVerdicts.parseMarkerComments(comments || [], {},
        MARKER_PREFIX, MARKER_SUFFIX, holdRecordFromPayload, false);
}

// Is one of the holds already stamped for THIS head (sameHead — prefix-tolerant)?
function hasHoldForHead(holds, headSha) {
    for (var i = 0; i < holds.length; i++) {
        if (reviewVerdicts.sameHead(holds[i].head, headSha)) return true;
    }
    return false;
}

// ── the gate ─────────────────────────────────────────────────────────────────

/**
 * Does this effective verdict hold the merge? Only the two blocking
 * verdicts do; APPROVE (and any absence) proceeds as today.
 */
function verdictHolds(verdict) {
    return HOLDING_VERDICTS.indexOf(String(verdict || '').toUpperCase()) !== -1;
}

/**
 * The deduped hold stamp (soft): a same-head hold refreshes in place (no
 * new comment), a fresh head gets its own marker, and a failed post never
 * throws — the defer already stands, the marker is observability.
 */
function stampHold(io, owner, name, comments, input, out, record) {
    try {
        if (hasHoldForHead(existingHolds(comments), out.head)) {
            out.holdDeduped = true;
            return;
        }
        if (!io || typeof io.createComment !== 'function') return;
        io.createComment({
            workspace: owner, repository: name, number: input.prNumber,
            body: buildHoldMarker(record, out.head, input.nowIso)
        });
        out.holdPosted = true;
    } catch (ePost) {
        out.holdPostFailed = true; // soft — the merge stays deferred regardless
    }
}

/**
 * The verdict-freshness gate for one PR about to merge (gh-1416). Returns
 * { prNumber, held, verdict, head, holdPosted, holdDeduped, holdPostFailed,
 *   commentsUnreadable } — `held` is the caller's defer signal. NEVER
 * throws: every fault inside the probe fails open (a broken read or a
 * garbage marker is "no records"; the merge proceeds as today and the
 * outcome lines say which fail-open shape fired).
 *
 * io:    { getComments, createComment } (raw bridge primitives or mocks).
 * input: { prNumber, headSha, logins, nowIso } — logins is the machine
 *        allowlist (empty trusts nothing); headSha null consults nothing.
 */
function runGate(io, owner, name, input) {
    var inp = input || {};
    var out = {
        prNumber: inp.prNumber,
        held: false,
        verdict: null,
        head: inp.headSha || null,
        holdPosted: false,
        holdDeduped: false,
        holdPostFailed: false,
        commentsUnreadable: false
    };
    if (!out.head) return out; // no head on the payload — nothing to consult
    if (!inp.logins || !inp.logins.length) {
        // No configured machine identity = nothing can ever be trusted —
        // skip the comment read entirely (no new API pressure on
        // deployments without the machineAuthor knob; the merge proceeds
        // as today, gh-807 review round 3 doctrine).
        return out;
    }
    var comments;
    try {
        comments = prCommentList(io && io.getComments, owner, name, inp.prNumber);
    } catch (eRead) {
        out.commentsUnreadable = true; // fail-open, logged by the outcome line
        return out;
    }
    if (!comments) return out; // capability miss (no primitive) — fail-open
    var effective;
    try {
        effective = reviewVerdicts.latestVerdictForHead(
            reviewVerdicts.parseVerdictRecords(comments,
                { authorLogins: inp.logins || [] }),
            out.head);
    } catch (eParse) {
        out.commentsUnreadable = true; // paranoia — the parser never throws
        return out;
    }
    if (!effective) return out; // fail-open: no records / older heads only
    out.verdict = effective.record.verdict;
    if (!verdictHolds(out.verdict)) return out; // APPROVE — merge as today
    out.held = true;
    stampHold(io, owner, name, comments, inp, out, effective.record);
    return out;
}

// ── caller-facing log lines ──────────────────────────────────────────────────

// The reason a non-held probe proceeded (the fail-open audit trail).
function proceedReason(out) {
    if (out.commentsUnreadable) {
        return 'verdict comments unreadable — fail-open (treated as absent)';
    }
    if (!out.head) return 'no head sha on the PR payload — nothing to consult';
    if (out.verdict) {
        return 'newest verdict on head ' + shortSha(out.head) + ' is ' + out.verdict;
    }
    return 'no verdict records for head ' + shortSha(out.head) + ' — fail-open';
}

// The hold-state fragment of the held line.
function holdStampLine(out) {
    if (out.holdPosted) return 'hold marker posted (one per head)';
    if (out.holdDeduped) return 'hold marker deduped per head (refreshed in place)';
    if (out.holdPostFailed) return 'hold marker post failed — fail-open';
    return 'hold marker skipped (no create-comment primitive)';
}

/**
 * One observable line per probe shape — the callers say() these verbatim.
 * The held line is the defer record (the "skipped, next tick retries"
 * path); every non-held shape names its fail-open reason.
 */
function outcomeLines(out) {
    if (!out) return [];
    if (out.held) {
        return ['\uD83D\uDED0 merge hold on PR #' + out.prNumber +
            ': newest verdict on head ' + shortSha(out.head) + ' is ' + out.verdict +
            ' — merge deferred (gh-1416), next tick retries; ' + holdStampLine(out) +
            '; resolution: a fresh verdict (rework lap) or a human resolves the discussion'];
    }
    return ['\uD83D\uDEA6 verdict gate on PR #' + out.prNumber + ': ' +
        proceedReason(out) + ' — merge proceeds (gh-1416)'];
}

// ── the merge-path wiring (shared by mergeTrigger + sm/mergeBot + retry) ────

/**
 * The dmtools github-bridge globals → the io bag runGate consumes. Each
 * identifier is typeof-guarded, so a runtime without a primitive maps null
 * (capability miss — the gate skips degraded) instead of throwing a
 * ReferenceError in a harness that did not declare it. Absent = null,
 * never a stub.
 */
function githubBridgeIo() {
    return {
        getComments: (typeof github_get_pr_comments === 'function') ? github_get_pr_comments : null,
        createComment: (typeof github_create_comment === 'function') ? github_create_comment : null
    };
}

/**
 * The one-call wiring for a merge path about to squash-merge (gh-1416):
 * builds the input from the PR payload + jobParams, runs the gate and says
 * the outcome lines verbatim. Never throws (runGate fails open); returns
 * the outcome — `held` is the caller's defer signal.
 *
 *   bridges — the io bag (githubBridgeIo() in production; test mocks).
 *   job     — the caller's jobParams (machineAuthor allowlist lives there).
 *   pr      — the parsed get_pr payload (either shape).
 */
function runGateForPr(bridges, owner, name, job, prNumber, pr, say) {
    var out = runGate(bridges, owner, name, {
        prNumber: prNumber,
        headSha: headShaOf(pr),
        logins: machineLoginsOf(job),
        nowIso: (new Date()).toISOString()
    });
    outcomeLines(out).forEach(function (line) { if (say) say(line); });
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        HOLDING_VERDICTS: HOLDING_VERDICTS,
        verdictHolds: verdictHolds,
        prCommentList: prCommentList,
        buildHoldMarker: buildHoldMarker,
        existingHolds: existingHolds,
        hasHoldForHead: hasHoldForHead,
        headShaOf: headShaOf,
        runGate: runGate,
        outcomeLines: outcomeLines,
        githubBridgeIo: githubBridgeIo,
        runGateForPr: runGateForPr
    };
}
