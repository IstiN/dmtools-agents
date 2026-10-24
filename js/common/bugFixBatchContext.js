/**
 * Shared runtime helpers for the bug-fix batch pre-/post-CLI actions.
 *
 * gh-1250: js/prepareBugFixBatchContext.js and js/developBugFixBatchAndCreatePR.js
 * used to carry identical copies of the runCmd/cleanCommandOutput wrapper block
 * and the params/epic resolution block. They live here once; the actions keep
 * thin local delegates so their module.exports surfaces stay unchanged.
 */

var configLoader = require('./configLoader.js');
var trackersModule = require('./trackers.js');
var prHelper = require('./pullRequest.js');

// Working directory applied to every command issued while an action runs.
// Set once per action() invocation via setWorkingDir.
var _workingDir = null;

function setWorkingDir(dir) {
    _workingDir = dir || null;
}

function runCmd(args) {
    if (typeof args === 'string') args = { command: args };
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

/** Pre-CLI params carry the input folder at the top level; jobs nest them under jobParams. */
function resolveBatchParams(params) {
    return params.inputFolderPath ? params : (params.jobParams || params);
}

/** Re-fetch the epic when the ticket payload carries no fields; a failed fetch degrades to key-only. */
function resolveBatchEpic(tracker, epicKey, epic) {
    if (epic.fields) return epic;
    try {
        return tracker.getIssue(epicKey, ['summary', 'description', 'status', 'labels']);
    } catch (e) {
        console.warn('Could not fetch Epic details (non-fatal):', e);
        return { key: epicKey, fields: {} };
    }
}

/**
 * Resolve everything a batch action needs up front: unwrapped params, project
 * config (whose workingDir is applied to subsequent commands), the tracker,
 * and the epic key/folder/epic derived from the input folder.
 */
function resolveBatchActionContext(params) {
    var actualParams = resolveBatchParams(params);
    var config = configLoader.loadProjectConfig(actualParams);
    setWorkingDir(config.workingDir || null);
    var tracker = trackersModule.createTracker(config, actualParams.customParams || {});

    var epicFolder = actualParams.inputFolderPath;
    var epicKey = epicFolder.split('/').pop();
    var epic = resolveBatchEpic(tracker, epicKey, actualParams.ticket || { key: epicKey, fields: {} });

    return {
        actualParams: actualParams,
        config: config,
        tracker: tracker,
        epicFolder: epicFolder,
        epicKey: epicKey,
        epic: epic
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { setWorkingDir, runCmd, cleanCommandOutput, resolveBatchParams, resolveBatchEpic, resolveBatchActionContext };
}
