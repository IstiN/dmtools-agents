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
 * unwrapped ((res.output || res.stdout) || res — the #893 review lesson)
 * and never trimmed.
 */

var reviewVerdict = require('./review_verdict.js');

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
    var tmpSeq = 0;
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
        _tmpSeq: function () { return ++tmpSeq; }
    };
}

/**
 * JSRunner action. deps is a test seam: production resolves the dmtools
 * globals (cli_execute_command / file_write / file_read). The no-verdict
 * path throws (exit-1 parity — the workflow step must redden); every other
 * terminal state returns { status, ... }.
 */
function action(params, deps) {
    deps = deps || {};
    var exec = deps.cli_execute_command ||
        (typeof cli_execute_command === 'function' ? cli_execute_command : null);
    var writeRaw = deps.file_write ||
        (typeof file_write === 'function' ? file_write : null);
    var readRaw = deps.file_read ||
        (typeof file_read === 'function' ? file_read : null);
    var opts = resolveParams(params, deps.env);
    var seq = opts._tmpSeq;
    delete opts._tmpSeq;
    var result = reviewVerdict.applyReviewVerdict(opts, {
        exec: function (cmd) {
            var res = exec({ command: cmd });
            // execOut pattern, no trim: bodies/file paths ride verbatim.
            // An empty-output result object is an empty output — never the
            // object itself ('[object Object]' as a command string).
            var out = res && (res.output || res.stdout);
            if (out === undefined || out === null) {
                out = (typeof res === 'string') ? res : '';
            }
            return String(out || '');
        },
        writeFile: function (p, c) {
            if (!writeRaw) throw new Error('file_write is not available on this runtime');
            return writeRaw(p, c);
        },
        readFile: function (p) {
            if (!readRaw) throw new Error('file_read is not available on this runtime');
            return readRaw({ path: p });
        },
        tempFile: function (hint) {
            var base = (opts.runOutput && opts.runOutput.indexOf('/') === 0)
                ? opts.runOutput.replace(/[^/]*$/, '') : '/tmp/';
            return base + 'rv-' + seq() + '-' + hint;
        },
        clock: function () { return new Date(); },
        sleepMs: function (ms) { /* the runtime's own timer would go here */ },
        log: function (line) { console.log(line); }
    });
    console.log('  ⚖️ review verdict: ' + result.status +
        (result.pr ? ' (PR #' + result.pr + ')' : '') +
        (result.decision ? ' — ' + result.decision : ''));
    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveParams: resolveParams,
        envValue: envValue
    };
}
