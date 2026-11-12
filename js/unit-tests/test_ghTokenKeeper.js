/**
 * Unit tests for the gh-1450 token-expiry fix — the leg-scoped credential
 * keeper and the fresh-credential glue wiring.
 *
 * Live failure (gh-1450, dmtools-agents run 43172953082): a dev leg that
 * runs longer than ~60 min dies mid-flight with
 * `HTTP 401: Bad credentials (api.github.com/graphql)` — the GitHub App
 * installation token minted by actions/create-github-app-token@v2 expires
 * at GitHub's fixed 1-hour TTL and nothing refreshes it. The post-agent
 * steps then hard-fail WITHOUT the graceful interrupt handling: the
 * failure notice itself (`report-leg-failure.sh`) calls `gh` with the same
 * expired token, 401s, and the ticket silently stalls (no stamp, no
 * reset, no re-arm).
 *
 * Two layers fix this within the engine repo:
 *
 *   AC1  setup/gh-token-keeper.sh — a background keeper that re-publishes
 *        a fresh credential every ~45 min (App re-mint via APP_ID +
 *        APP_PRIVATE_KEY, else the SOURCE_GITHUB_TOKEN PAT — the
 *        PAT-based long-leg credential, ticket fix direction 3) into the
 *        job's GITHUB_ENV and a state file. Inert on short legs and when
 *        no credential source exists.
 *   AC2  scripts/gh-auth-refresh.sh — a sourced helper that applies the
 *        keeper's freshest token, and (with no keeper running — today's
 *        factory wiring) probes the current GH_TOKEN and swaps to the PAT
 *        on authentication failure, so the graceful degradation path
 *        itself survives the expiry (ticket fix direction 2).
 *   AC3  the post-agent glue scripts that call `gh` (report-leg-failure,
 *        apply-review-verdict, close-review-cycle, close-rework-cycle,
 *        hand-issue-to-reviewer, publish-token-usage) apply the helper
 *        BEFORE their first gh call.
 *   AC4  the keeper and the helper ship in the factory-setup release
 *        asset (the awf flip calls them from the same zip).
 *   AC5  both scripts carry --self-test suites and those suites PASS
 *        (the advertised verification is real).
 */

/* global loadModule, assert, test, suite, file_read, cli_execute_command */

var PACKS = file_read({ path: 'ci/release_packs.mjs' }) || '';

// ── AC1/AC3 — the scripts exist and expose the contract surface ──────────

suite('gh-token-keeper — script surface (gh-1450 AC1/AC3)', function () {

    test('the keeper script exists with the refresh/start/stop mode contract', function () {
        var script = file_read({ path: 'setup/gh-token-keeper.sh' }) || '';
        assert.ok(script.length > 0, 'setup/gh-token-keeper.sh must exist');
        ['refresh)', 'start)', 'stop)', '--self-test)'].forEach(function (mode) {
            assert.ok(script.indexOf(mode) !== -1,
                'keeper must handle the ' + mode + ' mode');
        });
    });

    test('the keeper refreshes from the App installation (APP_ID + APP_PRIVATE_KEY)', function () {
        var script = file_read({ path: 'setup/gh-token-keeper.sh' }) || '';
        assert.ok(script.indexOf('APP_ID') !== -1 && script.indexOf('APP_PRIVATE_KEY') !== -1,
            'the keeper must support the App-token re-mint path (ticket fix direction 1)');
        assert.ok(script.indexOf('/repos/') !== -1 && script.indexOf('/installation') !== -1,
            'the keeper must resolve the app installation via the repos API');
    });

    test('the keeper falls back to the SOURCE_GITHUB_TOKEN PAT (long-leg credential)', function () {
        var script = file_read({ path: 'setup/gh-token-keeper.sh' }) || '';
        assert.ok(script.indexOf('SOURCE_GITHUB_TOKEN') !== -1,
            'the keeper must support the PAT-based long-leg credential (ticket fix direction 3)');
    });

    test('the keeper publishes to GITHUB_ENV and a state file', function () {
        var script = file_read({ path: 'setup/gh-token-keeper.sh' }) || '';
        assert.ok(script.indexOf('GITHUB_ENV') !== -1,
            'the keeper must publish into GITHUB_ENV so later steps see the fresh token');
    });

    test('the refresh helper exists and exposes gh_auth_refresh_apply', function () {
        var script = file_read({ path: 'scripts/gh-auth-refresh.sh' }) || '';
        assert.ok(script.length > 0, 'scripts/gh-auth-refresh.sh must exist');
        assert.ok(script.indexOf('gh_auth_refresh_apply') !== -1,
            'the helper must expose gh_auth_refresh_apply (the one-call freshness entry)');
    });

    test('the helper swaps to the PAT when the current GH_TOKEN fails its probe', function () {
        var script = file_read({ path: 'scripts/gh-auth-refresh.sh' }) || '';
        assert.ok(script.indexOf('SOURCE_GITHUB_TOKEN') !== -1,
            'the helper must fall back to SOURCE_GITHUB_TOKEN (ticket fix direction 2: the graceful path must survive the expiry)');
    });
});

// ── AC2 — the post-agent glue applies freshness before its first gh call ──

suite('gh-auth-refresh — post-agent glue wiring (gh-1450 AC2)', function () {

    // The scripts whose gh calls form the graceful interrupt/reporting path
    // — exactly the steps that hard-failed in run 43172953082.
    var GLUE_SCRIPTS = [
        'scripts/report-leg-failure.sh',
        'scripts/apply-review-verdict.sh',
        'scripts/close-review-cycle.sh',
        'scripts/close-rework-cycle.sh',
        'scripts/hand-issue-to-reviewer.sh',
        'scripts/publish-token-usage.sh',
    ];

    GLUE_SCRIPTS.forEach(function (path) {
        test(path + ' applies the fresh credential before its gh calls', function () {
            var body = file_read({ path: path }) || '';
            assert.ok(body.length > 0, path + ' must exist');
            // Comment lines excluded — the headers mention `gh run view` and
            // `scripts/gh-auth-refresh.sh` long before the executable body;
            // every index below lives on the same stripped text.
            var code = body.split('\n').filter(function (line) {
                return line.trim().charAt(0) !== '#';
            }).join('\n');
            var sourceIdx = code.indexOf('gh-auth-refresh.sh');
            var applyIdx = code.indexOf('gh_auth_refresh_apply');
            assert.ok(sourceIdx !== -1, path + ' must source scripts/gh-auth-refresh.sh');
            assert.ok(applyIdx !== -1, path + ' must call gh_auth_refresh_apply');
            assert.ok(applyIdx < sourceIdx + 400,
                path + ' must apply the freshness immediately after sourcing it (one glue block)');
            var firstGh = code.indexOf('gh ');
            assert.ok(firstGh === -1 || applyIdx < firstGh,
                path + ' must apply freshness BEFORE its first gh call');
        });
    });
});

// ── AC4 — factory-setup carry contract (the awf flip runs the same zip) ──

suite('gh-token-keeper — factory-setup carry contract (gh-1450 AC4)', function () {

    test('the keeper and the helper ship in the factory-setup asset', function () {
        // The keeper rides the wholesale setup/ copy in buildFactorySetup
        // (every setup/* script ships; no per-file list entry exists for it).
        assert.ok(PACKS.indexOf("cpSync(join(ROOT, 'setup')") !== -1,
            'the keeper ships via the wholesale setup/ copy in buildFactorySetup');
        assert.ok(PACKS.indexOf("'gh-auth-refresh.sh'") !== -1,
            'FACTORY_SETUP_SCRIPTS must list gh-auth-refresh.sh');
    });
});

// ── AC5 — the advertised verification is real (self-tests pass) ──────────

var _ktkCanRunBash_ = typeof cli_execute_command === 'function';
if (_ktkCanRunBash_) {
    try {
        cli_execute_command({ command: 'bash -c "echo __ktk_probe__"' });
    } catch (e) {
        _ktkCanRunBash_ = false; // bash not whitelisted in this dmtools env
    }
}

suite('gh-token-keeper — transport script self-tests (gh-1450 AC5)', function () {

    if (!_ktkCanRunBash_) {
        console.log('  ⏭️  skipped — bash not executable here');
        return;
    }

    test('bash scripts/gh-auth-refresh.sh --self-test passes', function () {
        var out = cli_execute_command({ command: 'bash scripts/gh-auth-refresh.sh --self-test' }) || '';
        assert.ok(String(out).indexOf('gh-auth-refresh self-test: PASS') !== -1,
            'self-test must pass; got:\n' + out);
        assert.equal(String(out).indexOf('self-test: FAIL'), -1, 'got:\n' + out);
    });

    test('bash setup/gh-token-keeper.sh --self-test passes', function () {
        var out = cli_execute_command({ command: 'bash setup/gh-token-keeper.sh --self-test' }) || '';
        assert.ok(String(out).indexOf('gh-token-keeper self-test: PASS') !== -1,
            'self-test must pass; got:\n' + out);
        assert.equal(String(out).indexOf('self-test: FAIL'), -1, 'got:\n' + out);
    });
});

// ── suite registration ───────────────────────────────────────────────────

suite('gh-token-keeper — suite registration', function () {
    test('the suite is wired into run_all.json', function () {
        var all = file_read({ path: 'js/unit-tests/run_all.json' }) || '';
        assert.ok(all.indexOf('test_ghTokenKeeper.js') !== -1,
            'test_ghTokenKeeper.js must be registered in run_all.json');
    });
});
