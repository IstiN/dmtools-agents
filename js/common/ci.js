/**
 * CI check-run mirroring for dispatch-only workflows.
 *
 * Problem: when a repository's CI is triggered via workflow_dispatch
 * (no pull_request trigger), GitHub does not associate the run's check
 * runs with open PRs — the branch-protection required checks stay
 * "expected/pending" forever, and the real pass/fail is invisible in
 * the PR Checks tab (a zombie check-run may exist on the head SHA from
 * a stale push event).
 *
 * Fix: re-read the ACTUAL jobs of the dispatch run and re-create one
 * check-run per required check name on the PR head SHA (same names,
 * same conclusions, summary links back to the source run). GitHub's
 * Checks UI and branch protection take the LATEST check-run per
 * (name, head SHA), so the mirror overrides any zombie.
 *
 * Tools used (dmtools registry, snake_case, synchronous):
 *   github_get_workflow_run_jobs({workspace, repository, runId})
 *       -> { total_count, jobs: [{id, name, status, conclusion, html_url}] }
 *   github_create_check_run({workspace, repository, name, headSha
 *       [, status][, title][, summary][, text]})
 *       -> check-run object (use .id for the follow-up update)
 *   github_update_check_run({workspace, repository, checkRunId,
 *       status, conclusion[, title][, summary][, text]})
 *   github_create_commit_status({workspace, repository, sha, state
 *       [, description][, context][, targetUrl]})
 *
 * Conclusion policy (documented behaviour of stampRequiredChecks):
 *   - job.conclusion === 'skipped'         -> NOT stamped (a skipped job
 *       must never green a required check); recorded in `skipped`.
 *   - job.status !== 'completed' (running/queued/null conclusion)
 *                                          -> NOT stamped; `skipped`
 *       entry with reason 'not-completed'.
 *   - success | neutral                    -> stamped as 'success' (and
 *       commit-status 'success' when the fallback is on).
 *   - failure | timed_out | startup_failure | cancelled | action_required
 *                                          -> stamped as-is ('cancelled'
 *       and 'action_required' map to commit-status 'failure' — GitHub
 *       statuses have no neutral value, and a cancelled CI run must not
 *       read as green on a PR).
 *
 * Job matching: required check `name` is matched EXACTLY against the
 * job `name` (GitHub matrix jobs include the parenthesised variant, so
 * list the full name, e.g. "build (ubuntu-latest)"). When several jobs
 * share a name (re-runs, matrix), the LAST match in the run's job list
 * wins — it is the most recent attempt. A required entry may override
 * the matched job name with `jobName` when the protected check name
 * intentionally differs from the workflow job name.
 */

function _parseJson(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
}

function _jobsOf(response) {
    var parsed = _parseJson(response);
    if (parsed && Array.isArray(parsed.jobs)) return parsed.jobs;
    if (parsed && Array.isArray(parsed.job_runs)) return parsed.job_runs;
    if (Array.isArray(parsed)) return parsed;
    return [];
}

function _failedConclusions() {
    return {
        failure: true,
        timed_out: true,
        startup_failure: true,
        cancelled: true,
        action_required: true
    };
}

function stampRequiredChecks(options) {
    var opts = options || {};
    var workspace = opts.workspace;
    var repository = opts.repository;
    var headSha = opts.headSha;
    var runId = opts.runId;
    var required = opts.requiredChecks || [];

    if (!workspace) throw new Error('stampRequiredChecks: workspace is required');
    if (!repository) throw new Error('stampRequiredChecks: repository is required');
    if (!headSha) throw new Error('stampRequiredChecks: headSha is required');
    if (runId === undefined || runId === null || String(runId).trim() === '') {
        throw new Error('stampRequiredChecks: runId is required');
    }

    var summary = { stamped: [], skipped: [], missing: [] };
    if (!required.length) return summary;

    var jobs = _jobsOf(github_get_workflow_run_jobs({
        workspace: workspace,
        repository: repository,
        runId: runId
    }));
    var failed = _failedConclusions();

    for (var i = 0; i < required.length; i++) {
        var entry = required[i] || {};
        var checkName = entry.name;
        var jobName = entry.jobName || entry.name;
        if (!checkName) {
            summary.skipped.push({ name: null, reason: 'no-name' });
            continue;
        }

        // Last match wins: later entries in the run's job list are the
        // most recent attempt (re-runs, requeue).
        var job = null;
        for (var j = 0; j < jobs.length; j++) {
            if (jobs[j] && jobs[j].name === jobName) job = jobs[j];
        }

        if (!job) {
            summary.missing.push({ name: checkName, jobName: jobName });
            continue;
        }
        if (job.status !== 'completed' || !job.conclusion) {
            summary.skipped.push({ name: checkName, jobName: jobName, reason: 'not-completed', jobStatus: job.status });
            continue;
        }
        if (job.conclusion === 'skipped') {
            summary.skipped.push({ name: checkName, jobName: jobName, reason: 'skipped' });
            continue;
        }

        var created = _parseJson(github_create_check_run({
            workspace: workspace,
            repository: repository,
            name: checkName,
            headSha: headSha,
            status: 'in_progress'
        }));
        var checkRunId = created && (created.id !== undefined && created.id !== null ? created.id : (created.checkRunId));
        github_update_check_run({
            workspace: workspace,
            repository: repository,
            checkRunId: checkRunId,
            status: 'completed',
            conclusion: job.conclusion,
            title: checkName + ' — ' + job.conclusion + ' (mirrored from run ' + runId + ')',
            summary: 'Mirrored from [workflow run ' + runId + '](' +
                (job.html_url || '') + '): job `' + jobName + '` concluded `' +
                job.conclusion + '`.'
        });
        summary.stamped.push({ name: checkName, conclusion: job.conclusion, checkRunId: checkRunId });

        if (opts.commitStatusFallback === true) {
            var state = failed[job.conclusion] ? 'failure' : 'success';
            github_create_commit_status({
                workspace: workspace,
                repository: repository,
                sha: headSha,
                state: state,
                context: checkName,
                description: job.conclusion + ' (mirrored from run ' + runId + ')',
                targetUrl: job.html_url
            });
            summary.stamped[summary.stamped.length - 1].commitStatus = state;
        }
    }

    return summary;
}

module.exports = {
    stampRequiredChecks: stampRequiredChecks
};
