/**
 * SM Agent — Scrum Master automation (JSRunner)
 *
 * Reads an array of rules from params.rules (defined in agents/sm.json)
 * and for each rule:
 *   1. Queries Jira by rule.jql (with {jiraProject}/{parentTicket} interpolation)
 *   2. Optionally transitions each ticket to rule.targetStatus
 *   3. Triggers an ai-teammate GitHub Actions workflow for each ticket
 *      OR executes the postJSAction locally (if localExecution: true)
 *
 * Configuration:
 *   Loads project config from .dmtools/config.js (via configLoader).
 *   If config.smRules is provided, uses those instead of params.rules (full override).
 *   Repository owner/repo from config override params when present.
 *   JQL placeholders {jiraProject} and {parentTicket} are resolved from config.
 *   jobParams.maxTriggeredWorkflows (or maxWorkflowsPerRun) limits total active plus newly
 *   dispatched workflows across all non-local rules.
 *   Override priority: config.smMaxWorkflows (from .dmtools/config.js) > sm.json value.
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
 */

var configLoader = require('./configLoader.js');
var scmModule = require('./common/scm.js');

// Project config loaded once in action() — used as global default for rules without configPath
var projectConfig = null;

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

function buildEncodedConfig(ticketKey, rule, effectiveConfig) {
    var p = { inputJql: 'key = ' + ticketKey };
    var resolvedCf = resolveConfigFile(rule, effectiveConfig);

    // Derive project key to resolve project-specific agent JSON (e.g. "agents/pr_review.json" → "ai_teammate/myproject/pr_review.json")
    var projectKey = rule.projectKey || '';
    if (!projectKey && effectiveConfig && effectiveConfig._configPath) {
        var cp = effectiveConfig._configPath;
        var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
        if (base && base !== 'config') projectKey = base;
    }

    // Load target agent's customParams and include them in encoded_config so they survive
    // regardless of whether dmtools merges or replaces customParams at the job level.
    if (resolvedCf) {
        var agentJsonPath = resolvedCf;
        if (projectKey) {
            var filename = resolvedCf.replace(/^.*\//, '');
            var projectSpecific = 'ai_teammate/' + projectKey + '/' + filename;
            try {
                var testRaw = file_read({ path: projectSpecific });
                if (testRaw) agentJsonPath = projectSpecific;
            } catch (e) { /* file not found — use generic path */ }
        }
        try {
            var agentJson = JSON.parse(file_read({ path: agentJsonPath }));
            var agentParamsRoot = agentJson.params || {};
            Object.keys(agentParamsRoot).forEach(function(paramKey) {
                var value = agentParamsRoot[paramKey];
                if (typeof value === 'string' &&
                    (value.indexOf('{jiraProject}') !== -1 || value.indexOf('{parentTicket}') !== -1)) {
                    p[paramKey] = configLoader.interpolateJql(value, effectiveConfig);
                }
            });
            var agentParams = (agentJson.params || {}).agentParams;
            if (agentParams && typeof agentParams === 'object') {
                p.agentParams = configLoader.deepMerge({}, agentParams);
            }
            var agentCustomParams = (agentJson.params || {}).customParams;
            if (agentCustomParams && typeof agentCustomParams === 'object') {
                p.customParams = Object.assign({}, agentCustomParams);
            }
        } catch (e) { /* ignore — agent JSON not readable */ }
    }

    if (effectiveConfig && resolvedCf) {
        var agentName = extractAgentName(resolvedCf);
        var resolved = configLoader.resolveInstructions(agentName, null, effectiveConfig);

        if (resolved.instructionsOverridden) {
            if (!p.agentParams) p.agentParams = {};
            p.agentParams.instructions = resolved.instructions;
        }
        if (resolved.additionalInstructions && resolved.additionalInstructions.length > 0) {
            p.additionalInstructions = resolved.additionalInstructions;
        }
        if (resolved.cliPrompts && resolved.cliPrompts.length > 0) {
            p.cliPrompts = resolved.cliPrompts;
        }
        if (resolved.cliPrompt) {
            p.cliPrompt = resolved.cliPrompt;
        }
        if (resolved.agentParamPatch) {
            if (!p.agentParams) p.agentParams = {};
            p.agentParams = configLoader.deepMerge(p.agentParams, resolved.agentParamPatch);
        }
        if (resolved.jobParamPatch) {
            p = configLoader.deepMerge(p, resolved.jobParamPatch);
        }

        // Inject project-specific field name overrides from jira.fields config
        var jiraFields = effectiveConfig.jira && effectiveConfig.jira.fields;
        if (jiraFields) {
            var fieldMap = {
                'story_acceptance_criteria': jiraFields.acceptanceCriteria,
                'story_acceptance_criterias': jiraFields.acceptanceCriteria
            };
            var override = fieldMap[agentName];
            if (override) {
                p.fieldName = override;
            }
        }
    }

    // configPath from effectiveConfig always overrides — so the triggered agent also finds the project config
    if (effectiveConfig && effectiveConfig._configPath) {
        if (!p.customParams) p.customParams = {};
        p.customParams.configPath = effectiveConfig._configPath;
    }

    return encodeURIComponent(JSON.stringify({ params: p }));
}

function extractAgentName(configFile) {
    if (!configFile) return '';
    var name = configFile;
    var slashIdx = name.lastIndexOf('/');
    if (slashIdx !== -1) name = name.substring(slashIdx + 1);
    if (name.indexOf('.json') !== -1) name = name.replace('.json', '');
    return name;
}

/**
 * Resolve the full path to an agent config JSON.
 * If rule.configFile is a bare filename (no "/"), prefix with agentConfigsDir from config.
 * Example: "TestCasesGenerator.json" + agentConfigsDir "projects/alpha"
 *        → "projects/alpha/TestCasesGenerator.json"
 */
function resolveConfigFile(rule, effectiveConfig) {
    var cf = rule.configFile;
    if (!cf) return cf;
    // Already a path (contains "/") — use as-is
    if (cf.indexOf('/') !== -1) return cf;
    // Short filename — prefix with agentConfigsDir if available
    var dir = effectiveConfig && effectiveConfig.agentConfigsDir;
    if (dir) {
        return dir.replace(/\/$/, '') + '/' + cf;
    }
    return cf;
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
            var runName = run.name || run.display_title || '';
            if (runName === expectedRunName) {
                console.log('  ⏭️  ' + ticketKey + ' skipped (active workflow already exists: ' + expectedRunName + ')');
                return true;
            }
        }
    }

    return false;
}

function countActiveWorkflowRuns(scm, workflowFile) {
    if (!scm || typeof scm.listWorkflowRuns !== 'function') return 0;

    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];
    var seen = {};
    var count = 0;

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
            var id = run.id || run.databaseId || run.run_number || ((run.name || run.display_title || '') + ':' + j + ':' + statuses[i]);
            if (!seen[id]) {
                seen[id] = true;
                count += 1;
            }
        }
    }

    return count;
}

function ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile) {
    if (!workflowBudget) return;
    if (!workflowBudget.activeCountsByWorkflow) workflowBudget.activeCountsByWorkflow = {};
    if (workflowBudget.activeCountsByWorkflow[workflowFile]) return;

    var activeCount = countActiveWorkflowRuns(scm, workflowFile);
    workflowBudget.activeCount = (workflowBudget.activeCount || 0) + activeCount;
    workflowBudget.remaining = Math.max(0, workflowBudget.remaining - activeCount);
    workflowBudget.activeCountsByWorkflow[workflowFile] = true;

    if (activeCount > 0) {
        console.log('  Active workflow cap accounting: ' + activeCount + ' active, ' + workflowBudget.remaining + ' dispatch slot(s) left');
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
    var resolvedCf   = resolveConfigFile(rule, effectiveConfig);
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
                input_jql:       'key = ' + ticketKey,
                config_file:     resolvedCf,
                encoded_config:  buildEncodedConfig(ticketKey, rule, effectiveConfig),
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

    var resolvedCf = resolveConfigFile(rule, effectiveConfig);
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

    if (workflowBudget && workflowBudget.remaining <= 0) {
        var skippedLabel = rule.description || ('Rule #' + (ruleIndex + 1));
        console.log('\n══ ' + skippedLabel + ' ══');
        console.log('  ⏭️  Global workflow cap reached (' + workflowBudget.initial + ') — skipping rule');
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
    if (workflowBudget) {
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
        if (workflowBudget && workflowBudget.remaining <= 0) {
            break;
        }
        if (effectiveLimit !== null && processedKeys.length >= effectiveLimit) {
            break;
        }
        var ticket = tickets[idx];
        var key = ticket.key;

        var skipLabel = firstMatchingLabel(ticket, normalizeLabels(rule.skipIfLabel, rule.skipIfLabels));
        if (skipLabel) {
            if (shouldRecoverStaleTriggerLabel(rule, skipLabel)) {
                var workflowFile = rule.workflowFile || 'ai-teammate.yml';
                var resolvedCf = resolveConfigFile(rule, effectiveConfig);
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
            if (isWorkflowBudgetExhausted(rule, effectiveConfig, workflowBudget)) {
                console.log('  ⏭️  ' + key + ' skipped before transition (global workflow cap reached: ' + workflowBudget.initial + ')');
                break;
            }
            moveStatus(key, rule.targetStatus);
        }

        var triggered = triggerWorkflow(effectiveRepoInfo, key, rule, effectiveConfig, workflowBudget);

        if (triggered) addRuleLabels(key, rule);

        if (triggered) {
            processedKeys.push(key);
            if (workflowBudget) workflowBudget.remaining -= 1;
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
