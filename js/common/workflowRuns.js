/**
 * js/common/workflowRuns.js
 *
 * Shared workflow-run probes and scans (gh-1249 duplication dedup). The
 * active-status fan-out the in-flight guards used to inline (smAgent.js
 * hasActiveTargetWorkflowRun / hasActiveLegRunOnBranch /
 * hasActiveLegRunForPull / collectActiveWorkflowRuns, autoStart.js
 * hasActiveTargetRun / collectActiveWorkflowRuns), the dispatched-CI
 * `gh api .../runs?head_sha…` probe family the five dispatched guards
 * each fired on their own (smAgent.js hasActiveDispatchedRun /
 * latestDispatchedVerdict / hasSuccessfulDispatchedRun / newestDispatchedRun
 * / greenCoverRun), and the small pure helpers both sides share
 * (parse, timestamp, age, newest-first ordering, id index).
 *
 * Pure module — no tool globals at load time; cli_execute_command is only
 * touched inside dispatchedRuns() and is injected per-test.
 */

var ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'pending'];

/**
 * Unwraps a REST workflow-run list payload: an array passes through, a
 * { workflow_runs } / { runs } envelope is unwrapped, a JSON string is
 * parsed. Anything unparseable reads as [] (the smAgent.js copy, moved
 * verbatim).
 */
function parseWorkflowRuns(raw) {
    if (!raw) return [];
    var parsed = raw;
    if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch (e) { return []; }
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.workflow_runs)) return parsed.workflow_runs;
    if (parsed && Array.isArray(parsed.runs)) return parsed.runs;
    return [];
}

/**
 * Fan-out scan over the four active run statuses. Per-status probe errors
 * log `warnPrefix (status): <error>` and are skipped (fail-open).
 * visit(status, runsRaw) receives the RAW listWorkflowRuns payload — each
 * caller keeps its own parse flavor (autoStart's parse warns on bad JSON,
 * the SM's parses silently), so only the transport lives here. Returning
 * truthy from visit aborts the scan early. Returns true iff aborted early.
 *
 * extraArgs (e.g. [owner, repo]) is forwarded after
 * (status, workflowFile, 50) for providers whose listWorkflowRuns is
 * repo-scoped.
 */
function eachActiveStatusRun(scm, workflowFile, warnPrefix, extraArgs, visit) {
    var aborted = false;
    for (var i = 0; i < ACTIVE_RUN_STATUSES.length; i++) {
        var status = ACTIVE_RUN_STATUSES[i];
        var raw = null;
        try {
            if (extraArgs && extraArgs.length) {
                raw = scm.listWorkflowRuns.apply(scm,
                    [status, workflowFile, 50].concat(extraArgs));
            } else {
                raw = scm.listWorkflowRuns(status, workflowFile, 50);
            }
        } catch (e) {
            console.warn(warnPrefix + ' (' + status + '): ' + (e.message || e));
            continue;
        }
        if (visit(status, raw)) { aborted = true; break; }
    }
    return aborted;
}

/** Run → epoch ms via updated_at/updatedAt/created_at/createdAt, or null. */
function workflowRunTimestamp(run) {
    var value = run && (run.updated_at || run.updatedAt || run.created_at || run.createdAt);
    if (!value) return null;
    var timestamp = Date.parse(value);
    return isNaN(timestamp) ? null : timestamp;
}

/** Run → '42m' / '2h 5m' human age, or '' when the run carries no time. */
function workflowRunAge(run) {
    var timestamp = workflowRunTimestamp(run);
    if (!timestamp) return '';

    var ageMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (ageMinutes < 60) return ageMinutes + 'm';
    var ageHours = Math.floor(ageMinutes / 60);
    var remainingMinutes = ageMinutes % 60;
    return ageHours + 'h' + (remainingMinutes ? ' ' + remainingMinutes + 'm' : '');
}

// mcpParse parity for `gh api` probe results: bridge tools may return
// decoded objects, JSON strings, or { output | stdout } envelopes.
function parseProbeResult(res) {
    var out = (res && (res.output || res.stdout)) || res;
    if (!out) return null;
    if (typeof out === 'string') {
        try { return JSON.parse(out); } catch (e) { return null; }
    }
    return out;
}

/**
 * The dispatched runs of ciWorkflow on one exact head (workflow_dispatch
 * only) — the ONE `gh api .../runs?head_sha…` round the five dispatched-CI
 * guards used to fire independently. THROWS on cli failure: every caller
 * owns its fail-open/fail-closed catch (the per-guard probe comments pin
 * which side each one fails). Unparseable bodies read as an empty list.
 */
function dispatchedRuns(repoInfo, ciWorkflow, headSha) {
    var res = cli_execute_command({
        command: 'gh api "repos/' + repoInfo.owner + '/' +
                 repoInfo.repo +
                 '/actions/workflows/' + ciWorkflow +
                 '/runs?head_sha=' + headSha +
                 '&event=workflow_dispatch&per_page=5"'
    });
    var runs = parseProbeResult(res);
    return (runs && runs.workflow_runs) || [];
}

/**
 * Newest-first ordering by run time (updated_at, else created_at) — one
 * comparator for every 'sort the newest run to the front' probe
 * (new Date(x).getTime() and Date.parse(x) agree on every parseable
 * timestamp, so the two legacy spellings collapse into this one).
 */
function newestRunTime(a, b) {
    return Date.parse((b && (b.updated_at || b.created_at)) || 0) -
           Date.parse((a && (a.updated_at || a.created_at)) || 0);
}

/** Sorts list newest-first IN PLACE (the legacy callers sorted locals). */
function sortRunsNewestFirst(list) {
    list.sort(newestRunTime);
    return list;
}

/** Run list → { '<stringified id>': run } index; id-less runs are skipped. */
function indexRunsById(runs) {
    var byId = {};
    (runs || []).forEach(function (r) {
        if (r && r.id !== undefined && r.id !== null) byId[String(r.id)] = r;
    });
    return byId;
}

module.exports = {
    ACTIVE_RUN_STATUSES: ACTIVE_RUN_STATUSES,
    parseWorkflowRuns: parseWorkflowRuns,
    eachActiveStatusRun: eachActiveStatusRun,
    workflowRunTimestamp: workflowRunTimestamp,
    workflowRunAge: workflowRunAge,
    dispatchedRuns: dispatchedRuns,
    newestRunTime: newestRunTime,
    sortRunsNewestFirst: sortRunsNewestFirst,
    indexRunsById: indexRunsById
};
