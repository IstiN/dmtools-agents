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
        // The banner is quoted INSIDE the stub script (dsShq(opts.stubDart) rides
        // inside the script text, not as a shell argument) — an unquoted echo
        // would die on the banner's parentheses and print no version at all.
        lines.push('printf %s ' + dsShq('#!/bin/sh\necho ' + dsShq(opts.stubDart)) + ' > "$d/bin/dart"');
        lines.push('chmod +x "$d/bin/dart"');
    }
    if (opts.managedBanner !== undefined) {
        // A fake SDK installed at <DART_INSTALL_DIR>/dart-sdk/bin/dart — what
        // dart.sh itself (or a CI cache restore) would have put there.
        lines.push('mkdir -p "$d/nodart/dart-sdk/bin"');
        lines.push('printf %s ' + dsShq('#!/bin/sh\necho ' + dsShq(opts.managedBanner)) +
            ' > "$d/nodart/dart-sdk/bin/dart"');
        lines.push('chmod +x "$d/nodart/dart-sdk/bin/dart"');
    }
    if (opts.stubCurlFails) {
        // A curl that always fails — simulates the network-hiccup degraded
        // path (channel_latest cannot resolve) without any real network.
        lines.push('mkdir -p "$d/bin"');
        lines.push('printf %s ' + dsShq('#!/bin/sh\nexit 1') + ' > "$d/bin/curl"');
        lines.push('chmod +x "$d/bin/curl"');
    }
    if (opts.versionFile !== undefined) {
        // The repo's version-file pin convention (gh-1137): a one-token
        // .dart-version at the repo root — the first pin source checked.
        lines.push('printf %s ' + dsShq(opts.versionFile) + ' > "$d/.dart-version"');
    }
    if (opts.pubspec) {
        // Marks the sandbox checkout as a Dart repo (gh-1137: the stable
        // fallback and its loud warning apply to Dart repos; a non-Dart
        // repo skips the SDK install entirely).
        lines.push('printf %s ' + dsShq('name: sandbox\nenvironment:\n  sdk: ^3.0.0\n') + ' > "$d/pubspec.yaml"');
    }
    var env = (opts.env || []).slice();
    // Hermetic against the HOST: the script's installed-version probe falls
    // back to <DART_INSTALL_DIR>/dart-sdk/bin/dart, so a real SDK cached on
    // the runner (or left by a manual install — live: the verification step
    // of this very ticket) would leak into `status`/`plan`. Point the
    // install dir INSIDE the sandbox for every invocation.
    env.push('DART_INSTALL_DIR="$d/nodart"');
    if (opts.noHostDart) {
        // Hermetic against a dart already on the host PATH: only the sandbox bin + system dirs.
        lines.push('mkdir -p "$d/bin"');
        env.push('PATH="$d/bin:/usr/bin:/bin"');
    } else if (opts.stubDart !== undefined || opts.stubCurlFails) {
        env.push('PATH="$d/bin:$PATH"');
    }
    if (opts.trailTarget !== undefined) {
        // register_path's parent-visible trail (/tmp/_registered_paths) is
        // how the sandbox can observe WHICH dirs the script put on PATH for
        // the leg session — the only observable for the degraded-branch lie.
        // trailTarget may reference the sandbox dir as $d — expanded by the
        // wrapper shell (double-quoted), NOT by dsShq.
        lines.push('touch /tmp/_registered_paths');
        lines.push('before=$(wc -l < /tmp/_registered_paths)');
        lines.push('dpath="' + opts.trailTarget + '"');
    }
    lines.push('cd "$d"');
    lines.push((env.length ? env.join(' ') + ' ' : '') +
        'bash "$r/setup/dart.sh" ' + subcommand);
    lines.push('rc=$?');
    if (opts.trailTarget !== undefined) {
        lines.push('after=$(wc -l < /tmp/_registered_paths 2>/dev/null || echo 0)');
        lines.push('trail_hit=0');
        lines.push('if [ "$after" -gt "$before" ] && tail -n "+$((before + 1))" /tmp/_registered_paths 2>/dev/null | grep -qF -- "$dpath"; then trail_hit=1; fi');
        lines.push('echo "trail_hit=$trail_hit"');
    }
    lines.push('cd /; rm -rf "$d"');
    lines.push('exit $rc');
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

// Fixture: QUOTED action ref (legal YAML, common in generated/templated workflows).
var DS_QUALITY_QUOTED = DS_QUALITY_BETA
    .replace("- uses: dart-lang/setup-dart@v1", '- uses: "dart-lang/setup-dart@v1"');

// Fixture: the setup-dart step COMMENTED OUT (its channel must not leak in).
var DS_QUALITY_COMMENTED_STEP = DS_QUALITY_BETA
    .replace(/^(      - uses: dart-lang)/m, '#$1')
    .replace(/^(          channel: beta)$/m, '#$1');

// Fixture: live setup-dart step whose `channel:` line is commented out
// (a stale comment must not win over the real input).
var DS_QUALITY_COMMENTED_CHANNEL = DS_QUALITY_BETA
    .replace('          channel: beta',
        '          # channel: beta   (was beta, pinned to stable for now)\n          channel: stable');

// ── gh-1137 fixtures ─────────────────────────────────────────────────────────
// The dmtools-dart live scenario: CI pins sdk: 3.13.5 (no channel input → stable).
var DS_QUALITY_PIN_3135 = DS_QUALITY_BETA.replace('          channel: beta', '          sdk: 3.13.5');

/**
 * Run dart.sh with merged stdout+stderr and a captured exit code — for
 * error-path assertions (usage errors) where dsParseKv is not applicable.
 * Returns { rc, out }.
 */
function dsRunRaw(subcommand, opts) {
    opts = opts || {};
    var lines = ['r="$(pwd)"', 'd="$(mktemp -d)"'];
    if (opts.qualityYml !== undefined) {
        lines.push('mkdir -p "$d/.github/workflows"');
        lines.push('printf %s ' + dsShq(opts.qualityYml) + ' > "$d/.github/workflows/quality.yml"');
    }
    if (opts.versionFile !== undefined) {
        lines.push('printf %s ' + dsShq(opts.versionFile) + ' > "$d/.dart-version"');
    }
    if (opts.pubspec) {
        lines.push('printf %s ' + dsShq('name: sandbox\nenvironment:\n  sdk: ^3.0.0\n') + ' > "$d/pubspec.yaml"');
    }
    if (opts.managedBanner !== undefined) {
        lines.push('mkdir -p "$d/nodart/dart-sdk/bin"');
        lines.push('printf %s ' + dsShq('#!/bin/sh\necho ' + dsShq(opts.managedBanner)) +
            ' > "$d/nodart/dart-sdk/bin/dart"');
        lines.push('chmod +x "$d/nodart/dart-sdk/bin/dart"');
    }
    if (opts.stubCurlFails) {
        lines.push('mkdir -p "$d/bin"');
        lines.push('printf %s ' + dsShq('#!/bin/sh\nexit 1') + ' > "$d/bin/curl"');
        lines.push('chmod +x "$d/bin/curl"');
    }
    var env = (opts.env || []).slice();
    env.push('DART_INSTALL_DIR="$d/nodart"');
    if (opts.stubCurlFails) {
        env.push('PATH="$d/bin:$PATH"');
    }
    lines.push('cd "$d"');
    lines.push('out="$( (' + (env.length ? env.join(' ') + ' ' : '') +
        'bash "$r/setup/dart.sh" ' + subcommand + ') 2>&1 )"; rc=$?');
    lines.push('printf "__RC__=%s\\n" "$rc"');
    lines.push('printf "%s\\n" "$out"');
    lines.push('cd /; rm -rf "$d"; exit 0');
    var out = String(cli_execute_command({ command: 'bash -c ' + dsShq(lines.join('\n')) }));
    var m = /^__RC__=(\d+)\n/.exec(out);
    return { rc: m ? Number(m[1]) : -1, out: out.replace(/^__RC__=\d+\n/, '') };
}

/**
 * Run `setup/cache.sh <args>` inside a fresh mktemp sandbox (the dart cache
 * key must follow what dart.sh resolves FROM THE CHECKOUT — the sandbox
 * carries the quality.yml fixture). Returns { rc, out } with merged output.
 */
function dsCacheRun(argsLine, opts) {
    opts = opts || {};
    var lines = ['r="$(pwd)"', 'd="$(mktemp -d)"'];
    if (opts.qualityYml !== undefined) {
        lines.push('mkdir -p "$d/.github/workflows"');
        lines.push('printf %s ' + dsShq(opts.qualityYml) + ' > "$d/.github/workflows/quality.yml"');
    }
    var env = (opts.env || []).slice();
    lines.push('cd "$d"');
    lines.push('out="$( (' + (env.length ? env.join(' ') + ' ' : '') +
        'bash "$r/setup/cache.sh" ' + argsLine + ') 2>&1 )"; rc=$?');
    lines.push('printf "__RC__=%s\\n" "$rc"');
    lines.push('printf "%s\\n" "$out"');
    lines.push('cd /; rm -rf "$d"; exit 0');
    var out = String(cli_execute_command({ command: 'bash -c ' + dsShq(lines.join('\n')) }));
    var m = /^__RC__=(\d+)\n/.exec(out);
    return { rc: m ? Number(m[1]) : -1, out: out.replace(/^__RC__=\d+\n/, '') };
}

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

    test('quoted uses: "dart-lang/setup-dart@v1" is still detected (generated/templated workflows)', function () {
        var r = dsRun('plan', { qualityYml: DS_QUALITY_QUOTED });
        assert.equal(r.channel, 'beta',
            'a quoted action ref must not silently fall back to stable');
        assert.equal(r.source, 'quality workflow');
    });

    test('a commented-out setup-dart step does not hijack detection', function () {
        var r = dsRun('plan', { qualityYml: DS_QUALITY_COMMENTED_STEP });
        assert.equal(r.channel, 'stable',
            'a # - uses: dart-lang/setup-dart line is a comment, not a step');
        assert.equal(r.source, 'default',
            'no live step → no "quality workflow" source');
    });

    test('a commented-out channel line inside a live step does not win', function () {
        var r = dsRun('plan', { qualityYml: DS_QUALITY_COMMENTED_CHANNEL });
        assert.equal(r.channel, 'stable',
            'the stale "# channel: beta" comment must not shadow channel: stable');
        assert.equal(r.source, 'quality workflow');
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

    test('status parses the FULL token from a beta banner — 3.14.0-315.1.beta, not truncated at "-"', function () {
        // Live dart-archive beta banner. channel_latest returns the full
        // 3.14.0-315.1.beta from the VERSION file; truncating the banner at
        // the first "-" makes the version-aware cache check ALWAYS mismatch
        // on beta/dev channels → the SDK is wiped and re-downloaded per leg.
        var r = dsRun('status', { stubDart: 'Dart SDK version: 3.14.0-315.1.beta (beta) on "linux_x64"' });
        assert.equal(r.installed, '3.14.0-315.1.beta');
    });

    test('status parses the FULL token from a dev banner (3.15.0-27.0.dev)', function () {
        var r = dsRun('status', { stubDart: 'Dart SDK version: 3.15.0-27.0.dev (dev) on "linux_x64"' });
        assert.equal(r.installed, '3.15.0-27.0.dev');
    });

    test('a managed <install-dir> dart wins over a foreign PATH dart (cache-hit must describe OUR install)', function () {
        // The cache-hit branch registers <SDK_BIN> on PATH and points DART_HOME
        // at it — it must only fire for the SDK this script owns, never for a
        // foreign dart that happens to sit on PATH.
        var r = dsRun('status', {
            stubDart: 'Dart SDK version: 3.5.4 (stable) on "linux_x64"',
            managedBanner: 'Dart SDK version: 3.14.0-315.1.beta (beta) on "linux_x64"'
        });
        assert.equal(r.installed, '3.14.0-315.1.beta',
            'installed_version must probe <SDK_BIN>/dart (the managed install) before PATH');
    });

    test('status reports an empty installed version when dart is absent (the gh-918 leg state)', function () {
        var r = dsRun('status', { noHostDart: true });
        assert.equal(r.installed, '');
    });
});

suite('setup/dart.sh: mistyped targets fail fast with usage (no bogus version 404s)', function () {

    if (!_dsCanRun_) {
        console.log('  ⏭️  skipped — bash not executable here');
        return;
    }

    test('--help fails with a usage error instead of resolving as a version target', function () {
        var r = dsRunRaw('plan --help');
        assert.ok(r.rc !== 0, '--help must not resolve to version mode (rc=' + r.rc + '), out: ' + r.out);
        assert.ok(/unknown target/.test(r.out), 'must name the offending target, got: ' + r.out);
    });

    test('a typo like `instal` fails with a usage error, not a late curl 404', function () {
        var r = dsRunRaw('plan instal');
        assert.ok(r.rc !== 0, 'typo must be rejected up front (rc=' + r.rc + '), out: ' + r.out);
        assert.ok(/unknown target/.test(r.out), 'got: ' + r.out);
    });

    test('garbage target (`latest-sdk`) fails with a usage error', function () {
        var r = dsRunRaw('plan latest-sdk');
        assert.ok(r.rc !== 0, 'got: ' + r.out);
        assert.ok(/unknown target/.test(r.out), 'got: ' + r.out);
    });

    test('a v-prefixed version is accepted and stripped (fa.sh/dmtools.sh muscle memory)', function () {
        var r = dsRun('plan v3.9.4');
        assert.equal(r.mode, 'version');
        assert.equal(r.version, '3.9.4', 'dart-archive URLs are unprefixed — v must be stripped');
        assert.ok(String(r.sdk_url).indexOf('/release/3.9.4/sdk/') !== -1,
            'got: ' + r.sdk_url);
    });

    test('--help as the FIRST argument prints usage and exits 0', function () {
        var r = dsRunRaw('--help');
        assert.equal(r.rc, 0, 'got: ' + r.out);
        assert.ok(/Usage:/.test(r.out), 'got: ' + r.out);
    });
});

suite('setup/cache.sh: DART_CACHE_KEY follows the target dart.sh actually resolves', function () {

    if (!_dsCanRun_) {
        console.log('  ⏭️  skipped — bash not executable here');
        return;
    }

    test('keys dart on a beta-pinned repo keys dart-beta-… (restore/save round-trip)', function () {
        // RED pre-fix: _cache_dart keyed on ${DART_VERSION:-stable} → dart-stable-…
        // while dart.sh installed beta — the primary key could never hit.
        var r = dsCacheRun('keys dart', { qualityYml: DS_QUALITY_BETA });
        assert.equal(r.rc, 0, 'got: ' + r.out);
        assert.ok(/key=dart-beta-/.test(r.out),
            'restore key must follow the quality.yml-resolved channel, got: ' + r.out);
        assert.ok(r.out.indexOf('dart-stable-') === -1,
            'must NOT key stable when quality.yml pins beta, got: ' + r.out);
    });

    test('keys dart with an sdk-pinned repo keys on the pinned version', function () {
        var r = dsCacheRun('keys dart', { qualityYml: DS_QUALITY_PINNED });
        assert.equal(r.rc, 0, 'got: ' + r.out);
        assert.ok(/key=dart-3\.9\.4-/.test(r.out), 'got: ' + r.out);
    });

    test('keys dart without any detection source still keys dart-stable-…', function () {
        var r = dsCacheRun('keys dart', {});
        assert.equal(r.rc, 0, 'got: ' + r.out);
        assert.ok(/key=dart-stable-/.test(r.out), 'got: ' + r.out);
    });

    test('explicit dart:<version> argument wins over plan resolution', function () {
        var r = dsCacheRun('keys dart:3.5.0', { qualityYml: DS_QUALITY_BETA });
        assert.equal(r.rc, 0, 'got: ' + r.out);
        assert.ok(/key=dart-3\.5\.0-/.test(r.out), 'got: ' + r.out);
    });

    test('DART_VERSION env (a pure input pin) keys consistently for restore AND save', function () {
        // dart.sh must NOT re-export the installed version into DART_VERSION:
        // the save step runs after the install, and a re-export would flip its
        // key from dart-beta-… to dart-<installed>-… — never looked for by the
        // restore step. With DART_VERSION kept a pure input, both steps see
        // the same value and derive the same key.
        var restore = dsCacheRun('keys dart', { env: ['DART_VERSION=beta'] });
        var save = dsCacheRun('keys dart', { env: ['DART_VERSION=beta'] });
        var keyOf = function (o) {
            var m = /key=([^\s]+)/.exec(o.out);
            return m ? m[1] : '(none)';
        };
        assert.equal(keyOf(restore), keyOf(save),
            'restore and save must derive identical keys for the same environment');
        assert.ok(/dart-beta-/.test(keyOf(restore)), 'got: ' + restore.out);
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

    test('checksum sidecar is the literal .sha256sum — dart-archive has no .sha256 (it 404s live)', function () {
        // Live-verified: ...zip.sha256 → 404, ...zip.sha256sum → 200. A \.sha256
        // substring match cannot tell them apart, so assert the FULL extension.
        var src = file_read({ path: 'setup/dart.sh' });
        assert.ok(/verify_sha256[^]*?\$\{url\}\.sha256sum/.test(src),
            'the verify call site must pass ${url}.sha256sum');
        assert.equal(src.indexOf('.sha256"'), -1,
            'a bare .sha256 sidecar reference 404s on dart-archive — sidecar name must always end in .sha256sum');
        assert.ok(/cut -d' ' -f1/.test(src),
            'the sidecar payload is a canonical sha256sum line ("<hash> *<name>") — only the hash field may be compared');
    });
});

suite('setup/dart.sh: degraded keep never lies about the managed install (foreign PATH dart)', function () {

    if (!_dsCanRun_) {
        console.log('  ⏭️  skipped — bash not executable here');
        return;
    }

    test('network hiccup + foreign PATH dart only → no fake <SDK_BIN> registration', function () {
        // The degraded keep (resolved resolution failed, some dart exists) must
        // not register <SDK_BIN> on the leg PATH / point DART_HOME at it when
        // the only dart is a FOREIGN one — the dir does not exist.
        var r = dsRun('', {
            stubDart: 'Dart SDK version: 3.5.4 (stable) on "linux_x64"',
            stubCurlFails: true,
            trailTarget: '$d/nodart/dart-sdk/bin'
        });
        assert.equal(r.trail_hit, '0',
            'the nonexistent managed bin dir must NOT be registered for a foreign PATH dart');
    });

    test('network hiccup + MANAGED SDK → the managed bin dir is still registered (behavior preserved)', function () {
        var r = dsRun('', {
            managedBanner: 'Dart SDK version: 3.14.0-315.1.beta (beta) on "linux_x64"',
            stubCurlFails: true,
            trailTarget: '$d/nodart/dart-sdk/bin'
        });
        assert.equal(r.trail_hit, '1',
            'a real (managed/cache-restored) SDK must keep being registered in degraded mode');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// gh-1137 — the leg toolchain must match the repo's CI SDK, and the leg
// summary must carry `toolchain: dart <version> (CI: <version>, match: …)`.
// ══════════════════════════════════════════════════════════════════════════════

suite('setup/dart.sh: .dart-version version-file pin (gh-1137 step 1)', function () {

    if (!_dsCanRun_) {
        console.log('  ⏭️  skipped — bash not executable here');
        return;
    }

    test('.dart-version pin resolves as the target with source=version file', function () {
        var r = dsRun('plan', { versionFile: '3.13.5\n', pubspec: true });
        assert.equal(r.mode, 'version');
        assert.equal(r.version, '3.13.5');
        assert.equal(r.source, 'version file',
            'the repo version file is pin source #1, before the CI workflow line');
    });

    test('.dart-version pin wins over the quality.yml sdk: line (ticket precedence: file → CI)', function () {
        var r = dsRun('plan', { versionFile: '3.13.5\n', qualityYml: DS_QUALITY_PIN_3135, pubspec: true });
        assert.equal(r.version, '3.13.5');
        assert.equal(r.source, 'version file');
    });

    test('explicit DART_VERSION env still beats the repo version file (operator input wins)', function () {
        var r = dsRun('plan', { versionFile: '3.13.5\n', env: ['DART_VERSION=3.9.4'], pubspec: true });
        assert.equal(r.version, '3.9.4');
        assert.equal(r.source, 'environment');
    });

    test('.dart-version carrying a channel token (beta) resolves as channel mode', function () {
        var r = dsRun('plan', { versionFile: 'beta\n', pubspec: true });
        assert.equal(r.mode, 'channel');
        assert.equal(r.channel, 'beta');
        assert.equal(r.source, 'version file');
    });

    test('.dart-version ignores comment and blank lines (first live token wins)', function () {
        var r = dsRun('plan', { versionFile: '# pinned below\n\n  3.13.5  \n', pubspec: true });
        assert.equal(r.version, '3.13.5');
        assert.equal(r.source, 'version file');
    });

    test('a v-prefixed .dart-version token is stripped (same muscle-memory rule as arguments)', function () {
        var r = dsRun('plan', { versionFile: 'v3.13.5\n', pubspec: true });
        assert.equal(r.version, '3.13.5');
    });
});

suite('setup/dart.sh: toolchain summary line (gh-1137 AC2 + AC3)', function () {

    if (!_dsCanRun_) {
        console.log('  ⏭️  skipped — bash not executable here');
        return;
    }

    test('pinned repo + installed==pin → the exact ticket summary line (AC3)', function () {
        // Live dmtools-dart shape: CI pins sdk: 3.13.5, the leg installed
        // exactly that → the summary shows a YES match. Asserted via dsRunRaw
        // in the next test (dsRun's key=value parser does not apply here).
        var r = dsRunRaw('summary', {
            qualityYml: DS_QUALITY_PIN_3135,
            managedBanner: 'Dart SDK version: 3.13.5 (stable) on "linux_x64"',
            pubspec: true
        });
        assert.equal(r.rc, 0, 'summary is network-free and must succeed: ' + r.out);
        assert.ok(r.out.indexOf('toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)') !== -1,
            'got: ' + r.out);
    });

    test('summary output contract: exactly one toolchain line when pinned and matching', function () {
        var r = dsRunRaw('summary', {
            qualityYml: DS_QUALITY_PIN_3135,
            managedBanner: 'Dart SDK version: 3.13.5 (stable) on "linux_x64"',
            pubspec: true
        });
        assert.equal(r.rc, 0, 'summary is network-free and must succeed: ' + r.out);
        var toolchainLines = r.out.split('\n').filter(function (l) {
            return l.indexOf('toolchain:') === 0;
        });
        assert.equal(toolchainLines.length, 1, 'exactly one toolchain line, got: ' + r.out);
        assert.equal(toolchainLines[0], 'toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)',
            'the leg summary line must carry version, CI pin and the match flag (AC3)');
    });

    test('installed SDK differs from the CI pin → match: no (honest flag)', function () {
        var r = dsRunRaw('summary', {
            qualityYml: DS_QUALITY_PIN_3135,
            managedBanner: 'Dart SDK version: 3.9.4 (stable) on "linux_x64"',
            pubspec: true
        });
        assert.equal(r.rc, 0);
        assert.ok(r.out.indexOf('toolchain: dart 3.9.4 (CI: 3.13.5, match: no)') !== -1,
            'got: ' + r.out);
        assert.ok(r.out.indexOf('match: yes') === -1, 'must not claim a match, got: ' + r.out);
    });

    test('Dart repo with NO pin and NO CI line → match: no + loud warning line (AC2)', function () {
        var r = dsRunRaw('summary', {
            managedBanner: 'Dart SDK version: 3.2.1 (stable) on "linux_x64"',
            pubspec: true
        });
        assert.equal(r.rc, 0);
        assert.ok(r.out.indexOf('toolchain: dart 3.2.1 (CI: none, match: no)') !== -1,
            'got: ' + r.out);
        var warningLines = r.out.split('\n').filter(function (l) {
            return l.indexOf('⚠️') !== -1 && l.indexOf('differ from CI') !== -1;
        });
        assert.ok(warningLines.length >= 1,
            'the no-pin fallback must add a warning line to the summary (AC2), got: ' + r.out);
    });

    test('summary never touches the network (channel_latest down → summary still works)', function () {
        var r = dsRunRaw('summary', {
            managedBanner: 'Dart SDK version: 3.2.1 (stable) on "linux_x64"',
            stubCurlFails: true,
            pubspec: true
        });
        assert.equal(r.rc, 0, 'summary must be network-free, got rc=' + r.rc + ': ' + r.out);
        assert.ok(r.out.indexOf('toolchain: dart 3.2.1 (CI: none, match: no)') !== -1, 'got: ' + r.out);
    });

    test('channel-only CI pin (channel: beta) + beta SDK → CI: beta, match: yes', function () {
        var r = dsRunRaw('summary', {
            qualityYml: DS_QUALITY_BETA,
            managedBanner: 'Dart SDK version: 3.14.0-315.1.beta (beta) on "linux_x64"',
            pubspec: true
        });
        assert.equal(r.rc, 0);
        assert.ok(r.out.indexOf('toolchain: dart 3.14.0-315.1.beta (CI: beta, match: yes)') !== -1,
            'a channel pin matches on channel identity (CI runs channel latest), got: ' + r.out);
    });

    test('channel-only CI pin but the leg resolved another channel → match: no', function () {
        var r = dsRunRaw('summary', {
            qualityYml: DS_QUALITY_BETA,
            managedBanner: 'Dart SDK version: 3.14.0-315.1.beta (beta) on "linux_x64"',
            env: ['DART_VERSION=stable'],
            pubspec: true
        });
        assert.equal(r.rc, 0);
        assert.ok(r.out.indexOf('match: no') !== -1, 'got: ' + r.out);
        assert.ok(r.out.indexOf('match: yes') === -1, 'got: ' + r.out);
    });

    test('non-Dart repo (no pubspec.yaml) → match: n/a skip line, no warning noise', function () {
        var r = dsRunRaw('summary', { managedBanner: 'Dart SDK version: 3.2.1 (stable) on "linux_x64"' });
        assert.equal(r.rc, 0);
        var toolchainLines = r.out.split('\n').filter(function (l) {
            return l.indexOf('toolchain:') === 0;
        });
        assert.equal(toolchainLines.length, 1, 'got: ' + r.out);
        assert.ok(toolchainLines[0].indexOf('match: n/a') !== -1, 'got: ' + toolchainLines[0]);
        assert.ok(toolchainLines[0].indexOf('dart none') !== -1, 'got: ' + toolchainLines[0]);
    });

    test('version-file pin is reported as the CI slot value with a matching SDK', function () {
        var r = dsRunRaw('summary', {
            versionFile: '3.13.5\n',
            managedBanner: 'Dart SDK version: 3.13.5 (stable) on "linux_x64"',
            pubspec: true
        });
        assert.equal(r.rc, 0);
        assert.ok(r.out.indexOf('toolchain: dart 3.13.5 (CI: 3.13.5, match: yes)') !== -1,
            'got: ' + r.out);
    });

    test('summary without any installed dart still reports the resolved target honestly', function () {
        var r = dsRunRaw('summary', {
            qualityYml: DS_QUALITY_PIN_3135,
            noHostDart: true,
            pubspec: true
        });
        assert.equal(r.rc, 0);
        // No dart installed → the summary still names the CI pin and cannot
        // claim a match (the install has not run yet).
        assert.ok(r.out.indexOf('(CI: 3.13.5, match: no)') !== -1, 'got: ' + r.out);
    });
});

suite('setup/dart.sh: install-path fallback warning + non-Dart skip (gh-1137)', function () {

    if (!_dsCanRun_) {
        console.log('  ⏭️  skipped — bash not executable here');
        return;
    }

    test('AC1 shape: quality.yml sdk: 3.13.5 resolves version mode on the stable channel', function () {
        var r = dsRun('plan', { qualityYml: DS_QUALITY_PIN_3135 });
        assert.equal(r.mode, 'version');
        assert.equal(r.version, '3.13.5');
        assert.equal(r.channel, 'stable');
        assert.equal(r.source, 'quality workflow');
        assert.ok(String(r.sdk_url).indexOf('/channels/stable/release/3.13.5/sdk/') !== -1,
            'the install URL must pin 3.13.5 exactly, got: ' + r.sdk_url);
    });

    test('Dart repo, no pin → install path prints the loud may-differ-from-CI warning', function () {
        // stubCurlFails kills the download AFTER resolution — the warning must
        // already be out by then (it precedes any network I/O).
        var r = dsRunRaw('', { stubCurlFails: true, pubspec: true });
        assert.ok(r.rc !== 0, 'the (stub) install itself still fails — the test only asserts the warning');
        assert.ok(r.out.indexOf('RESULTS MAY DIFFER FROM CI') !== -1,
            'the stable fallback must print a loud warning (ticket step 3), got: ' + r.out);
    });

    test('Dart repo, no pin, warning also fires when a stable SDK is already installed (degraded keep)', function () {
        // The degraded-keep branch exits 0 without downloading — the warning
        // must not depend on the download path being reached.
        var r = dsRunRaw('', {
            managedBanner: 'Dart SDK version: 3.2.1 (stable) on "linux_x64"',
            stubCurlFails: true,
            pubspec: true
        });
        assert.equal(r.rc, 0, 'degraded keep exits 0, got: ' + r.out);
        assert.ok(r.out.indexOf('RESULTS MAY DIFFER FROM CI') !== -1, 'got: ' + r.out);
    });

    test('non-Dart repo, no pin → install path SKIPS entirely (rc 0, no download attempt)', function () {
        // stubCurlFails proves no download was attempted: any curl call would
        // red the run. The skip must exit 0 before any network I/O.
        var r = dsRunRaw('', { stubCurlFails: true });
        assert.equal(r.rc, 0, 'a non-Dart repo must not install (or attempt) any SDK, got: ' + r.out);
        assert.ok(r.out.indexOf('differ from CI') === -1,
            'no warning — the skip is not a mismatch, got: ' + r.out);
    });

    test('non-Dart repo with an explicit pin still installs (operator intent wins over the skip)', function () {
        // DART_VERSION=beta + failing curl → the install IS attempted (and the
        // stub curl fails it) — proving the skip did not swallow explicit pins.
        var r = dsRunRaw('', { stubCurlFails: true, env: ['DART_VERSION=beta'] });
        assert.ok(r.rc !== 0, 'an explicit target must reach the download step, got rc=0: ' + r.out);
    });

    test('pinned Dart repo install path prints NO fallback warning', function () {
        var r = dsRunRaw('', {
            qualityYml: DS_QUALITY_PIN_3135,
            managedBanner: 'Dart SDK version: 3.13.5 (stable) on "linux_x64"',
            stubCurlFails: true,
            pubspec: true
        });
        assert.equal(r.rc, 0, 'cache hit: installed==pin, got: ' + r.out);
        assert.ok(r.out.indexOf('differ from CI') === -1,
            'a matching install must not warn, got: ' + r.out);
        assert.ok(r.out.indexOf('3.13.5') !== -1, 'got: ' + r.out);
    });
});
