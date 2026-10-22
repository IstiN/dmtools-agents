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
var configLoader = null;
try { configLoader = require('./configLoader.js'); } catch (e) {}

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}
function resolveProjectConfig(params) {
    return configLoader ? configLoader.loadProjectConfig(params) : null;
}

// ─── Pure helpers (extracted from action — gh-1007) ──────────────────────────

/**
 * Normalize the listWorkflowRuns payload into a runs array.
 * Returns { runs: [...] } on success or { error } when the payload
 * cannot be parsed (mirrors the original inline try/catch exactly —
 * a JSON 'null' payload is an error, not an empty list).
 */
function parseWorkflowRuns(runsRaw) {
    try {
        var parsed = typeof runsRaw === 'string' ? JSON.parse(runsRaw) : runsRaw;
        return { runs: parsed.workflow_runs || [] };
    } catch (e) {
        return { error: 'Failed to parse workflow runs', detail: e.message || String(e) };
    }
}

/** Extract a ticket key from a run name ("config.json : PROJ-123"). */
function detectTicketKey(runName) {
    var ticketMatch = (runName || '').match(/([A-Z]+-\d+)\s*$/);
    return ticketMatch ? ticketMatch[1] : null;
}

function buildBugSummary(run, workflowId) {
    return 'Failed CI: ' + run.name + ' #' + run.run_number +
        (workflowId ? ' [' + workflowId + ']' : '');
}

function buildBugDescription(run, runWorkflow, ticketKey) {
    return 'GitHub Actions workflow run failed.\n\n' +
        (ticketKey ? '*Ticket:* [' + ticketKey + ']\n' : '') +
        '*Workflow:* ' + runWorkflow + '\n' +
        '*Run:* ' + run.name + ' #' + run.run_number + '\n' +
        '*Branch:* ' + (run.head_branch || 'unknown') + '\n' +
        '*Commit:* ' + (run.head_sha ? run.head_sha.substring(0, 7) : 'unknown') + '\n' +
        '*URL:* ' + run.html_url + '\n' +
        '*Run ID:* ' + run.id;
}

/** Extract the new ticket key from a bare-key string (JSON payload, plain key or /browse/ URL). */
function extractKeyFromString(result) {
    var newKey = null;
    try {
        var parsed = JSON.parse(result);
        if (parsed && parsed.key) newKey = parsed.key;
    } catch (e) {}
    if (!newKey && /^[A-Za-z0-9_-]+$/.test(result.trim())) newKey = result.trim(); // tracker returns the bare key
    if (!newKey) {
        var urlMatch = result.match(/\/browse\/([A-Z]+-\d+)/);
        if (urlMatch) newKey = urlMatch[1];
    }
    return newKey;
}

/** Extract the created ticket key from any tracker result shape. */
function extractCreatedTicketKey(result) {
    if (!result) return null;
    if (typeof result === 'string') return extractKeyFromString(result);
    if (result.key) return result.key;
    return null;
}

/** Run a bug search and tolerate JQL errors (warn + empty result). */
function searchBugsOrEmpty(tracker, jql, fields, warnPrefix) {
    try {
        return tracker.searchIssues(jql, { fields: fields }) || [];
    } catch (e) {
        console.warn(warnPrefix + (e.message || e));
        return [];
    }
}

/**
 * Dedup gate for one run: skip when a ci-run-labeled bug exists, detect the
 * ticket key from the run name and skip when an open ci-ticket bug exists.
 * Returns { status: 'skipped_existing' | 'skipped_open_bug' } to skip, or
 * { ticketKey } to proceed.
 */
function checkRunDedup(run, tracker, jiraProject) {
    var runId = run.id;
    var label = 'ci-run-' + runId;

    var existing = searchBugsOrEmpty(tracker,
        'project = ' + jiraProject + ' AND issuetype = Bug AND labels = "' + label + '"',
        ['key'], '  ⚠️  JQL search failed for run ' + runId + ': ');

    if (existing.length > 0) {
        console.log('  ⏭️  Run ' + runId + ' — bug already exists (' + existing[0].key + '), skipping');
        return { status: 'skipped_existing' };
    }

    var ticketKey = detectTicketKey(run.name);
    if (!ticketKey) return { ticketKey: null };

    console.log('  🎫 Detected ticket: ' + ticketKey);

    var ticketLabel = 'ci-ticket-' + ticketKey;
    var openBug = searchBugsOrEmpty(tracker,
        'project = ' + jiraProject + ' AND issuetype = Bug AND labels = "' + ticketLabel + '" AND statusCategory != Done',
        ['key', 'status'], '  ⚠️  JQL search for open ticket bug failed: ');

    if (openBug.length > 0) {
        console.log('  ⏭️  ' + ticketKey + ' — open bug already exists (' + openBug[0].key + '), skipping run ' + runId);
        return { status: 'skipped_open_bug' };
    }
    return { ticketKey: ticketKey };
}

/** Create the bug ticket for a run and extract its key from any result shape. */
function createBugTicket(tracker, jiraProject, run, workflowId, ticketKey) {
    var runWorkflow = (run.name || workflowId || 'unknown');
    var summary = buildBugSummary(run, workflowId);
    var description = buildBugDescription(run, runWorkflow, ticketKey);

    var result, newKey;
    try {
        result = tracker.createTicket(jiraProject, 'Bug', summary, description);
        newKey = extractCreatedTicketKey(result);
    } catch (e) {
        console.error('  ❌ Failed to create bug for run ' + run.id + ': ' + (e.message || e));
        return { status: 'create_failed' };
    }

    if (!newKey) {
        console.warn('  ⚠️  Bug created but no key returned for run ' + run.id + ' (result: ' + result + ')');
        return { status: 'created_keyless' };
    }
    return { status: 'created', key: newKey };
}

/** Link the created bug to the detected ticket and add the ci-ticket dedup label. */
function linkCreatedBug(tracker, newKey, ticketKey) {
    try {
        tracker.linkIssues(ticketKey, newKey, 'is blocked by');
        console.log('  🔗 Linked ' + ticketKey + ' is blocked by ' + newKey);
    } catch (e) {
        console.warn('  ⚠️  Failed to link ' + newKey + ' to ' + ticketKey + ': ' + (e.message || e));
    }
    try {
        tracker.addLabel(newKey, 'ci-ticket-' + ticketKey);
    } catch (e) {
        console.warn('  ⚠️  Failed to add ci-ticket label to ' + newKey + ': ' + (e.message || e));
    }
}

/**
 * Idempotent per-run pipeline: dedup by ci-run label, dedup by open
 * ci-ticket bug, create the bug, label and link it.
 * Returns { status: 'skipped_existing' | 'skipped_open_bug' | 'created_keyless' |
 *                  'create_failed' | 'created', key? }.
 */
function processFailedRun(run, ctx) {
    var tracker = ctx.tracker;
    var jiraProject = ctx.jiraProject;
    var workflowId = ctx.workflowId;
    var runId = run.id;

    var dedup = checkRunDedup(run, tracker, jiraProject);
    if (dedup.status) return dedup;

    var created = createBugTicket(tracker, jiraProject, run, workflowId, dedup.ticketKey);
    if (created.status !== 'created') return created;
    var newKey = created.key;

    // Add idempotency label
    try {
        tracker.addLabel(newKey, 'ci-run-' + runId);
    } catch (e) {
        console.warn('  ⚠️  Failed to add label ci-run-' + runId + ' to ' + newKey + ': ' + (e.message || e));
    }

    // Link bug to ticket if detected + add ci-ticket label for dedup
    if (dedup.ticketKey) {
        linkCreatedBug(tracker, newKey, dedup.ticketKey);
    }

    console.log('  ✅ Created ' + newKey + ' for run ' + runId);
    return { status: 'created', key: newKey };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function action(params) {
    var custom      = params.jobParams.customParams;
    var workspace   = custom.workspace;
    var repository  = custom.repository;
    var workflowId  = custom.workflowId || null;   // optional — null means all workflows
    var jiraProject = custom.jiraProject;
    initTracker(resolveProjectConfig(params), custom);

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
    if (runsRaw == null) {
        console.warn('⚠️  listWorkflowRuns is not supported by the configured SCM provider.');
        return { success: false, error: 'listWorkflowRuns not supported by provider: ' + (custom.scmProvider || 'github') };
    }
    var runsResult = parseWorkflowRuns(runsRaw);
    if (runsResult.error) {
        console.error('❌ Failed to parse workflow runs: ' + runsResult.detail);
        return { success: false, error: runsResult.error };
    }
    var runs = runsResult.runs;

    if (runs.length === 0) {
        console.log('No failed runs found.');
        return { success: true, created: 0, skipped: 0, totalRuns: 0 };
    }

    console.log('Found ' + runs.length + ' failed run(s)');

    var created = 0;
    var skipped = 0;
    var createdKeys = [];

    for (var i = 0; i < runs.length; i++) {
        var outcome = processFailedRun(runs[i], {
            tracker: getTracker(),
            jiraProject: jiraProject,
            workflowId: workflowId
        });
        if (outcome.status === 'skipped_existing' || outcome.status === 'skipped_open_bug') {
            skipped++;
        } else if (outcome.status === 'created' || outcome.status === 'created_keyless') {
            created++;
            if (outcome.key) createdKeys.push(outcome.key);
        }
    }

    console.log('\n══ Workflow Failure Reporter complete — created: ' + created +
        (createdKeys.length ? ' [' + createdKeys.join(', ') + ']' : '') +
        ', skipped: ' + skipped + ' ══');

    return { success: true, created: created, skipped: skipped, totalRuns: runs.length, createdKeys: createdKeys };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parseWorkflowRuns: parseWorkflowRuns,
        detectTicketKey: detectTicketKey,
        buildBugSummary: buildBugSummary,
        buildBugDescription: buildBugDescription,
        extractKeyFromString: extractKeyFromString,
        extractCreatedTicketKey: extractCreatedTicketKey,
        searchBugsOrEmpty: searchBugsOrEmpty,
        checkRunDedup: checkRunDedup,
        createBugTicket: createBugTicket,
        processFailedRun: processFailedRun,
        linkCreatedBug: linkCreatedBug
    };
}
