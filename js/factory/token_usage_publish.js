/**
 * JSRunner entry — publish per-leg token usage (fa-tokens ledger →
 * factory-data). Thin caller for js/factory/token_usage.js, the JS port of
 * the awf factory-teammate.yml «Publish leg token usage» step
 * (IstiN/dmtools-agentic-workflows#34 scripts/publish-token-usage.sh).
 *
 * Invocation (machine-kit / awf stage-3 rewire — the sh call becomes):
 *   dmtools run agents/js/factory/run_token_usage_publish.json
 *
 * Params resolve customParams first, then the sh step's env names, then the
 * sh defaults — so the same config works from a workflow env block or a
 * fully-materialized runner config. See js/factory/README.md for the full
 * env/file contract.
 */

var tokenUsage = require('./token_usage.js');
// gh-1248: the env reader + pick closure are canonical in publishParams.js
// (one copy shared by the three *_publish entries).
var publishParams = require('./publishParams.js');

function resolveParams(params, envMap) {
    var pick = publishParams.makePicker(params, envMap);
    var custom = (params && params.jobParams && params.jobParams.customParams) || {};
    return {
        runOutput: pick('runOutput', 'RUN_OUTPUT', ''),
        configPath: pick('configPath', 'CONFIG', ''),
        kind: pick('kind', 'KIND', ''),
        anchor: pick('anchor', 'ANCHOR', ''),
        repo: pick('repo', 'REPO', ''),
        dataBranch: pick('dataBranch', 'DATA_BRANCH', tokenUsage.DEFAULT_DATA_BRANCH),
        dataPath: pick('dataPath', 'DATA_PATH', tokenUsage.DEFAULT_DATA_PATH),
        now: custom.now
    };
}

function resolveGlobalFn(injected, globalFn) {
    if (typeof injected === 'function') return injected;
    if (typeof globalFn === 'function') return globalFn;
    return null;
}

function invokeFn(fn) {
    return fn ? function (a) { return fn(a); } : undefined;
}

function invokeRead(readRaw) {
    return readRaw ? function (p) { return readRaw({ path: p }); } : undefined;
}

function buildIo(deps) {
    var exec = resolveGlobalFn(deps.cli_execute_command,
        typeof cli_execute_command === 'function' ? cli_execute_command : null);
    var readRaw = resolveGlobalFn(deps.file_read,
        typeof file_read === 'function' ? file_read : null);
    var writeRaw = resolveGlobalFn(deps.file_write,
        typeof file_write === 'function' ? file_write : null);
    var delRaw = resolveGlobalFn(deps.file_delete,
        typeof file_delete === 'function' ? file_delete : null);
    return {
        exec: invokeFn(exec),
        read: invokeRead(readRaw),
        write: invokeFn(writeRaw),
        del: invokeFn(delRaw),
        log: function (line) { console.log(line); }
    };
}

function formatSummaryLine(result) {
    return '  🪙 token publish: ' + result.status +
        (result.reason ? ' (' + result.reason + ')' : '') +
        (result.key ? ' — ' + result.key + ' ' + result.leg : '') +
        (result.attempts ? ' after ' + result.attempts + ' attempt(s)' : '');
}

/**
 * JSRunner action. deps is a test seam: production resolves the dmtools
 * globals (cli_execute_command / file_read / file_write / file_delete)
 * exactly like smAgent.js wires checkRunStamp — exec MUST return the child
 * output for the sha probe to work.
 */
function action(params, deps) {
    deps = deps || {};
    var opts = resolveParams(params, deps.env);
    var result = tokenUsage.publishTokenUsage(opts, buildIo(deps));
    console.log(formatSummaryLine(result));
    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveParams: resolveParams,
        envValue: publishParams.envValue
    };
}
