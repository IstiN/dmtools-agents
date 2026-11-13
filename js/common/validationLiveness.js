// Validation liveness (gh-821): pure classify() + marker bookkeeping for
// zombie/stale-cancel/ghost-guard/silent-update/fork-route/workflow-write.
'use strict';

var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending'];
var POOL_STALE_NON_RUNNING_MS = 6 * 60 * 60 * 1000;

// GitHub-hosted orchestration / release workflows never compete for the
// validation / self-hosted runner pool (macos / ubuntu-arm).
// repoPoolFree runs FROM INSIDE machine-sm.yml — counting these runs
// made repoPoolFree self-block on every live tick (fa #2133).
var POOL_EXCLUDED_WORKFLOW_FILES = [
    'machine-sm.yml', 'factory-sm.yml', 'sm-kicker.yml', 'factory-sm-kicker.yml',
    'agent-pack-release-kicker.yml', 'machine-merge.yml', 'merge-trigger.yml',
    'sm-merge-guard.yml', 'release.yml', 'agent-pack-release.yml', 'codeql.yml'
];

function workflowFileOf(r) {
    var p = String((r && r.path) || '').toLowerCase();
    var slash = p.lastIndexOf('/');
    return slash !== -1 ? p.slice(slash + 1) : p;
}

function isPoolExcludedWorkflowRun(r) {
    return POOL_EXCLUDED_WORKFLOW_FILES.indexOf(workflowFileOf(r)) !== -1;
}

function isFreshNonRunning(r, nowMs, limit) {
    var created = Date.parse(r.created_at || r.run_started_at || '');
    return isNaN(created) || (nowMs - created) <= limit; // unknown age: busy
}

function runOccupiesPool(r, nowMs, limit) {
    var st = String((r && r.status) || '').toLowerCase();
    if (ACTIVE_RUN_STATES.indexOf(st) === -1 || isPoolExcludedWorkflowRun(r)) return false;
    return st === 'in_progress' || isFreshNonRunning(r, nowMs, limit);
}
/** True when `runs` carry a run that materially occupies the pool. */
function poolBusy(runs, nowMs, staleMs) {
    var limit = typeof staleMs === 'number' ? staleMs : POOL_STALE_NON_RUNNING_MS;
    return (runs || []).some(function (r) { return runOccupiesPool(r, nowMs, limit); });
}

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

// Classify probeDispatchedState ({ active, verdict, green, newest }) →
// 'running' | 'green' | 'red' | 'zombie-cancelled' | 'zombie-no-run'.
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

// Zombie re-dispatch markers: 🔄 zombie re-dispatch <sha> — zombie <N>/<cap> at <iso>
var ZOMBIE_MARKER_RE = /\uD83D\uDD04 zombie re-dispatch ([0-9a-f]{7,40}) \u2014 zombie (\d+)\/\d+ at (\S+)/g;
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

// Stale-cancel markers (gh-846): 🛑 stale-cancel <fullHeadSha> — stale base at <iso>
var STALE_CANCEL_MARKER_RE = /\uD83D\uDED1 stale-cancel ([0-9a-f]{7,40}) \u2014 stale base at (\S+)/g;
function staleCancelMarkerLine(headSha, atIso) {
    return '\uD83D\uDED1 stale-cancel ' + headSha +
        ' \u2014 stale base at ' + (atIso || '');
}

// Ghost-guard markers (gh-848): one-marker-per-head dedupe for defer/clean events.
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

// Silent-update failure markers (gh-1000 I5).
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

// Silent-update failure surface: stderr tail + reason + secret redaction (gh-1074).
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

// Fork-aware silent-update routing (gh-1070): 'base' | 'fork' | 'park'.
function forkHeadFull(headRepoFull, baseOwner, baseRepo) {
    // Case-insensitive same-repo comparison (gh-1070 rework).
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

// Workflow-write rejection escalation (gh-1106).
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
    POOL_STALE_NON_RUNNING_MS: POOL_STALE_NON_RUNNING_MS,
    poolBusy: poolBusy,
    POOL_EXCLUDED_WORKFLOW_FILES: POOL_EXCLUDED_WORKFLOW_FILES,
    isPoolExcludedWorkflowRun: isPoolExcludedWorkflowRun,
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
