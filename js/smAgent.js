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
 *   projectKey     (optional) — value passed as the `project_key` workflow input so the runner
 *                               activates the correct project-specific dependency setup (e.g. "mapc",
 *                               "bice"). Auto-derived from configPath basename when not set
 *                               (e.g. ".dmtools/configs/mapc.js" → "mapc").
 *   skipIfLabel    (optional) — skip ticket if it already has this label (idempotency)
 *   skipIfLabels   (optional) — skip ticket if it already has any of these labels
 *   addLabel       (optional) — add this label after triggering (idempotency marker)
 *   addLabels      (optional) — add these labels after triggering
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

    // Derive project key to resolve project-specific agent JSON (e.g. "agents/pr_review.json" → "ai_teammate/mapc/pr_review.json")
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

function triggerWorkflow(repoInfo, ticketKey, rule, effectiveConfig) {
    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    var workflowRef  = rule.workflowRef  || 'main';
    var resolvedCf   = resolveConfigFile(rule, effectiveConfig);

    // Resolve project_key: explicit rule field takes priority, then auto-derive from configPath
    // e.g. ".dmtools/configs/mapc.js" → "mapc", ".dmtools/configs/bice.js" → "bice"
    var projectKey = rule.projectKey || '';
    if (!projectKey && effectiveConfig && effectiveConfig._configPath) {
        var cp = effectiveConfig._configPath;
        var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
        if (base && base !== 'config') projectKey = base;
    }

    try {
        var scm = scmModule.createScm(effectiveConfig);
        scm.triggerWorkflow(
            repoInfo.owner,
            repoInfo.repo,
            workflowFile,
            JSON.stringify({
                concurrency_key: ticketKey,
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

// ─── Local execution ──────────────────────────────────────────────────────────

function runLocalAction(jsPath, ticket, agentParams) {
    var actionCode = file_read({ path: jsPath });
    if (!actionCode || !actionCode.trim()) throw new Error('Cannot read: ' + jsPath);

    var configCode = file_read({ path: 'agents/js/config.js' });
    if (!configCode || !configCode.trim()) throw new Error('Cannot read: agents/js/config.js');

    var scmCode = file_read({ path: 'agents/js/common/scm.js' });
    if (!scmCode || !scmCode.trim()) throw new Error('Cannot read: agents/js/common/scm.js');

    var configLoaderCode = file_read({ path: 'agents/js/configLoader.js' });

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
            console.error('  ❌ Failed to fetch ticket ' + key + ': ' + e);
            return;
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

function processRule(rule, globalRepoInfo, ruleIndex) {
    if (rule.localExecution) {
        return processRuleLocally(rule, globalRepoInfo, ruleIndex);
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

    if (typeof rule.limit === 'number' && tickets.length > rule.limit) {
        console.log('  Limiting from ' + tickets.length + ' to ' + rule.limit + ' ticket(s)');
        tickets = tickets.slice(0, rule.limit);
    }

    if (tickets.length === 0) {
        console.log('  No tickets found.');
        return { processedKeys: [], skippedKeys: [] };
    }

    console.log('  Found ' + tickets.length + ' ticket(s)');

    var processedKeys = [];
    var skippedKeys   = [];

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

        var triggered = triggerWorkflow(effectiveRepoInfo, key, rule, effectiveConfig);

        if (triggered) addRuleLabels(key, rule);

        if (triggered) processedKeys.push(key);
    });

    return { processedKeys: processedKeys, skippedKeys: skippedKeys };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function action(params) {
    var p     = params.jobParams || params;
    var rules = p.rules;

    // Load global project configuration (used as default when rules have no configPath)
    projectConfig = configLoader.loadProjectConfig(p);

    // Use smRules from config if provided (full override)
    if (projectConfig.smRules && Array.isArray(projectConfig.smRules) && projectConfig.smRules.length > 0) {
        console.log('SM Agent: Using smRules override from project config (' + projectConfig.smRules.length + ' rules)');
        rules = projectConfig.smRules;
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

    // NOTE: JQL interpolation is now done per-rule inside processRule using each rule's
    // effective config. Rules with configPath get their own {jiraProject}/{parentTicket} resolved.

    var allProcessedKeys = [];
    var allSkippedKeys   = [];

    rules.forEach(function(rule, i) {
        var result = processRule(rule, globalRepoInfo, i);
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
