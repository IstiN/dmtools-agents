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

function markerExists(path) {
    if (typeof file_exists === 'function') {
        try { return !!file_exists({ path: path }); } catch (e) { return false; }
    }
    return true;
}

function resolveWorkingDir(params) {
    try {
        if (markerExists('.dmtools-target-workingdir')) {
            var content = file_read({ path: '.dmtools-target-workingdir' });
            if (content && String(content).trim()) {
                return String(content).trim();
            }
        }
    } catch (e) {
        // ignore
    }
    if (params && typeof params.workingDirectory === 'string' && params.workingDirectory.trim()) {
        return params.workingDirectory.trim();
    }
    return null;
}

function runCliCheck(command, workingDir) {
    var args = { command: command };
    if (workingDir) {
        args.workingDirectory = workingDir;
    }
    var out = cli_execute_command(args);
    return !!(out && String(out).trim());
}

function checkCodeGraphDir(workingDir) {
    var args = { command: 'git -c alias.cgdir="!test -d .codegraph" cgdir' };
    if (workingDir) args.workingDirectory = workingDir;
    cli_execute_command(args);
    return true;
}

function checkCodeGraphBin(workingDir) {
    return runCliCheck('git -c alias.cgbin="!command -v codegraph" cgbin', workingDir);
}

function isCodeGraphAvailable(params) {
    try {
        var workingDir = resolveWorkingDir(params);
        return checkCodeGraphDir(workingDir) && checkCodeGraphBin(workingDir);
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
