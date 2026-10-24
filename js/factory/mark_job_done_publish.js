/**
 * JSRunner entry — mark the machine job done (issue task list). Thin caller
 * for js/factory/mark_job_done.js, the JS port of the awf
 * factory-teammate.yml «Mark machine job done (issue task list)» step
 * (IstiN/dmtools-agentic-workflows#34 scripts/mark-job-done.sh).
 *
 * Invocation (machine-kit / final awf rewire — the sh call becomes):
 *   dmtools run agents/js/factory/run_mark_job_done.json
 *
 * Params resolve customParams first, then the sh step's env names, then the
 * sh defaults — so the same config works from a workflow env block or a
 * fully-materialized runner config. See js/factory/README.md for the full
 * env/file contract.
 *
 * Error contract mirrors the sh under `bash -e`: gh failures PROPAGATE (the
 * step runs under always() and a dead marker flip must redden); the
 * no-marker path is a warning, not an error.
 */

var markJobDone = require('./mark_job_done.js');
// gh-1248: the env reader + pick closure are canonical in publishParams.js
// (one copy shared by the three *_publish entries).
var publishParams = require('./publishParams.js');

function resolveParams(params, envMap) {
    var pick = publishParams.makePicker(params, envMap);
    return {
        number: pick('number', 'NUMBER', ''),
        runUrl: pick('runUrl', 'RUN_URL', ''),
        jobResult: pick('jobResult', 'JOB_RESULT', ''),
        repo: pick('repo', 'GITHUB_REPOSITORY', ''),
        tempPath: pick('tempPath', '', markJobDone.DEFAULT_TEMP_PATH),
        endTs: pick('endTs', '', '')
    };
}

/**
 * The raw gh body from the transport: a result object ({output|stdout}) is
 * unwrapped, a bare string rides as-is, and a null/undefined result becomes
 * '' — String(res) would feed '[object Object]' to the flip and silently
 * no-op every marker. No .trim(): the sh consumes the gh body
 * byte-for-byte (trailing newline included) and the awk-port ORS semantics
 * handle the rest.
 */
function execResultText(exec, cmd) {
    var res = exec({ command: cmd });
    return String((res && (res.output || res.stdout)) || res || '');
}

/**
 * JSRunner action. deps is a test seam: production resolves the dmtools
 * globals (cli_execute_command / file_write) exactly like
 * token_usage_publish.js wires its transport.
 */
function action(params, deps) {
    deps = deps || {};
    var exec = deps.cli_execute_command ||
        (typeof cli_execute_command === 'function' ? cli_execute_command : null);
    var write = deps.file_write ||
        (typeof file_write === 'function' ? file_write : null);
    var opts = resolveParams(params, deps.env);
    var result = markJobDone.markJobDone(opts, {
        exec: function (cmd) {
            return execResultText(exec, cmd);
        },
        writeFile: function (path, content) {
            if (!write) throw new Error('file_write is not available on this runtime');
            return write(path, content);
        },
        clock: function () { return new Date(); },
        log: function (line) { console.log(line); }
    });
    console.log('  ✅ job marker: ' + result.status +
        (result.flipped ? ' (' + result.flipped + ' line(s))' : '') +
        ' — ' + result.mark);
    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        execResultText: execResultText,
        resolveParams: resolveParams,
        envValue: publishParams.envValue
    };
}
