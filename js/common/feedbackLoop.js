var DEFAULT_MAX_ATTEMPTS = 2;

function sanitizeId(value) {
    return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function writeFile(path, content) {
    file_write({ path: path, content: content });
}

function readFile(path) {
    try { return file_read({ path: path }); } catch (e) { return null; }
}

function runCommand(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function ensureFeedbackDir() {
    try { runCommand('mkdir -p outputs/feedback'); } catch (e) {}
}

function normalizeConfig(customParams, section) {
    var root = (customParams && customParams.feedbackLoop) || {};
    var scoped = (section && root[section] && typeof root[section] === 'object') ? root[section] : {};
    var merged = {};
    Object.keys(root).forEach(function(key) {
        if (typeof root[key] !== 'object' || Array.isArray(root[key])) merged[key] = root[key];
    });
    Object.keys(scoped).forEach(function(key) { merged[key] = scoped[key]; });
    return merged;
}

function isFeedbackEnabled(customParams, section) {
    var root = (customParams && customParams.feedbackLoop) || null;
    if (!root) return false;
    var scoped = (section && root[section] && typeof root[section] === 'object') ? root[section] : null;
    return root.enabled === true || (scoped && scoped.enabled === true);
}

function getAttempt(markerPath) {
    var raw = readFile(markerPath);
    var value = parseInt(raw || '0', 10);
    return isNaN(value) ? 0 : value;
}

function setAttempt(markerPath, attempt) {
    writeFile(markerPath, String(attempt));
}

function isNonRecoverable(errorText, config) {
    var text = String(errorText || '');
    var patterns = (config && config.nonRecoverablePatterns) || [
        'COPILOT_GITHUB_TOKEN',
        'GITHUB_TOKEN',
        'JIRA_API_TOKEN',
        'Bad credentials',
        'Resource not accessible by integration',
        'could not read Username',
        'Authentication failed',
        'refusing to merge unrelated histories',
        'No merge base found between HEAD and origin/'
    ];
    return patterns.some(function(pattern) {
        return text.indexOf(pattern) !== -1;
    });
}

function buildFeedbackPrompt(options) {
    return [
        'A previous automation step failed. Continue/resume the current task in the same repository and fix the root cause.',
        '',
        'Ticket: ' + (options.ticketKey || 'unknown'),
        'Stage: ' + (options.stage || 'unknown'),
        'Attempt: ' + (options.attempt || 1),
        '',
        'Error/output:',
        '```',
        String(options.error || '').substring(0, 12000),
        '```',
        '',
        'Instructions:',
        '- Inspect the current working tree and recent changes.',
        '- Fix the failure directly; do not revert unrelated user or automation changes.',
        '- Keep the implementation focused on the ticket and the failing gate/post-action.',
        '- Update outputs/response.md with what you changed and any validation you ran.',
        '- Do not push; the post-action will commit and push after you finish.'
    ].join('\n');
}

function resumeAgent(options) {
    options = options || {};
    var customParams = options.customParams || {};
    var config = normalizeConfig(customParams, options.section || 'postAction');
    if (!isFeedbackEnabled(customParams, options.section || 'postAction') || config.enabled === false) {
        return { attempted: false, reason: 'disabled' };
    }

    var maxAttempts = config.maxAttempts;
    if (maxAttempts === undefined || maxAttempts === null) maxAttempts = DEFAULT_MAX_ATTEMPTS;
    maxAttempts = parseInt(maxAttempts, 10);
    if (!maxAttempts || maxAttempts < 1) return { attempted: false, reason: 'maxAttempts=0' };

    var errorText = String(options.error || '');
    if (isNonRecoverable(errorText, config)) {
        return { attempted: false, reason: 'non-recoverable' };
    }

    ensureFeedbackDir();
    var key = sanitizeId((options.ticketKey || 'unknown') + '_' + (options.stage || 'feedback'));
    var markerPath = 'outputs/feedback/' + key + '.attempt';
    var attempt = getAttempt(markerPath);
    if (attempt >= maxAttempts) {
        return { attempted: false, reason: 'attempts-exhausted', attempts: attempt };
    }

    attempt += 1;
    setAttempt(markerPath, attempt);

    var prompt = buildFeedbackPrompt({
        ticketKey: options.ticketKey,
        stage: options.stage,
        attempt: attempt,
        error: errorText
    });
    var promptPath = 'outputs/feedback/' + key + '.md';
    writeFile(promptPath, prompt);

    var resumeArgs = config.resumeArgs || '--continue --resume';
    var command = 'bash agents/scripts/run-agent.sh ' + resumeArgs + ' ' + promptPath;
    console.log('Feedback loop: resuming agent for ' + (options.stage || 'failure') + ' attempt ' + attempt + '/' + maxAttempts);
    runCommand(command);
    return { attempted: true, attempts: attempt, promptPath: promptPath };
}

function getConfiguredGates(customParams, section, legacyKey) {
    var config = normalizeConfig(customParams || {}, section);
    var gates = config.gates || config[section] || ((customParams && customParams[legacyKey || section]) || []);
    return Array.isArray(gates) ? gates : [];
}

function runConfiguredGates(options, section, stagePrefix) {
    options = options || {};
    section = section || 'qualityGates';
    stagePrefix = stagePrefix || 'quality_gate';
    var gateType = section === 'policyGates' ? 'policy gate' : 'quality gate';
    var customParams = options.customParams || {};
    var config = normalizeConfig(customParams, options.section || section);
    var gates = getConfiguredGates(customParams, options.section || section, section);
    var results = [];
    var nonBlockingFailures = [];

    for (var i = 0; i < gates.length; i++) {
        var gate = gates[i];
        if (!gate || gate.enabled === false) continue;
        var name = gate.name || ('gate_' + (i + 1));
        var command = gate.command ? String(gate.command).replace(/\{ticketKey\}/g, options.ticketKey || '') : null;
        if (!command) continue;
        var workingDir = gate.workingDir || options.workingDir || config.workingDir || null;
        // blocking defaults to true (backward compatible): set "blocking": false on a gate
        // (e.g. spotbugs on a codebase with pre-existing findings unrelated to the PR) to
        // report its failure without aborting the push/PR-reply flow for the whole ticket.
        var isBlocking = gate.blocking !== false;

        var attempts = 0;
        var maxAttempts = gate.maxAttempts;
        if (maxAttempts === undefined || maxAttempts === null) maxAttempts = DEFAULT_MAX_ATTEMPTS;
        maxAttempts = parseInt(maxAttempts, 10) || 0;

        while (true) {
            attempts += 1;
            try {
                console.log('Running ' + gateType + ' "' + name + '": ' + command);
                var output = runCommand(command, workingDir) || '';
                results.push({ name: name, success: true, attempts: attempts, output: output });
                break;
            } catch (e) {
                var errorText = e && e.message ? e.message : String(e);
                if (attempts > maxAttempts || gate.retryWithAgent === false) {
                    if (!isBlocking) {
                        console.warn('⚠️ Non-blocking ' + gateType + ' "' + name + '" failed after ' + attempts +
                            ' attempt(s) — continuing without blocking: ' + errorText);
                        results.push({ name: name, success: false, attempts: attempts, error: errorText, blocking: false });
                        nonBlockingFailures.push({ name: name, error: errorText });
                        break;
                    }
                    return {
                        success: false,
                        failedGate: name,
                        error: errorText,
                        results: results,
                        nonBlockingFailures: nonBlockingFailures
                    };
                }

                var feedbackLoopConfig = { feedbackLoop: {} };
                feedbackLoopConfig.feedbackLoop[section] = {
                    enabled: true,
                    maxAttempts: maxAttempts,
                    resumeArgs: gate.resumeArgs || undefined,
                    nonRecoverablePatterns: gate.nonRecoverablePatterns || undefined
                };
                var resume = resumeAgent({
                    ticketKey: options.ticketKey,
                    customParams: feedbackLoopConfig,
                    section: section,
                    stage: stagePrefix + '_' + name,
                    error: 'Command failed: ' + command +
                        (workingDir ? '\nWorking directory: ' + workingDir : '') +
                        '\n\n' + errorText
                });
                if (!resume.attempted) {
                    if (!isBlocking) {
                        console.warn('⚠️ Non-blocking ' + gateType + ' "' + name + '" failed (no resume attempted) — continuing without blocking: ' + errorText);
                        results.push({ name: name, success: false, attempts: attempts, error: errorText, blocking: false });
                        nonBlockingFailures.push({ name: name, error: errorText });
                        break;
                    }
                    return {
                        success: false,
                        failedGate: name,
                        error: errorText,
                        results: results,
                        nonBlockingFailures: nonBlockingFailures
                    };
                }
                if (options.returnAfterResume || config.returnAfterResume || gate.returnAfterResume) {
                    return {
                        success: false,
                        failedGate: name,
                        error: errorText,
                        resumeAttempted: true,
                        results: results,
                        nonBlockingFailures: nonBlockingFailures
                    };
                }
            }
        }
    }

    return { success: true, results: results, nonBlockingFailures: nonBlockingFailures };
}

function runQualityGates(options) {
    return runConfiguredGates(options || {}, 'qualityGates', 'quality_gate');
}

function runPolicyGates(options) {
    return runConfiguredGates(options || {}, 'policyGates', 'policy_gate');
}

function runPostPublishGates(options) {
    options = options || {};
    options.returnAfterResume = options.returnAfterResume !== false;
    return runConfiguredGates(options, 'postPublishGates', 'post_publish_gate');
}

module.exports = {
    DEFAULT_MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS,
    resumeAgent: resumeAgent,
    runQualityGates: runQualityGates,
    runPolicyGates: runPolicyGates,
    runPostPublishGates: runPostPublishGates,
    normalizeConfig: normalizeConfig,
    isFeedbackEnabled: isFeedbackEnabled,
    sanitizeId: sanitizeId
};
