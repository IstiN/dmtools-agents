/**
 * Workflow Failure Reporter (JSRunner)
 *
 * Checks for failed GitHub workflow runs and creates Jira bugs for each unique failure.
 * Uses a label (ci-run-{runId}) for idempotency — skips if a bug with that label exists.
 *
 * customParams:
 *   workspace    — GitHub owner/org       (e.g. "ai-teammate")
 *   repository   — GitHub repo name       (e.g. "mytube")
 *   workflowId   — workflow filename      (e.g. "ai-teammate.yml")
 *   jiraProject  — Jira project key       (e.g. "MYTUBE")
 */

// ─── Main ─────────────────────────────────────────────────────────────────────

function action(params) {
    var custom      = params.jobParams.customParams;
    var workspace   = custom.workspace;
    var repository  = custom.repository;
    var workflowId  = custom.workflowId;
    var jiraProject = custom.jiraProject;

    if (!workspace || !repository || !workflowId || !jiraProject) {
        console.error('❌ customParams must include workspace, repository, workflowId, jiraProject');
        return { success: false, error: 'Missing required customParams' };
    }

    console.log('Workflow Failure Reporter — ' + workspace + '/' + repository + ' [' + workflowId + ']');

    // 1. Get failed runs
    var runsRaw = github_list_workflow_runs(workspace, repository, 'failure', workflowId, 50);
    var runs;
    try {
        var parsed = typeof runsRaw === 'string' ? JSON.parse(runsRaw) : runsRaw;
        runs = parsed.workflow_runs || [];
    } catch (e) {
        console.error('❌ Failed to parse workflow runs: ' + (e.message || e));
        return { success: false, error: 'Failed to parse workflow runs' };
    }

    if (runs.length === 0) {
        console.log('No failed runs found.');
        return { success: true, created: 0, skipped: 0, totalRuns: 0 };
    }

    console.log('Found ' + runs.length + ' failed run(s)');

    var created = 0;
    var skipped = 0;
    var createdKeys = [];

    for (var i = 0; i < runs.length; i++) {
        var run   = runs[i];
        var runId = run.id;
        var label = 'ci-run-' + runId;

        // 2. Check if bug already exists by label
        var existing = [];
        try {
            existing = jira_search_by_jql({
                jql:    'project = ' + jiraProject + ' AND issuetype = Bug AND labels = "' + label + '"',
                limit:  1,
                fields: ['key']
            }) || [];
        } catch (e) {
            console.warn('  ⚠️  JQL search failed for run ' + runId + ': ' + (e.message || e));
        }

        if (existing.length > 0) {
            console.log('  ⏭️  Run ' + runId + ' — bug already exists (' + existing[0].key + '), skipping');
            skipped++;
            continue;
        }

        // 3. Create bug
        var summary = 'Failed CI: ' + run.name + ' #' + run.run_number + ' [' + workflowId + ']';
        var description =
            'GitHub Actions workflow run failed.\n\n' +
            '*Workflow:* ' + workflowId + '\n' +
            '*Run:* ' + run.name + ' #' + run.run_number + '\n' +
            '*Branch:* ' + (run.head_branch || 'unknown') + '\n' +
            '*Commit:* ' + (run.head_sha ? run.head_sha.substring(0, 7) : 'unknown') + '\n' +
            '*URL:* ' + run.html_url + '\n' +
            '*Run ID:* ' + runId;

        try {
            var result = jira_create_ticket({
                project:     jiraProject,
                summary:     summary,
                description: description,
                issuetype:   'Bug',
                priority:    'High'
            });
            var newKey = result && result.key ? result.key : null;

            if (!newKey) {
                console.warn('  ⚠️  Bug created but no key returned for run ' + runId);
                created++;
                continue;
            }

            // 4. Add idempotency label
            try {
                jira_add_label({ key: newKey, label: label });
            } catch (e) {
                console.warn('  ⚠️  Failed to add label ' + label + ' to ' + newKey + ': ' + (e.message || e));
            }

            console.log('  ✅ Created ' + newKey + ' for run ' + runId);
            createdKeys.push(newKey);
            created++;
        } catch (e) {
            console.error('  ❌ Failed to create bug for run ' + runId + ': ' + (e.message || e));
        }
    }

    console.log('\n══ Workflow Failure Reporter complete — created: ' + created +
        (createdKeys.length ? ' [' + createdKeys.join(', ') + ']' : '') +
        ', skipped: ' + skipped + ' ══');

    return { success: true, created: created, skipped: skipped, totalRuns: runs.length, createdKeys: createdKeys };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
