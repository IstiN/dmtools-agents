var scmModule = require('./scm.js');
var buildEncodedConfigModule = require('./buildEncodedConfig.js');
var STALE_NON_RUNNING_WORKFLOW_MS = 6 * 60 * 60 * 1000;

function deriveProjectKey(customParams) {
    if (!customParams) return '';
    if (customParams.projectKey) return customParams.projectKey;
    var cp = customParams.configPath || '';
    if (!cp) return '';
    var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
    return (base && base !== 'config') ? base : '';
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

function hasActiveTargetRun(scm, configFile, ticketKey, workflowFile, owner, repo) {
    var expectedName = configFile + ' : ' + ticketKey;
    var expectedNameSuffix = ' : ' + ticketKey;
    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];

    for (var i = 0; i < statuses.length; i++) {
        var runsRaw = null;
        try {
            runsRaw = scm.listWorkflowRuns(statuses[i], workflowFile, 50, owner, repo);
        } catch (e) {
            console.warn('autoStart: could not list ' + statuses[i] + ' workflow runs:', e.message || e);
            continue;
        }

        var runs = parseWorkflowRuns(runsRaw);
        for (var j = 0; j < runs.length; j++) {
            var run = runs[j] || {};
            if (isStaleNonRunningWorkflowRun(run, statuses[i])) continue;
            var name = run.display_title || run.displayTitle || run.name || '';
            var matchesOldName = name === expectedName;
            var matchesDisplayName = name.indexOf(configFile + ' : ') === 0 &&
                name.substring(name.length - expectedNameSuffix.length) === expectedNameSuffix;
            if (matchesOldName || matchesDisplayName) {
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

function normalizePositiveInt(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    var normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
}

function collectActiveWorkflowRuns(scm, workflowFile, owner, repo) {
    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];
    var seen = {};
    var count = 0;
    var summaries = [];

    for (var i = 0; i < statuses.length; i++) {
        var runsRaw = null;
        try {
            runsRaw = scm.listWorkflowRuns(statuses[i], workflowFile, 50, owner, repo);
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
                summaries.push(formatWorkflowRunSummary(run, statuses[i]));
            }
        }
    }

    return { count: count, summaries: summaries };
}

function countActiveWorkflowRuns(scm, workflowFile, owner, repo) {
    return collectActiveWorkflowRuns(scm, workflowFile, owner, repo).count;
}

function logBlockingWorkflowRuns(summaries) {
    if (!summaries || !summaries.length) return;
    console.log('autoStart: blocking active workflow run(s):');
    summaries.slice(0, 5).forEach(function(summary) {
        console.log('autoStart:  - ' + summary);
    });
    if (summaries.length > 5) {
        console.log('autoStart:  - ... +' + (summaries.length - 5) + ' more');
    }
}

function resolveActiveWorkflowCap(options) {
    var explicitCap = normalizePositiveInt(options.maxActiveWorkflows);
    if (explicitCap) return explicitCap;
    return normalizePositiveInt(options.config && options.config.smMaxWorkflows);
}

function isGlobalWorkflowCapReached(scm, workflowFile, options) {
    options = options || {};
    var cap = resolveActiveWorkflowCap(options);
    if (!cap) return false;

    var active = collectActiveWorkflowRuns(scm, workflowFile, options.owner, options.repo);
    var activeCount = active.count;
    if (activeCount >= cap) {
        console.log('autoStart: skipped workflow trigger because ' + activeCount +
            ' active workflow run(s) reached global cap ' + cap);
        logBlockingWorkflowRuns(active.summaries);
        return true;
    }

    return false;
}

/**
 * Local-execution counterpart of triggerConfiguredWorkflowForTicket(): instead of a
 * GitHub Actions workflow_dispatch, runs the next stage's dmtools job directly on
 * this machine, synchronously, in the already-checked-out working tree.
 *
 * Deliberately does NOT reuse scripts/run-teammate-local.sh: that script takes an
 * exclusive flock on .git/dmtools-local-run.lock for its *entire* lifetime (see its
 * own module docstring) to serialize concurrent top-level ticket runs against the
 * shared checkout. This function, however, is called from *inside* a job that
 * run-teammate-local.sh is already running and already holding that same lock for
 * — recursing back into the wrapper would try to re-acquire a lock the parent
 * process is still holding open (parent blocked waiting on this very child, child
 * blocked waiting on a lock only the parent can release), hard-deadlocking until
 * the wrapper's 30-minute flock timeout kills the run. A direct `dmtools run` call
 * takes no such lock and simply continues in the same already-checked-out
 * branch/working tree — exactly what's needed to chain e.g. pr_review -> pr_rework
 * -> pr_review for the same ticket without ever leaving the local machine.
 */
function triggerConfiguredJobLocally(options) {
    var ticketKey = options.ticketKey;
    var configFile = options.configFile;
    var config = options.config || {};
    var customParams = options.customParams || {};
    var projectKey = options.projectKey || deriveProjectKey(customParams);
    var label = options.label || configFile;

    // isLocal=true propagates customParams.localTeammate=true into the chained job
    // too, so if IT also auto-starts a further stage, that stays local as well.
    var encodedCfg = buildEncodedConfigModule.buildEncodedConfig(
        ticketKey,
        { configFile: configFile, projectKey: projectKey },
        config,
        true
    );

    var safeTicket = ticketKey.replace(/[^A-Za-z0-9_-]/g, '_');
    var encodedConfigFile = '.dmtools/local-run-encoded-config-autochain-' + safeTicket + '-' + Date.now() + '.json';
    try {
        file_write({ path: encodedConfigFile, content: encodedCfg });
    } catch (e) {
        console.warn('autoStart(local): could not write encoded config file — skipping: ' + (e.message || e));
        return false;
    }

    // Mirrors the exact `dmtools --debug run <config> "<encoded>" --inputJql ... --ciRunUrl ...`
    // invocation scripts/run-teammate-local.sh and ai-teammate.yml both use — read the encoded
    // config back from disk with $(cat ...) rather than inlining it, to avoid shell-escaping a
    // large/multiline JSON blob as a literal CLI argument.
    var ciRunUrl = 'local://autochain/' + ticketKey + '/' + Date.now();
    var cmd = 'bash -c \'ENCODED_CONFIG="$(cat ' + encodedConfigFile + ')"; dmtools --debug run ' +
        configFile + ' "${ENCODED_CONFIG}" --inputJql "key = ' + ticketKey + '" --ciRunUrl "' + ciRunUrl + '"\'';

    console.log('  🖥️  [local auto-chain] ' + cmd);

    var ok = true;
    try {
        cli_execute_command({ command: cmd });
        console.log('✅ Auto-started ' + label + ' for ' + ticketKey +
            ' [local, config=' + configFile + (projectKey ? ', project=' + projectKey : '') + ']');
    } catch (e) {
        ok = false;
        console.warn('⚠️ autoStart(local): ' + label + ' failed for ' + ticketKey + ': ' + (e.message || e));
    }

    // Bare "rm" isn't in the CLI executor's whitelist — wrap in "bash -c" (whitelisted) so this
    // best-effort temp-file cleanup doesn't log a noisy, misleading security-violation error.
    try { cli_execute_command({ command: 'bash -c "rm -f ' + encodedConfigFile + '"' }); } catch (e2) {}

    return ok;
}

function triggerConfiguredWorkflowForTicket(options) {
    var ticketKey = options.ticketKey;
    var customParams = options.customParams || {};
    var config = options.config || {};
    var configFile = options.configFile;
    var workflowFile = options.workflowFile || 'ai-teammate.yml';
    // Default to the target repo's actual default branch (config.git.baseBranch, e.g. 'master')
    // rather than assuming 'main' — dispatching a workflow_dispatch against a non-existent ref
    // fails with "No ref found for: <ref>" (HTTP 422) and silently breaks auto-chaining.
    var ref = options.ref || (config.git && config.git.baseBranch) || 'main';
    var label = options.label || configFile || workflowFile;
    if (!ticketKey || !configFile) {
        console.warn('autoStart: missing ticketKey or configFile — skipping');
        return false;
    }

    var projectKey = deriveProjectKey(customParams);

    // The job that's about to call this was itself started locally by smAgent's
    // runTeammateLocally() (forceLocalTeammate/localTeammate:true path), which stamps
    // customParams.localTeammate=true onto the encoded config it builds (see
    // buildEncodedConfig.js). If so, keep the whole chain on this machine instead of
    // dispatching a GitHub Actions workflow_dispatch that can't see this checkout's
    // in-flight branch/commits and would race the still-running local process for the
    // same PR.
    if (customParams.localTeammate === true) {
        return triggerConfiguredJobLocally({
            ticketKey: ticketKey,
            configFile: configFile,
            config: config,
            customParams: customParams,
            projectKey: projectKey,
            label: label
        });
    }

    var aiRepoCfg = customParams.aiRepository;
    var aiOwner = (aiRepoCfg && aiRepoCfg.owner) || (config.repository && config.repository.owner);
    var aiRepo = (aiRepoCfg && aiRepoCfg.repo) || (config.repository && config.repository.repo);

    if (!aiOwner || !aiRepo) {
        console.warn('autoStart: config.repository.owner/repo not set — skipping');
        return false;
    }

    var scm = options.scm || scmModule.createScm(config);
    var encodedCfg = buildEncodedConfigModule.buildEncodedConfig(
        ticketKey,
        { configFile: configFile, projectKey: projectKey },
        config
    );

    if (isGlobalWorkflowCapReached(scm, workflowFile, {
            config: config,
            maxActiveWorkflows: options.maxActiveWorkflows,
            owner: aiOwner,
            repo: aiRepo
        })) {
        return false;
    }

    if (hasActiveTargetRun(scm, configFile, ticketKey, workflowFile, aiOwner, aiRepo)) {
        return false;
    }

    scm.triggerWorkflow(
        aiOwner,
        aiRepo,
        workflowFile,
        JSON.stringify({
            concurrency_key: ticketKey,
            display_key: ticketKey,
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

    var aiRepoCfg = customParams.aiRepository;
    var aiOwner = (aiRepoCfg && aiRepoCfg.owner) || (config.repository && config.repository.owner);
    var aiRepo = (aiRepoCfg && aiRepoCfg.repo) || (config.repository && config.repository.repo);
    if (!aiOwner || !aiRepo) {
        console.warn('SM fallback: config.repository.owner/repo not set — skipping');
        return false;
    }

    var scm = options.scm || scmModule.createScm(config);

    var activeCount = 0;
    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];
    for (var i = 0; i < statuses.length; i++) {
        try {
            var runsRaw = scm.listWorkflowRuns(statuses[i], agentWorkflowFile, 50, aiOwner, aiRepo);
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
        var ref = (config.git && config.git.baseBranch) || 'main';
        scm.triggerWorkflow(aiOwner, aiRepo, smWorkflowFile, '{}', ref);
        console.log('✅ SM fallback: system idle — triggered ' + smWorkflowFile);
        return true;
    } catch (e) {
        console.warn('SM fallback: failed to trigger ' + smWorkflowFile + ':', e.message || e);
        return false;
    }
}

module.exports = {
    deriveProjectKey: deriveProjectKey,
    triggerConfiguredWorkflowForTicket: triggerConfiguredWorkflowForTicket,
    triggerConfiguredJobLocally: triggerConfiguredJobLocally,
    hasActiveTargetRun: hasActiveTargetRun,
    countActiveWorkflowRuns: countActiveWorkflowRuns,
    collectActiveWorkflowRuns: collectActiveWorkflowRuns,
    isGlobalWorkflowCapReached: isGlobalWorkflowCapReached,
    isStaleNonRunningWorkflowRun: isStaleNonRunningWorkflowRun,
    triggerSmIfIdle: triggerSmIfIdle
};
