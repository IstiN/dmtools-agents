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
 *   - the fa dev/rework runner configs (.dmtools/runners/) carry the dart
 *     preamble in customParams.setupCommands so the SDK is installed BEFORE
 *     the CLI agent starts.
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
        var commandUsed = null;
        var ts = loadToolchainSummary({
            file_read: function(opts) {
                seen.push(opts.path);
                return opts.path === 'repo/setup/dart.sh' ? '#!/usr/bin/env bash' : null;
            },
            cli_execute_command: function(args) {
                commandUsed = args.command;
                return 'toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)';
            }
        });
        var out = ts.withToolchainLine('## Fix\n- done', { workingDir: 'repo' });
        assert.equal(commandUsed, 'bash repo/setup/dart.sh summary',
            'the FIRST existing candidate wins, got: ' + commandUsed);
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
            '⚠️ toolchain warning: no Dart SDK pin found — local dart format/analyzer results may differ from CI');
        var out = ts.withToolchainLine('body', { workingDir: 'repo' });
        assert.ok(out.indexOf('toolchain: dart 3.2.1 (CI: none, match: no)') !== -1, 'got: ' + out);
        assert.ok(out.indexOf('may differ from CI') !== -1, 'the warning line must ride along, got: ' + out);
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

    test('fa dev runner carries the dart preamble in customParams.setupCommands', function () {
        var cfg = JSON.parse(file_read({ path: '.dmtools/runners/fa-story-dev.json' }));
        var cmds = (cfg.params.customParams || {}).setupCommands || [];
        assert.ok(cmds.some(function(c) { return /dart\.sh$/.test(c); }),
            'fa-story-dev.json customParams.setupCommands must run the dart preamble, got: ' + JSON.stringify(cmds));
    });

    test('fa rework runner carries the dart preamble in customParams.setupCommands', function () {
        var cfg = JSON.parse(file_read({ path: '.dmtools/runners/fa-rework.json' }));
        var cmds = (cfg.params.customParams || {}).setupCommands || [];
        assert.ok(cmds.some(function(c) { return /dart\.sh$/.test(c); }),
            'fa-rework.json customParams.setupCommands must run the dart preamble, got: ' + JSON.stringify(cmds));
    });
});
