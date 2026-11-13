/**
 * Red-verdict handling for the SM fail_validation localAction (and the
 * sweep_stale_validation failure side) — extracted from smAgent.js
 * processRule (IstiN/dmtools-agents#1459: decompose smAgent.js).
 *
 * Flow per red PR (handle()):
 *   1. gh-755: a cancelled-only red is NO verdict → 'skip'.
 *   2. FLAKE RERUN (fa #2148, live 22b1977d: CI green 09:09Z, the identical
 *      sha re-dispatched and went red 09:32Z on a golden-image flake — the
 *      SM armed a useless rework leg): on a MACHINE PR whose newest red
 *      dispatched run shares its head sha with an EARLIER successful
 *      dispatched run, green→red on identical code is flake evidence. The
 *      failed jobs are re-run ONCE (`gh run rerun <id> --failed`), recorded
 *      by a 🎲 marker comment (cap: one per head sha). A second red on the
 *      same sha, a rerun failure, or no prior green → the normal path.
 *   3. Normal path (unchanged behavior): unarm ai_validating, report with
 *      the red-head / empty-lap / convergence-park markers, machine-only
 *      rework arm (linked issue or PR-anchored), guest park.
 *
 * Every tool touch is an injected dep (see smAgent.js redVerdictDeps) so
 * this module unit-tests without the bridge globals. GraalJS: var only.
 */

'use strict';

var redConvergence = require('../common/redConvergence.js');
var prTerminalState = require('../common/prTerminalState.js');

var FLAKE_MARKER_RE = /\uD83C\uDFB2 flake rerun head ([0-9a-f]{7,40})\b/g;

function flakeMarkerLine(headSha, redRunId, greenRunId) {
    return '\uD83C\uDFB2 flake rerun head ' + headSha + ' \u2014 red run ' + redRunId +
        ' re-run (--failed) once: green run ' + greenRunId + ' already passed on this exact sha';
}

/** Heads that already carry a 🎲 flake-rerun marker. */
function flakeMarkedHeads(bodies) {
    var out = {};
    (bodies || []).forEach(function (b) {
        var m;
        FLAKE_MARKER_RE.lastIndex = 0;
        while ((m = FLAKE_MARKER_RE.exec(String(b == null ? '' : b))) !== null) out[m[1]] = true;
    });
    return out;
}

function runStamp(r) {
    return Date.parse(r.updated_at || r.created_at || 0) || 0;
}

function headVerdictRuns(runs, headSha) {
    if (!headSha || !Array.isArray(runs)) return [];
    return runs.filter(function (r) {
        return r && r.event === 'workflow_dispatch' && r.head_sha === headSha &&
            r.status === 'completed' && !!r.conclusion && r.conclusion !== 'cancelled';
    }).sort(function (a, b) { return runStamp(b) - runStamp(a); });
}

function isRedConclusion(c) {
    return c === 'failure' || c === 'timed_out';
}

// ── moved verbatim-in-behavior from smAgent.js (#1459) ───────────────────

/**
 * jobParams.emptyLapMax (default 1, review #703 retune): empty rework laps
 * on the same head before the rework arm is WITHHELD.
 */
function emptyLapMaxOf(jobParams) {
    var n = (jobParams || {}).emptyLapMax;
    n = typeof n === 'string' ? parseInt(n, 10) : n;
    return (typeof n === 'number' && n > 0) ? Math.floor(n) : 1;
}

function isHeadRedRun(r, headSha) {
    return !!r && r.event === 'workflow_dispatch' && r.head_sha === headSha &&
        r.status === 'completed' && isRedConclusion(r.conclusion);
}

/**
 * The 'Failed run: <url>' report line (owner 2026-10-01): newest 1-3
 * failure/timed_out dispatched runs on THIS head. '' on any miss.
 */
function failedRunLinksFromList(list, headSha) {
    if (!headSha || !Array.isArray(list)) return '';
    var urls = list.filter(function (r) { return isHeadRedRun(r, headSha); })
        .sort(function (a, b) { return runStamp(b) - runStamp(a); })
        .slice(0, 3).map(function (r) { return r.html_url; })
        .filter(function (u) { return !!u; });
    if (!urls.length) return '';
    return (urls.length === 1 ? 'Failed run: ' : 'Failed runs: ') + urls.join(', ');
}

/**
 * Flake evidence on the head: { red, green } when the newest verdict run is
 * a first-attempt red AND an earlier dispatched run on the SAME sha went
 * green; null otherwise (no prior green / already re-run / not red).
 */
function flakeCandidate(runs, headSha) {
    var mine = headVerdictRuns(runs, headSha);
    var red = mine[0];
    if (!red || !isRedConclusion(red.conclusion)) return null;
    if ((red.run_attempt || 1) > 1) return null;
    var green = mine.filter(function (r) { return r.conclusion === 'success'; })[0];
    return green ? { red: red, green: green } : null;
}

/** Try the one-per-sha flake rerun. true = handled (no rework, no red count). */
function tryFlakeRerun(ctx, deps, runs) {
    var cand = flakeCandidate(runs, ctx.head);
    if (!cand) return false;
    if (flakeMarkedHeads(deps.commentBodies())[ctx.head]) {
        deps.log('  \uD83C\uDFB2 ' + ctx.key + ' flake rerun already spent on head ' +
            String(ctx.head).slice(0, 7) + ' \u2014 second red is a real verdict');
        return false;
    }
    return runFlakeRerun(ctx, deps, cand);
}

function runFlakeRerun(ctx, deps, cand) {
    if (deps.dry) {
        deps.log('  [dry] \uD83C\uDFB2 ' + ctx.key + ' would gh run rerun ' + cand.red.id + ' --failed');
        return true;
    }
    try {
        deps.rerunFailed(cand.red.id);
    } catch (e) {
        deps.warn('  \u26a0\ufe0f  ' + ctx.key + ' flake rerun of run ' + cand.red.id + ' failed (' +
            (e.message || e) + ') \u2014 falling back to the rework path');
        return false;
    }
    deps.stampInProgress(ctx.head);
    deps.postComment(ctx.prNumber, flakeMarkerLine(ctx.head, cand.red.id, cand.green.id) +
        '\n\nValidation went red on a head sha that ALREADY passed validation (green\u2192red on' +
        ' identical code = flake evidence, fa #2148). The failed jobs were re-run once instead of' +
        ' arming rework; a second red on this sha takes the normal rework path.');
    deps.log('  \uD83C\uDFB2 ' + ctx.key + ' flake rerun: run ' + cand.red.id + ' --failed (green run ' +
        cand.green.id + ' on the same sha ' + String(ctx.head).slice(0, 7) + ')');
    return true;
}

// ── linked issue / terminal state (machine PRs) ──────────────────────────

function linkedFromBody(prObj) {
    var m = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String((prObj && prObj.body) || ''));
    return m ? parseInt(m[1], 10) : null;
}

function linkedFromBranch(branch) {
    var bm = /(?:^|\/)gh-(\d+)$/i.exec(String(branch || ''));
    return bm ? parseInt(bm[1], 10) : null;
}

/** { linked, terminal } — github_get_pr body/branch linkage + gh-1369 terminal guard. */
function machineLinkage(ctx, deps) {
    var prObj = null;
    try {
        prObj = deps.getPr(ctx.prNumber) || {};
    } catch (e) {
        deps.warn('  \u26a0\ufe0f linked-issue lookup failed: ' + (e.message || e));
    }
    var linked = linkedFromBody(prObj) || (ctx.branch ? linkedFromBranch(ctx.branch) : null);
    var terminal = prObj ? prTerminalState.isTerminalPrState(prObj.state, prObj.merged) : false;
    return { linked: linked, terminal: terminal };
}

// ── red-count / empty-lap / convergence state ────────────────────────────

function emptyLapLineOf(s) {
    if (!(s.isMachine && s.priorReds > 0 && !s.emptyCapped && s.head)) return null;
    return '\uD83C\uDF00 empty rework lap ' + (s.emptyLaps + 1) + '/' + s.lapMax +
        ' \u2014 head ' + s.head +
        ' unchanged since the previous red (owner finding 2026-10-04:' +
        ' the rework lap closed itself successful without pushing a fix)' +
        ((s.emptyLaps + 1) >= s.lapMax
            ? ' \u2014 LAST CHANCE: one more red on this unchanged head' +
              ' WITHHOLDS the rework arm and escalates to a human'
            : '');
}

function parkLineOf(s) {
    if (!s.park) return null;
    return '\uD83C\uDD7F\uFE0F CONVERGENCE PARK (gh-832) \u2014 ' + s.streak +
        ' consecutive red validation verdicts on the unchanged head `' + s.head +
        '` \u2014 parking validation_failed; the merge window yields until a NEW head' +
        ' lands (a rework push or a human push re-enters validation through the' +
        ' standard park-reset probes).';
}

function lapState(marks, head, isMachine, jobParams) {
    var priorReds = head ? (marks.redHeads[head] || 0) : 0;
    var lapMax = emptyLapMaxOf(jobParams);
    var emptyLaps = priorReds > 0 && head ? (marks.emptyLaps[head] || 0) : 0;
    return { priorReds: priorReds, lapMax: lapMax, emptyLaps: emptyLaps,
             emptyCapped: isMachine && priorReds > 0 && emptyLaps >= lapMax };
}

function verdictState(ctx, deps, runs, isMachine) {
    var head = ctx.head;
    var s = lapState(deps.readFailMarks(), head, isMachine, deps.jobParams);
    s.head = head;
    s.isMachine = isMachine;
    s.streak = redConvergence.streakFromRuns(runs, head);
    s.park = redConvergence.shouldPark(s.streak, redConvergence.parkCapOf(deps.jobParams));
    s.failingJobs = s.park ? deps.failingJobs(head) : [];
    s.redLine = deps.redLine(s.priorReds, head);
    s.failedRunsLine = failedRunLinksFromList(runs, head);
    return s;
}

// ── report ───────────────────────────────────────────────────────────────

function machineHeadline(s, link) {
    if (link.terminal) {
        return '\u26a0\ufe0f Validation CI went red on the head, but this PR is already ' +
            'MERGED/CLOSED \u2014 terminal (gh-1369): nothing to rework, the rework ' +
            'arm is skipped (validation red on shipped code never re-queues rework).';
    }
    if (s.emptyCapped) {
        return '\u26a0\ufe0f Validation CI went red on the head AGAIN \u2014 and the last ' +
            s.emptyLaps + ' rework laps left the head `' + s.head + '` unchanged ' +
            '(empty laps: the leg closes itself successful without pushing a fix). ' +
            'The rework arm is WITHHELD \u2014 a human owns this PR from here.';
    }
    return '\u26a0\ufe0f Validation CI went red on the head \u2014 merge aborted, rework re-queued.' +
        (link.linked ? ' (linked issue #' + link.linked + ' re-armed)' : '') +
        ' (approval latch kept \u2014 no re-review after fixes)';
}

var GUEST_HEADLINE = '\u26a0\ufe0f Validation CI went red on the head. Guest PR: rebase onto main and push \u2014 ' +
    'validation re-runs automatically; auto-rework is reserved for the machine ' +
    'account (gh-757). Your push clears the validation_failed park via the ' +
    'head-change reset.';

function buildReport(s, link) {
    var parkedHead = ((s.park || !s.isMachine) && s.head) ? 'parked-head: ' + s.head : null;
    var jobs = s.failingJobs.length ? 'Failing job(s): ' + s.failingJobs.join(', ') : null;
    return [s.isMachine ? machineHeadline(s, link) : GUEST_HEADLINE, s.failedRunsLine, s.redLine,
        emptyLapLineOf(s), parkLineOf(s), parkedHead, jobs]
        .filter(function (l) { return !!l; }).join('\n');
}

// ── side effects ─────────────────────────────────────────────────────────

function safeAddLabel(deps, number, label, what) {
    try {
        deps.addLabel(number, label);
        return true;
    } catch (e) {
        deps.warn('  \u26a0\ufe0f  ' + what + ' failed: ' + (e.message || e));
        return false;
    }
}

function applyConvergencePark(ctx, deps, s) {
    if (!s.park) return;
    safeAddLabel(deps, ctx.prNumber, 'validation_failed', 'convergence park label');
    deps.log('  \uD83C\uDD7F\uFE0F ' + ctx.key + ' convergence park (gh-832) \u2014 ' + s.streak +
        ' consecutive reds on head ' + String(s.head).slice(0, 7) + ' \u2014 validation_failed; failing: ' +
        (s.failingJobs.length ? s.failingJobs.join(', ') : '(check-run rollup unavailable)'));
}

function escalateEmptyCap(ctx, deps, s) {
    deps.log('  \uD83D\uDED1 ' + ctx.key + ' empty rework-lap cap reached (' + s.emptyLaps +
        '/' + s.lapMax + ' on head ' + s.head + ') \u2014 NO agent:rework arm,' +
        ' a human owns the PR (live fa#1211: successful laps that push nothing)');
    try {
        deps.postComment(ctx.prNumber, '\uD83D\uDED1 @' + ctx.owner + ' \u2014 pr-' + ctx.prNumber +
            ' needs a human: validation went red on head `' + s.head + '` left UNCHANGED after ' +
            (s.emptyLaps + 1) + ' empty rework lap(s) (each lap closed itself successful without' +
            ' pushing a fix \u2014 owner finding 2026-10-04, live fa#1211). The agent:rework arm is' +
            ' WITHHELD (empty-lap cap ' + s.emptyLaps + '/' + s.lapMax + ') and this head will' +
            ' not be re-validated \u2014 the machine will not re-arm itself here.');
    } catch (e) {
        deps.warn('  \u26a0\ufe0f  empty-lap escalation post failed: ' + (e.message || e));
    }
}

function armRework(ctx, deps, link, latched) {
    if (latched) {
        deps.log('  \u23ed\ufe0f  ' + ctx.key + (link.linked
            ? ' rework re-arm suppressed'
            : ' PR-anchored rework arm suppressed') + ' \u2014 leg already in flight for this head (AC1)');
        return;
    }
    if (link.linked) {
        deps.addLabel(link.linked, 'agent:rework');
        deps.latchRework();
        return;
    }
    if (safeAddLabel(deps, ctx.prNumber, 'agent:rework', 'unlinked machine rework arm')) deps.latchRework();
}

function applyMachineArm(ctx, deps, s, link, latched) {
    if (link.terminal) {
        deps.log('  \u23ed\ufe0f  ' + ctx.key + ' PR #' + ctx.prNumber + ' is terminal (merged/closed) \u2014 ' +
            'validation red on shipped code never re-arms rework (gh-1369)');
    } else if (s.emptyCapped) {
        escalateEmptyCap(ctx, deps, s);
    } else {
        armRework(ctx, deps, link, latched);
    }
}

function summaryLine(ctx, s, link) {
    if (!s.isMachine) {
        return 'guest PR, parked (validation_failed) \u2014 no rework arm (auto-rework is machine-only, gh-757)';
    }
    if (s.emptyCapped) {
        return 'rework arm WITHHELD (empty-lap cap ' + s.emptyLaps + '/' + s.lapMax +
            ') \u2014 owner escalated, a human owns the PR';
    }
    return 'rework re-queued' + (link.linked ? ' (issue #' + link.linked + ')'
        : ' \u2014 no linked issue, armed PR-anchored');
}

/** The normal (non-flake) red verdict: unarm, report, arm/park. */
function failVerdict(ctx, deps, runs, isMachine) {
    try { deps.removeLabel(ctx.prNumber, 'ai_validating'); } catch (e) { /* absent label is fine */ }
    var latched = isMachine ? deps.reworkLatched() : false;
    var link = isMachine ? machineLinkage(ctx, deps) : { linked: null, terminal: false };
    var s = verdictState(ctx, deps, runs, isMachine);
    deps.postComment(ctx.prNumber, buildReport(s, link));
    applyConvergencePark(ctx, deps, s);
    if (isMachine) applyMachineArm(ctx, deps, s, link, latched);
    else safeAddLabel(deps, ctx.prNumber, 'validation_failed', 'guest park label');
    deps.log('  \uD83D\uDD01 ' + ctx.key + ' validation failed \u2014 ' + summaryLine(ctx, s, link));
}

/**
 * Entry point. ctx: { key, owner, prNumber, head, branch }.
 * Returns 'skip' (no verdict — not processed), 'rerun' (flake rerun, processed)
 * or 'failed' (normal red verdict, processed). Throws on hard tool errors.
 */
function handle(ctx, deps) {
    if (ctx.head && !deps.realRed(ctx.head)) {
        deps.log('  \u23ed\ufe0f  ' + ctx.key + ' red is cancelled-only \u2014 no verdict (gh-755):' +
            ' skipping the fail path, waiting on the rerun-cancelled-checks remedy');
        return 'skip';
    }
    var isMachine = deps.isMachinePr();
    var runs = deps.dispatchedRuns();
    if (isMachine && tryFlakeRerun(ctx, deps, runs)) return 'rerun';
    failVerdict(ctx, deps, runs, isMachine);
    return 'failed';
}

module.exports = {
    handle: handle,
    flakeCandidate: flakeCandidate,
    flakeMarkedHeads: flakeMarkedHeads,
    flakeMarkerLine: flakeMarkerLine,
    buildReport: buildReport,
    emptyLapMaxOf: emptyLapMaxOf,
    failedRunLinksFromList: failedRunLinksFromList
};
