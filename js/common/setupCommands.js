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
 *    JSON — see repo-agents/gens-igt/story_development.json for an example.
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
                throw new Error('Required setup command failed: ' + name + ' — ' + errorText);
            }
        }
    }
    return { ran: results.length, results: results };
}

module.exports = {
    runSetupCommands: runSetupCommands
};
