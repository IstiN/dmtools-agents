/**
 * Unit tests for js/common/toolchainSummary.js — the gh-1137 leg-summary
 * annotation: the dev/rework leg's summary (outputs/response.md content) must
 * carry one machine-generated line
 *
 *     toolchain: dart <version> (CI: <pin>, match: yes|no)
 *
 * so a reviewer can check every "format-clean" / analyzer claim against the
 * SDK the leg actually verified with (live #433: the leg disputed a mechanical
 * dart_format red because its runner SDK differed from CI's 3.13.5).
 *
 * The line is produced by `setup/dart.sh summary` (network-free — covered by
 * test_dartSetup.js); this module resolves the script inside the leg
 * workspace, runs it at post time (the SDK is already installed by the leg
 * preamble) and appends the line to the response text. It must NEVER break
 * the post action: every failure path returns the input unchanged.
 *
 * Wiring contracts covered here:
 *   - developTicketAndCreatePR.js (dev leg) consumes the helper;
 *   - pushReworkChanges.js (rework leg) consumes the helper;
 *   - any runner config that declares a dart preamble in
 *     customParams.setupCommands must run the repo-owned setup/dart.sh
 *     (deployment-specific runner configs live in the consuming repo, not
 *     here — the preamble contract itself stays generic).
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadToolchainSummary(mocks) {
    return loadModule('js/common/toolchainSummary.js', makeRequire({}), Object.assign({
        file_read: function() { return null; },
        cli_execute_command: function() { return ''; }
    }, mocks || {}));
}

// ── Script resolution ────────────────────────────────────────────────────────

suite('toolchainSummary: dart.sh resolution inside the leg workspace', function () {

    test('prefers <workingDir>/setup/dart.sh (self-hosted engine layout)', function () {
        var seen = [];
        var argsUsed = null;
        var ts = loadToolchainSummary({
            file_read: function(opts) {
                seen.push(opts.path);
                return opts.path === 'repo/setup/dart.sh' ? '#!/usr/bin/env bash' : null;
            },
            cli_execute_command: function(args) {
                argsUsed = args;
                return 'toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)';
            }
        });
        var out = ts.withToolchainLine('## Fix\n- done', { workingDir: 'repo' });
        // gh-1137 review: command text is workingDirectory-RELATIVE in this
        // engine — the workingDir-prefixed probe path is only for file_read.
        // Running the prefixed path INSIDE workingDirectory would double the
        // prefix and silently exit 127 on nested layouts.
        assert.equal(argsUsed.command, 'bash setup/dart.sh summary',
            'the command must be workingDir-relative, got: ' + argsUsed.command);
        assert.equal(argsUsed.workingDirectory, 'repo',
            'the command must run inside the leg workingDir, got: ' + JSON.stringify(argsUsed));
        assert.equal(seen.indexOf('repo/agents/setup/dart.sh'), -1,
            'no probe past the first hit, seen: ' + seen.join(','));
        assert.ok(out.indexOf('toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)') !== -1, 'got: ' + out);
    });

    test('falls back to agents/setup/dart.sh (target-repo submodule layout)', function () {
        var ts = loadToolchainSummary({
            file_read: function(opts) {
                return opts.path === 'repo/agents/setup/dart.sh' ? '#!/usr/bin/env bash' : null;
            },
            cli_execute_command: function(args) {
                assert.equal(args.command, 'bash agents/setup/dart.sh summary', 'got: ' + args.command);
                assert.equal(args.workingDirectory, 'repo');
                return 'toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)';
            }
        });
        var out = ts.withToolchainLine('body', { workingDir: 'repo' });
        assert.ok(out.indexOf('match: yes') !== -1, 'got: ' + out);
    });

    test('a dot workingDir (engine-rooted leg) runs the repo-relative path too', function () {
        var ts = loadToolchainSummary({
            file_read: function(opts) {
                return opts.path === './setup/dart.sh' ? '#!/usr/bin/env bash' : null;
            },
            cli_execute_command: function(args) {
                assert.equal(args.command, 'bash setup/dart.sh summary', 'got: ' + args.command);
                assert.equal(args.workingDirectory, '.');
                return 'toolchain: dart 3.9.4 (CI: 3.9.4, match: yes)';
            }
        });
        var out = ts.withToolchainLine('body', { workingDir: '.' });
        assert.ok(out.indexOf('match: yes') !== -1, 'got: ' + out);
    });

    test('no dart.sh anywhere → response returned unchanged (never breaks the post action)', function () {
        var ts = loadToolchainSummary({});
        var out = ts.withToolchainLine('## Fix\n- done', { workingDir: 'repo' });
        assert.equal(out, '## Fix\n- done');
    });
});

// ── Line appending ───────────────────────────────────────────────────────────

suite('toolchainSummary.withToolchainLine: the leg summary gains the toolchain line', function () {

    function tsWithCommandOutput(output) {
        return loadToolchainSummary({
            file_read: function(opts) {
                return opts.path === 'repo/setup/dart.sh' ? '#!/usr/bin/env bash' : null;
            },
            cli_execute_command: function() { return output; }
        });
    }

    test('appends the exact gh-1137 line to the summary', function () {
        var ts = tsWithCommandOutput('toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)');
        var out = ts.withToolchainLine('### What changed\n- fixed the parser', { workingDir: 'repo' });
        assert.ok(out.indexOf('### What changed\n- fixed the parser') === 0, 'original content preserved, got: ' + out);
        assert.ok(out.indexOf('toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)') !== -1, 'got: ' + out);
    });

    test('a no-pin run carries the warning line too (gh-1137 AC2 at the summary level)', function () {
        var ts = tsWithCommandOutput(
            'toolchain: dart 3.2.1 (CI: none, match: no)\n' +
            '⚠️ toolchain-warn: no Dart SDK pin found — local dart format/analyzer results may differ from CI');
        var out = ts.withToolchainLine('body', { workingDir: 'repo' });
        assert.ok(out.indexOf('toolchain: dart 3.2.1 (CI: none, match: no)') !== -1, 'got: ' + out);
        assert.ok(out.indexOf('may differ from CI') !== -1, 'the warning line must ride along, got: ' + out);
    });

    test('a warn line NOT immediately after the toolchain line does not ride along', function () {
        var ts = tsWithCommandOutput(
            'noise before\ntoolchain: dart 3.2.1 (CI: none, match: no)');
        var out = ts.withToolchainLine('body', { workingDir: 'repo' });
        assert.ok(out.indexOf('toolchain: dart 3.2.1') !== -1, 'got: ' + out);
    });

    test('non-Dart repo skip line (dart none) → no annotation noise on JS/Kotlin legs', function () {
        var ts = tsWithCommandOutput(
            'toolchain: dart none (CI: none, match: n/a) — not a Dart repo (no pubspec.yaml); SDK install skipped');
        var out = ts.withToolchainLine('## Fix\n- done', { workingDir: 'repo' });
        assert.equal(out, '## Fix\n- done', 'dart none must not be appended, got: ' + out);
    });

    test('a summary that already carries a toolchain line is not annotated twice', function () {
        var ts = tsWithCommandOutput('toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)');
        var body = '## Fix\n- done\ntoolchain: dart 3.9.4 (CI: 3.13.5, match: no)';
        assert.equal(ts.withToolchainLine(body, { workingDir: 'repo' }), body);
    });

    test('command failure → response returned unchanged', function () {
        var ts = loadToolchainSummary({
            file_read: function(opts) {
                return opts.path === 'repo/setup/dart.sh' ? '#!/usr/bin/env bash' : null;
            },
            cli_execute_command: function() { throw new Error('bash not whitelisted'); }
        });
        var out = ts.withToolchainLine('## Fix\n- done', { workingDir: 'repo' });
        assert.equal(out, '## Fix\n- done');
    });

    test('empty summary → returned unchanged (nothing to annotate)', function () {
        var ts = tsWithCommandOutput('toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)');
        assert.equal(ts.withToolchainLine(null, { workingDir: 'repo' }), null);
        assert.equal(ts.withToolchainLine('', { workingDir: 'repo' }), '');
        assert.equal(ts.withToolchainLine('   \n  ', { workingDir: 'repo' }), '   \n  ');
    });

    test('trailing whitespace of the summary is collapsed to exactly one newline before the line', function () {
        var ts = tsWithCommandOutput('toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)');
        var out = ts.withToolchainLine('## Fix\n- done\n\n\n', { workingDir: 'repo' });
        assert.ok(/- done\ntoolchain: dart/.test(out), 'got: ' + JSON.stringify(out));
    });
});

// ── Wiring contracts ─────────────────────────────────────────────────────────

suite('toolchainSummary: leg wiring contracts (gh-1137)', function () {

    test('dev leg post action (developTicketAndCreatePR.js) consumes the helper', function () {
        var src = file_read({ path: 'js/developTicketAndCreatePR.js' });
        assert.ok(/require\('\.\/common\/toolchainSummary\.js'\)/.test(src),
            'dev leg must require ./common/toolchainSummary.js');
        assert.ok(/withToolchainLine/.test(src),
            'dev leg must run the response through withToolchainLine');
    });

    test('rework leg post action (pushReworkChanges.js) consumes the helper', function () {
        var src = file_read({ path: 'js/pushReworkChanges.js' });
        assert.ok(/require\('\.\/common\/toolchainSummary\.js'\)/.test(src),
            'rework leg must require ./common/toolchainSummary.js');
        assert.ok(/withToolchainLine/.test(src),
            'rework leg must run the fix summary through withToolchainLine');
    });

    test('any runner config declaring a dart preamble must run the repo-owned setup/dart.sh', function () {
        // gh-1137 review round 1: deployment-specific runner configs (fa-*)
        // do not belong in this repo — the preamble CONTRACT is what stays:
        // any config that opts into a dart preamble must run the repo-owned
        // setup/dart.sh (root-mounted or agents/ submodule layout), never a
        // copied/engine-local variant that could drift from this repo.
        var tracked = String(cli_execute_command({ command: 'git ls-files ".dmtools/runners/*.json"' }) || '')
            .split('\n').map(function (s) { return s.trim(); })
            .filter(function (s) { return /\.json$/.test(s); });
        assert.ok(tracked.length > 0, 'runner configs must be enumerable (git ls-files)');
        tracked.forEach(function (configPath) {
            var raw = file_read({ path: configPath });
            if (!raw) {
                return;
            }
            var cfg = JSON.parse(raw);
            var cmds = (((cfg.params || {}).customParams) || {}).setupCommands || [];
            cmds.forEach(function (cmd) {
                if (/dart\.sh/.test(String(cmd))) {
                    assert.ok(/^bash (agents\/)?setup\/dart\.sh$/.test(String(cmd).trim()),
                        configPath + ' dart preamble must run the repo-owned setup/dart.sh, got: ' + cmd);
                }
            });
        });
    });

    test('the toolchain-warn marker is a wiring contract between setup/dart.sh and this module', function () {
        // gh-1137 review: the no-pin warning pickup must match a STABLE
        // token, not dart.sh prose — a reworded warning must not silently
        // disappear from leg summaries with everything green.
        var sh = file_read({ path: 'setup/dart.sh' });
        assert.ok(sh.indexOf('toolchain-warn:') !== -1,
            'dart.sh summary must emit the stable toolchain-warn: marker');
        var ts = file_read({ path: 'js/common/toolchainSummary.js' });
        assert.ok(ts.indexOf("'toolchain-warn:'") !== -1,
            'toolchainSummary must match the stable toolchain-warn: token (never dart.sh prose)');
    });
});
