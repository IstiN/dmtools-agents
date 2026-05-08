var scmModule = require('./scm.js');

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
    var statuses = ['queued', 'in_progress'];

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

module.exports = {
    deriveProjectKey: deriveProjectKey,
    buildAutoStartEncodedConfig: buildAutoStartEncodedConfig,
    triggerConfiguredWorkflowForTicket: triggerConfiguredWorkflowForTicket,
    hasActiveTargetRun: hasActiveTargetRun
};
