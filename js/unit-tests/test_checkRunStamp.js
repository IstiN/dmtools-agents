/**
 * Unit tests for js/common/checkRunStamp.js — the check-run stamp transport (gh-1107).
 *
 * Bug (live 2026-10-19 17:15, IstiN/flutter_agent_harness run 39290439628):
 * stampValidationChecksForModule built `gh api -X POST .../check-runs
 * -f summary="<jobs table>"` as a shell string with untrusted values inside
 * double quotes. The dispatched run carried a job literally named
 * `Lockfile smoke (${{ matrix.os }} release)`; /bin/sh (dash) saw `${{ ... }}`
 * → `Bad substitution`, exit 2, NO stamp written. Missing stamps keep the
 * required checks "expected" → PRs BLOCKED (bridge-free mode, factory #510).
 *
 * Contract (ticket gh-1107):
 *   - the request body travels as a JSON temp file (`--input <file>`), so
 *     the shell command string carries ZERO untrusted bytes — only the fixed
 *     repo path and the temp-file path (AC2);
 *   - the posted body equals the input byte-for-byte — JSON.stringify
 *     preserves every `${{ }}`, `$(id)`, backtick, quote, backslash and
 *     newline (AC1);
 *   - the temp file is removed on success AND failure (AC3);
 *   - a summary past GitHub's 65,535-char output limit is truncated with a
 *     marker, not rejected (E1);
 *   - an unwritable temp dir fails soft: the error propagates to the
 *     caller's per-stamp warn-and-skip, exactly today's failure mode (E2).
 *
 * Pure module — the transport takes { write, exec, del } capturers
 * (factoryState.js convention) so no test touches a real global.
 */

var assert = globalThis.assert;

var tokenUsage = loadModule('js/factory/token_usage.js', makeRequire({}), {});
var crs = loadModule('js/common/checkRunStamp.js', makeRequire({
    '../factory/token_usage.js': tokenUsage
}), {});

// The live bug's payload: a job table whose job name carries GitHub Actions
// matrix expression syntax plus every other shell-hostile byte class.
var HOSTILE_NAME = 'Lockfile smoke (${{ matrix.os }} release)';
var HOSTILE_SUMMARY = 'Dispatched run: https://github.com/a/b/actions/runs/777\n' +
    '| [Lockfile smoke (${{ matrix.os }} release)](https://github.com/a/b/actions/runs/777/jobs/11) | success |\n' +
    '| [js `engine` $(id) "quoted" back\\slash](https://github.com/a/b/actions/runs/777/jobs/12) | failure |\n' +
    '\n_Stamped by the SM tick (bridge-free mode)._';
var HOSTILE_TOKENS = ['${', '$(', '${{', '}}', '`', '"', '\\', HOSTILE_NAME, '$(id)'];

suite('checkRunStamp: buildCheckRunBody (AC1 request shape)', function () {

test('the body mirrors the Checks API create-check-run schema', function () {
    var body = crs.buildCheckRunBody({
        name: 'Quality gate', headSha: 'abc123', status: 'in_progress',
        title: 'SM validation (tick-dispatched)', summary: 'Stamped by the SM tick.'
    });
    assert.deepEqual(Object.keys(body).sort(), ['head_sha', 'name', 'output', 'status'],
        'no conclusion / details_url fields until there is something to say');
    assert.equal(body.name, 'Quality gate');
    assert.equal(body.head_sha, 'abc123');
    assert.equal(body.status, 'in_progress');
    assert.deepEqual(Object.keys(body.output).sort(), ['summary', 'title']);
    assert.equal(body.output.title, 'SM validation (tick-dispatched)');
    assert.equal(body.output.summary, 'Stamped by the SM tick.');
});

test('conclusion and details_url ride along only when present', function () {
    var body = crs.buildCheckRunBody({
        name: 'Quality gate', headSha: 'abc123', status: 'completed',
        conclusion: 'failure', detailsUrl: 'https://github.com/a/b/actions/runs/777/jobs/21',
        title: 'SM validation: failure', summary: 'red'
    });
    assert.equal(body.conclusion, 'failure');
    assert.equal(body.details_url, 'https://github.com/a/b/actions/runs/777/jobs/21');
});

});

suite('checkRunStamp: hostile bytes survive byte-for-byte (AC1 / UT-1)', function () {

test('buildCheckRunBody preserves every hostile byte class verbatim', function () {
    var body = crs.buildCheckRunBody({
        name: HOSTILE_NAME, headSha: '26203e9', status: 'completed',
        conclusion: 'success', title: 'SM validation: success',
        summary: HOSTILE_SUMMARY
    });
    HOSTILE_TOKENS.forEach(function (tok) {
        assert.ok(body.name.indexOf(tok) !== -1 || body.output.summary.indexOf(tok) !== -1,
            'hostile token must survive into the body: ' + JSON.stringify(tok));
    });
    assert.equal(body.output.summary, HOSTILE_SUMMARY, 'summary byte-for-byte');
    assert.equal(body.name, HOSTILE_NAME, 'name byte-for-byte');
});

test('JSON.stringify/parse round-trip keeps the hostile payload identical', function () {
    var body = crs.buildCheckRunBody({
        name: HOSTILE_NAME, headSha: '26203e9', status: 'completed',
        conclusion: 'success', title: 'SM validation: success',
        summary: HOSTILE_SUMMARY
    });
    var text = JSON.stringify(body);
    var back = JSON.parse(text);
    assert.equal(back.name, HOSTILE_NAME);
    assert.equal(back.output.summary, HOSTILE_SUMMARY);
    assert.equal(back.output.title, 'SM validation: success');
});

});

suite('checkRunStamp: the shell command stays clean (AC2 / UT-2 byte-scan)', function () {

test('stampCommand carries only the fixed repo path and the temp-file path', function () {
    var cmd = crs.stampCommand({ owner: 'a', repo: 'b' }, '/tmp/sm-check-run-1-0.json');
    assert.equal(cmd, 'gh api -X POST repos/a/b/check-runs --input /tmp/sm-check-run-1-0.json');
    HOSTILE_TOKENS.forEach(function (tok) {
        assert.equal(cmd.indexOf(tok), -1,
            'command must not carry untrusted bytes: ' + JSON.stringify(tok));
    });
});

test('tempBodyPath is digits-only safe — no shell metacharacter can ride the path', function () {
    var p = crs.tempBodyPath(1760000000000, 3);
    assert.ok(/^\/tmp\/sm-check-run-\d+-\d+\.json$/.test(p),
        'fixed /tmp prefix + numeric suffixes only, got: ' + p);
});

test('postCheckRunStamp posts the file verbatim and the command never sees the body bytes', function () {
    var writes = [];
    var commands = [];
    var deleted = [];
    var body = crs.buildCheckRunBody({
        name: HOSTILE_NAME, headSha: '26203e9', status: 'completed',
        conclusion: 'success', title: 'SM validation: success',
        summary: HOSTILE_SUMMARY
    });
    var ok = crs.postCheckRunStamp({ owner: 'a', repo: 'b' }, body,
        '/tmp/sm-check-run-1-0.json', {
            write: function (o) { writes.push(o); return true; },
            exec: function (o) { commands.push(o.command); return ''; },
            del: function (o) { deleted.push(o.path); }
        });
    assert.equal(ok, true, 'a clean post reports success');
    assert.deepEqual(deleted, ['/tmp/sm-check-run-1-0.json'], 'AC3: cleaned up');
    assert.equal(writes.length, 1, 'exactly one temp-file write');
    assert.equal(writes[0].path, '/tmp/sm-check-run-1-0.json');
    assert.equal(writes[0].content, JSON.stringify(body), 'UT-1: the written body is the exact JSON');
    assert.equal(commands.length, 1, 'exactly one gh call');
    assert.equal(commands[0].indexOf('--input /tmp/sm-check-run-1-0.json') !== -1, true,
        'the body rides --input');
    HOSTILE_TOKENS.forEach(function (tok) {
        assert.equal(commands[0].indexOf(tok), -1,
            'AC2: no untrusted byte in the shell string: ' + JSON.stringify(tok));
    });
});

});

suite('checkRunStamp: temp-file lifecycle (AC3 / UT-3)', function () {

test('the temp file is deleted on success', function () {
    var deleted = [];
    crs.postCheckRunStamp({ owner: 'a', repo: 'b' },
        crs.buildCheckRunBody({ name: 'n', headSha: 's', status: 'in_progress',
                                title: 't', summary: 'm' }),
        '/tmp/sm-check-run-1-0.json', {
            write: function () { return true; },
            exec: function () { return ''; },
            del: function (o) { deleted.push(o.path); }
        });
    assert.deepEqual(deleted, ['/tmp/sm-check-run-1-0.json']);
});

test('the temp file is deleted when the gh call throws — and the error propagates', function () {
    var deleted = [];
    var threw = null;
    try {
        crs.postCheckRunStamp({ owner: 'a', repo: 'b' },
            crs.buildCheckRunBody({ name: 'n', headSha: 's', status: 'in_progress',
                                    title: 't', summary: 'm' }),
            '/tmp/sm-check-run-1-1.json', {
                write: function () { return true; },
                exec: function () { throw new Error('exit code 2: Bad substitution'); },
                del: function (o) { deleted.push(o.path); }
            });
    } catch (e) { threw = e; }
    assert.ok(threw, 'the caller must see the failure (warn-and-skip is the caller\'s job)');
    assert.deepEqual(deleted, ['/tmp/sm-check-run-1-1.json'], 'AC3: deleted despite the failure');
});

test('a failed write still attempts the delete and propagates (E2 — unwritable temp dir)', function () {
    var deleted = [];
    var threw = null;
    try {
        crs.postCheckRunStamp({ owner: 'a', repo: 'b' },
            crs.buildCheckRunBody({ name: 'n', headSha: 's', status: 'in_progress',
                                    title: 't', summary: 'm' }),
            '/tmp/sm-check-run-1-2.json', {
                write: function () { throw new Error('Permission denied'); },
                exec: function () { throw new Error('must not run'); },
                del: function (o) { deleted.push(o.path); }
            });
    } catch (e) { threw = e; }
    assert.ok(threw && String(threw.message).indexOf('Permission denied') !== -1,
        'E2: the write failure surfaces for the caller\'s warn-and-skip');
    assert.deepEqual(deleted, ['/tmp/sm-check-run-1-2.json'],
        'AC3: the delete is attempted even after a failed write');
    assert.equal(deleted.length, 1, 'exactly one delete attempt');
});

test('a throwing delete never masks a successful post', function () {
    var ok = crs.postCheckRunStamp({ owner: 'a', repo: 'b' },
        crs.buildCheckRunBody({ name: 'n', headSha: 's', status: 'in_progress',
                                title: 't', summary: 'm' }),
        '/tmp/sm-check-run-1-3.json', {
            write: function () { return true; },
            exec: function () { return ''; },
            del: function () { throw new Error('rm failed'); }
        });
    assert.equal(ok, true, 'cleanup failure must not fail the stamp');
});

});

suite('checkRunStamp: E1 — oversized summary truncates with a marker', function () {

test('a summary at or under 65,535 chars passes through untouched', function () {
    var at = new Array(65535 + 1).join('x');
    assert.equal(crs.truncateCheckRunSummary(at), at, 'exactly at the limit: untouched');
    assert.equal(crs.truncateCheckRunSummary('short'), 'short');
    assert.equal(crs.truncateCheckRunSummary(''), '');
    assert.equal(crs.truncateCheckRunSummary(null), '');
});

test('a summary past the limit is truncated to ≤65,535 chars and carries the marker', function () {
    var big = new Array(70000 + 1).join('y');
    var out = crs.truncateCheckRunSummary(big);
    assert.ok(out.length <= 65535,
        'the truncated summary must still satisfy the GitHub output limit, got ' + out.length);
    assert.ok(out.indexOf(crs.SUMMARY_TRUNCATION_MARKER, out.length - crs.SUMMARY_TRUNCATION_MARKER.length) !== -1,
        'the truncation marker is appended');
    assert.equal(out.slice(0, 4), 'yyyy', 'the head of the summary is preserved');
});

test('buildCheckRunBody truncates an oversized summary (E1)', function () {
    var body = crs.buildCheckRunBody({
        name: 'Quality gate', headSha: 'abc', status: 'completed', conclusion: 'success',
        title: 't', summary: new Array(80000 + 1).join('z')
    });
    assert.ok(body.output.summary.length <= 65535);
    assert.ok(body.output.summary.indexOf('[truncated') !== -1, 'marker present');
});

});

suite('checkRunStamp: the single shellQuote helper (AC5)', function () {

test('shellQuote single-quotes hostile text the factoryState way', function () {
    assert.equal(crs.shellQuote("ai/g'h-757;touch /tmp/pwn"),
        "'ai/g'\\''h-757;touch /tmp/pwn'");
    assert.equal(crs.shellQuote('${{ matrix.os }}'), "'${{ matrix.os }}'");
    assert.equal(crs.shellQuote(''), "''");
});

});

// ── gh-1118 never-again: ONE retry before a stamp is counted as failed ──────
// The tick log showed ⚠️ lines but the check-runs stayed absent downstream —
// a transient gh/sh hiccup must re-fire before the failure is surfaced in
// stamps_failed. The helper keeps the retry OUT of the SM stamp loop so the
// loop's CRAP stays flat; the caller counts `false` returns.
suite('checkRunStamp: postCheckRunStampRetryOnce (gh-1118 retry-once)', function () {

    function captureIo(execResults, writeResults) {
        var io = { execs: 0, writes: 0, dels: 0, retries: [] };
        io.write = function () {
            var err = (writeResults && writeResults.length > io.writes) ? writeResults[io.writes] : null;
            io.writes++;
            if (err) throw err;
            return true;
        };
        io.exec = function () {
            var err = (execResults && execResults.length > io.execs) ? execResults[io.execs] : null;
            io.execs++;
            if (err) throw err;
            return '';
        };
        io.del = function () { io.dels++; return true; };
        io.onRetry = function (e) { io.retries.push(e); };
        return io;
    }

    var BODY = { name: 'Quality gate', head_sha: 'abc', status: 'completed',
        output: { title: 't', summary: 's' } };

    test('immediate success: one attempt, no retry callback', function () {
        var io = captureIo([]);
        var ok = crs.postCheckRunStampRetryOnce({ owner: 'o', repo: 'r' }, BODY,
            '/tmp/sm-check-run-1-1.json', io, io.onRetry);
        assert.equal(ok, true, 'a clean first attempt posts');
        assert.equal(io.execs, 1, 'exactly one gh call');
        assert.equal(io.retries.length, 0, 'no retry fired');
        assert.equal(io.dels, 1, 'the temp file is still cleaned up');
    });

    test('transient failure recovers on the retry: true, two attempts, one retry callback', function () {
        var io = captureIo([new Error('transient exit 1')]);
        var ok = crs.postCheckRunStampRetryOnce({ owner: 'o', repo: 'r' }, BODY,
            '/tmp/sm-check-run-1-2.json', io, io.onRetry);
        assert.equal(ok, true, 'the retry succeeded');
        assert.equal(io.execs, 2, 'first attempt + one retry — never a third');
        assert.equal(io.retries.length, 1, 'the caller is told about the first failure');
        assert.equal(io.retries[0].message, 'transient exit 1');
        assert.equal(io.dels, 2, 'each attempt cleans up its temp file');
    });

    test('persistent failure: false after exactly one retry (two attempts total)', function () {
        var io = captureIo([new Error('exit 2: Bad substitution'),
                            new Error('exit 2: Bad substitution')]);
        var ok = crs.postCheckRunStampRetryOnce({ owner: 'o', repo: 'r' }, BODY,
            '/tmp/sm-check-run-1-3.json', io, io.onRetry);
        assert.equal(ok, false, 'the caller counts the stamp as failed');
        assert.equal(io.execs, 2, 'bounded at two attempts');
        assert.equal(io.retries.length, 1, 'only the first failure notifies');
    });

    test('a failed body-file write (E2) is retried too and recovers', function () {
        var io = captureIo([], [new Error('EACCES: temp dir unwritable')]);
        var ok = crs.postCheckRunStampRetryOnce({ owner: 'o', repo: 'r' }, BODY,
            '/tmp/sm-check-run-1-4.json', io, io.onRetry);
        assert.equal(ok, true, 'the write retry succeeded');
        assert.equal(io.writes, 2, 'two body writes');
        assert.equal(io.execs, 1, 'the gh call ran once the write landed');
    });

    test('a missing onRetry callback still retries (never a crash)', function () {
        var io = captureIo([new Error('exit 2'), new Error('exit 2')]);
        var ok = crs.postCheckRunStampRetryOnce({ owner: 'o', repo: 'r' }, BODY,
            '/tmp/sm-check-run-1-5.json', io, null);
        assert.equal(ok, false);
        assert.equal(io.execs, 2);
    });

});