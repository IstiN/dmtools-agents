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
