/**
 * SM Agent — Scrum Master automation (JSRunner)
 *
 * Reads an array of rules from params.rules (defined in agents/sm.json)
 * and for each rule:
 *   1. Queries Jira by rule.jql (with {jiraProject}/{parentTicket} interpolation)
 *   2. Optionally transitions each ticket to rule.targetStatus
 *   3. Runs the agent for each matching ticket, via one of three modes:
 *      - dispatch (default) — triggers an ai-teammate GitHub Actions workflow (async)
 *      - localExecution: true — runs the agent config's postJSAction directly in the
 *        SM process (pure JS, no AI CLI, no checkout — for fast/safe operations)
 *      - localTeammate: true — runs the FULL teammate pipeline (checkout/branch switch,
 *        AI CLI, PR/Jira actions) synchronously on the local machine via
 *        scripts/run-teammate-local.sh, one ticket at a time (no GitHub Actions runner)
 *
 * Configuration:
 *   Loads project config from .dmtools/config.js (via configLoader).
 *   If config.smRules is provided, uses those instead of params.rules (full override).
 *   Repository owner/repo from config override params when present.
 *   JQL placeholders {jiraProject} and {parentTicket} are resolved from config.
 *   jobParams.maxTriggeredWorkflows (or maxWorkflowsPerRun) limits total active plus newly
 *   dispatched workflows across all non-local rules.
 *   Override priority: config.smMaxWorkflows (from .dmtools/config.js) > sm.json value.
 *   jobParams.forceLocalTeammate — set via a CLI JSON override (note the outer `params`
 *   wrapper — `dmtools run <file> <override>` deep-merges into the whole {name, params}
 *   job config, not directly into params.jobParams; a bare {"jobParams":{...}} override
 *   is silently ignored):
 *   `dmtools run agents/sm.json '{"params":{"jobParams":{"forceLocalTeammate":true}}}'`
 *   to switch EVERY default-dispatch rule to the local teammate pipeline for that run,
 *   without editing sm.json/.dmtools/config.js. Rules with localExecution:true are
 *   unaffected; a rule can still opt out with an explicit `localTeammate: false`.
 *
 * Rule fields:
 *   jql            (required) — JQL to find tickets (supports {jiraProject}, {parentTicket})
 *   configFile     (required) — agents/*.json to pass as config_file workflow input
 *   configPath     (optional) — path to a project config (.dmtools/config.js) for this rule
 *                               overrides the global config; enables multi-project orchestration
 *   description    (optional) — human-readable label shown in logs
 *   targetStatus   (optional) — Jira status to transition tickets to before triggering
 *   workflowFile   (optional) — GitHub Actions workflow file  (default: ai-teammate.yml)
 *   workflowRef    (optional) — git ref for dispatch           (default: main)
 *   concurrencyKey (optional) — workflow concurrency key override (default: ticket key)
 *   projectKey     (optional) — value passed as the `project_key` workflow input so the runner
 *                               activates the correct project-specific dependency setup (e.g. "myproject",
 *                               "bice"). Auto-derived from configPath basename when not set
 *                               (e.g. ".dmtools/configs/myproject.js" → "myproject").
 *   skipIfLabel    (optional) — skip ticket if it already has this label (idempotency)
 *   skipIfLabels   (optional) — skip ticket if it already has any of these labels
 *   addLabel       (optional) — add this label after triggering (idempotency marker)
 *   addLabels      (optional) — add these labels after triggering
 *   recoverStaleTriggerLabel (optional) — if true, remove skip labels when no matching
 *                               active workflow exists and continue processing. Trigger
 *                               labels that are also added by the same rule recover by
 *                               default; set false to opt out.
 *   enabled        (optional) — set to false to disable the rule entirely (default: true)
 *   limit          (optional) — max number of tickets to process per run (default: 50)
 *   localExecution (optional) — if true, run postJSAction directly (no runner, no AI/CLI)
 *   localTeammate  (optional) — if true, run the full teammate pipeline (checkout, AI CLI,
 *                               PR/Jira actions) synchronously in-process via
 *                               scripts/run-teammate-local.sh instead of dispatching a
 *                               GitHub Actions workflow_dispatch. Tickets are processed
 *                               strictly one at a time (the local checkout is reused across
 *                               tickets, so no concurrency/workflowBudget accounting applies).
 *                               Secrets are read from the calling shell's environment or from
 *                               dmtools.env (see scripts/run-agent.sh loader) — never from
 *                               GitHub Actions secrets.
 *   localTeammateScript (optional) — path to the local runner script
 *                               (default: agents/scripts/run-teammate-local.sh)
 */

// Dry-run mode: log every side effect instead of performing it (dispatches,
// label moves, status moves, local executions). Set from jobParams.dryRun.
var DRY = false;

var configLoader = require('./configLoader.js');
var smSource = require('./sm/sourceResolver.js');
var scmModule = require('./common/scm.js');
var buildEncodedConfigModule = require('./common/buildEncodedConfig.js');
var machineAuthorModule = require('./common/machineAuthor.js');

// Project config loaded once in action() — used as global default for rules without configPath
var projectConfig = null;
var STALE_NON_RUNNING_WORKFLOW_MS = 6 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the effective config for a rule.
 * If rule.configPath is set, loads that config (enables per-rule / multi-project override).
 * Otherwise falls back to the global projectConfig.
 */
function loadRuleConfig(rule) {
    if (!rule.configPath) return projectConfig;
    var ruleConfig = configLoader.loadProjectConfig({ configPath: rule.configPath });
    console.log('  🔧 Rule config: ' + rule.configPath +
        (ruleConfig.jira.project ? ' (project: ' + ruleConfig.jira.project + ')' : ''));
    return ruleConfig;
}

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

function labelList(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function isRuleTriggerLabel(rule, label) {
    var labels = labelList(rule.addLabel).concat(labelList(rule.addLabels));
    for (var i = 0; i < labels.length; i++) {
        if (labels[i] === label) return true;
    }
    return false;
}

function shouldRecoverStaleTriggerLabel(rule, label) {
    if (rule.recoverStaleTriggerLabel === true) return true;
    if (rule.recoverStaleTriggerLabel === false) return false;
    return isRuleTriggerLabel(rule, label);
}

function hasActiveTargetWorkflowRun(scm, workflowFile, configFile, ticketKey) {
    if (!scm || typeof scm.listWorkflowRuns !== 'function') return false;

    var expectedRunName = configFile + ' : ' + ticketKey;
    var expectedRunNameSuffix = ' : ' + ticketKey;
    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];

    for (var i = 0; i < statuses.length; i++) {
        var runs = [];
        try {
            runs = parseWorkflowRuns(scm.listWorkflowRuns(statuses[i], workflowFile, 50));
        } catch (e) {
            console.warn('  ⚠️  Could not inspect active workflow runs (' + statuses[i] + '): ' + (e.message || e));
            continue;
        }

        for (var j = 0; j < runs.length; j++) {
            var run = runs[j] || {};
            if (isStaleNonRunningWorkflowRun(run, statuses[i])) continue;
            // GitHub REST carries BOTH fields: `name` is the workflow name
            // ('AI Teammate') while `display_title` is the per-run title
            // ('▶ review (SM) · gh-702'). Name-first made the stub-title
            // match dead code — every SM-dispatched run slipped the
            // in-flight guard and duplicated (live: gh-702 review ×2).
            var runName = run.display_title || run.displayTitle || run.name || '';
            var matchesOldName = runName === expectedRunName;
            var matchesDisplayName = runName.indexOf(configFile + ' : ') === 0 &&
                runName.substring(runName.length - expectedRunNameSuffix.length) === expectedRunNameSuffix;
            // Stub-title match (#687): the caller-side stub names its runs
            // '▶ <leg> (SM) · gh-<key>' / '· pr-<key>' — recognize the
            // ticket key token so PR-anchored dispatches are not re-fired
            // on every tick while the review is still running.
            var matchesStubName = runName.indexOf('· ' + ticketKey) !== -1;
            if (matchesOldName || matchesDisplayName || matchesStubName) {
                console.log('  ⏭️  ' + ticketKey + ' skipped (active workflow already exists: ' + expectedRunName + ')');
                return true;
            }
        }
    }

    return false;
}

function workflowRunTimestamp(run) {
    var value = run && (run.updated_at || run.updatedAt || run.created_at || run.createdAt);
    if (!value) return null;
    var timestamp = Date.parse(value);
    return isNaN(timestamp) ? null : timestamp;
}

function isStaleNonRunningWorkflowRun(run, status) {
    if (status === 'in_progress') return false;
    var timestamp = workflowRunTimestamp(run);
    if (!timestamp) return false;
    return (Date.now() - timestamp) > STALE_NON_RUNNING_WORKFLOW_MS;
}

function workflowRunAge(run) {
    var timestamp = workflowRunTimestamp(run);
    if (!timestamp) return '';

    var ageMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (ageMinutes < 60) return ageMinutes + 'm';
    var ageHours = Math.floor(ageMinutes / 60);
    var remainingMinutes = ageMinutes % 60;
    return ageHours + 'h' + (remainingMinutes ? ' ' + remainingMinutes + 'm' : '');
}

function formatWorkflowRunSummary(run, fallbackStatus) {
    run = run || {};
    var title = run.display_title || run.displayTitle || run.name || 'workflow run';
    var status = run.status || fallbackStatus || 'active';
    var age = workflowRunAge(run);
    var id = run.id || run.databaseId || run.run_number || run.runNumber || '?';
    var url = run.html_url || run.htmlUrl || run.url || '';
    return title + ' [' + status + ', age ' + (age || '?') + ', id ' + id + ']' + (url ? ' ' + url : '');
}

function collectActiveWorkflowRuns(scm, workflowFile) {
    if (!scm || typeof scm.listWorkflowRuns !== 'function') return { count: 0, summaries: [] };

    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];
    var seen = {};
    var count = 0;
    var summaries = [];

    for (var i = 0; i < statuses.length; i++) {
        var runs = [];
        try {
            runs = parseWorkflowRuns(scm.listWorkflowRuns(statuses[i], workflowFile, 50));
        } catch (e) {
            console.warn('  ⚠️  Could not count active workflow runs (' + statuses[i] + '): ' + (e.message || e));
            continue;
        }

        for (var j = 0; j < runs.length; j++) {
            var run = runs[j] || {};
            if (isStaleNonRunningWorkflowRun(run, statuses[i])) continue;
            var id = run.id || run.databaseId || run.run_number || ((run.name || run.display_title || '') + ':' + j + ':' + statuses[i]);
            if (!seen[id]) {
                seen[id] = true;
                count += 1;
                summaries.push(formatWorkflowRunSummary(run, statuses[i]));
            }
        }
    }

    return { count: count, summaries: summaries };
}

function countActiveWorkflowRuns(scm, workflowFile) {
    return collectActiveWorkflowRuns(scm, workflowFile).count;
}

function logBlockingWorkflowRuns(workflowBudget, workflowFile) {
    if (!workflowBudget || !workflowBudget.activeRunSummariesByWorkflow) return;
    var summaries = workflowBudget.activeRunSummariesByWorkflow[workflowFile] || [];
    if (!summaries.length) return;

    console.log('  Blocking active workflow run(s):');
    summaries.slice(0, 5).forEach(function(summary) {
        console.log('   - ' + summary);
    });
    if (summaries.length > 5) {
        console.log('   - ... +' + (summaries.length - 5) + ' more');
    }
}

function ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile) {
    if (!workflowBudget) return;
    if (!workflowBudget.activeCountsByWorkflow) workflowBudget.activeCountsByWorkflow = {};
    if (workflowBudget.activeCountsByWorkflow[workflowFile]) return;
    if (!workflowBudget.activeRunSummariesByWorkflow) workflowBudget.activeRunSummariesByWorkflow = {};

    var active = collectActiveWorkflowRuns(scm, workflowFile);
    var activeCount = active.count;
    workflowBudget.activeCount = (workflowBudget.activeCount || 0) + activeCount;
    workflowBudget.remaining = Math.max(0, workflowBudget.remaining - activeCount);
    workflowBudget.activeCountsByWorkflow[workflowFile] = true;
    workflowBudget.activeRunSummariesByWorkflow[workflowFile] = active.summaries;

    if (activeCount > 0) {
        console.log('  Active workflow cap accounting: ' + activeCount + ' active, ' + workflowBudget.remaining + ' dispatch slot(s) left');
        logBlockingWorkflowRuns(workflowBudget, workflowFile);
    }
}

// Creates the SCM client pinned to the rule's EFFECTIVE target repo.
// The SM engine runs from the dmtools-agents checkout, so createScm's
// git-remote autodetect would otherwise resolve the ENGINE repo whenever
// the config carries no explicit repository (live: the in-flight guard
// listed runs in IstiN/dmtools-agents while the dispatch went to
// flutter_agent_harness — duplicate review gh-691).
function createTargetScm(effectiveConfig, repoInfo) {
    if (!repoInfo || !repoInfo.owner || !repoInfo.repo) {
        return scmModule.createScm(effectiveConfig);
    }
    var cfg = {};
    if (effectiveConfig) {
        for (var k in effectiveConfig) {
            if (Object.prototype.hasOwnProperty.call(effectiveConfig, k)) cfg[k] = effectiveConfig[k];
        }
    }
    cfg.repository = { owner: repoInfo.owner, repo: repoInfo.repo };
    return scmModule.createScm(cfg);
}

function isWorkflowBudgetExhausted(rule, effectiveConfig, workflowBudget, repoInfo) {
    if (!workflowBudget) return false;

    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    var scm = createTargetScm(effectiveConfig, repoInfo);
    ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile);
    return workflowBudget.remaining <= 0;
}

function triggerWorkflow(repoInfo, ticketKey, rule, effectiveConfig, workflowBudget, item) {
    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    // workflowRef may reference the matched item: '{branch}' dispatches the
    // leg ON the PR head so GitHub links the run to the PR (checks + PR
    // timeline) — e.g. review/rework legs become pr-visible runs. An empty
    // expansion (no linked PR / no head) falls back to 'main'.
    var workflowRef  = rule.workflowRef  || 'main';
    var it0 = item || {};
    workflowRef = String(workflowRef)
        .replace(/\{branch\}/g, String(it0.branch || ''))
        .replace(/\{prNumber\}/g, String(it0.prNumber || ''));
    if (!workflowRef) workflowRef = 'main';
    var resolvedCf   = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
    var concurrencyKey = rule.concurrencyKey || ticketKey;

    // Resolve project_key: explicit rule field takes priority, then auto-derive from configPath
    // e.g. ".dmtools/configs/myproject.js" → "myproject", ".dmtools/configs/bice.js" → "bice"
    var projectKey = rule.projectKey || '';
    if (!projectKey && effectiveConfig && effectiveConfig._configPath) {
        var cp = effectiveConfig._configPath;
        var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
        if (base && base !== 'config') projectKey = base;
    }

    try {
        var scm = createTargetScm(effectiveConfig, repoInfo);
        ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile);
        if (workflowBudget && workflowBudget.remaining <= 0) {
            console.log('  ⏭️  ' + ticketKey + ' skipped (global workflow cap reached: ' + workflowBudget.initial + ')');
            logBlockingWorkflowRuns(workflowBudget, workflowFile);
            return false;
        }
        if (hasActiveTargetWorkflowRun(scm, workflowFile, resolvedCf, concurrencyKey)) {
            return false;
        }
        var inputs;
        if (rule.inputs) {
            // Rule-declared dispatch inputs (github-source rules): values may
            // reference the matched item via '{key}' / '{issueNumber}' /
            // '{prNumber}' placeholders.
            var it = item || {};
            // {issueNumber} on a PR-carrier item without a linked issue must
            // NOT fall back to the ticket key — dispatching issue='pr-N'
            // breaks the factory guard's anchor validation. Skip loudly.
            var needsIssue = Object.keys(rule.inputs).some(function (k) {
                return String(rule.inputs[k]).indexOf('{issueNumber}') !== -1;
            });
            if (needsIssue && (it.issueNumber === undefined || it.issueNumber === null)) {
                console.log('  ⏭️  ' + ticketKey + ' skipped (rule "' + (rule.id || '') +
                    '" needs {issueNumber} but the PR links no issue)');
                return false;
            }
            inputs = {};
            Object.keys(rule.inputs).forEach(function (k) {
                inputs[k] = String(rule.inputs[k])
                    .replace(/\{key\}/g, String(ticketKey))
                    .replace(/\{issueNumber\}/g, String(it.issueNumber !== undefined && it.issueNumber !== null ? it.issueNumber : ticketKey))
                    .replace(/\{prNumber\}/g, String(it.prNumber || ''));
            });
        } else {
            inputs = {
                concurrency_key: concurrencyKey,
                display_key:     ticketKey,
                input_jql:       'key = ' + ticketKey,
                config_file:     resolvedCf,
                encoded_config:  buildEncodedConfigModule.buildEncodedConfig(ticketKey, rule, effectiveConfig),
                project_key:     projectKey
            };
        }
        if (DRY) {
            console.log('  [dry] ▶️ ' + ticketKey + ' dispatch:' + workflowFile + ' inputs=' + JSON.stringify(inputs));
            return;
        }
        scm.triggerWorkflow(
            repoInfo.owner,
            repoInfo.repo,
            workflowFile,
            JSON.stringify(inputs),
            workflowRef
        );
        console.log('  ✅ Triggered ' + workflowFile + '@' + workflowRef + ' for ' + ticketKey +
            (projectKey ? ' [project_key=' + projectKey + ']' : ''));
        return true;
    } catch (e) {
        console.warn('  ⚠️  Workflow trigger failed for ' + ticketKey + ': ' + (e.message || e));
        return false;
    }
}

/**
 * Runs the full teammate pipeline locally (synchronously) instead of dispatching a
 * GitHub Actions workflow_dispatch. Delegates checkout/branch-switching, the AI CLI
 * run, and PR/Jira post-actions to scripts/run-teammate-local.sh — the same
 * agents/*.json config and dmtools `run` entrypoint used by ai-teammate.yml, just
 * invoked on the local machine instead of a runner.
 *
 * Because cli_execute_command() blocks until the child process exits, calling this
 * from the same sequential ticket loop as triggerWorkflow() naturally enforces
 * one-ticket-at-a-time processing — no separate queue/scheduler is needed.
 */
function runTeammateLocally(ticketKey, rule, effectiveConfig) {
    var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
    // isLocal=true marks the encoded config with customParams.localTeammate=true so
    // any autoStartReview/autoStartRework chaining triggered by this job's postJSAction
    // (see js/common/autoStart.js) keeps running on this machine instead of dispatching
    // a GitHub Actions workflow_dispatch that can't see this checkout's in-flight state.
    var encodedConfig = buildEncodedConfigModule.buildEncodedConfig(ticketKey, rule, effectiveConfig, true);

    var projectKey = rule.projectKey || '';
    if (!projectKey && effectiveConfig && effectiveConfig._configPath) {
        var cp = effectiveConfig._configPath;
        var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
        if (base && base !== 'config') projectKey = base;
    }

    var scriptPath = rule.localTeammateScript || 'agents/scripts/run-teammate-local.sh';
    // Write the encoded config to a temp file rather than inlining it as a CLI argument —
    // avoids shell-escaping a large/multiline JSON blob (the script reads it back with $(cat ...)).
    var encodedConfigFile = '';
    if (encodedConfig) {
        var safeTicket = ticketKey.replace(/[^A-Za-z0-9_-]/g, '_');
        encodedConfigFile = '.dmtools/local-run-encoded-config-' + safeTicket + '.json';
        try {
            file_write({ path: encodedConfigFile, content: encodedConfig });
        } catch (e) {
            console.warn('  ⚠️  Could not write encoded config file: ' + (e.message || e));
            encodedConfigFile = '';
        }
    }

    // config.git.baseBranch (project override) takes precedence over rule.baseBranch;
    // run-teammate-local.sh itself defaults to "main" when --base-branch is omitted,
    // which silently breaks on any project whose default branch is named differently
    // (e.g. "master") — always pass it explicitly when we know it.
    var baseBranch = (effectiveConfig && effectiveConfig.git && effectiveConfig.git.baseBranch)
        || rule.baseBranch || '';

    var cmd = 'bash ' + scriptPath +
        ' --config-file ' + resolvedCf +
        ' --ticket ' + ticketKey +
        (encodedConfigFile ? ' --encoded-config-file ' + encodedConfigFile : '') +
        (projectKey ? ' --project-key ' + projectKey : '') +
        (baseBranch ? ' --base-branch ' + baseBranch : '');

    console.log('  🖥️  [local] ' + cmd);

    var ok = true;
    try {
        cli_execute_command({ command: cmd });
        console.log('  ✅ Local run complete for ' + ticketKey);
    } catch (e) {
        ok = false;
        console.error('  ❌ Local teammate run failed for ' + ticketKey + ': ' + (e.message || e));
    }

    if (encodedConfigFile) {
        // Bare "rm" isn't in the CLI executor's whitelist (gh, gcloud, npm, docker,
        // ansible, git, dmtools, kubectl, az, terraform, bash, yarn, aws) and throws a
        // SecurityException — wrap in "bash -c" (which is whitelisted) so this best-effort
        // temp-file cleanup doesn't log a noisy, misleading security-violation error.
        try { cli_execute_command({ command: 'bash -c "rm -f ' + encodedConfigFile + '"' }); } catch (e2) {}
    }

    return ok;
}

function moveStatus(ticketKey, targetStatus) {
    try {
        if (DRY) { console.log('  [dry] 🔀 ' + ticketKey + ' → ' + targetStatus); }
        else { jira_move_to_status({ key: ticketKey, statusName: targetStatus }); }
        console.log('  ✅ ' + ticketKey + ' → ' + targetStatus);
    } catch (e) {
        console.warn('  ⚠️  Status transition failed for ' + ticketKey + ': ' + (e.message || e));
    }
}

function hasLabel(ticket, label) {
    if (!label) return false;
    // State items from the sources are flattened ({labels: [...]}); raw Jira
    // ticket objects keep them under fields.labels.
    var labels = ticket.labels ||
        ((ticket.fields && ticket.fields.labels) ? ticket.fields.labels : []);
    return labels.indexOf(label) !== -1;
}

function normalizeLabels(singleLabel, labelList) {
    var labels = [];
    if (singleLabel) labels.push(singleLabel);
    if (Array.isArray(labelList)) {
        labelList.forEach(function(label) {
            if (label && labels.indexOf(label) === -1) labels.push(label);
        });
    }
    return labels;
}

function firstMatchingLabel(ticket, labels) {
    for (var i = 0; i < labels.length; i++) {
        if (hasLabel(ticket, labels[i])) return labels[i];
    }
    return null;
}

function addRuleLabels(ticketKey, rule) {
    normalizeLabels(rule.addLabel, rule.addLabels).forEach(function(label) {
        try {
            if (rule.source === 'github') {
                var n = /(\d+)$/.exec(String(ticketKey));
                if (n) github_add_labels({ number: parseInt(n[1], 10), labels: [label] });
            } else {
                if (DRY) { console.log('  [dry] 🏷️ ' + ticketKey + ' +' + label); }
                else { jira_add_label({ key: ticketKey, label: label }); }
            }
        } catch (e) {}
    });
}

// True when the rule's own target config (e.g. pr_review.json, pr_rework.json,
// bug_development.json) already removes this exact addLabel itself via
// customParams.removeLabel/removeLabels — i.e. the job manages the label's full
// lifecycle (add is implied by dispatch, remove happens on its own completion) and
// smAgent must not re-add it afterward. See processRule()'s localTeammate handling.
function ruleTargetSelfManagesLabel(rule) {
    var addLabels = normalizeLabels(rule.addLabel, rule.addLabels);
    if (!addLabels.length || !rule.configFile) return false;
    try {
        var raw = file_read({ path: rule.configFile });
        var targetConfig = JSON.parse(raw);
        var customParams = (targetConfig.params && targetConfig.params.customParams) || {};
        var removeLabels = normalizeLabels(customParams.removeLabel, customParams.removeLabels);
        return addLabels.some(function(label) { return removeLabels.indexOf(label) !== -1; });
    } catch (e) {
        return false;
    }
}

function removeRuleLabel(ticketKey, label, rule) {
    if (!ticketKey || !label) return;
    try {
        if (rule && rule.source === 'github') {
            var n = /(\d+)$/.exec(String(ticketKey));
            if (n) github_remove_label({ number: parseInt(n[1], 10), labels: [label] });
        } else {
            if (DRY) { console.log('  [dry] 🏷️ ' + ticketKey + ' -' + label); }
            else { jira_remove_label({ key: ticketKey, label: label }); }
        }
        console.log('  🏷️  Removed stale trigger label "' + label + '" from ' + ticketKey);
    } catch (e) {
        console.warn('  ⚠️  Could not remove stale trigger label "' + label + '" from ' + ticketKey + ': ' + (e.message || e));
    }
}

function normalizePositiveInt(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    var normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
}

// ─── Local execution ──────────────────────────────────────────────────────────

function runLocalAction(jsPath, ticket, agentParams) {
    // CWD portability: agents/ prefix present when running from the parent
    // repo, absent when running from the agents checkout root — try both.
    var actionCode = file_read({ path: jsPath });
    if ((!actionCode || !actionCode.trim()) && jsPath.indexOf('agents/') === 0) {
        actionCode = file_read({ path: jsPath.substring('agents/'.length) });
    }
    if ((!actionCode || !actionCode.trim()) && jsPath.indexOf('agents/') !== 0) {
        actionCode = file_read({ path: 'agents/' + jsPath });
    }
    if (!actionCode || !actionCode.trim()) throw new Error('Cannot read: ' + jsPath);

    var configCode = file_read({ path: 'agents/js/config.js' });
    if (!configCode || !configCode.trim()) configCode = file_read({ path: 'js/config.js' });
    if (!configCode || !configCode.trim()) throw new Error('Cannot read: config.js');

    var scmCode = file_read({ path: 'agents/js/common/scm.js' });
    if (!scmCode || !scmCode.trim()) scmCode = file_read({ path: 'js/common/scm.js' });
    if (!scmCode || !scmCode.trim()) throw new Error('Cannot read: common/scm.js');

    var configLoaderCode = file_read({ path: 'agents/js/configLoader.js' });
    if (!configLoaderCode || !configLoaderCode.trim()) configLoaderCode = file_read({ path: 'js/configLoader.js' });

    var script =
        '(function() {\n' +
        '  var _cm = { exports: {} };\n' +
        '  (function(module, exports) {\n' + configCode + '\n  })(_cm, _cm.exports);\n' +
        '  var _scm = { exports: {} };\n' +
        '  (function(module, exports, require) {\n' + scmCode + '\n  })(_scm, _scm.exports, function(id) { return _cm.exports; });\n' +
        '  var _cl = { exports: {} };\n' +
        (configLoaderCode ?
        '  (function(module, exports, require) {\n' + configLoaderCode + '\n  })(_cl, _cl.exports, function(id) { return id.indexOf("scm.js") !== -1 ? _scm.exports : _cm.exports; });\n' :
        '') +
        '  var _am = { exports: {} };\n' +
        '  (function(module, exports, require) {\n' + actionCode + '\n  })(\n' +
        '    _am, _am.exports,\n' +
        '    function(id) {\n' +
        '      if (id === "./configLoader.js" || id === "./configLoader") return _cl.exports;\n' +
        '      if (id.indexOf("scm.js") !== -1) return _scm.exports;\n' +
        '      return _cm.exports;\n' +
        '    }\n' +
        '  );\n' +
        '  return _am.exports;\n' +
        '})()';

    var exported = eval(script);
    if (!exported || typeof exported.action !== 'function') {
        throw new Error('No action() exported from: ' + jsPath);
    }
    return exported.action({ ticket: ticket, jobParams: agentParams });
}

function processRuleLocally(rule, globalRepoInfo, ruleIndex) {
    if (DRY) {
        console.log('\n══ [LOCAL·DRY] ' + (rule.description || ('Rule #' + (ruleIndex + 1))) + ' ══');
        console.log('  [dry] local execution skipped');
        return { processedKeys: [], skippedKeys: [] };
    }
    var effectiveConfig = loadRuleConfig(rule);
    var interpolatedJql = configLoader.interpolateJql(rule.jql, effectiveConfig);
    var effectiveRepoInfo = globalRepoInfo || {};

    var label = rule.description || ('Rule #' + (ruleIndex + 1));
    console.log('\n══ [LOCAL] ' + label + ' ══');
    if (rule.source && rule.source !== 'jira') {
        console.log('   Query[' + rule.source + ']: ' + JSON.stringify(rule.query || {}) +
            (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
    } else {
        console.log('   JQL: ' + interpolatedJql + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
    }

    if (rule.enabled === false) {
        console.log('  ⏸️  Rule disabled — skipping');
        return { processedKeys: [], skippedKeys: [] };
    }

    var needsJqlLocal = !rule.source || rule.source === 'jira';
    if ((needsJqlLocal ? !rule.jql : !rule.query) || !rule.configFile) {
        console.warn('  ⚠️  Skipping rule — ' + (needsJqlLocal ? 'jql' : 'query') +
            ' and configFile are required');
        return { processedKeys: [], skippedKeys: [] };
    }

    var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
    var agentConfig = null;
    var cfCandidates = [resolvedCf];
    // CWD portability: the config may sit in an agents/ checkout root while
    // we run from the parent repo (or vice versa) — try both layouts.
    if (resolvedCf.indexOf('agents/') === 0) cfCandidates.push(resolvedCf.substring('agents/'.length));
    else cfCandidates.push('agents/' + resolvedCf.replace(/^agents\//, ''));
    for (var ci = 0; ci < cfCandidates.length && !agentConfig; ci++) {
        try {
            var raw = file_read({ path: cfCandidates[ci] });
            if (raw && raw.trim()) agentConfig = JSON.parse(raw);
        } catch (e) { /* try next layout */ }
    }
    if (!agentConfig) {
        console.error('  ❌ Cannot read/parse configFile: ' + resolvedCf);
        return { processedKeys: [], skippedKeys: [] };
    }

    var agentParams = agentConfig.params || {};
    var postJSActionPath = agentParams.postJSAction;
    // The rule's target repo rides the job params (config.repository wins over
    // any value in the agent JSON) — local actions must never fall back to the
    // git remote of this checkout (dmtools-agents when SM runs from it).
    agentParams = Object.assign({}, agentParams, {
        repository: (effectiveConfig.repository && effectiveConfig.repository.owner)
            ? effectiveConfig.repository
            : { owner: effectiveRepoInfo.owner, repo: effectiveRepoInfo.repo }
    });

    if (!postJSActionPath) {
        console.warn('  ⚠️  No postJSAction in ' + resolvedCf + ' — cannot run locally');
        return { processedKeys: [], skippedKeys: [] };
    }

    var tickets = [];
    try {
        var sourceMod = smSource.resolve(rule);
        tickets = sourceMod.query(rule, {
            config: effectiveConfig, repoInfo: effectiveRepoInfo, jql: interpolatedJql,
            machineAuthor: machineAuthorModule.resolveMachineAuthor(
                RUN_JOB_PARAMS, effectiveConfig)
        }) || [];
    } catch (e) {
        console.error('  ❌ state query failed: ' + (e.message || e));
        throw e;
    }

    if (typeof rule.limit === 'number' && tickets.length > rule.limit) {
        console.log('  Limiting from ' + tickets.length + ' to ' + rule.limit + ' ticket(s)');
        tickets = tickets.slice(0, rule.limit);
    }

    if (tickets.length === 0) {
        console.log('  No tickets found.');
        return { processedKeys: [], skippedKeys: [] };
    }

    console.log('  Found ' + tickets.length + ' ticket(s) — running locally via ' + postJSActionPath);

    var processedKeys = [];
    var skippedKeys = [];

    tickets.forEach(function(ticket) {
        var key = ticket.key;

        var skipLabel = firstMatchingLabel(ticket, normalizeLabels(rule.skipIfLabel, rule.skipIfLabels));
        if (skipLabel) {
            // Local execution is synchronous — there is never an in-flight
            // workflow run between ticks, so a surviving lock label means the
            // previous local action crashed: recover and retry.
            if (shouldRecoverStaleTriggerLabel(rule, skipLabel)) {
                console.log('  ♻️  ' + key + ' has stale lock ' + skipLabel + ' (local run finished) — recovering');
                removeRuleLabel(key, skipLabel, rule);
            } else {
                console.log('  ⏭️  ' + key + ' skipped (label: ' + skipLabel + ')');
                skippedKeys.push(key);
                return;
            }
        }

        if (rule.targetStatus) {
            moveStatus(key, rule.targetStatus);
        }

        var fullTicket;
        try {
            var ticketRaw = jira_get_ticket(key);
            fullTicket = (typeof ticketRaw === 'string') ? JSON.parse(ticketRaw) : ticketRaw;
            if (!fullTicket || !fullTicket.key) throw new Error('Empty ticket returned');
        } catch (e) {
            console.warn('  ⚠️  jira_get_ticket(' + key + ') failed (' + e + '), falling back to search-result data');
            fullTicket = ticket;
            if (!fullTicket || !fullTicket.key) {
                console.error('  ❌ Search-result fallback also has no key for ' + key);
                return;
            }
        }

        try {
            console.log('  ▶️  ' + key + ' → ' + postJSActionPath);
            var result = runLocalAction(postJSActionPath, fullTicket, agentParams);
            console.log('  ✅ ' + key + ' done — action: ' + (result && result.action || JSON.stringify(result).substring(0, 80)));
            processedKeys.push(key);

            addRuleLabels(key, rule);
        } catch (e) {
            console.error('  ❌ Local execution failed for ' + key + ': ' + (e.message || e));
        }
    });

    return { processedKeys: processedKeys, skippedKeys: skippedKeys };
}

// ─── Rule processor ───────────────────────────────────────────────────────────

// Run context (set once per action() invocation): PR-lifecycle
// localActions read the silent/source tokens from here (#687).
var RUN_JOB_PARAMS = {};

function processRule(rule, globalRepoInfo, ruleIndex, workflowBudget) {
    if (rule.localExecution) {
        return processRuleLocally(rule, globalRepoInfo, ruleIndex);
    }

    // localTeammate runs synchronously in-process — the workflow cap only bounds
    // concurrent/outstanding GitHub Actions dispatches, so it applies neither
    // here nor to localActions (inline curl/API calls, no dispatch).
    if (!rule.localTeammate && !rule.localAction && workflowBudget && workflowBudget.remaining <= 0) {
        var skippedLabel = rule.description || ('Rule #' + (ruleIndex + 1));
        var workflowFile = rule.workflowFile || 'ai-teammate.yml';
        console.log('\n══ ' + skippedLabel + ' ══');
        console.log('  ⏭️  Global workflow cap reached (' + workflowBudget.initial + ') — skipping rule');
        logBlockingWorkflowRuns(workflowBudget, workflowFile);
        return { processedKeys: [], skippedKeys: [] };
    }

    // Load per-rule config if rule.configPath is set; otherwise use global projectConfig.
    // This enables multi-project orchestration: each rule can target a different project.
    var effectiveConfig = loadRuleConfig(rule);

    // Effective repo: rule config > global config > globalRepoInfo fallback
    var effectiveOwner = (effectiveConfig.repository && effectiveConfig.repository.owner) || globalRepoInfo.owner;
    var effectiveRepo  = (effectiveConfig.repository && effectiveConfig.repository.repo)  || globalRepoInfo.repo;
    var effectiveRepoInfo = { owner: effectiveOwner, repo: effectiveRepo };

    // Bridge-free checks: refresh tick-stamped validation verdicts BEFORE
    // this rule's source reads the rollup, so green/red rules see the
    // dispatched run's conclusion in the same tick (owner 2026-09-23).
    if (rule.source === 'github' && (rule.query || {}).type === 'pr') {
        try {
            // stampValidationChecksFor hoists within processRule's scope.
            syncValidationChecks(effectiveRepoInfo, stampValidationChecksFor);
        } catch (e) {
            console.warn('  ⚠️  validation-check sync failed: ' + (e.message || e));
        }
    }

    // JQL interpolation per rule using effectiveConfig (so {jiraProject} resolves correctly per project)
    var interpolatedJql = configLoader.interpolateJql(rule.jql, effectiveConfig);

    var label = rule.description || ('Rule #' + (ruleIndex + 1));
    console.log('\n══ ' + label + ' ══');
    if (rule.source && rule.source !== 'jira') {
        var qdesc = JSON.stringify(rule.query || {});
        console.log('   Query[' + rule.source + ']: ' + qdesc + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
    } else {
        console.log('   JQL: ' + interpolatedJql + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
    }

    if (rule.enabled === false) {
        console.log('  ⏸️  Rule disabled — skipping');
        return { processedKeys: [], skippedKeys: [] };
    }

    // Source-aware requirement check: classic rules need jql; github rules
    // need a query object. configFile is required by both.
    var needsJql = !rule.source || rule.source === 'jira';
    // GitHub rules with explicit rule.inputs pin the runner via workflow
    // inputs (issue/leg) — configFile is only mandatory for the classic
    // config_file dispatch shape. localAction rules (close-on-merge) need
    // neither: they act directly, no dispatch happens.
    if ((needsJql ? !rule.jql : !rule.query) || (!rule.configFile && !rule.inputs && !rule.localAction)) {
        console.warn('  ⚠️  Skipping rule — ' + (needsJql ? 'jql' : 'query') +
            ' and configFile (or inputs) are required');
        return { processedKeys: [], skippedKeys: [] };
    }

    var tickets = [];
    try {
        var sourceMod = smSource.resolve(rule);
        tickets = sourceMod.query(rule, {
            config: effectiveConfig, repoInfo: effectiveRepoInfo, jql: interpolatedJql,
            machineAuthor: machineAuthorModule.resolveMachineAuthor(
                RUN_JOB_PARAMS, effectiveConfig)
        }) || [];
    } catch (e) {
        console.error('  ❌ state query failed: ' + (e.message || e));
        throw e;
    }

    // Computed once per rule (not per ticket) — see ruleTargetSelfManagesLabel() and its
    // use in the localTeammate branch below.
    var ruleSelfManagesLabel = rule.localTeammate && ruleTargetSelfManagesLabel(rule);
    if (ruleSelfManagesLabel) {
        console.log('  ℹ️  Target job self-manages "' + (rule.addLabel || rule.addLabels) +
            '" — smAgent will not re-add it after a local run');
    }

    var ruleLimit = (typeof rule.limit === 'number' && rule.limit > 0) ? Math.floor(rule.limit) : null;
    var effectiveLimit = ruleLimit;
    // The workflow budget caps concurrent AI-RUN dispatches. localActions
    // (update_branch, validate_pr, merge_pr, complete_validation, close_issue,
    // fail_validation, unarm_validation, conflict_rework)
    // run inline curl/API calls — they neither start workflows nor compete
    // for dispatch slots, so the budget must not throttle them (live bug:
    // one active review run zeroed the budget and silent-update-behind
    // freshened exactly ONE of four behind PRs per tick).
    var budgetCapped = !rule.localTeammate && !rule.localAction;
    if (workflowBudget && budgetCapped) {
        effectiveLimit = effectiveLimit === null
            ? workflowBudget.remaining
            : Math.min(effectiveLimit, workflowBudget.remaining);
    }

    if (effectiveLimit !== null && tickets.length > effectiveLimit) {
        console.log('  Will trigger up to ' + effectiveLimit + ' ticket(s) after skipping active/stale labels');
    }

    if (tickets.length === 0) {
        console.log('  No tickets found.');
        return { processedKeys: [], skippedKeys: [] };
    }

    console.log('  Found ' + tickets.length + ' ticket(s)');

    var processedKeys = [];
    var skippedKeys   = [];

    for (var idx = 0; idx < tickets.length; idx++) {
        if (!rule.localTeammate && !rule.localAction && workflowBudget && workflowBudget.remaining <= 0) {
            break;
        }
        if (effectiveLimit !== null && processedKeys.length >= effectiveLimit) {
            break;
        }
        var ticket = tickets[idx];
        var key = ticket.key;

        var skipLabel = firstMatchingLabel(ticket, normalizeLabels(rule.skipIfLabel, rule.skipIfLabels));
        if (skipLabel) {
            // Stale-label recovery is based on inspecting active GitHub Actions runs — not
            // meaningful for localTeammate (there is no async run to inspect); just skip.
            if (!rule.localTeammate && shouldRecoverStaleTriggerLabel(rule, skipLabel)) {
                var workflowFile = rule.workflowFile || 'ai-teammate.yml';
                var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
                var scm = createTargetScm(effectiveConfig, effectiveRepoInfo);
                var activeKey = rule.concurrencyKey || key;
                if (hasActiveTargetWorkflowRun(scm, workflowFile, resolvedCf, activeKey)) {
                    skippedKeys.push(key);
                    continue;
                }
                console.log('  ♻️  ' + key + ' has ' + skipLabel + ' but no active workflow — recovering stale trigger label');
                removeRuleLabel(key, skipLabel, rule);
            } else {
                console.log('  ⏭️  ' + key + ' skipped (label: ' + skipLabel + ')');
                skippedKeys.push(key);
                continue;
            }
        }

        // localAction rules act directly on the source (no workflow dispatch,
        // no AI runner) — e.g. close-on-merge finishing the cycle. Idempotency
        // comes from the query itself: issues are searched with is:open, so a
        // closed issue never matches again.
        if (rule.localAction === 'close_issue') {
            try {
                github_close_issue({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.issueNumber
                });
                console.log('  ✅ ' + key + ' issue #' + ticket.issueNumber +
                    ' closed (linked PR #' + ticket.prNumber + ' merged)');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ close_issue failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'mark_developed') {
            // Machine-loop backfill: the dev leg opened a green PR but the
            // post-action labeling it grew up with is Jira-only, so GitHub
            // issues linger in `in progress` and the review rule (which
            // gates on ai_developed) never fires. The SM itself detects
            // the completed-development shape (issue in progress + OPEN
            // green PR) and labels the ISSUE — self-healing every stuck
            // ticket on the first tick after deploy, no manual backfill.
            try {
                github_add_labels({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.issueNumber,
                    labels: ['ai_developed']
                });
                console.log('  ✅ ' + key + ' issue #' + ticket.issueNumber +
                    ' labeled ai_developed (green PR #' + ticket.prNumber + ')');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ mark_developed failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'arm_review') {
            // Stale-verdict re-review (PR #690): the review's
            // CHANGES_REQUESTED was pinned to an older commit; fixes were
            // pushed and checks went green. Re-arm agent:review on the PR
            // — review-on-label dispatches the runner, the runner consumes
            // the label and re-reviews the current head. The fresh verdict
            // carries the head's commit_id, so the stale query never
            // matches it again (convergent, no loop).
            try {
                github_add_labels({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber,
                    labels: ['agent:review']
                });
                console.log('  ✅ ' + key + ' agent:review re-armed (stale CHANGES_REQUESTED on PR #' + ticket.prNumber + ')');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ arm_review failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        // Silent branch refresh = a git merge push, NOT the GitHub
        // update-branch APIs. Live-verified dead ends for
        // github-actions[bot]: the GraphQL mutation (gh pr update-branch)
        // is denied regardless of token scopes, and the REST endpoint is
        // PUT-only (PATCH 404s) yet still 403s the bot with "user doesn't
        // have permission to update head repository". A plain git push on
        // the runner's checkout IS allowed with the workflow token — and
        // workflow-token pushes trigger no workflows, which is the whole
        // point of the silent path. The merge aborts on conflicts (a DIRTY
        // PR is skipped with an error, the correct semantics).
        function silentUpdateBranch(branchName) {
            // The reconcile job's working directory is the dmtools-agents
            // engine checkout (live: `git fetch origin` there fetched
            // dmtools-agents and every PR pathspec 404'd) — clone the
            // TARGET repo instead. `gh repo clone` rides GH_TOKEN; with
            // the workflow token that push is silent (a PAT in its place
            // would fire CI — do not point silent-token at a PAT).
            var dir = '/tmp/sm-silent-update-' + Date.now() + '-' +
                      String(branchName).replace(/[^a-zA-Z0-9._-]/g, '_');
            cli_execute_command({
                command: 'gh repo clone ' + effectiveRepoInfo.owner + '/' +
                         effectiveRepoInfo.repo + ' ' + dir +
                         ' -- --no-tags --single-branch --branch ' + branchName +
                         ' --depth 200' +
                         ' && cd ' + dir +
                         ' && git fetch --no-tags --depth 200 origin main' +
                         // Skip when main is already contained: two ticks racing
                         // on the same branch produced a branch-into-itself
                         // merge commit (dart gh-191, 14:08) that moved the head
                         // past a green validation for no reason.
                         ' && ! git merge-base --is-ancestor FETCH_HEAD HEAD' +
                         ' || exit 0' +
                         ' && git -c user.name=sm-silent-update' +
                         ' -c user.email=sm-silent-update@users.noreply.github.com' +
                         ' merge --no-edit FETCH_HEAD' +
                         // The anonymous clone of a public repo carries no
                         // push credentials ("could not read Username" —
                         // live). Push via a one-off token URL: sh expands
                         // ${GH_TOKEN} from the child env (the workflow
                         // token there), and the token never appears in
                         // this script or the logged command line.
                         ' && git push https://x-access-token:${GH_TOKEN}@github.com/' +
                         effectiveRepoInfo.owner + '/' + effectiveRepoInfo.repo +
                         '.git ' + branchName
            });
        }

        // Validation trigger (dispatch-only CI): no push ever fires CI on
        // its own — the SM is the only trigger. The PAT update-branch dance
        // (a source-token push DOES fire CI) is retired: a workflow_dispatch
        // run lands directly on the branch head, needs no actor checks, and
        // branch freshness stays with silent-update-behind (the validate
        // rules already exclude BEHIND PRs). The CI workflow file is a
        // per-repo knob: rule.ciWorkflow > jobParams.ciWorkflow (factory-sm
        // `ci-workflow` input) > 'quality.yml'.
        function dispatchCiWorkflow(branchName) {
            var ciWorkflow = rule.ciWorkflow ||
                ((RUN_JOB_PARAMS || {}).ciWorkflow) || 'quality.yml';
            cli_execute_command({
                command: 'gh workflow run ' + ciWorkflow +
                         ' --repo ' + effectiveRepoInfo.owner + '/' +
                         effectiveRepoInfo.repo + ' --ref ' + branchName
            });
        }

        // ── Bridge-free validation checks (owner 2026-09-23) ──────────────
        // "sm стартанул триггер... ушел спать" — the tick IS the mirror. No
        // ci-gate waiter jobs burning runner slots for 85 minutes: when the
        // caller configures jobParams.validationChecks (JSON array of the
        // branch-protection required check names), the SM stamps those
        // checks itself — in_progress right after the dispatch (below) and
        // the dispatched run's verdict on every subsequent pass (see
        // syncValidationChecks, hooked ahead of each PR rule's source
        // query). Repos without the knob keep the bridge architecture.
        function stampValidationChecksFor(headSha, status, conclusion, runUrl) {
            var names = validationCheckNames();
            if (!names || !headSha) return;
            names.forEach(function (checkName) {
                if (DRY) {
                    console.log('  🧪 [dry] stamp "' + checkName + '" ' +
                                status + (conclusion ? '/' + conclusion : ''));
                    return;
                }
                try {
                    github_create_check_run({
                        workspace: effectiveRepoInfo.owner,
                        repository: effectiveRepoInfo.repo,
                        name: checkName,
                        headSha: headSha,
                        status: status,
                        conclusion: conclusion || undefined,
                        title: 'SM validation' + (conclusion ? (': ' + conclusion) : ' (tick-dispatched)'),
                        summary: runUrl ? ('Dispatched run: ' + runUrl)
                                        : 'Stamped by the SM tick (bridge-free mode).'
                    });
                } catch (e) {
                    console.warn('  ⚠️  stamp "' + checkName + '" on ' +
                                 String(headSha).slice(0, 7) + ': ' + (e.message || e));
                }
            });
        }

        // ── PR-lifecycle localActions (issue #687: the SM owns the loop) ──
        // They act on the PR directly (type:pr rules; ticket.prNumber set,
        // ticket.issueNumber null). Idempotency comes from the query guards:
        // each action flips exactly the fact its rule filtered on.

        if (rule.localAction === 'update_branch') {
            // Open PR behind main → silent refresh via a git merge push on
            // the runner checkout (workflow-token pushes trigger no
            // workflows → the CI matrix does not re-run).
            if (!ticket.branch) {
                console.error('  ❌ update_branch: no head branch on ' + key + ' — skipped');
                continue;
            }
            try {
                silentUpdateBranch(ticket.branch);
                console.log('  ✅ ' + key + ' branch silently updated (no CI)');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ update_branch failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'validate_pr') {
            // Dispatch the CI workflow on the head branch and arm the
            // ai_validating marker. Pre- and post-approval validation share
            // this action: pre-review (validate-fresh) latches ai_validated
            // on green; post-approval (validate-armed, sticky pr_approved)
            // merges on green. A dispatch failure leaves the marker un-armed
            // — the next tick retries (self-healing).
            if (!ticket.branch) {
                console.error('  ❌ validate_pr: no head branch on ' + key + ' — skipped');
                continue;
            }
            try {
                dispatchCiWorkflow(ticket.branch);
                var vHead = (ticket.pr && ticket.pr.headSha) || ticket.headSha;
                if (vHead) {
                    stampValidationChecksFor(vHead, 'in_progress', null, null);
                }
                github_add_labels({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber,
                    labels: ['ai_validating']
                });
                console.log('  🧪 ' + key + ' validation dispatched (CI runs on the head via workflow_dispatch)');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ validate_pr failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'unarm_validation') {
            // Validated-but-stale: ai_validating armed, validation green, but
            // base moved before the merge tick (mergeState BEHIND/BLOCKED).
            // silent-update-behind excludes ai_validating and merge-validated
            // needs CLEAN — without this unarm the PR deadlocks (live: fa
            // pr-744). Drop the marker; next ticks: silent refresh → merge
            // window re-validates the fresh head (422-arm covers the
            // already-fresh case) → merge.
            try {
                github_remove_label({
                    workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber, label: 'ai_validating'
                });
                console.log('  🔓 ' + key + ' unarmed (validated head went stale) — refresh + re-validate follows');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ unarm_validation failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'conflict_rework') {
            // Owner rule 2026-09-21: a machine PR whose branch CONFLICTS with
            // main (silent-update's git merge cannot land; mergeState DIRTY)
            // must not sit in the queue forever — send it to rework: the
            // agent resolves the conflicts and pushes, then the normal
            // validate → (pr_approved sticky) merge flow resumes. Guests get
            // the report only (same owner rule as fail_validation: rework is
            // machine-author-only). Once per head: a conflict-marker comment
            // carrying the current head sha means this head was already
            // reported+armed.
            try {
                var headSha = (ticket.pr && ticket.pr.headSha) || null;
                if (!headSha) {
                    try {
                        var cpr = github_get_pr({
                            workspace: effectiveRepoInfo.owner,
                            repository: effectiveRepoInfo.repo,
                            pullRequestId: ticket.prNumber
                        });
                        var cprObj = typeof cpr === 'string' ? JSON.parse(cpr) : (cpr || {});
                        headSha = (cprObj.head && (cprObj.head.sha || cprObj.head)) || null;
                    } catch (e5) { /* stays null — dedup degrades to marker-only */ }
                }
                var marker = '⚠️ Merge conflict with main';
                var alreadyReported = false;
                try {
                    var commentsRaw = github_get_pr_comments({
                        workspace: effectiveRepoInfo.owner,
                        repository: effectiveRepoInfo.repo,
                        pullRequestId: ticket.prNumber
                    });
                    var commentsObj = typeof commentsRaw === 'string' ? JSON.parse(commentsRaw) : (commentsRaw || []);
                    var commentList = Array.isArray(commentsObj)
                        ? commentsObj
                        : (commentsObj.comments || commentsObj.items || []);
                    alreadyReported = commentList.some(function (c) {
                        var b = String((c && c.body) || '');
                        return b.indexOf(marker) !== -1 &&
                            (!headSha || b.indexOf(String(headSha)) !== -1);
                    });
                } catch (e6) { /* read failed — treat as not reported */ }
                if (alreadyReported) {
                    console.log('  ⏭️  ' + key + ' conflict already reported for head — waiting on rework');
                    processedKeys.push(key);
                    continue;
                }
                try {
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                } catch (e7) { /* absent label is fine */ }
                var cMachineAuthor = machineAuthorModule.resolveMachineAuthor(RUN_JOB_PARAMS, effectiveConfig);
                var cIsMachinePr = !!cMachineAuthor && !!ticket.author &&
                    String(ticket.author).toLowerCase() === String(cMachineAuthor).toLowerCase();
                var cLinked = null;
                if (cIsMachinePr) {
                    try {
                        var bodyRaw = github_get_pr({
                            workspace: effectiveRepoInfo.owner,
                            repository: effectiveRepoInfo.repo,
                            pullRequestId: ticket.prNumber
                        });
                        var bodyObj = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : (bodyRaw || {});
                        var cm = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String(bodyObj.body || ''));
                        if (cm) cLinked = parseInt(cm[1], 10);
                    } catch (e8) { console.warn('  ⚠️ linked-issue lookup failed: ' + (e8.message || e8)); }
                    if (!cLinked && ticket.branch) {
                        var cbm = /(?:^|\/)gh-(\d+)$/i.exec(String(ticket.branch));
                        if (cbm) cLinked = parseInt(cbm[1], 10);
                    }
                }
                var cReport = cIsMachinePr
                    ? (marker + ' — the silent branch update could not merge main (conflict).' +
                       (headSha ? ' (head `' + headSha + '`)' : '') +
                       (cLinked ? ' Rework re-queued (linked issue #' + cLinked + ' re-armed): resolve the conflicts and push — validation re-runs automatically.' : ' Rework re-queued: resolve the conflicts and push — validation re-runs automatically.') +
                       ' (approval latch kept — no re-review after the fix)')
                    : (marker + ' — the silent branch update could not merge main (conflict).' +
                       (headSha ? ' (head `' + headSha + '`)' : '') +
                       ' Guest PR: rebase onto main and push — validation re-runs automatically; auto-rework is reserved for the machine account.');
                github_create_comment({
                    workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber, body: cReport
                });
                if (cIsMachinePr && cLinked) {
                    github_add_labels({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: cLinked, labels: ['agent:rework']
                    });
                }
                console.log('  🔁 ' + key + ' merge conflict with main — ' +
                    (cIsMachinePr ? 'rework re-queued' + (cLinked ? ' (issue #' + cLinked + ')' : '') : 'guest PR, report only'));
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ conflict_rework failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'merge_pr') {
            // Validated green + CLEAN + APPROVED → squash-merge, then clear
            // the armed markers. ai_validating no longer implies armed
            // (pre-review validation uses the same marker): verify the
            // sticky pr_approved latch on the PR itself — an un-approved
            // green head latches ai_validated and defers to review instead
            // of merging (defense in depth for the rule guards).
            try {
                var gateRaw = github_get_pr({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    pullRequestId: ticket.prNumber
                });
                var gatePr = {};
                try {
                    gatePr = typeof gateRaw === 'string' ? JSON.parse(gateRaw) : (gateRaw || {});
                } catch (gateParseErr) { gatePr = {}; }
                var gateLabels = (gatePr.labels || []).map(function (l) {
                    return (l && l.name) || l;
                });
                if (gateLabels.indexOf('pr_approved') === -1) {
                    // Pre-review validation green: latch, unarm, review
                    // follows (review-after-dev requires ai_validated).
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                    github_add_labels({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, labels: ['ai_validated']
                    });
                    console.log('  ✅ ' + key + ' validated (no approval yet) — ai_validated latched, review follows');
                    processedKeys.push(key);
                    continue;
                }
                var mergeRaw = github_merge_pr({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber,
                    mergeMethod: 'squash'
                });
                // The HTTP layer returns the raw body for error statuses
                // (Java parity) — a 405 "not mergeable" arrives as
                // {"merged": false, ...} with NO thrown error (live: fa
                // pr-753 — the merge was refused, the SM still cleared
                // pr_approved/ai_validating and logged "squash-merged",
                // orphaning the armed PR). Anything but an explicit
                // merged:true is a failure: keep the markers so the loop
                // self-heals (unarm-stale → refresh → re-validate → retry).
                var mergeResp = {};
                try {
                    mergeResp = typeof mergeRaw === 'string' ? JSON.parse(mergeRaw) : (mergeRaw || {});
                } catch (parseErr) { /* non-JSON body counts as refusal */ }
                if (mergeResp.merged !== true) {
                    throw new Error('merge refused: ' +
                        (typeof mergeRaw === 'string' ? mergeRaw : JSON.stringify(mergeRaw)));
                }
                try {
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'pr_approved'
                    });
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validated'
                    });
                } catch (e2) { /* absent labels are fine post-merge */ }
                console.log('  🎉 ' + key + ' squash-merged');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ merge_pr failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'complete_validation') {
            // Pre-review validation green (not CLEAN-armed, not approved):
            // latch ai_validated, unarm ai_validating — review-after-dev
            // dispatches the review leg on the latched head. Idempotent by
            // the query guard (only fires while ai_validating is armed).
            try {
                github_remove_label({
                    workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber, label: 'ai_validating'
                });
                github_add_labels({
                    workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber, labels: ['ai_validated']
                });
                console.log('  ✅ ' + key + ' validation green — ai_validated latched, review follows');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ complete_validation failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'fail_validation') {
            // Validation CI went red: unarm, tell the PR, and requeue the
            // machine loop by re-arming agent:rework on the linked issue
            // (the existing rework-on-red-ci rule picks it up). External
            // PRs without a linked issue get the report only.
            // Owner rule 2026-09-21: auto-REWORK is machine-author-ONLY.
            // Accounts other than the machine login are guests: they get
            // review + validation and NEVER a rework arm (they fix their
            // own findings; the SM re-validates on their push). A guest
            // "fixes #<n>" body must not arm rework on a machine ticket.
            try {
                try {
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                } catch (e3) { /* absent label is fine */ }
                var machineAuthor = machineAuthorModule.resolveMachineAuthor(RUN_JOB_PARAMS, effectiveConfig);
                var isMachinePr = !!machineAuthor && !!ticket.author &&
                    String(ticket.author).toLowerCase() === String(machineAuthor).toLowerCase();
                var linked = null;
                if (isMachinePr) {
                    try {
                        var prRaw = github_get_pr({
                            workspace: effectiveRepoInfo.owner,
                            repository: effectiveRepoInfo.repo,
                            pullRequestId: ticket.prNumber
                        });
                        var prObj = typeof prRaw === 'string' ? JSON.parse(prRaw) : (prRaw || {});
                        var m = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String(prObj.body || ''));
                        if (m) linked = parseInt(m[1], 10);
                    } catch (e4) { console.warn('  ⚠️ linked-issue lookup failed: ' + (e4.message || e4)); }
                    // Fallback (live: fa pr-750 — body said "Fixes the Play Store
                    // rejection (gh-746)", no closing keyword): machine PRs carry
                    // the issue in the branch name (ai/gh-<n>). Guest branches
                    // get nothing — the owner rule keeps auto-rework
                    // machine-only, so the fallback must be too.
                    if (!linked && ticket.branch) {
                        var bm = /(?:^|\/)gh-(\d+)$/i.exec(String(ticket.branch));
                        if (bm) linked = parseInt(bm[1], 10);
                    }
                }
                // pr_approved is STICKY (owner rule 2026-09: no re-review
                // after the first approval — review tokens are the budget).
                // Validation red post-approval re-arms rework only; the
                // fixed head re-validates via validate-armed and merges —
                // the reviewer never re-fires. Pre-review red also skips
                // this block: no approval exists to unarm. (Supersedes the
                // fa pr-750 unarm fix: the validate↔fail burn it patched is
                // now closed by the latch itself.)
                var report = isMachinePr
                    ? ('⚠️ Validation CI went red on the head — merge aborted, rework re-queued.' +
                       (linked ? ' (linked issue #' + linked + ' re-armed)' : '') +
                       ' (approval latch kept — no re-review after fixes)')
                    : '⚠️ Validation CI went red on the head. Guest PR: fix the findings and push — ' +
                      'validation re-runs automatically; auto-rework is reserved for the machine account.';
                github_create_comment({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber,
                    body: report
                });
                if (isMachinePr && linked) {
                    github_add_labels({
                        workspace: effectiveRepoInfo.owner,
                        repository: effectiveRepoInfo.repo,
                        number: linked,
                        labels: ['agent:rework']
                    });
                }
                console.log('  🔁 ' + key + ' validation failed — ' +
                    (isMachinePr ? 'rework re-queued' + (linked ? ' (issue #' + linked + ')' : '') : 'guest PR, report only'));
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ fail_validation failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.targetStatus) {
            if (!rule.localTeammate && isWorkflowBudgetExhausted(rule, effectiveConfig, workflowBudget, effectiveRepoInfo)) {
                console.log('  ⏭️  ' + key + ' skipped before transition (global workflow cap reached: ' + workflowBudget.initial + ')');
                break;
            }
            moveStatus(key, rule.targetStatus);
        }

        // localTeammate runs the *entire* job (checkout, AI CLI, postJSAction) synchronously
        // before returning here — unlike the async workflow_dispatch path, there is no in-flight
        // gap left to guard once it returns. Jobs whose own customParams already
        // remove/removeLabels this exact addLabel (pr_review, pr_rework, bug_development, ...)
        // are trusted to manage it themselves — e.g. clearing it on completion so the next
        // review<->rework cycle can re-trigger. Re-adding it here afterward would immediately
        // stomp on that cleanup and permanently stick the ticket, since local rules have no
        // stale-label recovery. Only add it when the target job does *not* already self-manage it.
        var triggered = rule.localTeammate
            ? runTeammateLocally(key, rule, effectiveConfig)
            : triggerWorkflow(effectiveRepoInfo, key, rule, effectiveConfig, workflowBudget, ticket);

        if (triggered && !ruleSelfManagesLabel) addRuleLabels(key, rule);

        // consumeLabels: the matched label IS the request (e.g. agent:rework
        // on a PR — a human's manual rework ask on any author). Consume it on
        // dispatch or every later tick re-fires; the issue-anchored runner's
        // customParams.removeLabels only reaches the ISSUE's labels, never
        // the PR's. Reuses the stale-label removal primitive (no-op in DRY).
        if (triggered && rule.consumeLabels) {
            normalizeLabels(null, rule.consumeLabels).forEach(function (label) {
                removeRuleLabel(key, label, rule);
            });
        }

        if (triggered) {
            processedKeys.push(key);
            if (!rule.localTeammate && workflowBudget) workflowBudget.remaining -= 1;
        }
    }

    return { processedKeys: processedKeys, skippedKeys: skippedKeys };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function resolveWorkflowCap(jsonCap, projectCfg) {
    // Priority: config.smMaxWorkflows (from .dmtools/config.js) > sm.json default
    if (projectCfg && typeof projectCfg.smMaxWorkflows !== 'undefined') {
        var n = normalizePositiveInt(projectCfg.smMaxWorkflows);
        if (n) { console.log('  Workflow cap override (config.smMaxWorkflows): ' + n); return n; }
    }
    return normalizePositiveInt(jsonCap);
}


// Patches rules from project config smRuleOverrides, matched by rule id
// (github rules carry stable ids) or configFile (jira rules).
function applyRuleOverrides(rules, overrides) {
    if (!overrides || typeof overrides !== 'object') return rules;
    return rules.map(function(rule) {
        var patch = overrides[rule.id] || overrides[rule.configFile];
        if (!patch) return rule;
        var patched = {};
        Object.keys(rule).forEach(function(k) { patched[k] = rule[k]; });
        Object.keys(patch).forEach(function(k) { patched[k] = patch[k]; });
        console.log('SM Agent: Patched rule "' + (rule.id || rule.description || rule.configFile) + '" with override:', JSON.stringify(patch));
        return patched;
    });
}

// ── Bridge-free validation checks (owner 2026-09-23) ──────────────────
// Shared helpers for tick-stamped checks. parseMcp parity: bridge tools
// may return decoded objects, JSON strings, or {data:…} envelopes.
function mcpParse(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

function validationCheckNames() {
    var raw = (RUN_JOB_PARAMS || {}).validationChecks;
    if (!raw) return null;
    if (Array.isArray(raw)) return raw.length ? raw : null;
    if (typeof raw === 'string') {
        try {
            var arr = JSON.parse(raw);
            return (Array.isArray(arr) && arr.length) ? arr : null;
        } catch (e) { return null; }
    }
    return null;
}

// One sync per repo per tick-process (the hook fires per PR rule; a
// short window stops repeat API passes inside a single tick).
var validationCheckSync = { repo: null, at: 0 };

// Refresh the stamped validation checks for every ai_validating PR in the
// repo from the newest dispatched ci runs (CANCELLED is never a verdict —
// gh-191; newest terminal non-cancelled run decides, else newest active).
function syncValidationChecks(repoInfo, stampFn) {
    if (!validationCheckNames() || !repoInfo || !repoInfo.owner || !repoInfo.repo) return;
    var repoKey = repoInfo.owner + '/' + repoInfo.repo;
    var now = Date.now();
    if (validationCheckSync.repo === repoKey && (now - validationCheckSync.at) < 5000) return;
    validationCheckSync = { repo: repoKey, at: now };
    var ciWorkflow = ((RUN_JOB_PARAMS || {}).ciWorkflow) || 'quality.yml';
    var prs = mcpParse(github_list_prs({
        workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open'
    }));
    var prList = Array.isArray(prs) ? prs :
        ((prs && (prs.pullRequests || prs.data || prs.items)) || []);
    var armed = prList.filter(function (pr) {
        return pr.head && pr.head.sha && pr.head.ref &&
            (pr.labels || []).some(function (l) {
                return (l && l.name) === 'ai_validating';
            });
    });
    if (!armed.length) return;
    var runs = mcpParse(github_list_workflow_runs({
        workflowId: ciWorkflow, perPage: 50
    })) || {};
    var runList = runs.workflow_runs || runs.workflowRuns || [];
    armed.forEach(function (pr) {
        var headSha = pr.head.sha;
        // REST lists newest-first; only THIS head's dispatched runs count.
        var mine = runList.filter(function (r) {
            return r.event === 'workflow_dispatch' && r.head_sha === headSha;
        });
        if (!mine.length) return; // dispatch not landed; validate_pr stamps
        var active = mine.filter(function (r) {
            return r.status === 'queued' || r.status === 'in_progress' ||
                   r.status === 'waiting' || r.status === 'pending';
        });
        var terminal = mine.filter(function (r) {
            return r.status === 'completed' && r.conclusion &&
                   r.conclusion !== 'cancelled';
        });
        if (terminal.length) {
            var t = terminal[0];
            stampFn(headSha, 'completed',
                    t.conclusion === 'success' ? 'success' : 'failure',
                    t.html_url);
        } else if (active.length) {
            stampFn(headSha, 'in_progress', null, active[0].html_url);
        }
    });
}

function action(params) {
    var p     = params.jobParams || params;
    RUN_JOB_PARAMS = p;    DRY = p.dryRun === true;
    if (DRY) console.log('🧪 DRY RUN — no side effects will be performed');
    var rules = p.rules;

    // Load global project configuration (used as default when rules have no configPath)
    projectConfig = configLoader.loadProjectConfig(p);

    var configuredWorkflowCap = resolveWorkflowCap(
        typeof p.maxTriggeredWorkflows !== 'undefined' ? p.maxTriggeredWorkflows : p.maxWorkflowsPerRun,
        projectConfig
    );
    var workflowBudget = configuredWorkflowCap ? { initial: configuredWorkflowCap, remaining: configuredWorkflowCap } : null;

    // Use smRules from config if provided (full override)
    if (projectConfig.smRules && Array.isArray(projectConfig.smRules) && projectConfig.smRules.length > 0) {
        console.log('SM Agent: Using smRules override from project config (' + projectConfig.smRules.length + ' rules)');
        rules = projectConfig.smRules;
    }

    // Apply smRuleOverrides from project config — patches individual rules by
    // id (github rules) or configFile (jira rules). Example in .dmtools/config.js:
    //   smRuleOverrides: {
    //     'rework-on-red-ci':            { enabled: false },
    //     'merge-approved-fifo':         { limit: 2 },
    //     'agents/bulk_bugs_creation.json': { enabled: true }
    //   }
    rules = applyRuleOverrides(rules, projectConfig.smRuleOverrides);

    // Global "run everything locally" override — set via a CLI JSON override, e.g.:
    //   dmtools run agents/sm.json '{"params":{"jobParams":{"forceLocalTeammate":true}}}'
    // NOTE the outer "params" wrapper: `dmtools run <file> <override>` deep-merges the
    // override into the whole {name, params} job config object, not directly into
    // params.jobParams — a bare {"jobParams":{...}} override (missing the "params"
    // wrapper) is silently ignored, no error, jobParams just stays at sm.json's defaults.
    // Forces every default-dispatch rule to run through the local teammate pipeline
    // (as if it had localTeammate:true) instead of a GitHub Actions workflow_dispatch —
    // no env var needed; dmtools' own CLI JSON-override mechanism is the switch. Rules
    // already using localExecution:true (pure-JS, no checkout/AI CLI) are left untouched.
    // A rule can opt out even while the override is
    // active by setting `localTeammate: false` explicitly.
    if (p.forceLocalTeammate && rules) {
        var forcedCount = 0;
        rules = rules.map(function(rule) {
            if (rule.localExecution || rule.localTeammate === false || rule.localTeammate) {
                return rule;
            }
            forcedCount++;
            var forced = {};
            Object.keys(rule).forEach(function(k) { forced[k] = rule[k]; });
            forced.localTeammate = true;
            return forced;
        });
        console.log('SM Agent: forceLocalTeammate override active — ' + forcedCount +
            ' rule(s) switched from dispatch to local execution');
    }

    // Targeted mode: bypass all JQL rules and dispatch a single agent to a single ticket.
    // Activated when targetTicket + targetAgent are present in jobParams (or encoded_config override).
    // Finds the existing rule for targetAgent (respecting smRules/smRuleOverrides) and inherits all
    // its properties (localExecution, concurrencyKey, addLabel, etc.) — only the JQL is replaced.
    // Idempotency skip labels are stripped so targeted runs always proceed regardless of prior state.
    var targetTicket = p.targetTicket;
    var targetAgent  = p.targetAgent;
    if (targetTicket && targetAgent) {
        console.log('SM Agent: Targeted mode — ticket: ' + targetTicket + ', agent: ' + targetAgent);

        var matchedRule = null;
        if (rules) {
            var normalizeAgent = function(cf) { return cf ? cf.replace(/^agents\//, '') : ''; };
            var normalizedTarget = normalizeAgent(targetAgent);
            for (var ri = 0; ri < rules.length; ri++) {
                if (normalizeAgent(rules[ri].configFile) === normalizedTarget) {
                    matchedRule = rules[ri];
                    break;
                }
            }
        }

        var targetedRule;
        if (matchedRule) {
            targetedRule = {};
            Object.keys(matchedRule).forEach(function(k) { targetedRule[k] = matchedRule[k]; });
            targetedRule.jql = 'key = ' + targetTicket;
            targetedRule.description = 'Targeted: ' + targetAgent + ' for ' + targetTicket;
            delete targetedRule.skipIfLabel;
            delete targetedRule.skipIfLabels;
            console.log('  Found matching rule — inheriting localExecution=' + (!!targetedRule.localExecution) +
                ', concurrencyKey=' + (targetedRule.concurrencyKey || targetTicket));
        } else {
            console.log('  No matching rule found for ' + targetAgent + ' — using minimal synthetic rule');
            // Read localExecution from the agent config so agents with localExecution:true
            // run directly in the SM job (skipping the ai-teammate checkout pipeline).
            var agentLocalExecution = false;
            try {
                var agentRaw = file_read({ path: targetAgent });
                if (agentRaw) {
                    var agentJsonParsed = JSON.parse(agentRaw);
                    if (agentJsonParsed && agentJsonParsed.params && agentJsonParsed.params.localExecution === true) {
                        agentLocalExecution = true;
                    }
                }
            } catch (e) {
                console.warn('  Could not read agent config to detect localExecution:', e);
            }
            targetedRule = {
                description: 'Targeted: ' + targetAgent + ' for ' + targetTicket,
                jql: 'key = ' + targetTicket,
                configFile: targetAgent,
                enabled: true,
                localExecution: agentLocalExecution
            };
            if (agentLocalExecution) {
                console.log('  Agent config has localExecution:true — will run locally (no checkout pipeline)');
            }
        }

        rules = [targetedRule];
        workflowBudget = null; // no cap for explicit single-ticket runs
    }

    if (!rules || rules.length === 0) {
        console.error('❌ No rules defined in jobParams.rules or project config');
        return { success: false, error: 'No rules defined' };
    }

    // Global repo fallback: used by rules that don't specify their own configPath.
    // Accepts split owner/repo fields or a combined "owner/repo" string (the
    // SM_REPO=github.repository shape used by the sm.yml template).
    var owner = (projectConfig.repository.owner) || p.owner;
    var repo  = (projectConfig.repository.repo)  || p.repo;
    if ((!owner || !repo) && typeof repo === 'string' && repo.indexOf('/') !== -1) {
        var seg = repo.split('/');
        owner = owner || seg[0];
        repo = seg[1];
    }

    if (!owner || !repo) {
        console.error('❌ Repository owner and repo are required (set in .dmtools/config.js or jobParams)');
        return { success: false, error: 'Missing owner or repo' };
    }

    var globalRepoInfo = { owner: owner, repo: repo };
    console.log('SM Agent — ' + globalRepoInfo.owner + '/' + globalRepoInfo.repo + ' (' + rules.length + ' rules)');
    if (projectConfig.jira.project) {
        console.log('  Jira project: ' + projectConfig.jira.project);
    }
    if (workflowBudget) {
        console.log('  Workflow cap per run: ' + workflowBudget.initial);
    }

    // NOTE: JQL interpolation is now done per-rule inside processRule using each rule's
    // effective config. Rules with configPath get their own {jiraProject}/{parentTicket} resolved.

    var allProcessedKeys = [];
    var allSkippedKeys   = [];

    rules.forEach(function(rule, i) {
        var result = processRule(rule, globalRepoInfo, i, workflowBudget);
        allProcessedKeys = allProcessedKeys.concat(result.processedKeys);
        allSkippedKeys   = allSkippedKeys.concat(result.skippedKeys);
    });

    console.log('\n══ SM Agent complete — processed: ' + allProcessedKeys.length + ' ' +
        (allProcessedKeys.length ? '[' + allProcessedKeys.join(', ') + ']' : '') +
        ', skipped: ' + allSkippedKeys.length +
        (allSkippedKeys.length ? ' [' + allSkippedKeys.join(', ') + ']' : '') + ' ══');

    return {
        success: true,
        processed: allProcessedKeys.length,
        skipped: allSkippedKeys.length,
        processedKeys: allProcessedKeys,
        skippedKeys: allSkippedKeys
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, applyRuleOverridesForTest: applyRuleOverrides };
}
