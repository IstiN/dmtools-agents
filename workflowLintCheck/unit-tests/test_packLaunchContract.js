/**
 * Unit tests for the pack launch-surface contract (Wave 2, owner decision
 * 2026-10-01): the four teammate packs (pr_review, pr_rework,
 * story_development, bug_development) must be SELF-SUFFICIENT in their
 * release zips —
 *
 *   launch.json      verbatim copy of the root entry config <agent>.json
 *                    ("how to launch me")
 *   loop/verdict.sh  verbatim copy of setup/review-verdict.sh (review packs
 *                    only — the loop-verdict logic versions with the pack)
 *
 * The contract table + pure manifest merge live in
 * ci/pack_launch_contract.cjs (loaded via loadModule); the release builder
 * (ci/release_packs.mjs) wires them between `dmtools compile` and the
 * manifest validation. The factory consumer (factory-teammate.yml, home:
 * dmtools-agentic-workflows) prefers the pack's launch.json over the legacy
 * factory-agents/<agent>.json tree copy — the naming helpers in
 * setup/fa-session.sh and scripts/run-agent.sh must therefore keep deriving
 * the AGENT identity (session group, usage name) from the pack dir, not
 * from the launch.json basename.
 *
 * Uses: loadModule(), file_read(), suite(), test(), assert
 */

function contract() {
    return loadModule('ci/pack_launch_contract.cjs');
}

// ── which packs carry a launch surface ───────────────────────────────────────

suite('pack launch contract: teammate pack set', function () {

    test('exactly the four teammate packs carry a launch surface', function () {
        var m = contract();
        var names = Object.keys(m.TEAMMATE_LAUNCH_PACKS).sort();
        assert.deepEqual(
            ['bug_development', 'pr_review', 'pr_rework', 'story_development'],
            names,
            'the teammate pack set is the four factory slots (bug/story dev, review, rework)');
    });

    test('non-teammate agents are recognized and left untouched', function () {
        var m = contract();
        assert.equal(m.isTeammatePack('sm_github'), false);
        assert.equal(m.isTeammatePack('machine_merge'), false);
        assert.equal(m.isTeammatePack('constructor'), false, 'no prototype pollution');
        assert.deepEqual(m.launchExtras('sm_github'), [],
            'sm_github pack zips stay exactly as dmtools compile built them');
    });
});

// ── launchExtras: what goes into the zip ─────────────────────────────────────

suite('pack launch contract: launchExtras', function () {

    test('pr_review adds launch.json + loop/verdict.sh', function () {
        var m = contract();
        assert.deepEqual(m.launchExtras('pr_review'), [
            { entry: 'launch.json', source: 'pr_review.json' },
            { entry: 'loop/verdict.sh', source: 'setup/review-verdict.sh' },
        ]);
    });

    test('pr_rework adds launch.json + loop/verdict.sh', function () {
        var m = contract();
        assert.deepEqual(m.launchExtras('pr_rework'), [
            { entry: 'launch.json', source: 'pr_rework.json' },
            { entry: 'loop/verdict.sh', source: 'setup/review-verdict.sh' },
        ]);
    });

    test('dev packs add launch.json only (no in-pack loop logic yet)', function () {
        var m = contract();
        assert.deepEqual(m.launchExtras('story_development'),
            [{ entry: 'launch.json', source: 'story_development.json' }]);
        assert.deepEqual(m.launchExtras('bug_development'),
            [{ entry: 'launch.json', source: 'bug_development.json' }]);
    });

    test('every referenced source exists in the tree (release would fail loudly otherwise)', function () {
        var m = contract();
        Object.keys(m.TEAMMATE_LAUNCH_PACKS).forEach(function (agent) {
            m.launchExtras(agent).forEach(function (x) {
                var src = file_read({ path: x.source });
                assert.ok(src && src.length > 0, x.source + ' must exist and be non-empty');
            });
        });
    });

    test('loop/verdict.sh source is the unit-tested review-verdict.sh', function () {
        var m = contract();
        assert.equal(m.VERDICT_SOURCE, 'setup/review-verdict.sh',
            'the pack verdict logic is a verbatim copy of the script tested by ' +
            'test_reviewVerdict.js + dmtools-dart test/machine_kit/review_verdict_test.dart');
    });
});

// ── mergeManifest: pure manifest folding ─────────────────────────────────────

suite('pack launch contract: mergeManifest', function () {

    test('adds new entries and keeps files sorted by path', function () {
        var m = contract();
        var out = m.mergeManifest(
            { agent: 'pr_review', version: '0.1.18', files: [
                { path: 'scripts/run-agent.sh', sha256: 'b', mode: '0755' },
                { path: 'js/x.js', sha256: 'a', mode: '0644' },
            ] },
            [
                { path: 'launch.json', sha256: 'l', mode: '0644' },
                { path: 'loop/verdict.sh', sha256: 'v', mode: '0755' },
            ],
        );
        assert.deepEqual(out.files.map(function (f) { return f.path; }), [
            'js/x.js', 'launch.json', 'loop/verdict.sh', 'scripts/run-agent.sh',
        ]);
    });

    test('a same-path entry is replaced, not duplicated', function () {
        var m = contract();
        var out = m.mergeManifest(
            { files: [{ path: 'launch.json', sha256: 'old', mode: '0644' }] },
            [{ path: 'launch.json', sha256: 'new', mode: '0644' }],
        );
        assert.equal(out.files.length, 1);
        assert.equal(out.files[0].sha256, 'new');
    });

    test('manifest identity keys pass through untouched', function () {
        var m = contract();
        var manifest = {
            agent: 'pr_review', version: '0.1.18', sourceCommit: 'deadbeef',
            defaultEntry: 'pr_review.json', minDmtoolsVersion: 'unknown',
            files: [],
        };
        var out = m.mergeManifest(manifest, [{ path: 'launch.json', sha256: 'l', mode: '0644' }]);
        assert.equal(out.agent, 'pr_review');
        assert.equal(out.version, '0.1.18');
        assert.equal(out.defaultEntry, 'pr_review.json',
            'defaultEntry still names the compile entry — launch.json is an ADDITIVE alias, not a replacement');
    });
});

// ── release builder wiring (haystack: order is load-bearing) ─────────────────

suite('pack launch contract: release builder wiring', function () {

    var builder = file_read({ path: 'ci/release_packs.mjs' });

    test('the builder imports the contract module', function () {
        assert.ok(builder.indexOf("pack_launch_contract.cjs") !== -1,
            'ci/release_packs.mjs must import ci/pack_launch_contract.cjs');
    });

    test('augmentLaunchSurface runs between compile and validation', function () {
        var compile = builder.indexOf('const zip = buildPack(agent, next);');
        var augment = builder.indexOf('augmentLaunchSurface(agent, zip);');
        var validate = builder.indexOf('const count = validatePack(zip);');
        assert.ok(compile !== -1 && augment !== -1 && validate !== -1,
            'build → augment → validate steps all present');
        assert.ok(compile < augment && augment < validate,
            'the launch surface is added BEFORE validation, so a broken manifest merge fails the release');
    });

    test('catalog.json format is untouched by the augmentation', function () {
        assert.ok(builder.indexOf("writeFileSync(join(OUT_DIR, 'catalog.json')") !== -1,
            'catalog.json is still written by the builder');
        var contractModule = file_read({ path: 'ci/pack_launch_contract.cjs' });
        assert.ok(contractModule.indexOf('writeFileSync') === -1,
            'the contract module is pure — no file writes, so it cannot alter the catalog format');
    });
});

// ── naming helpers stay pack-path aware (session/usage identity) ─────────────

suite('pack launch contract: pack-path aware naming helpers', function () {

    test('fa-session.sh derives the slug from the pack dir, not the launch.json basename', function () {
        var faSession = file_read({ path: 'setup/fa-session.sh' });
        assert.ok(faSession.indexOf('*/.dmtools/packs/*') !== -1,
            'a .dmtools/packs/<agent>-<version>/ config path is recognized as a pack launch surface');
        assert.ok(faSession.indexOf('${config#*/.dmtools/packs/}') !== -1,
            'the agent name is taken from the pack directory');
        // dev-write vs dev-review session separation rides on the slug being
        // the agent name: launch.json would collapse every agent into "launch".
        var groupCase = faSession.indexOf('story_development|bug_development|pr_rework');
        assert.ok(groupCase !== -1, 'session-group mapping preserved');
    });

    test('run-agent.sh derives the usage name from the pack dir too', function () {
        var runAgent = file_read({ path: 'scripts/run-agent.sh' });
        assert.ok(runAgent.indexOf('*/.dmtools/packs/*') !== -1,
            'pack launch configs are recognized in the usage-name derivation');
        assert.ok(runAgent.indexOf('${usage_name%-[0-9]*}') !== -1,
            'the version tail is stripped so usage reports keep the legacy agent name');
    });
});
