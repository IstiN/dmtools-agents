/**
 * Validation liveness (gh-821) — the arm-must-mean-a-live-run state machine.
 *
 * Live fa PR #1443 (2026-10-09 13:36–15:00Z): the dispatched validation run
 * concluded CANCELLED (kicker/dispatch race, gh-748 guard family) while the
 * `ai_validating` arm stayed on; the stale-arm sweeper skipped it ("no
 * concluded-and-stale validation run on the head — arm stays") and four
 * validated PRs deferred on the mutex for ~2h until a manual
 * `gh workflow run ci.yml --ref <head>` unstick. CANCELLED is never a
 * VERDICT (gh-755 — no rework on a cancel), but a cancel (or a lost
 * dispatch) behind an arm is a ZOMBIE: the mutex is held with no live run
 * behind it, which is exactly what the serial slot must never do.
 *
 * This module is the pure half of the fix:
 *
 *   classify(probe)  — the liveness state machine over a
 *                      probeDispatchedState bundle: 'running' (in-flight,
 *                      or concluded inside the check-visibility grace),
 *                      'green' / 'red' (verdict paths — callers keep their
 *                      existing consumption), 'zombie-cancelled' /
 *                      'zombie-no-run' (the arm holds the slot with no
 *                      live run; caller re-dispatches, bounded).
 *   zombie marks     — durable per-head re-dispatch bookkeeping carried in
 *                      marker comments (the red-head/empty-lap carrier:
 *                      per-PR state with zero extra infrastructure). One
 *                      marker per re-dispatch gives the crash-loop guard
 *                      (3 in a row on the same head ⇒ park) and the rate
 *                      bound (1 auto re-dispatch per head per hour).
 *
 * Probe-error degeneracy: newestDispatchedRun fails CLOSED (null on error
 * AND on an empty list), so a degraded read classifies as 'zombie-no-run'.
 * That is the documented fail-open contract of the dispatch guards — the
 * worst case is one bounded duplicate CI run (1/head/hour), never a wedge;
 * the alternative (treating a probe outage as live) re-creates the deadlock
 * this module exists to break.
 *
 * Pure functions, no tool globals — smAgent wires the transport, tests
 * inject nothing. CommonJS module like every other js/ module. GraalJS
 * rules apply: var + plain functions only.
 */

'use strict';

// Run states that mean "a run is materially in flight" — THE single source
// of truth for that vocabulary (gh-821 round-2 review): smAgent's
// hasActiveDispatchedRun and hasActiveHeadRun consume this constant instead
// of keeping parallel inline lists that drift. The PROBE_WORKER_SOURCE copy
// in smAgent keeps its own literal list by necessity (the worker source is
// serialized via fn.toString() and cannot close over module scope).
var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending'];

// gh-1101: post-conclusion check-visibility grace. Applies ONLY to the
// re-DISPATCH decision (a just-concluded run's check-runs may not be
// visible yet) — never to latching a green verdict.
var CONCLUDED_REDISPATCH_GRACE_MS = 15 * 60 * 1000;

/** True when `run` is completed and concluded less than `ms` before nowMs. */
function concludedWithin(run, nowMs, ms) {
    if (!run || run.status !== 'completed') return false;
    var age = nowMs - Date.parse(run.updated_at || run.created_at || '');
    return age >= 0 && age < ms;
}

// ── Liveness classification ────────────────────────────────────────────────

/**
 * Classify the head's dispatched-run state from one probeDispatchedState
 * bundle ({ active, verdict, green, newest }).
 *
 *   'running'          — a live run exists (queued/in_progress/waiting/
 *                        pending), OR the newest run concluded inside the
 *                        check-visibility grace (hasActiveDispatchedRun
 *                        counts a completed run active for 15 min after its
 *                        conclusion — the verdict race window gh-755 and the
 *                        rerun-cancelled-checks remedy own; a FRESH cancel
 *                        therefore still reads 'running', never a zombie).
 *   'green'            — newest concluded success (verdict path).
 *   'red'              — newest concluded failure/timed_out/… — any
 *                        non-cancelled, non-success conclusion is a verdict
 *                        word (sweep parity: the existing code treats every
 *                        `conclusion !== 'cancelled'` as sweepable).
 *   'zombie-cancelled' — newest concluded CANCELLED outside every grace —
 *                        no verdict, no live run: the arm dead-holds.
 *   'zombie-no-run'    — no dispatched run on the head at all (lost
 *                        dispatch, silent gh CLI failure): same dead-hold.
 *
 * Missing probe / odd per-facet shapes fail SAFE toward 'running' (arm
 * stays). A fully-failed probe (every facet at its catch default) reads
 * 'zombie-no-run' — the deliberate gh-821 bias documented in the header:
 * worst case one bounded duplicate CI run, never a wedge.
 */
function cancelledState(run) {
    return concludedWithin(run, Date.now(), CONCLUDED_REDISPATCH_GRACE_MS)
        ? 'running' : 'zombie-cancelled';
}

function classify(probe) {
    var newest = (probe && probe.newest) || null;
    if (!probe) return 'running';                 // no probe at all — fail safe
    if (probe.active === true) return 'running';
    if (!newest) return 'zombie-no-run';
    if (newest.status !== 'completed') return 'running'; // defensive: active should have caught it
    var c = newest.conclusion ? String(newest.conclusion) : null;
    if (!c) return 'running';                     // completed, no conclusion yet
    // gh-1101: the check-visibility grace moved here from the active
    // probe — a FRESH cancel is still owned by the rerun-cancelled-checks
    // remedy (no re-dispatch), but a concluded run is never "active".
    if (c === 'cancelled') return cancelledState(newest);
    if (c === 'success') return 'green';
    return 'red';
}

// ── Zombie re-dispatch markers (durable per-head bookkeeping) ───────────────
//
// One standalone PR comment per zombie re-dispatch, carrying the marker
// line the next tick's guard re-reads (failMarkerState parity — same
// single github_get_pr_comments fetch as the red-head/empty-lap markers):
//
//   🔄 zombie re-dispatch <fullHeadSha> — zombie <N>/<cap> at <iso>
//
// The head SHA keys the count: a head move (new push) starts a fresh
// count by construction, so "3 in a row on the same head" is exactly
// "3 markers for this SHA".

var ZOMBIE_MARKER_RE = /\uD83D\uDD04 zombie re-dispatch ([0-9a-f]{7,40}) \u2014 zombie (\d+)\/\d+ at (\S+)/g;

/**
 * Aggregate marker lines over comment bodies →
 * { <fullSha>: { count: <max N>, lastAtMs: <newest marker epoch ms> } }.
 * Malformed lines and other heads' markers are ignored; unparsable
 * timestamps degrade to lastAtMs=null (the rate bound then cannot fire —
 * the crash-loop cap still can, it reads the count only).
 */
function zombieMarks(bodies) {
    var map = {};
    (bodies || []).forEach(function (body) {
        var s = String(body == null ? '' : body);
        ZOMBIE_MARKER_RE.lastIndex = 0;
        var m;
        while ((m = ZOMBIE_MARKER_RE.exec(s)) !== null) {
            var sha = m[1];
            var n = parseInt(m[2], 10) || 0;
            var atMs = Date.parse(m[3]);
            var cur = map[sha];
            if (!cur) {
                cur = map[sha] = { count: 0, lastAtMs: null };
            }
            if (n > cur.count) cur.count = n;
            if (!isNaN(atMs) && (cur.lastAtMs === null || atMs > cur.lastAtMs)) {
                cur.lastAtMs = atMs;
            }
        }
    });
    return map;
}

/**
 * The marker line for the NEXT re-dispatch on this head (count = prior + 1 —
 * the caller holds the already-read marks; no second comment fetch).
 */
function zombieMarkerLine(count, headSha, cap, atIso) {
    return '\uD83D\uDD04 zombie re-dispatch ' + headSha +
        ' \u2014 zombie ' + count + '/' + cap + ' at ' + (atIso || '');
}

/**
 * Crash-loop cap: 3 zombie re-dispatches in a row on the same head (gh-821
 * AC2). jobParams.zombieRedispatchCap tunes it per deployment.
 */
function zombieCapOf(jobParams) {
    var n = (jobParams || {}).zombieRedispatchCap;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    return (typeof n === 'number' && n > 0) ? Math.floor(n) : 3;
}

/**
 * Rate bound: 1 auto re-dispatch per head per hour (gh-821 zombie rule —
 * bounded churn under a repeated cancel-loop). jobParams.zombieRedispatchMinMs
 * tunes it per deployment; 0 disables the bound (cap still applies).
 */
function zombieWindowMsOf(jobParams) {
    var n = (jobParams || {}).zombieRedispatchMinMs;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    if (typeof n !== 'number' || isNaN(n) || n < 0) return 60 * 60 * 1000;
    return Math.floor(n);
}

// ── Stale-cancel markers (gh-846) ───────────────────────────────────────────
//
// The refresh-path twin of the zombie marker: when a silent update moves
// the head, every dispatched validation run on the superseded head is
// cancelled (its result would be discarded). One marker line per cancelled
// head records the 'cancelled: stale base' reason durably on the PR — the
// gh-755 parity contract: CANCELLED is never a VERDICT, so the line is
// bookkeeping/audit only. No tick-side machinery consumes it (the verdict
// probes skip cancelled conclusions by construction; the zombie re-dispatch
// and red-head counters key on head shas and only ever read the CURRENT
// head), which is exactly why a cancelled-stale run can never trip
// fail-validation / zombie re-dispatch / red-head counting (AC3).
//
//   🛑 stale-cancel <fullHeadSha> — stale base at <iso>

var STALE_CANCEL_MARKER_RE = /\uD83D\uDED1 stale-cancel ([0-9a-f]{7,40}) \u2014 stale base at (\S+)/g;

/**
 * The marker line for one stale-cancelled head. Caller dedupes shas and
 * joins lines; count/cap are meaningless here (a head is cancelled once).
 */
function staleCancelMarkerLine(headSha, atIso) {
    return '\uD83D\uDED1 stale-cancel ' + headSha +
        ' \u2014 stale base at ' + (atIso || '');
}

// ── Ghost-guard markers (gh-848) ───────────────────────────────────────────
//
// The gh-748 twin-guard cancel path must never cancel a run before its jobs
// materialized — a queued cancel orphans the run's already-registered
// check-runs as `in_progress` ghosts forever (no run to re-run, no API to
// conclude them with the tick PAT) and the merge gate holds on the dead
// checks indefinitely (live fa #1457 five ghost cycles / #1520, ghosts
// #4-#6, 2026-10-10). One marker line per head records the two ghost-guard
// events durably on the PR — same bookkeeping-only contract as the markers
// above (gh-846/gh-755 parity: nothing tick-side consumes them; `cancelled`
// is never a verdict, no fail-validation / zombie re-dispatch keys on them):
//
//   ⏸ ghost-guard defer <fullHeadSha> — run <id> still queued at <iso>
//   🧹 ghost-guard clean <fullHeadSha> — <N> orphaned check-run(s) concluded at <iso>
//
// A head can sit queued across MANY ticks before its jobs materialize, and
// the audit poster dedupes per (event, head) against these markers — exactly
// ONE marker comment per head, never a comment per tick.

var GHOST_GUARD_DEFER_RE = /⏸ ghost-guard defer ([0-9a-f]{7,40}) — run (\d+) still queued at (\S+)/g;
var GHOST_GUARD_CLEAN_RE = /🧹 ghost-guard clean ([0-9a-f]{7,40}) — (\d+) orphaned check-run\(s\) concluded at (\S+)/g;

function ghostGuardDeferMarkerLine(headSha, runId, atIso) {
    return '⏸ ghost-guard defer ' + headSha +
        ' — run ' + runId + ' still queued at ' + (atIso || '');
}

function ghostGuardCleanMarkerLine(headSha, count, atIso) {
    return '🧹 ghost-guard clean ' + headSha +
        ' — ' + count + ' orphaned check-run(s) concluded at ' + (atIso || '');
}

/**
 * Aggregate ghost-guard marker lines over comment bodies →
 * { deferred: { <fullSha>: <newest marker epoch ms> },
 *   cleaned:  { <fullSha>: <newest marker epoch ms> } }.
 * The audit poster treats a head already present for an event as recorded —
 * that is the one-marker-per-head dedupe. Unparsable timestamps degrade to
 * absent entries (a duplicate marker is audit noise, never a functional
 * state).
 */
function ghostGuardMarks(bodies) {
    var out = { deferred: {}, cleaned: {} };
    (bodies || []).forEach(function (body) {
        var s = String(body == null ? '' : body);
        var m;
        GHOST_GUARD_DEFER_RE.lastIndex = 0;
        while ((m = GHOST_GUARD_DEFER_RE.exec(s)) !== null) {
            var atMs = Date.parse(m[3]);
            if (!isNaN(atMs) && (out.deferred[m[1]] === undefined || atMs > out.deferred[m[1]])) {
                out.deferred[m[1]] = atMs;
            }
        }
        GHOST_GUARD_CLEAN_RE.lastIndex = 0;
        while ((m = GHOST_GUARD_CLEAN_RE.exec(s)) !== null) {
            var atMs2 = Date.parse(m[3]);
            if (!isNaN(atMs2) && (out.cleaned[m[1]] === undefined || atMs2 > out.cleaned[m[1]])) {
                out.cleaned[m[1]] = atMs2;
            }
        }
    });
    return out;
}

// ── Silent-update failure markers (gh-1000 I5) ──────────────────────────────
//
// update_branch's silentUpdateBranch runs a throwaway /tmp clone to merge
// main under the head (no CI). A bare `exit 1` from that harness (live
// 2026-10-17 ~19:14Z) skipped park-set/unpark bookkeeping silently and the
// branch stayed stale forever. One marker line per failed attempt records
// the event durably on the PR — smAgent's recordSilentUpdateFailure (wired
// via silentUpdateBranchTracked) is the consumer: it posts the marker on
// every clone failure and applies the degraded flag once the attempts run
// out (the every-tick retry itself stays self-healing):
//
//   ⚠️ silent-update failure — attempt <n> at <iso>

var SILENT_UPDATE_MAX_FAILURES = 3;
var SILENT_UPDATE_DEGRADED_LABEL = 'silent-update-degraded';
var SILENT_UPDATE_MARKER_RE = /⚠️ silent-update failure — attempt (\d+) at (\S+)/g;

function silentUpdateFailureLine(attempt, iso, reason) {
    var line = '⚠️ silent-update failure — attempt ' + attempt + ' at ' + (iso || '');
    // gh-1074 AC2: the marker gains the one-line rejection reason when the
    // captured stderr tail carries one — the PR timeline alone then explains
    // the streak. The reason rides the SAME line AFTER the ISO timestamp,
    // so the counting regex above (attempt / ISO char-class) keeps parsing;
    // it collapses to one bounded line — the marker stays a marker.
    var r = String(reason == null ? '' : reason).trim();
    if (r) line += ' — ' + r.split('\n')[0].slice(0, 200);
    return line;
}

function commentBodyOf(c) {
    return (c && (c.body || c.text)) || (typeof c === 'string' ? c : '');
}

// Fold one comment body's failure markers into the accumulator.
function scanFailureMarkers(body, acc) {
    var re = /⚠️ silent-update failure — attempt (\d+) at ([0-9T:\-.\+Z]+)/g;
    var m;
    while ((m = re.exec(String(body))) !== null) {
        var n = parseInt(m[1], 10);
        if (n > acc.count) acc.count = n;
        var t = String(m[2]);
        if (!acc.newest || t > acc.newest) acc.newest = t;
    }
}

// Failure markers seen in a PR comment list (bodies or single strings).
// Returns { count, newest } — count is the highest attempt number observed
// (markers are monotonic per branch), newest the newest ISO timestamp.
function silentUpdateFailureCount(comments) {
    var acc = { count: 0, newest: null };
    (comments || []).forEach(function (c) {
        scanFailureMarkers(commentBodyOf(c), acc);
    });
    return acc;
}

// Remaining attempts before the branch is flagged degraded.
function silentUpdateAttemptsLeft(count) {
    var left = SILENT_UPDATE_MAX_FAILURES - (Math.floor(Number(count)) || 0);
    return left > 0 ? left : 0;
}

// ── Silent-update failure surface: the stderr tail (gh-1074) ────────────────
//
// Live fa PR #1591 (2026-10-19 05:51/05:52Z): the fork silent-update push
// failed 3× and the SM run log preserved only the BEGINNING of stderr
// ("Cloning into '…' / Updating files: N%"). cli_execute_command's failure
// message embeds the command output from the START (head-truncated), while
// git writes the decisive rejection ("remote: error: …", "! [remote
// rejected] HEAD:branch (reason)") at the END — exactly the part that is
// cut. The smAgent chain tees its stderr to a side file (clone truncates,
// the brace group appends — the file always holds THIS attempt's stderr);
// these pure helpers turn the capture into the failure surface:
//
//   silentUpdateStderrTail      — the LAST ~20 lines (the propagated error
//                                 carries these, not the head)
//   silentUpdateRejectionReason — the one-line reason for the marker
//                                 comment (AC2)
//   redactSilentUpdateSecrets   — the same secrets hygiene the command
//                                 line gets (AC3): git echoes the push URL
//                                 with the EXPANDED credential ("To
//                                 https://x-access-token:<token>@…") and a
//                                 hook can echo token-shaped strings.

var SILENT_UPDATE_STDERR_TAIL_LINES = 20;

function silentUpdateStderrTail(text, maxLines) {
    var n = (typeof maxLines === 'number' && maxLines > 0)
        ? Math.floor(maxLines) : SILENT_UPDATE_STDERR_TAIL_LINES;
    var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = s.split('\n');
    // a final newline is not a content line
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > n) lines = lines.slice(lines.length - n);
    return lines.join('\n');
}

function silentUpdateRejectionReason(tail) {
    var s = String(tail == null ? '' : tail);
    // the fragment the ticket calls out: "! [remote rejected] HEAD:branch
    // (reason)" — the '!' prefix stays on its own context, the bracketed
    // fragment is the durable one-line reason.
    var m = /\[remote rejected\][^\n]*/.exec(s);
    if (m) return m[0].trim().slice(0, 200);
    // fallback: the first "remote: error: …" line (hook/permission refusals
    // that never produce a refspec rejection)
    var lines = s.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var r = /remote:\s*error:\s*(.+)/.exec(lines[i]);
        if (r) return ('remote: error: ' + r[1].trim()).slice(0, 200);
    }
    return null;
}

function redactSilentUpdateSecrets(text) {
    var s = String(text == null ? '' : text);
    // the maintainer-edit token URL git echoes back on push — collapse the
    // credential exactly like the redacted command-line form
    s = s.replace(/(x-access-token:)[^@\s]+@/gi, '$1[REDACTED]@');
    // token-shaped strings a verbose git/hook output could echo (classic
    // ghp_/gho_/ghu_/ghs_/ghr_ prefixes and fine-grained github_pat_)
    s = s.replace(/\bgh[opsur]_[A-Za-z0-9]{6,}\b/g, '[REDACTED:token]');
    s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{6,}\b/g, '[REDACTED:token]');
    return s;
}

// ── Fork-aware silent-update routing (gh-1070) ──────────────────────────────
//
// update_branch's silent refresh was fork-blind: it cloned and pushed the
// BASE repo, so a fork PR's head (the branch lives on the fork) failed 3×
// and got flagged silent-update-degraded while the gh-757 guest park
// waited on the human author (live fa PR #1591, 2026-10-18). GitHub grants
// the base-repo token a push to the fork's PR branch when the author left
// "Allow edits from maintainers" on (default on personal forks; the PR
// payload field is maintainer_can_modify / maintainerCanModify; org forks
// never allow it). Pure dispatch — smAgent probes and executes, this
// module only routes:
//
//   base — same-repo head: the untouched base-repush path (AC4)
//   fork — editable fork: the machine merges main into the fork branch
//          via the maintainer-edit push; the head move clears the park
//          through the existing gh-994 head-change reset (AC1)
//   park — non-editable fork: the gh-757 guest park with ZERO
//          silent-update attempts and ZERO failure bookkeeping (AC2 —
//          the attempt can never succeed)

// The fork's 'owner/repo' full name when the PR head lives in a FOREIGN
// repo, null otherwise (same-repo, missing headRepo from a legacy payload,
// deleted fork, malformed name) — those keep the base path.
function forkHeadFull(headRepoFull, baseOwner, baseRepo) {
    // gh-1070 rework: the same-repo comparison is CASE-INSENSITIVE. The
    // base side comes from config (effectiveRepoInfo.owner/repo) while
    // headRepoFull comes from the API's head.repo.full_name, and GitHub
    // repo names are case-insensitive — a casing drift (config
    // 'istin/dmtools-agents' vs API 'IstiN/dmtools-agents') must NOT
    // classify a same-repo PR as a fork (AC4 silently violated, or a
    // false guest park when maintainer_can_modify=false — the exact
    // silent-misroute class gh-1059 eliminated). The fork's own casing
    // is preserved: the push URL is built from it.
    var full = String(headRepoFull || '');
    if (full.indexOf('/') === -1) return null;
    var baseFull = (String(baseOwner || '') + '/' + String(baseRepo || '')).toLowerCase();
    return full.toLowerCase() !== baseFull ? full : null;
}

// Three-path dispatch (UT-1). maintainerCanModify === true routes the
// editable fork; anything else (false, null = probe failed/absent) fails
// CLOSED to the park path — an unprobed fork push is never attempted.
function forkSilentUpdateRoute(headRepoFull, baseOwner, baseRepo, maintainerCanModify) {
    var forkFull = forkHeadFull(headRepoFull, baseOwner, baseRepo);
    if (!forkFull) return { route: 'base', forkFull: null };
    if (maintainerCanModify === true) return { route: 'fork', forkFull: forkFull };
    return { route: 'park', forkFull: forkFull };
}

// The maintainer-edit push target: the FORK's token URL built from
// head.repo.full_name — never the base repo for a fork head (UT-2). The
// token rides the child env (${GH_TOKEN}) exactly like the base-repush
// form, so the secret never appears in the script source.
function forkPushTokenUrl(forkFull) {
    return 'https://x-access-token:${GH_TOKEN}@github.com/' + forkFull + '.git';
}

// ── Workflow-write rejection escalation (gh-1106) ───────────────────────────
//
// Live fa PR #1591 (2026-10-19 17:16/17:17Z): the fork silent-update pushed
// the main merge with the silent token (github.token, github-actions[bot])
// and GitHub refused EVERY push touching `.github/workflows/*`:
//
//   ! [remote rejected] HEAD -> fix/android-dap-home-sandbox (refusing to
//   allow a GitHub App to create or update workflow
//   `.github/workflows/build-mobile.yml` without `workflows` permission)
//
// GITHUB_TOKEN can never gain that capability (there is no `permissions:`
// key that grants `workflows` to it), so the failure is a deterministic
// token-capability fact — retrying the same token can never succeed — and
// gh-1070's "maintainer edits revoked" 3-strike trail mis-frames it as an
// author decision, ending in a guest park the author cannot clear (the
// head predates the park; only the machine can move it: no push → park
// holds → no push). The pure half lives here: classify the rejection from
// the captured stderr tail and shape the distinct AC3 park marker. The
// wiring (smAgent fork lane, smProvider base lane) swaps env GH_TOKEN to a
// workflow-capable token (App installation token with Workflows: write, or
// a PAT with the `workflow` scope) for exactly one escalated attempt.

var WORKFLOWS_APP_REJECTION_RE =
    /refusing to allow a GitHub App to create or update workflow/i;
var WORKFLOWS_OAUTH_REJECTION_RE =
    /refusing to allow an OAuth App to create or update workflow [^\n]*without [`'\u0060]workflow[`'\u0060] scope/i;

/**
 * True when the stderr tail is GitHub's workflows-permission refusal — the
 * App-installation form (the exact #1591 phrasing) or the OAuth-App /
 * classic-PAT form (missing `workflow` scope). Everything else — protected
 * branch hooks, a genuine maintainer-edit revocation (E2), network noise,
 * an EMPTY or truncated tail that never reaches the phrase (E4) — is
 * deliberately generic: the escalation is a targeted cure for a named
 * platform refusal, never a catch-all retry.
 */
function isWorkflowsPermissionRejection(stderrTail) {
    var s = String(stderrTail == null ? '' : stderrTail);
    if (!s) return false;
    return WORKFLOWS_APP_REJECTION_RE.test(s) ||
        WORKFLOWS_OAUTH_REJECTION_RE.test(s);
}

// The distinct AC3 park marker (one per parked head):
//
//   🔐 workflow-write park (gh-1106) — update needs a workflow-write token at <iso> · parked-head: <sha>
//
// The embedded 'parked-head: <40-hex>' is what the existing gh-994
// head-change reset probes scan comments for — a later successful
// escalation (or any head-moving push) lifts this park with zero new
// machinery (AC4).
var WORKFLOW_WRITE_PARK_RE =
    /\uD83D\uDD10 workflow-write park \(gh-1106\) [^\n]*parked-head: ([0-9a-f]{7,40})/g;

function workflowWriteParkLine(headSha, atIso) {
    return '\uD83D\uDD10 workflow-write park (gh-1106) — update needs a workflow-write token at ' +
        (atIso || '') + ' \u00B7 parked-head: ' + (headSha || 'unknown');
}

/**
 * True when a comment body already carries the marker for THIS head
 * (one-marker-per-head dedupe, ghost-guard parity): a parked head re-runs
 * the doomed escalation every tick (self-healing if the token capability
 * is granted later) but posts the distinct reason exactly once; a head
 * MOVE starts a new park event and may post again.
 */
function workflowWriteParkMarked(bodies, headSha) {
    var want = String(headSha || '').toLowerCase();
    if (!want) return false;
    var marked = false;
    (bodies || []).forEach(function (body) {
        if (marked) return;
        var s = String(body == null ? '' : body);
        WORKFLOW_WRITE_PARK_RE.lastIndex = 0;
        var m;
        while ((m = WORKFLOW_WRITE_PARK_RE.exec(s)) !== null) {
            if (m[1].toLowerCase() === want) {
                marked = true;
                break;
            }
        }
    });
    return marked;
}

module.exports = {
    classify: classify,
    zombieMarks: zombieMarks,
    zombieMarkerLine: zombieMarkerLine,
    zombieCapOf: zombieCapOf,
    zombieWindowMsOf: zombieWindowMsOf,
    ghostGuardDeferMarkerLine: ghostGuardDeferMarkerLine,
    ghostGuardCleanMarkerLine: ghostGuardCleanMarkerLine,
    ghostGuardMarks: ghostGuardMarks,
    ZOMBIE_MARKER_RE: ZOMBIE_MARKER_RE,
    ACTIVE_RUN_STATES: ACTIVE_RUN_STATES,
    CONCLUDED_REDISPATCH_GRACE_MS: CONCLUDED_REDISPATCH_GRACE_MS,
    concludedWithin: concludedWithin,
    STALE_CANCEL_MARKER_RE: STALE_CANCEL_MARKER_RE,
    staleCancelMarkerLine: staleCancelMarkerLine,
    SILENT_UPDATE_MAX_FAILURES: SILENT_UPDATE_MAX_FAILURES,
    SILENT_UPDATE_DEGRADED_LABEL: SILENT_UPDATE_DEGRADED_LABEL,
    silentUpdateFailureLine: silentUpdateFailureLine,
    silentUpdateFailureCount: silentUpdateFailureCount,
    silentUpdateAttemptsLeft: silentUpdateAttemptsLeft,
    SILENT_UPDATE_STDERR_TAIL_LINES: SILENT_UPDATE_STDERR_TAIL_LINES,
    silentUpdateStderrTail: silentUpdateStderrTail,
    silentUpdateRejectionReason: silentUpdateRejectionReason,
    redactSilentUpdateSecrets: redactSilentUpdateSecrets,
    forkHeadFull: forkHeadFull,
    forkSilentUpdateRoute: forkSilentUpdateRoute,
    forkPushTokenUrl: forkPushTokenUrl,
    isWorkflowsPermissionRejection: isWorkflowsPermissionRejection,
    workflowWriteParkLine: workflowWriteParkLine,
    workflowWriteParkMarked: workflowWriteParkMarked
};
