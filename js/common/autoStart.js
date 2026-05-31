var scmModule = require('./scm.js');
var STALE_NON_RUNNING_WORKFLOW_MS = 6 * 60 * 60 * 1000;

function deriveProjectKey(customParams) {
    if (!customParams) return '';
    if (customParams.projectKey) return customParams.projectKey;
    var cp = customParams.configPath || '';
    if (!cp) return '';
    var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
    return (base && base !== 'config') ? base : '';
}

function buildAutoStartEncodedConfig(ticketKey, customParams, stripKeys) {
    var p = { inputJql: 'key = ' + ticketKey };

    if (customParams) {
        var nextCustomParams = Object.assign({}, customParams);
        (stripKeys || []).forEach(function(key) {
            delete nextCustomParams[key];
        });
        if (Object.keys(nextCustomParams).length > 0) {
            p.customParams = nextCustomParams;
        }
    }

    return encodeURIComponent(JSON.stringify({ params: p }));
}

function parseWorkflowRuns(raw) {
    if (!raw) return [];
    try {
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) return parsed;
        return parsed.workflow_runs || [];
    } catch (e) {
        console.warn('autoStart: failed to parse workflow runs:', e.message || e);
        return [];
    }
}

function hasActiveTargetRun(scm, configFile, ticketKey, workflowFile) {
    var expectedName = configFile + ' : ' + ticketKey;
    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];

    for (var i = 0; i < statuses.length; i++) {
        var runsRaw = null;
        try {
            runsRaw = scm.listWorkflowRuns(statuses[i], workflowFile, 50);
        } catch (e) {
            console.warn('autoStart: could not list ' + statuses[i] + ' workflow runs:', e.message || e);
            continue;
        }

        var runs = parseWorkflowRuns(runsRaw);
        for (var j = 0; j < runs.length; j++) {
            var run = runs[j] || {};
            if (isStaleNonRunningWorkflowRun(run, statuses[i])) continue;
            var name = run.display_title || run.displayTitle || run.name || '';
            if (name === expectedName) {
                console.log('autoStart: skipped duplicate ' + expectedName + ' because run #' +
                    (run.run_number || run.runNumber || run.id || '?') + ' is ' + (run.status || statuses[i]));
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

function normalizePositiveInt(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    var normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
}

function countActiveWorkflowRuns(scm, workflowFile) {
    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];
    var seen = {};
    var count = 0;

    for (var i = 0; i < statuses.length; i++) {
        var runsRaw = null;
        try {
            runsRaw = scm.listWorkflowRuns(statuses[i], workflowFile, 50);
        } catch (e) {
            console.warn('autoStart: could not count ' + statuses[i] + ' workflow runs:', e.message || e);
            continue;
        }

        var runs = parseWorkflowRuns(runsRaw);
        for (var j = 0; j < runs.length; j++) {
            var run = runs[j] || {};
            if (isStaleNonRunningWorkflowRun(run, statuses[i])) continue;
            var id = run.id || run.databaseId || run.run_number || ((run.display_title || run.displayTitle || run.name || '') + ':' + j + ':' + statuses[i]);
            if (!seen[id]) {
                seen[id] = true;
                count += 1;
            }
        }
    }

    return count;
}

function resolveActiveWorkflowCap(options) {
    var explicitCap = normalizePositiveInt(options.maxActiveWorkflows);
    if (explicitCap) return explicitCap;
    return normalizePositiveInt(options.config && options.config.smMaxWorkflows);
}

function isGlobalWorkflowCapReached(scm, workflowFile, options) {
    var cap = resolveActiveWorkflowCap(options || {});
    if (!cap) return false;

    var activeCount = countActiveWorkflowRuns(scm, workflowFile);
    if (activeCount >= cap) {
        console.log('autoStart: skipped workflow trigger because ' + activeCount +
            ' active workflow run(s) reached global cap ' + cap);
        return true;
    }

    return false;
}

function triggerConfiguredWorkflowForTicket(options) {
    var ticketKey = options.ticketKey;
    var customParams = options.customParams || {};
    var config = options.config || {};
    var configFile = options.configFile;
    var workflowFile = options.workflowFile || 'ai-teammate.yml';
    var ref = options.ref || 'main';
    var label = options.label || configFile || workflowFile;
    var stripKeys = options.stripKeys || [];

    if (!ticketKey || !configFile) {
        console.warn('autoStart: missing ticketKey or configFile — skipping');
        return false;
    }

    var aiRepoCfg = customParams.aiRepository;
    var aiOwner = (aiRepoCfg && aiRepoCfg.owner) || (config.repository && config.repository.owner);
    var aiRepo = (aiRepoCfg && aiRepoCfg.repo) || (config.repository && config.repository.repo);

    if (!aiOwner || !aiRepo) {
        console.warn('autoStart: config.repository.owner/repo not set — skipping');
        return false;
    }

    var scm = options.scm || scmModule.createScm(config);
    var projectKey = deriveProjectKey(customParams);
    var encodedCfg = buildAutoStartEncodedConfig(ticketKey, customParams, stripKeys);

    if (isGlobalWorkflowCapReached(scm, workflowFile, {
            config: config,
            maxActiveWorkflows: options.maxActiveWorkflows
        })) {
        return false;
    }

    if (hasActiveTargetRun(scm, configFile, ticketKey, workflowFile)) {
        return false;
    }

    scm.triggerWorkflow(
        aiOwner,
        aiRepo,
        workflowFile,
        JSON.stringify({
            concurrency_key: ticketKey,
            config_file: configFile,
            encoded_config: encodedCfg,
            project_key: projectKey || ''
        }),
        ref
    );

    console.log('✅ Auto-started ' + label + ' for ' + ticketKey +
        ' [config=' + configFile + (projectKey ? ', project=' + projectKey : '') + ']');
    return true;
}

/**
 * Trigger SM Agent when the system is idle.
 *
 * Called by post-actions that do NOT have a direct autoStart configured.
 * Checks whether any other AI Teammate runs are queued/in_progress.
 * If the system is idle (≤1 active run — this one) → dispatches sm.yml
 * so SM can immediately evaluate what to do next without waiting for cron.
 *
 * options:
 *   config          — job config (needs config.repository.owner / repo)
 *   customParams    — required; smFallback=true enables this trigger (opt-in)
 *   smWorkflowFile  — SM workflow file name (default 'sm.yml')
 *   agentWorkflowFile — AI teammate workflow to check (default 'ai-teammate.yml')
 *   scm             — optional pre-built scm instance
 */
function triggerSmIfIdle(options) {
    var config = options.config || {};
    var customParams = options.customParams || {};
    var smWorkflowFile = options.smWorkflowFile || 'sm.yml';
    var agentWorkflowFile = options.agentWorkflowFile || 'ai-teammate.yml';

    if (!customParams.smFallback) {
        return false;
    }

    var aiOwner = (config.repository && config.repository.owner);
    var aiRepo = (config.repository && config.repository.repo);
    if (!aiOwner || !aiRepo) {
        console.warn('SM fallback: config.repository.owner/repo not set — skipping');
        return false;
    }

    var scm = options.scm || scmModule.createScm(config);

    var activeCount = 0;
    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];
    for (var i = 0; i < statuses.length; i++) {
        try {
            var runsRaw = scm.listWorkflowRuns(statuses[i], agentWorkflowFile, 50);
            var runs = parseWorkflowRuns(runsRaw);
            activeCount += runs.length;
        } catch (e) {
            console.warn('SM fallback: could not list ' + statuses[i] + ' runs:', e.message || e);
        }
    }

    // ≤1 means only the current (finishing) run is active
    if (activeCount > 1) {
        console.log('SM fallback: ' + activeCount + ' active agent runs — skipping SM trigger');
        return false;
    }

    try {
        scm.triggerWorkflow(aiOwner, aiRepo, smWorkflowFile, '{}', 'main');
        console.log('✅ SM fallback: system idle — triggered ' + smWorkflowFile);
        return true;
    } catch (e) {
        console.warn('SM fallback: failed to trigger ' + smWorkflowFile + ':', e.message || e);
        return false;
    }
}

module.exports = {
    deriveProjectKey: deriveProjectKey,
    buildAutoStartEncodedConfig: buildAutoStartEncodedConfig,
    triggerConfiguredWorkflowForTicket: triggerConfiguredWorkflowForTicket,
    hasActiveTargetRun: hasActiveTargetRun,
    countActiveWorkflowRuns: countActiveWorkflowRuns,
    isGlobalWorkflowCapReached: isGlobalWorkflowCapReached,
    isStaleNonRunningWorkflowRun: isStaleNonRunningWorkflowRun,
    triggerSmIfIdle: triggerSmIfIdle
};
