/**
 * Condition script for conditional cliPrompts sections:
 * Returns true when CodeGraph is available and initialized in the working directory
 * (`.codegraph/` index directory exists and the `codegraph` CLI binary is on PATH).
 *
 * Used in agent JSON configs:
 *   {
 *     "id": "codegraph",
 *     "prompt": "./agents/prompts/codegraph_tools.md",
 *     "condition": "agents/js/conditions/isCodeGraphAvailable.js"
 *   }
 */

function resolveWorkingDir(params) {
    try {
        var content = file_read({ path: '.dmtools-target-workingdir' });
        if (content && String(content).trim()) {
            return String(content).trim();
        }
    } catch (e) {
        // ignore
    }
    if (params && typeof params.workingDirectory === 'string' && params.workingDirectory.trim()) {
        return params.workingDirectory.trim();
    }
    return null;
}

function isCodeGraphAvailable(params) {
    try {
        var workingDir = resolveWorkingDir(params);
        var args = { command: 'bash -c "test -d .codegraph"' };
        if (workingDir) {
            args.workingDirectory = workingDir;
        }
        cli_execute_command(args);

        var binArgs = { command: 'bash -c "command -v codegraph"' };
        if (workingDir) {
            binArgs.workingDirectory = workingDir;
        }
        var out = cli_execute_command(binArgs);
        return !!(out && String(out).trim());
    } catch (e) {
        return false;
    }
}

function action(params) {
    return isCodeGraphAvailable(params);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        isCodeGraphAvailable: isCodeGraphAvailable,
        resolveWorkingDir: resolveWorkingDir
    };
}
