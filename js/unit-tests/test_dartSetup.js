/**
 * Unit tests for setup/dart.sh — the cached, channel-aware Dart SDK
 * provisioner for machine-factory leg sessions (gh-918).
 *
 * The factory legs on Dart repos had NO dart SDK: rework legs could not run
 * `dart analyze/test/format` or `crap4dart check`, so they could neither see
 * nor verify quality-gate violations and claimed success while violations
 * stayed in place (gh-918 evidence: #408 operator-fixed CRAP 9.00, #413
 * rework "success" with method_size violations left in place, #414 operator
 * refactor). setup/dart.sh is the fix: same pattern as the golden-test
 * Flutter toolchain for fa legs — cached per resolved version, exposed on
 * PATH for the leg session, resolving the SAME channel/version the checked
 * out repo's quality workflow (dart-lang/setup-dart step) uses.
 *
 * The canonical green gate (agent-pack-release.yml) sets
 * CLI_ALLOWED_COMMANDS=bash so cli_execute_command may run the real bash
 * script against hermetic mktemp sandboxes (no worktree pollution). Where
 * bash is not executable the suite self-skips — the degraded-harness
 * precedent of test_reviewVerdict.js.
 *
 * Coverage (network-free decision logic — `plan`/`status` subcommands):
 *   - channel/version resolution precedence: argument > DART_VERSION env >
 *     quality-workflow dart-lang/setup-dart detection > stable default;
 *   - quality.yml `sdk:` pin + `channel:` pair → version mode on that
 *     channel (exactly "same channel the repo's quality.yml uses");
 *   - dart-archive URL/paths shape (os/arch mapping, dart-sdk/bin layout);
 *   - installed-version parsing from the `dart --version` banner;
 *   - wiring contracts: install.sh ALL_TOOLS + verify mapping, cache.sh
 *     DART_CACHE_* entries (mirrors test_packLaunchContract.js style).
 *
 * Uses: cli_execute_command, file_read, test(), suite(), assert
 */

// ── Capability probe ─────────────────────────────────────────────────────────

var _dsCanRun_ = typeof cli_execute_command === 'function';
if (_dsCanRun_) {
    try {
        cli_execute_command({ command: 'bash -c "echo __ds_probe__"' });
    } catch (e) {
        _dsCanRun_ = false; // bash not whitelisted in this dmtools env
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Shell-single-quote a value (safe inside `bash -c '…'` after one wrap). */
function dsShq(v) {
    return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

/** Parse the script's key=value output into an object. */
function dsParseKv(out) {
    var res = {};
    String(out).split('\n').forEach(function (line) {
        line = line.replace(/\r$/, '');
        var i = line.indexOf('=');
        if (i === -1) return;
        res[line.substring(0, i).trim()] = line.substring(i + 1).trim();
    });
    return res;
}

/** os/arch pair the script should resolve on THIS machine (for URL asserts). */
function dsOsArch() {
    var lines = [
        'case "$(uname -s)" in Darwin) echo macos;; Linux) echo linux;; *) echo unknown;; esac',
        'case "$(uname -m)" in arm64|aarch64) echo arm64;; *) echo x64;; esac'
    ];
    var out = cli_execute_command({ command: 'bash -c ' + dsShq(lines.join('; ')) });
    var parts = String(out).trim().split('\n');
    return { os: parts[0], arch: parts[1] };
}

/**
 * Run `setup/dart.sh <subcommand>` inside a fresh mktemp sandbox.
 * opts: qualityYml — contents written to <sandbox>/.github/workflows/quality.yml
 *       env        — extra `KEY=value` strings prefixed to the invocation
 *       stubDart   — version banner a fake `dart` on PATH prints (status tests)
 */
function dsRun(subcommand, opts) {
    opts = opts || {};
    var lines = ['r="$(pwd)"', 'd="$(mktemp -d)"'];
    if (opts.qualityYml !== undefined) {
        lines.push('mkdir -p "$d/.github/workflows"');
        lines.push('printf %s ' + dsShq(opts.qualityYml) + ' > "$d/.github/workflows/quality.yml"');
    }
    if (opts.stubDart !== undefined) {
        lines.push('mkdir -p "$d/bin"');
        lines.push("printf '#!/bin/sh\\necho %s\\n' " + dsShq(opts.stubDart) + ' > "$d/bin/dart"');
        lines.push('chmod +x "$d/bin/dart"');
    }
    var env = (opts.env || []).slice();
    if (opts.stubDart !== undefined) {
        env.push('PATH="$d/bin:$PATH"');
    }
    lines.push('cd "$d"');
    lines.push((env.length ? env.join(' ') + ' ' : '') +
        'bash "$r/setup/dart.sh" ' + subcommand);
    lines.push('rc=$?; cd /; rm -rf "$d"; exit $rc');
    return dsParseKv(cli_execute_command({ command: 'bash -c ' + dsShq(lines.join('\n')) }));
}

// Fixture: a minimal quality workflow using dart-lang/setup-dart (beta channel).
var DS_QUALITY_BETA = [
    'name: Quality',
    'on: [push]',
    'jobs:',
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: dart-lang/setup-dart@v1',
    '        with:',
    '          channel: beta',
    '      - run: dart analyze'
].join('\n');

// Fixture: quality workflow pinning BOTH an sdk version and a channel.
var DS_QUALITY_PINNED = DS_QUALITY_BETA
    .replace('          channel: beta', '          channel: beta\n          sdk: 3.9.4');

// ── Suite ────────────────────────────────────────────────────────────────────

suite('setup/dart.sh: target resolution precedence (gh-918)', function () {

    if (!_dsCanRun_) {
        console.log(
            '  ⏭️  skipped — bash not executable here (node-harness mock gap; ' +
            'the canonical gate runs this suite via CLI_ALLOWED_COMMANDS=bash)');
        return;
    }

    test('no argument, no quality workflow → stable default, source=default', function () {
        var r = dsRun('plan');
        assert.equal(r.mode, 'channel');
        assert.equal(r.channel, 'stable');
        assert.equal(r.requested, 'stable');
        assert.equal(r.source, 'default');
    });

    test('no argument, quality.yml setup-dart channel: beta → beta, source=quality workflow', function () {
        var r = dsRun('plan', { qualityYml: DS_QUALITY_BETA });
        assert.equal(r.mode, 'channel');
        assert.equal(r.channel, 'beta');
        assert.equal(r.source, 'quality workflow');
        assert.ok(String(r.sdk_url).indexOf('/channels/beta/release/latest/sdk/') !== -1,
            'sdk_url must use the detected channel, got: ' + r.sdk_url);
    });

    test('quality.yml sdk pin + channel → version mode on that channel ("same channel as quality.yml")', function () {
        var r = dsRun('plan', { qualityYml: DS_QUALITY_PINNED });
        assert.equal(r.mode, 'version');
        assert.equal(r.version, '3.9.4');
        assert.equal(r.channel, 'beta');
        assert.ok(String(r.sdk_url).indexOf('/channels/beta/release/3.9.4/sdk/') !== -1,
            'sdk_url must pin the version on the detected channel, got: ' + r.sdk_url);
    });

    test('quality.yml setup-dart step without channel → stable from detection (source=quality workflow)', function () {
        var noChannel = DS_QUALITY_BETA.replace('          channel: beta\n', '');
        var r = dsRun('plan', { qualityYml: noChannel });
        assert.equal(r.channel, 'stable');
        assert.equal(r.source, 'quality workflow');
    });

    test('explicit version argument wins over quality.yml detection, riding the detected channel', function () {
        var r = dsRun('plan 3.5.0', { qualityYml: DS_QUALITY_BETA });
        assert.equal(r.mode, 'version');
        assert.equal(r.version, '3.5.0');
        assert.equal(r.channel, 'beta', 'a pinned version rides the quality.yml channel (same gate as CI)');
        assert.equal(r.source, 'argument');
        assert.ok(String(r.sdk_url).indexOf('/channels/beta/release/3.5.0/sdk/') !== -1,
            'pinned version must download from the detected channel, got: ' + r.sdk_url);
    });

    test('explicit version argument without quality workflow rides stable', function () {
        var r = dsRun('plan 3.5.0');
        assert.equal(r.mode, 'version');
        assert.equal(r.version, '3.5.0');
        assert.equal(r.channel, 'stable');
        assert.equal(r.source, 'argument');
    });

    test('DART_VERSION env is honored when no argument is given (source=environment)', function () {
        var r = dsRun('plan', { env: ['DART_VERSION=beta'] });
        assert.equal(r.mode, 'channel');
        assert.equal(r.channel, 'beta');
        assert.equal(r.source, 'environment');
    });

    test('explicit channel argument wins over quality.yml detection', function () {
        var r = dsRun('plan dev', { qualityYml: DS_QUALITY_BETA });
        assert.equal(r.channel, 'dev');
        assert.equal(r.source, 'argument');
    });
});

suite('setup/dart.sh: install layout + PATH exposure contract', function () {

    if (!_dsCanRun_) {
        console.log('  ⏭️  skipped — bash not executable here');
        return;
    }

    test('plan emits dart-archive URL for THIS os/arch and the dart-sdk/bin layout', function () {
        var oa = dsOsArch();
        var r = dsRun('plan');
        assert.ok(String(r.sdk_url).indexOf(
            'https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/' +
            'dartsdk-' + oa.os + '-' + oa.arch + '-release.zip') === 0,
            'sdk_url must be the dart-archive channel URL for ' + oa.os + '/' + oa.arch +
            ', got: ' + r.sdk_url);
        assert.ok(/\/dart-sdk\/bin$/.test(String(r.sdk_bin_dir)),
            'sdk_bin_dir must point at <sdk>/dart-sdk/bin (what register_path exposes), got: ' + r.sdk_bin_dir);
        assert.ok(/\/dart-sdk$/.test(String(r.sdk_home)),
            'sdk_home must be the SDK root, got: ' + r.sdk_home);
        assert.equal(r.register_path, r.sdk_bin_dir,
            'plan must declare the exact dir register_path puts on the leg-session PATH');
    });

    test('status parses the installed version from the dart --version banner', function () {
        var r = dsRun('status', { stubDart: 'Dart SDK version: 3.5.4 (stable) on "linux_x64"' });
        assert.equal(r.installed, '3.5.4');
    });

    test('status reports an empty installed version when dart is absent (the gh-918 leg state)', function () {
        var r = dsRun('status');
        assert.equal(r.installed, '');
    });
});

suite('setup/dart.sh: factory wiring contracts', function () {

    test('install.sh lists dart in ALL_TOOLS and maps it to the dart binary for PATH verification', function () {
        var install = file_read({ path: 'setup/install.sh' });
        assert.ok(/^ALL_TOOLS="[^"]*\bdart\b[^"]*"$|^[A-Z_]*ALL_TOOLS="/m.test(install) &&
            /ALL_TOOLS="[^"]*\bdart\b[^"]*"/.test(install),
            'dart must be part of install.sh ALL_TOOLS so install.sh dart|all provisions it');
        assert.ok(/dart\)\s+BIN="dart"/.test(install),
            'install.sh verify mapping must check the dart binary on PATH');
    });

    test('cache.sh defines DART_CACHE_* so CI can cache the SDK per version', function () {
        var cache = file_read({ path: 'setup/cache.sh' });
        assert.ok(/DART_CACHE_PATH/.test(cache) && /DART_CACHE_KEY/.test(cache),
            'cache.sh must export DART_CACHE_PATH/DART_CACHE_KEY');
        assert.ok(/_cache_dart/.test(cache), 'cache.sh must have a _cache_dart dispatch entry');
        assert.ok(/ALL_TOOLS="[^"]*\bdart\b[^"]*"/.test(cache),
            'dart must be part of cache.sh ALL_TOOLS so cache.sh all covers it');
    });
});
