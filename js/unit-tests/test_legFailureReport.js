/**
 * Unit tests for js/common/legFailureReport.js — the shared leg-failure
 * report builder (gh-1363).
 *
 * Today a failed leg posts one information-free bare link
 * ("🤖 AI Teammate run failure: <run url>"). gh-1363 enriches every
 * leg-failure report with bounded, structured context, and requires the
 * workflow-side failure notice and the in-leg setup failure path
 * (js/preCliDevelopmentSetup.js → "Development Setup Error") to share ONE
 * report builder. This module is that builder: pure helpers only (signature
 * normalization, excerpt trimming, pre-flight line, rendering), IO injected.
 *
 * AC coverage:
 *   AC1  the report carries phase, failing step name, ≤30-line log excerpt,
 *        run id + link.
 *   AC2  two consecutive failures with the same normalized signature →
 *        "identical failure #2 in a row"; a different signature →
 *        "first failure with this signature".
 *   AC3  SHAs, run ids, timestamps and URLs never leak into the signature —
 *        two genuinely-different crashes that share only the error class
 *        normalize to the SAME signature, and one crash whose message
 *        embeds a SHA normalizes to the message without it.
 *   AC4  no secrets in excerpts — an Actions-masked token fixture (***)
 *        passes through verbatim and nothing un-masks it.
 *   AC5  report size bounded — the excerpt hard cap (30 lines) is enforced.
 *   AC6  existing behavior preserved — the success-path notice keeps the
 *        historical bare-link line byte-shape.
 *
 * Pure module — no dmtools globals, no requires; IO (git commands, env
 * reads) arrives injected so every path is unit-testable.
 */

/* global loadModule, makeRequire, assert, test, suite, file_read */

var legFailureReport = loadModule('js/common/legFailureReport.js');
var commentMarkup = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));

var MARKDOWN = commentMarkup.forFlavor('markdown');
var JIRA = commentMarkup.forFlavor('jira');

// ── helpers ──────────────────────────────────────────────────────────────

/** A log of n numbered lines. */
function numberedLog(n) {
    var lines = [];
    for (var i = 1; i <= n; i++) lines.push('log line ' + i);
    return lines.join('\n');
}

function countLines(text) {
    return String(text).split('\n').length;
}

function excerptBlockOf(rendered) {
    var m = rendered.match(/```[a-z]*\n([\s\S]*?)\n```/);
    return m ? m[1] : '';
}

// ── AC3 — signature normalization ─────────────────────────────────────────

suite('legFailureReport.normalizeSignature — noise stripped (AC3)', function () {

    test('a crash whose message embeds a SHA normalizes to the message without it', function () {
        var withSha = 'fatal: cannot lock ref ai/gh-1: 9f2c01ab8de71234567890abcdef1234567890ab is not a tree';
        var withoutSha = 'fatal: cannot lock ref ai/gh-1: is not a tree';
        assert.equal(legFailureReport.normalizeSignature(withSha), legFailureReport.normalizeSignature(withoutSha));
        assert.equal(legFailureReport.normalizeSignature(withSha).indexOf('9f2c01ab'), -1,
            'the SHA does not leak into the signature');
    });

    test('short SHAs are stripped too', function () {
        var sig = legFailureReport.normalizeSignature('checkout failed at deadbeef while syncing');
        assert.equal(sig, 'checkout failed at while syncing');
    });

    test('run ids and epoch timestamps are stripped', function () {
        var sig = legFailureReport.normalizeSignature('run 17543219000 failed at 1762252800000 after 3 tries');
        assert.equal(sig.indexOf('17543219000'), -1, 'run id gone');
        assert.equal(sig.indexOf('1762252800000'), -1, 'epoch ms gone');
    });

    test('ISO-8601 timestamps are stripped', function () {
        var sig = legFailureReport.normalizeSignature('failed 2026-11-04T10:00:00Z (see 2026-11-04)');
        assert.equal(sig, 'failed (see )');
        assert.equal(sig.indexOf('2026-11-04'), -1, 'timestamp gone');
    });

    test('URLs are stripped', function () {
        var sig = legFailureReport.normalizeSignature(
            'error: see https://github.com/acme/widgets/actions/runs/17500000000 for details');
        assert.equal(sig.indexOf('https://'), -1, 'URL gone');
        assert.equal(sig, 'error: see for details');
    });

    test('path-like tokens are stripped', function () {
        var sig = legFailureReport.normalizeSignature('ENOENT: no such file /home/runner/work/x/y.md open');
        assert.equal(sig.indexOf('/home/runner'), -1, 'absolute path gone');
    });

    test('whitespace collapses — the normalized text is stable', function () {
        var a = legFailureReport.normalizeSignature('   error:   boom\n\n\twith   noise   ');
        var b = legFailureReport.normalizeSignature('error: boom with noise');
        assert.equal(a, b);
    });

    test('the normalized signature is length-capped', function () {
        var long = new Array(60).join('word ');
        assert.ok(legFailureReport.normalizeSignature(long).length <= 200, 'capped at 200 chars');
    });

});

suite('legFailureReport.failureSignature — genuinely-different crashes, same class (AC3)', function () {

    var SIG_PARTS = { workflow: 'ai-teammate.yml', step: 'Checkout' };

    test('two crashes differing only in SHAs/ids/timestamps/URLs share one signature', function () {
        var crashA = 'fatal: reference 9f2c01ab8de7 is not a tree (run 17500000001 at 2026-11-04T10:00:00Z) https://ci/run/17500000001';
        var crashB = 'fatal: reference 3fe11bb2c41 is not a tree (run 17500000099 at 2026-11-04T11:30:00Z) https://ci/run/17500000099';
        var sigA = legFailureReport.failureSignature(Object.assign({}, SIG_PARTS, { message: crashA }));
        var sigB = legFailureReport.failureSignature(Object.assign({}, SIG_PARTS, { message: crashB }));
        assert.equal(sigA, sigB, 'noise-free error class — one signature');
    });

    test('genuinely different error classes never collide', function () {
        var sigA = legFailureReport.failureSignature(Object.assign({}, SIG_PARTS, { message: 'checkout failed: ref not a tree' }));
        var sigB = legFailureReport.failureSignature(Object.assign({}, SIG_PARTS, { message: 'setup command failed: npm ci exit 1' }));
        assert.notEqual(sigA, sigB);
    });

    test('workflow and step participate in the signature', function () {
        var message = 'boom';
        var withStepA = legFailureReport.failureSignature({ workflow: 'w.yml', step: 'Checkout', message: message });
        var withStepB = legFailureReport.failureSignature({ workflow: 'w.yml', step: 'Agent', message: message });
        var withWf = legFailureReport.failureSignature({ workflow: 'other.yml', step: 'Checkout', message: message });
        assert.notEqual(withStepA, withStepB, 'step is part of the key');
        assert.notEqual(withStepA, withWf, 'workflow is part of the key');
    });

    test('signature shape: workflow | step | normalized message', function () {
        var sig = legFailureReport.failureSignature({ workflow: 'w.yml', step: 'S', message: 'boom' });
        assert.equal(sig, 'w.yml | S | ' + legFailureReport.normalizeSignature('boom'));
    });

});

// ── AC2 — repeat count ────────────────────────────────────────────────────

suite('legFailureReport.consecutiveRepeatCount / repeatPhrase (AC2)', function () {

    var SIG = 'wf.yml | Checkout | fatal ref not a tree';
    var OTHER = 'wf.yml | Agent | npm ci exit 1';

    test('no priors → 1 → first failure with this signature', function () {
        var n = legFailureReport.consecutiveRepeatCount(SIG, []);
        assert.equal(n, 1);
        assert.equal(legFailureReport.repeatPhrase(n), 'first failure with this signature');
    });

    test('two consecutive failures → the second report says identical failure #2 in a row', function () {
        var first = legFailureReport.consecutiveRepeatCount(SIG, []);
        var second = legFailureReport.consecutiveRepeatCount(SIG, [SIG]); // chronological: one prior failure
        assert.equal(first, 1);
        assert.equal(second, 2);
        assert.equal(legFailureReport.repeatPhrase(second), 'identical failure #2 in a row');
    });

    test('three in a row → identical failure #3 in a row', function () {
        var n = legFailureReport.consecutiveRepeatCount(SIG, [SIG, SIG]); // chronological: two prior failures
        assert.equal(n, 3);
        assert.equal(legFailureReport.repeatPhrase(n), 'identical failure #3 in a row');
    });

    test('a non-matching prior breaks the streak — only CONSECUTIVE failures count', function () {
        // chronological: matching failure, then a different failure, then current
        assert.equal(legFailureReport.consecutiveRepeatCount(SIG, [SIG, OTHER]), 1);
        // most recent prior matches, older one differs
        assert.equal(legFailureReport.consecutiveRepeatCount(SIG, [OTHER, SIG]), 2);
    });

    test('unknown signature (derivation unavailable) → null → no repeat line', function () {
        assert.equal(legFailureReport.consecutiveRepeatCount(null, [SIG, SIG]), null);
        assert.equal(legFailureReport.repeatPhrase(null), null);
    });

});

// ── machine-readable signature history ────────────────────────────────────

suite('legFailureReport.signatureLine / parseSignatureLines', function () {

    test('roundtrip: the line parses back to the signature', function () {
        var sig = 'wf.yml | Checkout | fatal ref not a tree';
        var parsed = legFailureReport.parseSignatureLines(['prelude\n' + legFailureReport.signatureLine(sig) + '\npost']);
        assert.deepEqual(parsed, [sig]);
    });

    test('bodies without the marker yield nothing', function () {
        assert.deepEqual(legFailureReport.parseSignatureLines(['just a bare link comment', '']), []);
    });

    test('multiple comments keep chronological order (most recent last)', function () {
        var s1 = 'w | s1 | a';
        var s2 = 'w | s2 | b';
        var parsed = legFailureReport.parseSignatureLines([
            legFailureReport.signatureLine(s1),
            legFailureReport.signatureLine(s2)
        ]);
        assert.deepEqual(parsed, [s1, s2]);
    });

});

// ── AC5 — excerpt trimming ────────────────────────────────────────────────

suite('legFailureReport.trimLogExcerpt — bounded excerpt (AC5)', function () {

    test('a short log passes through (multi-line content preserved)', function () {
        var out = legFailureReport.trimLogExcerpt('line a\nline b\nline c');
        assert.equal(out, 'line a\nline b\nline c');
    });

    test('default keeps the LAST 10 lines of a long log', function () {
        var out = legFailureReport.trimLogExcerpt(numberedLog(100));
        assert.equal(countLines(out), 10, 'default excerpt is 10 lines');
        assert.ok(out.indexOf('log line 100') !== -1, 'the tail survives');
        assert.equal(out.indexOf('log line 1\n'), -1, 'the head is dropped');
    });

    test('explicit maxLines is honored', function () {
        var out = legFailureReport.trimLogExcerpt(numberedLog(20), 3);
        assert.equal(countLines(out), 3);
        assert.ok(out.indexOf('log line 20') !== -1);
    });

    test('hard cap: no caller argument can exceed 30 lines', function () {
        var out = legFailureReport.trimLogExcerpt(numberedLog(100), 500);
        assert.equal(countLines(out), 30, 'hard cap is 30 lines');
    });

    test('trailing blank lines are dropped before trimming', function () {
        var out = legFailureReport.trimLogExcerpt('a\nb\n\n\n\n', 10);
        assert.equal(out, 'a\nb');
    });

    test('ANSI escapes are stripped', function () {
        var out = legFailureReport.trimLogExcerpt('\u001b[31mred error\u001b[0m detail');
        assert.equal(out, 'red error detail');
    });

    test('null/empty log → empty string', function () {
        assert.equal(legFailureReport.trimLogExcerpt(null), '');
        assert.equal(legFailureReport.trimLogExcerpt(''), '');
    });

    test('a non-numeric maxLines falls back to the default 10', function () {
        var out = legFailureReport.trimLogExcerpt(numberedLog(20), 'not-a-number');
        assert.equal(countLines(out), 10);
    });

});

// ── pre-flight state line ─────────────────────────────────────────────────

suite('legFailureReport.preflightLine — canonical leg-start line', function () {

    test('canonical format: branch= head= dirty= staged= paths=[]', function () {
        var line = legFailureReport.preflightLine({
            branch: 'ai/gh-1363',
            head: 'f3183be0925cf2b3fe399b50323fbc533ccf223a',
            dirty: 2,
            staged: 1,
            paths: ['js/a.js', 'js/b.js']
        });
        assert.equal(line,
            'git pre-flight: branch=ai/gh-1363 head=f3183be0925cf2b3fe399b50323fbc533ccf223a dirty=2 staged=1 ' +
            'paths=[js/a.js, js/b.js]');
    });

    test('paths cap at 5 with a "+N more" suffix', function () {
        var line = legFailureReport.preflightLine({
            branch: 'b', head: 'f3183be', dirty: 7, staged: 0,
            paths: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
        });
        assert.ok(line.indexOf('paths=[p1, p2, p3, p4, p5 +2 more]') !== -1, 'got: ' + line);
    });

    test('five or fewer paths carry no "more" suffix', function () {
        var line = legFailureReport.preflightLine({ branch: 'b', head: 'f3183be', dirty: 5, staged: 0, paths: ['p1', 'p2', 'p3', 'p4', 'p5'] });
        assert.ok(line.indexOf('paths=[p1, p2, p3, p4, p5]') !== -1);
        assert.equal(line.indexOf('more'), -1);
    });

    test('clean workspace renders paths=[]', function () {
        var line = legFailureReport.preflightLine({ branch: 'b', head: 'f3183be', dirty: 0, staged: 0, paths: [] });
        assert.ok(line.indexOf('paths=[]') !== -1);
    });

    test('no state (collection failed) → null — the report simply omits the line', function () {
        assert.equal(legFailureReport.preflightLine(null), null);
        assert.equal(legFailureReport.preflightLine(undefined), null);
        assert.equal(legFailureReport.preflightLine({ head: 'f3183be' }), null, 'branch missing');
    });

    test('very long paths shrink below the segment cap, keeping the +N more summary', function () {
        var longPath = new Array(80).join('x');
        var line = legFailureReport.preflightLine({
            branch: 'b', head: 'f3183be', dirty: 5, staged: 0,
            paths: [longPath, longPath, longPath, longPath, longPath]
        });
        assert.ok(line.length < 500, 'line stays bounded, got ' + line.length);
        assert.ok(line.indexOf(' +3 more') !== -1, 'dropped entries summarized (2×79-char paths + ", " = exactly 160 ≤ cap): ' + line.slice(-40));
    });

    test('missing counts render as 0', function () {
        var line = legFailureReport.preflightLine({ branch: 'b', head: 'f3183be', paths: [] });
        assert.ok(line.indexOf('dirty=0 staged=0') !== -1, 'got: ' + line);
    });

});

suite('legFailureReport.collectPreflightState — injected git runner', function () {

    function makeRunner(responses) {
        return function (command) {
            if (Object.prototype.hasOwnProperty.call(responses, command)) return responses[command];
            throw new Error('unexpected command: ' + command);
        };
    }

    var PORCELAIN = ' M js/a.js\nM  js/b.js\n?? new.txt\nR  old.js -> new.js\n';

    test('parses branch, head, dirty/staged counts and paths from git', function () {
        var state = legFailureReport.collectPreflightState(makeRunner({
            'git rev-parse --abbrev-ref HEAD': 'ai/gh-1363\n',
            'git rev-parse HEAD': 'f3183be0925cf2b3fe399b50323fbc533ccf223a\n',
            'git status --porcelain': PORCELAIN
        }));
        assert.equal(state.branch, 'ai/gh-1363');
        assert.equal(state.head, 'f3183be0925cf2b3fe399b50323fbc533ccf223a');
        assert.equal(state.dirty, 4, 'every porcelain entry counts as dirty');
        assert.equal(state.staged, 2, 'index column set → staged (M  / R )');
        assert.deepEqual(state.paths, ['js/a.js', 'js/b.js', 'new.txt', 'old.js -> new.js']);
    });

    test('tolerates the {output} command-result shape', function () {
        var state = legFailureReport.collectPreflightState(makeRunner({
            'git rev-parse --abbrev-ref HEAD': { output: 'main\n' },
            'git rev-parse HEAD': { output: 'abc\n' },
            'git status --porcelain': { output: '' }
        }));
        assert.equal(state.branch, 'main');
        assert.equal(state.head, 'abc');
        assert.equal(state.dirty, 0);
        assert.deepEqual(state.paths, []);
    });

    test('quoted paths with spaces are unquoted', function () {
        var state = legFailureReport.collectPreflightState(makeRunner({
            'git rev-parse --abbrev-ref HEAD': 'main',
            'git rev-parse HEAD': 'abc',
            'git status --porcelain': '?? "my file with spaces.txt"\n'
        }));
        assert.deepEqual(state.paths, ['my file with spaces.txt']);
    });

    test('null command output and blank porcelain paths are tolerated', function () {
        var state = legFailureReport.collectPreflightState(makeRunner({
            'git rev-parse --abbrev-ref HEAD': null,
            'git rev-parse HEAD': undefined,
            'git status --porcelain': '?? \n\n'
        }));
        assert.equal(state.branch, '');
        assert.equal(state.head, '');
        assert.equal(state.dirty, 1, 'the blank entry counts, its empty path is skipped');
        assert.deepEqual(state.paths, []);
    });

    test('a git failure propagates — the caller wraps it best-effort', function () {
        var threw = false;
        try {
            legFailureReport.collectPreflightState(function () { throw new Error('git missing'); });
        } catch (e) {
            threw = true;
        }
        assert.ok(threw, 'collectPreflightState is the raw collector; wrapping is the caller concern');
    });

});

// ── AC1/AC4 — report rendering ────────────────────────────────────────────

suite('legFailureReport.renderReport — one enriched section block (AC1)', function () {

    var PARTS = {
        preflightLine: 'git pre-flight: branch=ai/gh-1 head=f3183be dirty=1 staged=0 paths=[x.js]',
        phase: 'setup',
        step: 'Git Branch Setup',
        runId: '17500000001',
        runUrl: 'https://github.com/acme/widgets/actions/runs/17500000001',
        excerpt: numberedLog(60),
        repeatCount: 2,
        signature: 'ai-teammate.yml | Git Branch Setup | fatal ref not a tree'
    };

    test('carries phase, failing step, run id + link, repeat line and the signature line', function () {
        var out = legFailureReport.renderReport(MARKDOWN, PARTS);
        assert.ok(out.indexOf('**Phase:** setup') !== -1, 'phase: ' + out);
        assert.ok(out.indexOf('**Failing step:** Git Branch Setup') !== -1, 'step');
        assert.ok(out.indexOf('17500000001') !== -1, 'run id');
        assert.ok(out.indexOf('https://github.com/acme/widgets/actions/runs/17500000001') !== -1, 'run link');
        assert.ok(out.indexOf('identical failure #2 in a row') !== -1, 'repeat');
        assert.ok(out.indexOf('failure-signature: ai-teammate.yml | Git Branch Setup | fatal ref not a tree') !== -1,
            'machine-readable signature line');
        assert.ok(out.indexOf('git pre-flight: branch=ai/gh-1') !== -1, 'pre-flight line');
    });

    test('excerpt block is hard-capped at 30 lines even for a longer raw log (AC5)', function () {
        var out = legFailureReport.renderReport(MARKDOWN, PARTS);
        var block = excerptBlockOf(out);
        assert.equal(countLines(block), 30, 'rendered excerpt is capped');
        assert.ok(block.indexOf('log line 60') !== -1, 'tail survives');
    });

    test('AC4 secret fixture: the Actions-masked token passes through verbatim, nothing un-masks it', function () {
        var maskedLog = 'Cloning with token ghp_FakeFakeFake1234567890***\n' +
            'fatal: Authentication failed for ***\n' +
            'The token ghp_FakeFakeFake1234567890*** was masked by Actions';
        var out = legFailureReport.renderReport(MARKDOWN, Object.assign({}, PARTS, { excerpt: maskedLog }));
        assert.ok(out.indexOf('ghp_FakeFakeFake1234567890***') !== -1, 'masked fixture preserved');
        assert.ok(out.indexOf('fatal: Authentication failed for ***') !== -1);
        // every token-shaped occurrence in the report still ends in the mask —
        // an un-masked secret would end in plain alphanumerics
        var tokens = out.match(/ghp_[A-Za-z0-9*]+/g) || [];
        assert.ok(tokens.length >= 2, 'fixture tokens present in the excerpt block');
        for (var i = 0; i < tokens.length; i++) {
            assert.ok(/\*\*\*$/.test(tokens[i]), 'every token occurrence stays masked: ' + tokens[i]);
        }
    });

    test('absent optional fields are omitted — no empty section noise', function () {
        var out = legFailureReport.renderReport(MARKDOWN, { phase: 'ai-work' });
        assert.ok(out.indexOf('**Phase:** ai-work') !== -1);
        assert.equal(out.indexOf('Failing step'), -1);
        assert.equal(out.indexOf('pre-flight'), -1);
        assert.equal(out.indexOf('**Repeat:**'), -1);
        assert.equal(out.indexOf('Log excerpt'), -1);
        assert.equal(out.indexOf('failure-signature:'), -1);
    });

    test('repeatCount 1 renders "first failure with this signature"', function () {
        var out = legFailureReport.renderReport(MARKDOWN, { phase: 'ai-work', repeatCount: 1 });
        assert.ok(out.indexOf('first failure with this signature') !== -1);
    });

    test('jira flavor renders wiki markup — no markdown constructs', function () {
        var out = legFailureReport.renderReport(JIRA, { phase: 'setup', step: 'Environment Setup' });
        assert.ok(out.indexOf('*Phase:* setup') !== -1, 'jira bold: ' + out);
        assert.ok(out.indexOf('**') === -1, 'no markdown bold');
        assert.ok(out.indexOf('###') === -1, 'no markdown heading');
    });

});

suite('legFailureReport.buildFailureComment / outcomeLine — the notice comment', function () {

    test('failure notice: heading + enriched sections in markdown', function () {
        var body = legFailureReport.buildFailureComment({
            phase: 'ai-work',
            step: 'Run agent',
            runId: '17500000001',
            runUrl: 'https://github.com/acme/widgets/actions/runs/17500000001',
            excerpt: numberedLog(15),
            repeatCount: 2,
            signature: 'sig'
        }, MARKDOWN);
        assert.ok(body.indexOf('### 🤖 AI Teammate run failed') === 0, 'starts with the notice heading: ' + body);
        assert.ok(body.indexOf('**Phase:** ai-work') !== -1);
        assert.ok(body.indexOf('identical failure #2 in a row') !== -1);
    });

    test('excerpt in the notice is capped at 30 lines (AC5)', function () {
        var body = legFailureReport.buildFailureComment({ phase: 'ai-work', excerpt: numberedLog(80) }, MARKDOWN);
        assert.equal(countLines(excerptBlockOf(body)), 30);
    });

    test('AC6: the success-path line keeps the historical bare-link byte-shape', function () {
        assert.equal(
            legFailureReport.outcomeLine('success', 'https://github.com/acme/widgets/actions/runs/1'),
            '🤖 AI Teammate run success: https://github.com/acme/widgets/actions/runs/1');
        assert.equal(
            legFailureReport.outcomeLine('failure', 'https://github.com/acme/widgets/actions/runs/2'),
            '🤖 AI Teammate run failure: https://github.com/acme/widgets/actions/runs/2');
    });

});

// ── run identity from the environment ─────────────────────────────────────

suite('legFailureReport.runUrlFromEnv / runIdFromEnv — best-effort run identity', function () {

    function envReader(values) {
        return function (name) {
            if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
            return null;
        };
    }

    test('full CI env → run URL + id', function () {
        var read = envReader({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/widgets', GITHUB_RUN_ID: '1750' });
        assert.equal(legFailureReport.runUrlFromEnv(read), 'https://github.com/acme/widgets/actions/runs/1750');
        assert.equal(legFailureReport.runIdFromEnv(read), '1750');
    });

    test('missing env (local run) → null, never a throw', function () {
        assert.equal(legFailureReport.runUrlFromEnv(envReader({ GITHUB_SERVER_URL: 'https://github.com' })), null);
        assert.equal(legFailureReport.runUrlFromEnv(envReader({})), null);
        assert.equal(legFailureReport.runIdFromEnv(envReader({})), null);
    });

    test('a throwing reader degrades to null', function () {
        assert.equal(legFailureReport.runUrlFromEnv(function () { throw new Error('no java bridge'); }), null);
    });

});

// ── pack carry contract (factory-setup ships the builder for the awf flip) ──

suite('legFailureReport — factory-setup carry contract', function () {

    var PACKS = file_read({ path: 'ci/release_packs.mjs' }) || '';
    var SCRIPT = file_read({ path: 'scripts/report-leg-failure.sh' }) || '';

    test('the notice transport script ships in the factory-setup asset', function () {
        assert.ok(PACKS.indexOf("'report-leg-failure.sh'") !== -1,
            'FACTORY_SETUP_SCRIPTS must list report-leg-failure.sh');
    });

    test('the pure builder (and its markup closure) ship in the factory-setup asset', function () {
        assert.ok(PACKS.indexOf("'js/common/legFailureReport.js'") !== -1, 'builder staged');
        assert.ok(PACKS.indexOf("'js/common/commentMarkup.js'") !== -1, 'markup flavor staged');
        assert.ok(PACKS.indexOf("'js/common/ticketKeyShapes.js'") !== -1, 'key-shape closure staged');
    });

    test('the transport script collects the failed-step log excerpt with the 30-line cap', function () {
        assert.ok(SCRIPT.indexOf('--log-failed') !== -1, 'gh run view --log-failed per the ticket');
        assert.ok(SCRIPT.indexOf('tail -n 30') !== -1, 'hard cap 30');
    });

    test('the transport script renders through the shared builder — no second normalizer', function () {
        assert.ok(SCRIPT.indexOf('legFailureReport.js') !== -1, 'requires the shipped builder');
        assert.ok(SCRIPT.indexOf('buildFailureComment') !== -1, 'builds the report with it');
    });

    test('the transport script keeps the historical bare-link line for success (AC6)', function () {
        assert.ok(SCRIPT.indexOf('🤖 AI Teammate run ') !== -1, 'bare-link line shape preserved');
        assert.ok(SCRIPT.indexOf('--body-file -') !== -1, 'failure body posts via stdin file');
    });

    test('the suite is wired into run_all.json', function () {
        var all = file_read({ path: 'js/unit-tests/run_all.json' }) || '';
        assert.ok(all.indexOf('test_legFailureReport.js') !== -1, 'test_legFailureReport.js must be registered');
    });

});
