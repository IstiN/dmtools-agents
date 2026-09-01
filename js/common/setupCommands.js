/**
 * Runs project-specific prerequisite/setup commands before the CLI agent starts.
 *
 * Configured via customParams.setupCommands: an array of either plain command
 * strings or objects { command, name, workingDir, allowFailure }.
 *
 * - Plain strings and entries without `allowFailure: false` are non-fatal:
 *   a failure is logged and the loop continues (useful for warm-up/caching
 *   steps that shouldn't block the whole pipeline).
 * - `allowFailure: false` makes the step required: a failure throws, stopping
 *   development before the CLI agent runs (useful for prerequisite checks
 *   like "required credentials are present").
 *
 * Used by: preCliDevelopmentSetup.js (story_development), preCliReworkSetup.js
 * (pr_rework) — runs once per ticket, right after the git branch is checked
 * out and before the CLI coding agent starts.
 *
 * ⚠️ IMPORTANT — every command here goes through cli_execute_command, which:
 * 1. Only allows executables in the whitelist: git, gh, dmtools, npm, yarn,
 *    docker, kubectl, terraform, ansible, aws, gcloud, az (base list). Anything
 *    else (bash, mvn, gradle, test, python3, ...) MUST be added via
 *    params.envVariables.CLI_ALLOWED_COMMANDS (comma-separated) on the agent
 *    JSON, e.g. { "envVariables": { "CLI_ALLOWED_COMMANDS": "bash,mvn" } }.
 * 2. Rejects any command string containing shell metacharacters —
 *    `;`, `&&`, `||`, `|`, `>`, `<`, `` ` ``, `$(...)`, `${...}` — even if the
 *    leading executable is whitelisted. There is NO way to pass a compound
 *    command (e.g. "test -n \"$X\" && echo ok") directly.
 *    If you need conditional/compound logic, put it inside a checked-in .sh
 *    script file and invoke that file with a single simple command
 *    (e.g. "bash agents/scripts/check_required_env_vars.sh VAR1 VAR2") — the
 *    metacharacter check only inspects the command string passed to
 *    cli_execute_command, not the contents of a script it runs.
 */

// Required setup command failures embed the raw tool output (e.g. full `mvn`/`gradle`
// console output, which can run into megabytes) in the thrown Error's message. Callers
// (preCliDevelopmentSetup.js, preCliReworkSetup.js) post that message straight into a
// Jira/tracker comment; trackers reject oversized comments (e.g. Jira's ~350000 char
// limit) and the resulting post failure can end up silently swallowed, leaving the
// ticket with zero visibility into why setup failed. Cap the embedded output here, at
// the source, so every consumer of this error automatically gets a bounded message.
var MAX_SETUP_ERROR_CHARS = 8000;

function truncateSetupError(text) {
    if (typeof text !== 'string' || text.length <= MAX_SETUP_ERROR_CHARS) {
        return text;
    }
    // Keep the head (command/context) and tail (usually the actual failure/exception)
    // since Maven/Gradle failures are typically reported at the very end of the output.
    var headLen = Math.floor(MAX_SETUP_ERROR_CHARS * 0.4);
    var tailLen = MAX_SETUP_ERROR_CHARS - headLen;
    var omitted = text.length - headLen - tailLen;
    return text.slice(0, headLen) +
        '\n... [truncated ' + omitted + ' char(s) — see CLI logs for full output] ...\n' +
        text.slice(text.length - tailLen);
}

function runSetupCommands(customParams, defaultWorkingDir) {
    var commands = (customParams && customParams.setupCommands) || [];
    if (!Array.isArray(commands) || commands.length === 0) {
        return { ran: 0, results: [] };
    }

    var results = [];
    for (var i = 0; i < commands.length; i++) {
        var entry = commands[i];
        var isString = typeof entry === 'string';
        var command = isString ? entry : (entry && entry.command);
        if (!command) continue;

        var workingDir = (!isString && entry.workingDir) || defaultWorkingDir || null;
        var allowFailure = isString ? true : (entry.allowFailure !== false);
        var name = (!isString && entry.name) || command;

        try {
            console.log('Running setup command "' + name + '": ' + command);
            var args = { command: command };
            if (workingDir) args.workingDirectory = workingDir;
            var output = cli_execute_command(args);
            results.push({ name: name, success: true, output: output });
        } catch (e) {
            var errorText = e && e.message ? e.message : String(e);
            console.warn('Setup command "' + name + '" failed:', errorText);
            results.push({ name: name, success: false, error: errorText });
            if (allowFailure === false) {
                throw new Error('Required setup command failed: ' + name + ' — ' + truncateSetupError(errorText));
            }
        }
    }
    return { ran: results.length, results: results };
}

/**
 * Builds a markdown summary of any non-fatal ("allowFailure" — the default) setup
 * command failures from a runSetupCommands() result, or null if none failed.
 *
 * Non-fatal failures are, by design, only logged to the CI console (see
 * runSetupCommands() above) — the CLI coding agent never sees them unless the caller
 * writes this out to an input file. Without that, a step like "build the project's
 * Docker test image" can fail for a genuine, agent-fixable content reason (e.g. a bad
 * migration file) and the agent will start working on the ticket with zero awareness
 * that anything is wrong, only to hit a confusing downstream failure later (or worse,
 * silently ship a broken fix). Callers should write this to e.g. `setup_warnings.md` in
 * the input folder whenever it returns non-null, so the CLI agent can read it as context
 * and attempt a fix, the same way it already does for merge_conflicts.md.
 */
function buildSetupWarningsMarkdown(runResult) {
    var results = (runResult && runResult.results) || [];
    var failures = results.filter(function(r) { return r && r.success === false; });
    if (failures.length === 0) {
        return null;
    }
    var lines = [
        '# Setup Command Warnings',
        '',
        'The following setup command(s) failed but were configured as non-fatal ' +
            '(allowFailure is not set to false), so environment setup continued. ' +
            'If this failure is caused by a fixable issue in the code (e.g. a bad ' +
            'migration, a broken test, a compile error), please investigate and fix it ' +
            'as part of this task.',
        ''
    ];
    for (var i = 0; i < failures.length; i++) {
        lines.push('## ' + failures[i].name);
        lines.push('');
        lines.push('```');
        lines.push(truncateSetupError(failures[i].error || ''));
        lines.push('```');
        lines.push('');
    }
    return lines.join('\n');
}

module.exports = {
    runSetupCommands: runSetupCommands,
    truncateSetupError: truncateSetupError,
    buildSetupWarningsMarkdown: buildSetupWarningsMarkdown
};
