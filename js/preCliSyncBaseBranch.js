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
 * Configuration (customParams.targetRepository):
 *   - baseBranch: branch to sync (default "main")
 *   - workingDir: checkout directory (from targetRepository.workingDir)
 */

var configLoader = require('./configLoader.js');

var _workingDir = null;
function runCmd(args) {
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function (line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function action(params) {
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    _workingDir = config.workingDir || null;
    var baseBranch = (config.git && config.git.baseBranch) || 'main';

    try {
        var out = cleanCommandOutput(runCmd({
            command: 'git checkout ' + baseBranch + ' && git pull --ff-only origin ' + baseBranch
        }));
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
