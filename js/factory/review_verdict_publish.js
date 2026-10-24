/**
 * JSRunner entry — apply the review verdict (review runs only). Thin caller
 * for js/factory/review_verdict.js, the JS port of the awf
 * factory-teammate.yml «Apply the review verdict» step
 * (IstiN/dmtools-agentic-workflows#34 scripts/apply-review-verdict.sh).
 *
 * Invocation (machine-kit / final awf rewire — the sh call becomes):
 *   dmtools run agents/js/factory/run_review_verdict.json
 *
 * Params resolve customParams first, then the sh step's env names, then the
 * sh defaults. See js/factory/README.md for the full env/file contract.
 *
 * Error contract mirrors the sh under `bash -e`: the loud no-verdict path
 * (gh-305) THROWS after leaving needs-human + the diagnosis comment (the sh
 * exits 1 — the step must redden); the parser-invocation transport is
 * unwrapped through the module's canonical `unwrap` (the #893 review
 * lesson — one definition) and never trimmed.
 *
 * Production seams (the sh equivalents):
 *   - sleepMs — the sh's `sleep 30` inside the CI-green poll gate. The
 *     default rides `java.lang.Thread.sleep` on GraalJS (the
 *     aiTeammateTokenUsageReporter.js pattern) and busy-walls on plain
 *     engines; `deps.sleepMs` overrides it in tests. A NO-OP default is
 *     forbidden here: inside a 10-min deadline loop it degenerates into a
 *     `gh pr view` busy-loop (rate-limit burn).
 *   - temp workspace — the sh's `mktemp -d` + `trap 'rm -rf' EXIT`: one
 *     unique per-run directory (created through the transport on the first
 *     staged file), every staged body inside it, best-effort `rm -rf` when
 *     action finishes — throw path included. Without `mktemp` on the
 *     transport the fallback is a randomized per-run file prefix under the
 *     runOutput dir (absolute) or /tmp — never the predictable
 *     /tmp/rv-N-* names, and the staged files are `rm -f`ed on the way out.
 */

var reviewVerdict = require('./review_verdict.js');
var shellQuote = require('./token_usage.js').shellQuote;

/**
 * Env reader for the fallback path (guarded — no java bridge on QuickJS).
 */
function envValue(name) {
    try {
        if (typeof java !== 'undefined' && java && java.lang &&
            java.lang.System && typeof java.lang.System.getenv === 'function') {
            var v = java.lang.System.getenv(name);
            return (v === null || v === undefined) ? '' : String(v);
        }
    } catch (e) { /* no env bridge on this runtime */ }
    return '';
}

/**
 * customParams > env > sh-step defaults. envMap is a test seam.
 */
function resolveParams(params, envMap) {
    var custom = (params && params.jobParams && params.jobParams.customParams) || {};
    function env(name) {
        if (envMap && Object.prototype.hasOwnProperty.call(envMap, name)) return envMap[name];
        return envValue(name);
    }
    function pick(key, envName, dflt) {
        var v = custom[key];
        if (v === undefined || v === null || v === '') v = env(envName);
        if (v === undefined || v === null || v === '') v = dflt;
        return v === undefined || v === null ? '' : String(v);
    }
    return {
        repo: pick('repo', 'GITHUB_REPOSITORY', ''),
        number: pick('number', 'NUMBER', ''),
        runOutput: pick('runOutput', 'RUN_OUTPUT', reviewVerdict.DEFAULT_RUN_OUTPUT || '.dmtools/run-output.txt'),
        machineAuthor: pick('machineAuthor', 'MACHINE_AUTHOR', ''),
        maxRounds: pick('maxRounds', 'MAX_ROUNDS', ''),
        config: pick('config', 'CONFIG', ''),
        factoryRoot: pick('factoryRoot', 'FACTORY_ROOT', ''),
        home: pick('home', 'HOME', ''),
        ghToken: pick('ghToken', 'GH_TOKEN', ''),
        // gh-1101: SM tick on approval when the head is already green.
        ciWorkflow: pick('ciWorkflow', 'CI_WORKFLOW', 'quality.yml'),
        smWorkflow: pick('smWorkflow', 'SM_WORKFLOW', 'machine-sm.yml'),
        smKick: pick('smKick', 'SM_KICK', 'true')
    };
}

/**
 * The production side of the sleepMs seam — the sh's `sleep 30`. Real
 * Thread.sleep under GraalJS; a wall-clock busy-wait keeps plain engines
 * honest (a no-op here busy-loops the CI-green poll gate).
 */
function productionSleepMs(ms) {
    ms = parseInt(ms, 10) || 0;
    if (ms <= 0) return;
    if (typeof Java !== 'undefined' && Java.type) {
        Java.type('java.lang.Thread').sleep(ms);
        return;
    }
    var end = Date.now() + ms;
    while (Date.now() < end) {}
}

/**
 * The mktemp -d + trap equivalent. The workspace is decided lazily (the
 * first staged file — a no-token run touches nothing): `mktemp -d` through
 * the transport wins; when the transport cannot mktemp, staged files fall
 * back to a randomized per-run prefix under the runOutput dir (absolute)
 * or /tmp — never the old predictable /tmp/rv-N-* names. cleanup() is the
 * trap: rm -rf the dir (or rm -f the fallback files), best-effort.
 */
function makeTempWorkspace(exec, opts) {
    var dir = null;
    var fallbackPrefix = '';
    var staged = [];
    function decide() {
        if (dir !== null) return;
        try { dir = String(exec('mktemp -d') || '').trim(); } catch (e) { dir = ''; }
        if (dir) return;
        var base = (opts.runOutput && opts.runOutput.indexOf('/') === 0)
            ? opts.runOutput.replace(/[^/]*$/, '') : '/tmp/';
        fallbackPrefix = base + 'rv-' + Date.now() + '-' +
            Math.floor(Math.random() * 10000) + '-';
    }
    return {
        tempFile: function (hint) {
            decide();
            var p = dir ? (dir + '/' + hint) : (fallbackPrefix + hint);
            staged.push(p);
            return p;
        },
        cleanup: function () {
            try {
                if (dir) exec('rm -rf ' + shellQuote(dir));
                else if (staged.length) {
                    exec('rm -f' + staged.map(function (p) {
                        return ' ' + shellQuote(p);
                    }).join(''));
                }
            } catch (e) { /* the sh's trap is best-effort */ }
        }
    };
}

/**
 * gh-1196: the deps-seam resolution, split out of action. Production
 * resolves the dmtools globals (cli_execute_command / file_write /
 * file_read) when the deps seam leaves a name unset; a runtime without the
 * global resolves null and the seam's user fails (writeFile/readFile throw
 * their not-available errors). Each seam keeps its original name under
 * deps.* as the test override.
 */
function resolveDeps(deps) {
    return {
        exec: deps.cli_execute_command ||
            (typeof cli_execute_command === 'function' ? cli_execute_command : null),
        write: deps.file_write ||
            (typeof file_write === 'function' ? file_write : null),
        read: deps.file_read ||
            (typeof file_read === 'function' ? file_read : null)
    };
}

// gh-1196: the one console.log line, split out of action (the ternaries ride
// along — the decision line is optional).
function verdictLogLine(result) {
    return '  ⚖️ review verdict: ' + result.status +
        (result.pr ? ' (PR #' + result.pr + ')' : '') +
        (result.decision ? ' — ' + result.decision : '');
}

/**
 * JSRunner action. deps is a test seam: production resolves the dmtools
 * globals (cli_execute_command / file_write / file_read). The no-verdict
 * path throws (exit-1 parity — the workflow step must redden); every other
 * terminal state returns { status, ... }.
 */
function action(params, deps) {
    deps = deps || {};
    var seams = resolveDeps(deps);
    var opts = resolveParams(params, deps.env);
    // execOut unwrap through the module's canonical definition (no trim:
    // bodies/file paths ride verbatim; an empty-output result object is an
    // empty output — never '[object Object]' as a command string).
    var exec = function (cmd) {
        return reviewVerdict.unwrap(seams.exec({ command: cmd }));
    };
    var ws = makeTempWorkspace(exec, opts);
    try {
        var result = reviewVerdict.applyReviewVerdict(opts, {
            exec: exec,
            writeFile: function (p, c) {
                if (!seams.write) throw new Error('file_write is not available on this runtime');
                return seams.write(p, c);
            },
            readFile: function (p) {
                if (!seams.read) throw new Error('file_read is not available on this runtime');
                return seams.read({ path: p });
            },
            tempFile: ws.tempFile,
            clock: deps.clock || function () { return new Date(); },
            sleepMs: deps.sleepMs || module.exports.productionSleepMs,
            log: deps.console_log ||
                (typeof console_log === 'function' ? console_log : function (line) { console.log(line); })
        });
        console.log(verdictLogLine(result));
        return result;
    } finally {
        ws.cleanup();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveParams: resolveParams,
        envValue: envValue,
        productionSleepMs: productionSleepMs
    };
}
