/**
 * Workflow Failure Reporter (JSRunner)
 *
 * Checks for failed GitHub workflow runs and creates Jira bugs for each unique failure.
 * Uses a label (ci-run-{runId}) for idempotency — skips if a bug with that label exists.
 *
 * customParams:
 *   workspace    — GitHub owner/org       (e.g. "my-org")
 *   repository   — GitHub repo name       (e.g. "my-repo")
 *   workflowId   — workflow filename      (optional, e.g. "ci.yml"; omit for all workflows)
 *   jiraProject  — Jira project key       (e.g. "PROJ")
 *
 * NOTE: Listing runs without workflowId requires dmtools to support the /actions/runs endpoint.
 * If you get a 404 when workflowId is omitted, please report to dmtools:
 * https://github.com/IstiN/dmtools/issues
 */

// ─── Main ─────────────────────────────────────────────────────────────────────

var scmModule = require('./common/scm.js');

function action(params) {
    var custom      = params.jobParams.customParams;
    var workspace   = custom.workspace;
    var repository  = custom.repository;
    var workflowId  = custom.workflowId || null;   // optional — null means all workflows
    var jiraProject = custom.jiraProject;

    if (!workspace || !repository || !jiraProject) {
        console.error('❌ customParams must include workspace, repository, jiraProject');
        return { success: false, error: 'Missing required customParams' };
    }

    console.log('Workflow Failure Reporter — ' + workspace + '/' + repository +
        (workflowId ? ' [' + workflowId + ']' : ' [all workflows]'));

    // 1. Get failed runs
    var scmConfig = {
        repository: { owner: workspace, repo: repository },
        scm: { provider: custom.scmProvider || 'github' }
    };
    var scm = scmModule.createScm(scmConfig);
    var runsRaw = scm.listWorkflowRuns('failure', workflowId, 50);
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

        // 3. Extract ticket key from run name (format: "config.json : PROJ-123")
        var ticketKey = null;
        var ticketMatch = (run.name || '').match(/([A-Z]+-\d+)\s*$/);
        if (ticketMatch) {
            ticketKey = ticketMatch[1];
            console.log('  🎫 Detected ticket: ' + ticketKey);
        }

        // 3b. If ticket detected — skip if open bug already exists for this ticket
        if (ticketKey) {
            var ticketLabel = 'ci-ticket-' + ticketKey;
            var openBug = [];
            try {
                openBug = jira_search_by_jql({
                    jql:    'project = ' + jiraProject + ' AND issuetype = Bug AND labels = "' + ticketLabel + '" AND statusCategory != Done',
                    limit:  1,
                    fields: ['key', 'status']
                }) || [];
            } catch (e) {
                console.warn('  ⚠️  JQL search for open ticket bug failed: ' + (e.message || e));
            }
            if (openBug.length > 0) {
                console.log('  ⏭️  ' + ticketKey + ' — open bug already exists (' + openBug[0].key + '), skipping run ' + runId);
                skipped++;
                continue;
            }
        }

        // 4. Create bug
        var runWorkflow = (run.name || workflowId || 'unknown');
        var summary = 'Failed CI: ' + run.name + ' #' + run.run_number +
            (workflowId ? ' [' + workflowId + ']' : '');
        var description =
            'GitHub Actions workflow run failed.\n\n' +
            (ticketKey ? '*Ticket:* [' + ticketKey + ']\n' : '') +
            '*Workflow:* ' + runWorkflow + '\n' +
            '*Run:* ' + run.name + ' #' + run.run_number + '\n' +
            '*Branch:* ' + (run.head_branch || 'unknown') + '\n' +
            '*Commit:* ' + (run.head_sha ? run.head_sha.substring(0, 7) : 'unknown') + '\n' +
            '*URL:* ' + run.html_url + '\n' +
            '*Run ID:* ' + runId;

        try {
            var result = jira_create_ticket_basic(jiraProject, 'Bug', summary, description);
            var newKey = null;
            if (result) {
                if (typeof result === 'string') {
                    // jira_create_ticket_basic returns JSON: {"id":"...","key":"PROJ-123",...}
                    try {
                        var parsed = JSON.parse(result);
                        if (parsed && parsed.key) newKey = parsed.key;
                    } catch (e) {}
                    if (!newKey) {
                        var urlMatch = result.match(/\/browse\/([A-Z]+-\d+)/);
                        if (urlMatch) newKey = urlMatch[1];
                    }
                } else if (result.key) {
                    newKey = result.key;
                }
            }

            if (!newKey) {
                console.warn('  ⚠️  Bug created but no key returned for run ' + runId + ' (result: ' + result + ')');
                created++;
                continue;
            }

            // 5. Add idempotency label
            try {
                jira_add_label({ key: newKey, label: label });
            } catch (e) {
                console.warn('  ⚠️  Failed to add label ' + label + ' to ' + newKey + ': ' + (e.message || e));
            }

            // 6. Link bug to ticket if detected + add ci-ticket label for dedup
            if (ticketKey) {
                try {
                    jira_link_issues({ sourceKey: ticketKey, anotherKey: newKey, relationship: 'is blocked by' });
                    console.log('  🔗 Linked ' + ticketKey + ' is blocked by ' + newKey);
                } catch (e) {
                    console.warn('  ⚠️  Failed to link ' + newKey + ' to ' + ticketKey + ': ' + (e.message || e));
                }
                try {
                    jira_add_label({ key: newKey, label: 'ci-ticket-' + ticketKey });
                } catch (e) {
                    console.warn('  ⚠️  Failed to add ci-ticket label to ' + newKey + ': ' + (e.message || e));
                }
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
