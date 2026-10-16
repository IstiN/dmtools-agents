/**
 * Pre-CLI Sync Base Branch Action
 *
 * Generic preCliJSAction for workflows that iterate directly on the target
 * repository's default branch (no feature branches, no PRs) — e.g. content
 * generation or documentation repos where every run should build on top of
 * the latest state.
 *
 * Ensures the working copy (customParams.targetRepository.workingDir) is on
 * the configured baseBranch and fast-forwarded to origin.
 *
 * Shell-safety: cli_execute_command rejects shell metacharacters
 * (&&, ||, |, ;, >, <, backticks, $(...), ${...}) — every command here is a
 * single plain invocation. Never chain commands in this file.
 *
 * Configuration (customParams.targetRepository):
 *   - baseBranch: branch to sync (default "main")
 *   - workingDir: checkout directory (from targetRepository.workingDir)
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');

var _workingDir = null;
function runCmd(args) {
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function action(params) {
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    _workingDir = config.workingDir || null;
    var baseBranch = (config.git && config.git.baseBranch) || 'main';

    try {
        // NOTE: cli_execute_command rejects shell metacharacters (&&, |, ;, ...).
        // Each git invocation must be a separate call.
        cleanCommandOutput(runCmd({ command: 'git checkout ' + baseBranch }));
        var out = cleanCommandOutput(runCmd({ command: 'git pull --ff-only origin ' + baseBranch }));
        console.log('preCliSyncBaseBranch: on ' + baseBranch + ', up to date. ' + out);
        return true;
    } catch (e) {
        console.error('preCliSyncBaseBranch: failed to sync ' + baseBranch + ':', e.toString());
        return false;
    }
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
