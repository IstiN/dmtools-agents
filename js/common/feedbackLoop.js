var DEFAULT_MAX_ATTEMPTS = 2;

// gh-775: hard wall-clock cap for the bounded missing-response resume.
// 40 min by recommendation — must fit the job's remaining timeout budget;
// projects can tighten it via feedbackLoop.missingResponse.timeoutSeconds.
var DEFAULT_MISSING_RESPONSE_TIMEOUT_SECONDS = 2400;

// gh-775: dedicated attempt-marker stage so the bounded resume never shares
// (or consumes) the failure-recovery stages' attempt counters.
var MISSING_RESPONSE_STAGE = 'missing_response';

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
    // mkdir is not in the cli_execute_command whitelist — wrap in bash -c.
    try { runCommand('bash -c "mkdir -p outputs/feedback"'); } catch (e) {}
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

// gh-775: follow-up prompt for the bounded missing-response resume — the exact
// scenario this recovery exists for is a hung background verification child
// that stalled the session after the real work was done (live fa gh-1341).
// Kept inline like buildFeedbackPrompt (the prompts/ home variant would add a
// runtime file-read failure mode for no versioning benefit — this file IS the
// versioned home of the resume mechanics).
function buildMissingResponsePrompt(options) {
    return [
        'Your previous run finished its real work but was interrupted before outputs/response.md could be written — most likely a background verification job (test suite, coverage, build) hung and the session stalled watching it.',
        '',
        'Resume and finish the task now:',
        '- Check running background jobs (bash_job status) and STOP any job with no progress: bash_job stop <id>.',
        '- Do NOT restart long verification runs. Note the unverified part in the deliverable (job id, command, last output tail) — validation CI on the pull request is the safety net.',
        '- Finish any remaining small steps, then write outputs/response.md (the deliverable the post-action expects) and end the turn.',
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

    // `buildFeedbackPrompt()` bakes in dev-flow assumptions ("do not push; the
    // post-action will commit and push after you finish") that don't apply to
    // every caller (e.g. a publish-only post-action that never pushes code).
    // Callers with a different resume flow can pass `promptOverride` with the
    // full prompt text instead — attempt tracking / non-recoverable-error
    // detection / the `--continue` resume mechanics stay identical either way.
    var prompt = options.promptOverride || buildFeedbackPrompt({
        ticketKey: options.ticketKey,
        stage: options.stage,
        attempt: attempt,
        error: errorText
    });
    var promptPath = 'outputs/feedback/' + key + '.md';
    writeFile(promptPath, prompt);

    // Copilot CLI's `--continue` already means "resume the most recent session in this
    // directory" (no value needed); its own `-r, --resume[=value]` flag is a second,
    // mutually exclusive way to resume (by explicit id or an interactive picker when bare).
    // Passing both together is rejected outright: "error: option '-r, --resume[=value]'
    // cannot be used with option '--continue'" — which made every feedback-loop retry fail
    // deterministically before the agent ever got a chance to act on the new prompt.
    var resumeArgs = config.resumeArgs || '--continue';
    var command = 'bash agents/scripts/run-agent.sh ' + resumeArgs + ' ' + promptPath;
    // gh-775: bounded resume — a hard wall-clock cap on the wrapper invocation so a
    // hung provider session cannot hold the post-action (and the job's remaining
    // timeout budget) hostage. `timeout -k 60 <N>` TERM-inates the wrapper after <N>
    // seconds and KILLs it 60s later if TERM is ignored. The wrapper is entered
    // through `bash` (cli_execute_command whitelists the command's FIRST token only;
    // dev runners carry it via envVariables.CLI_ALLOWED_COMMANDS), so no new
    // whitelist entry is needed.
    var timeoutSeconds = parseInt(options.timeoutSeconds, 10);
    if (timeoutSeconds && timeoutSeconds > 0) {
        command = 'bash -c "timeout -k 60 ' + timeoutSeconds + ' ' + command + '"';
    }
    console.log('Feedback loop: resuming agent for ' + (options.stage || 'failure') + ' attempt ' + attempt + '/' + maxAttempts);
    runCommand(command);
    return { attempted: true, attempts: attempt, promptPath: promptPath };
}

// ── gh-775: ONE bounded resume for a missing deliverable ────────────────────
// A dev agent can finish all real work and still lose the leg to a HUNG
// background verification job: the post-action finds outputs/response.md
// missing and cold-resets a session that was one "write the deliverable" step
// away from done (live fa gh-1341, run 37521704313). Before that cold reset,
// the dev post-action makes exactly ONE bounded resume attempt so the
// still-resumable session can finish and land the deliverable.
//
// Contract:
// - gated on the same feedback-loop enablement switch as every other resume
//   path (root `enabled` or a dedicated `missingResponse.enabled`), with a
//   section-level `enabled: false` winning over the root switch;
// - exactly ONE attempt per leg (own `missing_response` attempt marker —
//   multi-resume retries are a non-goal by design);
// - the wrapper invocation is hard-capped (timeout -k 60 <timeoutSeconds>,
//   default 2400s = 40 min; configurable via
//   feedbackLoop.missingResponse.timeoutSeconds);
// - a failed/timed-out wrapper invocation is a resume FAILURE, not a crash:
//   it is returned (attempted: true, failed: true) so the caller can re-check
//   the deliverable and fall back to the EXISTING cold reset verbatim.
function resumeOnceForMissingResponse(options) {
    options = options || {};
    var customParams = options.customParams || {};
    var root = customParams.feedbackLoop || {};
    var scoped = (root.missingResponse && typeof root.missingResponse === 'object') ? root.missingResponse : {};
    if (scoped.enabled === false) {
        return { attempted: false, reason: 'disabled' };
    }
    if (!isFeedbackEnabled(customParams, 'missingResponse')) {
        return { attempted: false, reason: 'disabled' };
    }

    var timeoutSeconds = parseInt(scoped.timeoutSeconds, 10);
    if (!timeoutSeconds || timeoutSeconds < 1) {
        timeoutSeconds = DEFAULT_MISSING_RESPONSE_TIMEOUT_SECONDS;
    }

    // Force exactly one attempt for this stage regardless of the inherited
    // root maxAttempts — gh-775 is explicit: no multi-resume retries.
    var forced = {};
    for (var key in customParams) {
        if (customParams.hasOwnProperty(key)) forced[key] = customParams[key];
    }
    forced.feedbackLoop = Object.assign({}, root, {
        missingResponse: Object.assign({}, scoped, { enabled: true, maxAttempts: 1 })
    });

    try {
        return resumeAgent({
            ticketKey: options.ticketKey,
            customParams: forced,
            section: 'missingResponse',
            stage: MISSING_RESPONSE_STAGE,
            error: options.error || '',
            promptOverride: options.promptOverride || buildMissingResponsePrompt({
                ticketKey: options.ticketKey
            }),
            timeoutSeconds: timeoutSeconds
        });
    } catch (e) {
        console.warn('Bounded resume for missing outputs/response.md failed/timed out:', e);
        return { attempted: true, failed: true, error: e && e.message ? e.message : String(e) };
    }
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
    DEFAULT_MISSING_RESPONSE_TIMEOUT_SECONDS: DEFAULT_MISSING_RESPONSE_TIMEOUT_SECONDS,
    MISSING_RESPONSE_STAGE: MISSING_RESPONSE_STAGE,
    resumeAgent: resumeAgent,
    resumeOnceForMissingResponse: resumeOnceForMissingResponse,
    buildFeedbackPrompt: buildFeedbackPrompt,
    buildMissingResponsePrompt: buildMissingResponsePrompt,
    runQualityGates: runQualityGates,
    runPolicyGates: runPolicyGates,
    runPostPublishGates: runPostPublishGates,
    normalizeConfig: normalizeConfig,
    isFeedbackEnabled: isFeedbackEnabled,
    sanitizeId: sanitizeId
};
