/**
 * Unit tests for js/preCliMobileTestAutomationSetupHelpers.js — pure helpers
 * extracted from js/preCliMobileTestAutomationSetup.js (gh-1034 CRAP split).
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadSetupHelpers() {
    return loadModule(
        'js/preCliMobileTestAutomationSetupHelpers.js',
        makeRequire({}),
        {}
    );
}

// ── Suite: decideSuccessfulBuilds ────────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: decideSuccessfulBuilds', function() {

    test('keeps only status 1 or status_text success builds', function() {
        var h = loadSetupHelpers();
        var builds = [
            { slug: 'a', status: 1 },
            { slug: 'b', status: 2, status_text: 'success' },
            { slug: 'c', status: 3, status_text: 'failed' },
            { slug: 'd', status: 0 }
        ];
        var success = h.decideSuccessfulBuilds(builds);
        assert.equal(success.length, 2);
        assert.equal(success[0].slug, 'a');
        assert.equal(success[1].slug, 'b');
    });

    test('treats null builds as empty list', function() {
        var h = loadSetupHelpers();
        assert.equal(h.decideSuccessfulBuilds(null).length, 0);
        assert.equal(h.decideSuccessfulBuilds([]).length, 0);
    });

});

// ── Suite: decideBranchBuilds ────────────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: decideBranchBuilds', function() {

    test('narrows to builds whose commit message mentions the branch', function() {
        var h = loadSetupHelpers();
        var builds = [
            { slug: 'a', commit_message: 'PROJ-1 — build for bug/PROJ-1' },
            { slug: 'b', commit_message: 'unrelated' },
            { slug: 'c', original_build_params_commit_message: 'bug/PROJ-1 retry' }
        ];
        var d = h.decideBranchBuilds(builds, 'bug/PROJ-1');
        assert.equal(d.matched, true);
        assert.equal(d.builds.length, 2);
        assert.equal(d.builds[0].slug, 'a');
        assert.equal(d.builds[1].slug, 'c');
    });

    test('falls back to the full list when no commit message matches', function() {
        var h = loadSetupHelpers();
        var builds = [
            { slug: 'a', commit_message: 'other work' },
            { slug: 'b', commit_message: 'more work' }
        ];
        var d = h.decideBranchBuilds(builds, 'bug/PROJ-9');
        assert.equal(d.matched, false);
        assert.equal(d.builds.length, 2, 'should keep all successful builds');
    });

    test('returns the input list when branch is null', function() {
        var h = loadSetupHelpers();
        var builds = [{ slug: 'a' }];
        var d = h.decideBranchBuilds(builds, null);
        assert.equal(d.matched, false);
        assert.equal(d.builds.length, 1);
    });

});

// ── Suite: decideBuildSlug ───────────────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: decideBuildSlug', function() {

    test('returns slug and build number of the first build', function() {
        var h = loadSetupHelpers();
        var d = h.decideBuildSlug([{ slug: 's1', build_number: 42 }], 'wf');
        assert.equal(d.slug, 's1');
        assert.equal(d.buildNumber, 42);
    });

    test('throws the canonical no-successful-builds error', function() {
        var h = loadSetupHelpers();
        var threw = false;
        try {
            h.decideBuildSlug([], 'build_ios_simulator');
        } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('No successful build_ios_simulator builds found') !== -1,
                'message should name the workflow: ' + e.message);
            assert.ok(e.message.indexOf('Trigger a build first') !== -1, 'should mention triggering a build');
        }
        assert.ok(threw, 'should throw on empty builds');
        threw = false;
        try {
            h.decideBuildSlug(null, 'wf');
        } catch (e2) {
            threw = true;
        }
        assert.ok(threw, 'should throw on null builds');
    });

});

// ── Suite: formatBuildsWarningList ───────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: formatBuildsWarningList', function() {

    test('lists up to 5 builds with truncated commit messages', function() {
        var h = loadSetupHelpers();
        var builds = [];
        for (var i = 0; i < 7; i++) {
            builds.push({ build_number: 100 + i, commit_message: 'message-' + i + '-' + new Array(120).join('x') });
        }
        var lines = h.formatBuildsWarningList(builds);
        assert.equal(lines.length, 5, 'should cap at 5 lines');
        assert.ok(lines[0].indexOf('#100') !== -1, 'should contain build number');
        assert.ok(lines[0].indexOf('message-0-') !== -1, 'should contain commit message');
        assert.ok(lines[0].length < 120, 'commit message should be truncated to 80 chars');
    });

});

// ── Suite: decideAppArtifact ─────────────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: decideAppArtifact', function() {

    test('picks the first .zip/.app/simulator-titled artifact', function() {
        var h = loadSetupHelpers();
        var list = [
            { slug: 'log', title: 'build-log.txt' },
            { slug: 'zip', title: 'Example Business-simulator.zip' },
            { slug: 'other', title: 'other.zip' }
        ];
        assert.equal(h.decideAppArtifact(list).slug, 'zip');
    });

    test('falls back to the first artifact when nothing matches', function() {
        var h = loadSetupHelpers();
        var list = [{ slug: 'only', title: 'random.bin' }];
        assert.equal(h.decideAppArtifact(list).slug, 'only');
    });

    test('returns null for an empty artifact list', function() {
        var h = loadSetupHelpers();
        assert.equal(h.decideAppArtifact([]), null);
        assert.equal(h.decideAppArtifact(null), null);
    });

});

// ── Suite: parseFindAppResult ────────────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: parseFindAppResult', function() {

    test('returns the first real .app line, skipping .dSYM and blanks', function() {
        var h = loadSetupHelpers();
        var out = '\n  ./app/Example.app.dSYM/Contents\n\n./app/Example Business.app \n./app/Other.app\n';
        assert.equal(h.parseFindAppResult(out), './app/Example Business.app');
    });

    test('returns null when there is no usable output', function() {
        var h = loadSetupHelpers();
        assert.equal(h.parseFindAppResult(''), null);
        assert.equal(h.parseFindAppResult(null), null);
        assert.equal(h.parseFindAppResult('./a.dSYM/x\n'), null, 'dSYM-only output yields null');
    });

});

// ── Suite: buildAppInfoMarkdown ──────────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: buildAppInfoMarkdown', function() {

    test('builds markdown with App Path section when appPath present', function() {
        var h = loadSetupHelpers();
        var lines = h.buildAppInfoMarkdown('wf', 'slug-1', 'app.zip', 'bug/X-1', '/tmp/app/X.app', '/tmp/app');
        var md = lines.join('\n');
        assert.ok(md.indexOf('# iOS App Build Info') !== -1);
        assert.ok(md.indexOf('| Bitrise Workflow | wf |') !== -1);
        assert.ok(md.indexOf('| Build Slug | slug-1 |') !== -1);
        assert.ok(md.indexOf('| Artifact | app.zip |') !== -1);
        assert.ok(md.indexOf('| Branch | bug/X-1 |') !== -1);
        assert.ok(md.indexOf('| App Path | `/tmp/app/X.app` |') !== -1);
        assert.ok(md.indexOf('export APP_PATH="/tmp/app/X.app"') !== -1);
    });

    test('builds manual-locate markdown without appPath and without branch row', function() {
        var h = loadSetupHelpers();
        var lines = h.buildAppInfoMarkdown('wf', 'slug-1', 'app.zip', null, null, '/tmp/app');
        var md = lines.join('\n');
        assert.ok(md.indexOf('| Branch |') === -1, 'should not contain branch row');
        assert.ok(md.indexOf('| App Dir | `/tmp/app` |') !== -1);
        assert.ok(md.indexOf('locate the `.app` bundle manually') !== -1);
    });

});

// ── Suite: resolveEnvironmentBuildConfig ─────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: resolveEnvironmentBuildConfig', function() {

    test('overrides workflowId from the environment config', function() {
        var h = loadSetupHelpers();
        var bitriseBuild = {
            appSlug: 'slug',
            workflowId: 'default_wf',
            environments: {
                staging: { workflowId: 'staging_wf', appId: 'com.example.staging' }
            }
        };
        var r = h.resolveEnvironmentBuildConfig(bitriseBuild, 'staging');
        assert.equal(r.active, true);
        assert.equal(r.environment, 'staging');
        assert.equal(r.buildConfig.appSlug, 'slug');
        assert.equal(r.buildConfig.workflowId, 'staging_wf');
        assert.equal(r.envConfig.appId, 'com.example.staging');
    });

    test('keeps the default workflowId when env config has none', function() {
        var h = loadSetupHelpers();
        var bitriseBuild = {
            appSlug: 'slug',
            workflowId: 'default_wf',
            environments: { prod: { appId: 'com.example' } }
        };
        var r = h.resolveEnvironmentBuildConfig(bitriseBuild, 'prod');
        assert.equal(r.active, true);
        assert.equal(r.buildConfig.workflowId, 'default_wf');
    });

    test('stays inactive when the environment is not configured', function() {
        var h = loadSetupHelpers();
        var bitriseBuild = {
            appSlug: 'slug',
            workflowId: 'default_wf',
            environments: { staging: { workflowId: 'staging_wf' } }
        };
        var r = h.resolveEnvironmentBuildConfig(bitriseBuild, 'prod');
        assert.equal(r.active, false);
        assert.equal(r.buildConfig, bitriseBuild, 'buildConfig should be untouched');
        assert.equal(r.envConfig, null);
        var noEnv = h.resolveEnvironmentBuildConfig({ appSlug: 's', workflowId: 'w' }, 'prod');
        assert.equal(noEnv.active, false);
    });

});

// ── Suite: buildEnvironmentMarkdown ──────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: buildEnvironmentMarkdown', function() {

    test('builds environment.md with defaults for credential env var names', function() {
        var h = loadSetupHelpers();
        var lines = h.buildEnvironmentMarkdown('staging', 'staging_wf', { appId: 'com.example.staging' });
        var md = lines.join('\n');
        assert.ok(md.indexOf('# Test Environment: STAGING') !== -1);
        assert.ok(md.indexOf('| Environment | staging |') !== -1);
        assert.ok(md.indexOf('| Bitrise Workflow | staging_wf |') !== -1);
        assert.ok(md.indexOf('| APP_ID | `com.example.staging` |') !== -1);
        assert.ok(md.indexOf('`TEST_USER_EMAIL`') !== -1, 'default user env var');
        assert.ok(md.indexOf('`TEST_USER_PASSWORD`') !== -1, 'default password env var');
        assert.ok(md.indexOf('`TEST_USER_PIN`') !== -1, 'default pin env var');
    });

    test('honours custom credential env var names and omits APP_ID when absent', function() {
        var h = loadSetupHelpers();
        var lines = h.buildEnvironmentMarkdown('prod', 'wf', {
            userEnvVar: 'STAGE_USER', passwordEnvVar: 'STAGE_PASS', pinEnvVar: 'STAGE_PIN'
        });
        var md = lines.join('\n');
        assert.ok(md.indexOf('| APP_ID |') === -1, 'no APP_ID row without appId');
        assert.ok(md.indexOf('`STAGE_USER`') !== -1);
        assert.ok(md.indexOf('`STAGE_PASS`') !== -1);
        assert.ok(md.indexOf('`STAGE_PIN`') !== -1);
    });

});

// ── Suite: decideAppId ───────────────────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: decideAppId', function() {

    test('returns appId from the matching environment', function() {
        var h = loadSetupHelpers();
        var bitriseBuild = { environments: { prod: { appId: 'com.example' } } };
        assert.equal(h.decideAppId(bitriseBuild, 'prod'), 'com.example');
    });

    test('returns null when env or appId missing', function() {
        var h = loadSetupHelpers();
        assert.equal(h.decideAppId(null, 'prod'), null);
        assert.equal(h.decideAppId({ environments: {} }, 'prod'), null);
        assert.equal(h.decideAppId({ environments: { prod: {} } }, 'prod'), null);
    });

});

// ── Suite: defaultAppId ──────────────────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: defaultAppId', function() {

    test('falls back to the default bundle id', function() {
        var h = loadSetupHelpers();
        assert.equal(h.defaultAppId(null), 'com.example.internal.business.app');
        assert.equal(h.defaultAppId('com.custom'), 'com.custom');
    });

});

// ── Suite: matchBootedSimulatorUdid ──────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: matchBootedSimulatorUdid', function() {

    test('extracts the first UDID from simctl output', function() {
        var h = loadSetupHelpers();
        var out = '== Devices ==\n    iPhone 15 (ABC12345-1234-1234-1234-1234567890AB) (Booted)\n';
        assert.equal(h.matchBootedSimulatorUdid(out), 'ABC12345-1234-1234-1234-1234567890AB');
    });

    test('returns null when no booted device is listed', function() {
        var h = loadSetupHelpers();
        assert.equal(h.matchBootedSimulatorUdid('== Devices ==\n-- iOS 17.0 --\n    iPhone 15 (Shutdown)\n'), null);
        assert.equal(h.matchBootedSimulatorUdid(null), null);
    });

});

// ── Suite: buildSimulatorInfoMarkdown ────────────────────────────────────────

suite('preCliMobileTestAutomationSetupHelpers: buildSimulatorInfoMarkdown', function() {

    test('builds the simulator & Maestro block with udid and appId', function() {
        var h = loadSetupHelpers();
        var lines = h.buildSimulatorInfoMarkdown('UDID-1', 'com.example.app');
        var md = lines.join('\n');
        assert.ok(md.indexOf('## Simulator & Maestro') !== -1);
        assert.ok(md.indexOf('| MAESTRO_DEVICE | `UDID-1` |') !== -1);
        assert.ok(md.indexOf('| APP_ID | `com.example.app` |') !== -1);
        assert.ok(md.indexOf('MAESTRO_DEVICE="UDID-1" APP_ID="com.example.app" PLATFORM=ios') !== -1);
    });

});
