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

var configLoader = require('./configLoader.js');
var scmModule = require('./common/scm.js');
var buildEncodedConfigModule = require('./common/buildEncodedConfig.js');

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
            var runName = run.name || run.display_title || '';
            var matchesOldName = runName === expectedRunName;
            var matchesDisplayName = runName.indexOf(configFile + ' : ') === 0 &&
                runName.substring(runName.length - expectedRunNameSuffix.length) === expectedRunNameSuffix;
            if (matchesOldName || matchesDisplayName) {
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

function isWorkflowBudgetExhausted(rule, effectiveConfig, workflowBudget) {
    if (!workflowBudget) return false;

    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    var scm = scmModule.createScm(effectiveConfig);
    ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile);
    return workflowBudget.remaining <= 0;
}

function triggerWorkflow(repoInfo, ticketKey, rule, effectiveConfig, workflowBudget) {
    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    var workflowRef  = rule.workflowRef  || 'main';
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
        var scm = scmModule.createScm(effectiveConfig);
        ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile);
        if (workflowBudget && workflowBudget.remaining <= 0) {
            console.log('  ⏭️  ' + ticketKey + ' skipped (global workflow cap reached: ' + workflowBudget.initial + ')');
            logBlockingWorkflowRuns(workflowBudget, workflowFile);
            return false;
        }
        if (hasActiveTargetWorkflowRun(scm, workflowFile, resolvedCf, concurrencyKey)) {
            return false;
        }
        scm.triggerWorkflow(
            repoInfo.owner,
            repoInfo.repo,
            workflowFile,
            JSON.stringify({
                concurrency_key: concurrencyKey,
                display_key:     ticketKey,
                input_jql:       'key = ' + ticketKey,
                config_file:     resolvedCf,
                encoded_config:  buildEncodedConfigModule.buildEncodedConfig(ticketKey, rule, effectiveConfig),
                project_key:     projectKey
            }),
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
    var encodedConfig = buildEncodedConfigModule.buildEncodedConfig(ticketKey, rule, effectiveConfig);

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

    var cmd = 'bash ' + scriptPath +
        ' --config-file ' + resolvedCf +
        ' --ticket ' + ticketKey +
        (encodedConfigFile ? ' --encoded-config-file ' + encodedConfigFile : '') +
        (projectKey ? ' --project-key ' + projectKey : '');

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
        try { cli_execute_command({ command: 'rm -f ' + encodedConfigFile }); } catch (e2) {}
    }

    return ok;
}

function moveStatus(ticketKey, targetStatus) {
    try {
        jira_move_to_status({ key: ticketKey, statusName: targetStatus });
        console.log('  ✅ ' + ticketKey + ' → ' + targetStatus);
    } catch (e) {
        console.warn('  ⚠️  Status transition failed for ' + ticketKey + ': ' + (e.message || e));
    }
}

function hasLabel(ticket, label) {
    if (!label) return false;
    var labels = (ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
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
        try { jira_add_label({ key: ticketKey, label: label }); } catch (e) {}
    });
}

function removeRuleLabel(ticketKey, label) {
    if (!ticketKey || !label) return;
    try {
        jira_remove_label({ key: ticketKey, label: label });
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
    var actionCode = file_read({ path: jsPath });
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
    var effectiveConfig = loadRuleConfig(rule);
    var interpolatedJql = configLoader.interpolateJql(rule.jql, effectiveConfig);

    var label = rule.description || ('Rule #' + (ruleIndex + 1));
    console.log('\n══ [LOCAL] ' + label + ' ══');
    console.log('   JQL: ' + interpolatedJql + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));

    if (rule.enabled === false) {
        console.log('  ⏸️  Rule disabled — skipping');
        return { processedKeys: [], skippedKeys: [] };
    }

    if (!rule.jql || !rule.configFile) {
        console.warn('  ⚠️  Skipping rule — jql and configFile are required');
        return { processedKeys: [], skippedKeys: [] };
    }

    var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
    var agentConfig;
    try {
        var raw = file_read({ path: resolvedCf });
        agentConfig = JSON.parse(raw);
    } catch (e) {
        console.error('  ❌ Cannot read/parse configFile: ' + resolvedCf + ' — ' + e);
        return { processedKeys: [], skippedKeys: [] };
    }

    var agentParams = agentConfig.params || {};
    var postJSActionPath = agentParams.postJSAction;

    if (!postJSActionPath) {
        console.warn('  ⚠️  No postJSAction in ' + resolvedCf + ' — cannot run locally');
        return { processedKeys: [], skippedKeys: [] };
    }

    var tickets = [];
    try {
        tickets = jira_search_by_jql({ jql: interpolatedJql, fields: ['key', 'labels'] }) || [];
    } catch (e) {
        console.error('  ❌ Jira query failed: ' + (e.message || e));
        return { processedKeys: [], skippedKeys: [] };
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
            console.log('  ⏭️  ' + key + ' skipped (label: ' + skipLabel + ')');
            skippedKeys.push(key);
            return;
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

function processRule(rule, globalRepoInfo, ruleIndex, workflowBudget) {
    if (rule.localExecution) {
        return processRuleLocally(rule, globalRepoInfo, ruleIndex);
    }

    // localTeammate runs synchronously in-process — the workflow cap only bounds
    // concurrent/outstanding GitHub Actions dispatches, so it doesn't apply here.
    if (!rule.localTeammate && workflowBudget && workflowBudget.remaining <= 0) {
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

    // JQL interpolation per rule using effectiveConfig (so {jiraProject} resolves correctly per project)
    var interpolatedJql = configLoader.interpolateJql(rule.jql, effectiveConfig);

    var label = rule.description || ('Rule #' + (ruleIndex + 1));
    console.log('\n══ ' + label + ' ══');
    console.log('   JQL: ' + interpolatedJql + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));

    if (rule.enabled === false) {
        console.log('  ⏸️  Rule disabled — skipping');
        return { processedKeys: [], skippedKeys: [] };
    }

    if (!rule.jql || !rule.configFile) {
        console.warn('  ⚠️  Skipping rule — jql and configFile are required');
        return { processedKeys: [], skippedKeys: [] };
    }

    var tickets = [];
    try {
        tickets = jira_search_by_jql({ jql: interpolatedJql, fields: ['key', 'labels'] }) || [];
    } catch (e) {
        console.error('  ❌ Jira query failed: ' + (e.message || e));
        return { processedKeys: [], skippedKeys: [] };
    }

    var ruleLimit = (typeof rule.limit === 'number' && rule.limit > 0) ? Math.floor(rule.limit) : null;
    var effectiveLimit = ruleLimit;
    if (workflowBudget && !rule.localTeammate) {
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
        if (!rule.localTeammate && workflowBudget && workflowBudget.remaining <= 0) {
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
                var scm = scmModule.createScm(effectiveConfig);
                var activeKey = rule.concurrencyKey || key;
                if (hasActiveTargetWorkflowRun(scm, workflowFile, resolvedCf, activeKey)) {
                    skippedKeys.push(key);
                    continue;
                }
                console.log('  ♻️  ' + key + ' has ' + skipLabel + ' but no active workflow — recovering stale trigger label');
                removeRuleLabel(key, skipLabel);
            } else {
                console.log('  ⏭️  ' + key + ' skipped (label: ' + skipLabel + ')');
                skippedKeys.push(key);
                continue;
            }
        }

        if (rule.targetStatus) {
            if (!rule.localTeammate && isWorkflowBudgetExhausted(rule, effectiveConfig, workflowBudget)) {
                console.log('  ⏭️  ' + key + ' skipped before transition (global workflow cap reached: ' + workflowBudget.initial + ')');
                break;
            }
            moveStatus(key, rule.targetStatus);
        }

        var triggered = rule.localTeammate
            ? runTeammateLocally(key, rule, effectiveConfig)
            : triggerWorkflow(effectiveRepoInfo, key, rule, effectiveConfig, workflowBudget);

        if (triggered) addRuleLabels(key, rule);

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

function action(params) {
    var p     = params.jobParams || params;
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

    // Apply smRuleOverrides from project config — patches individual rules by configFile
    // Example in .dmtools/config.js:
    //   smRuleOverrides: {
    //     'agents/bug_creation.json':      { enabled: false },
    //     'agents/bulk_bugs_creation.json': { enabled: true }
    //   }
    if (projectConfig.smRuleOverrides && typeof projectConfig.smRuleOverrides === 'object') {
        var overrides = projectConfig.smRuleOverrides;
        rules = rules.map(function(rule) {
            var patch = overrides[rule.configFile];
            if (!patch) return rule;
            var patched = {};
            Object.keys(rule).forEach(function(k) { patched[k] = rule[k]; });
            Object.keys(patch).forEach(function(k) { patched[k] = patch[k]; });
            console.log('SM Agent: Patched rule "' + (rule.description || rule.configFile) + '" with override:', JSON.stringify(patch));
            return patched;
        });
    }

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

    // Global repo fallback: used by rules that don't specify their own configPath
    var owner = (projectConfig.repository.owner) || p.owner;
    var repo  = (projectConfig.repository.repo)  || p.repo;

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
    module.exports = { action: action };
}
