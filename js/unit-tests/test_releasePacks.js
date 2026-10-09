/**
 * Unit tests: the pack-release pipeline (ci/release_packs.mjs +
 * .github/workflows/agent-pack-release.yml + ci/pack_release_guard.cjs).
 *
 * Guards the gh-690 incident class (live 2026-10-04 05:40-05:48): three
 * content PRs merged within 3 minutes → three overlapping release runs →
 * THREE ledger bump PRs, of which #689 MERGED WITH A 0-BYTE DIFF (its branch
 * was cut before #688's identical ledger landed; `gh pr merge --auto` fires
 * server-side the moment checks pass and cannot re-verify that main did not
 * move in between). The same stale-checkout race double-bumped the agents
 * whose content landed mid-flight (sm_github/pr_review 0.1.24 vs 0.1.23).
 *
 * Invariants:
 *   R1 ledger sweep — versions.json is the version LEDGER (data), never an
 *      agent: agent discovery and the affected-set computation must exclude
 *      it (the old sweep built a phantom versions-*.zip, shipped it in every
 *      release, and wrote a bogus "versions" key into the ledger).
 *   R2 nothing-changed guard — a ledger bump PR whose versions.json already
 *      matches main must be CLOSED (or never created), never merged.
 *   R3 queued runs release CURRENT main — a run queued behind another must
 *      reset to origin/main before computing the affected set, so content
 *      that landed mid-queue is released exactly once from the current
 *      ledger (no duplicate releases, no off-by-one bumps).
 *   R4 single trigger plane — the concurrency group serializes release
 *      runs (present since #441; pinned here so it cannot silently vanish).
 *
 * Uses: loadModule(), file_read(), suite(), test(), assert
 */

'use strict';

/* global loadModule, assert, test, suite, file_read */

function guard() {
    return loadModule('ci/pack_release_guard.cjs');
}

function nthIndexOf(haystack, needle, n) {
    var i = -1;
    for (var k = 0; k < n; k++) {
        i = haystack.indexOf(needle, i + 1);
        if (i === -1) return -1;
    }
    return i;
}

// ── R1: the ledger is data, not an agent ─────────────────────────────────────

suite('pack release guard: file classification', function () {

    test('the version ledger is recognized', function () {
        assert.equal(guard().isLedgerFile('versions.json'), true);
        assert.equal(guard().LEDGER_FILE, 'versions.json');
    });

    test('agent configs and unrelated files are not the ledger', function () {
        assert.equal(guard().isLedgerFile('sm.json'), false);
        assert.equal(guard().isLedgerFile('package.json'), false);
        assert.equal(guard().isLedgerFile('js/versions.json'), false,
            'only the repo-root ledger counts');
    });

    test('a root entry config is an agent config', function () {
        assert.equal(guard().isAgentConfigFile('sm.json'), true);
        assert.equal(guard().isAgentConfigFile('createRepoTasks.json'), true);
    });

    test('the ledger is NOT an agent config (gh-690 R1)', function () {
        assert.equal(guard().isAgentConfigFile('versions.json'), false,
            'the old allAgents() sweep treated versions.json as an agent named ' +
            '"versions" — a phantom pack in every release and a bogus ledger key');
    });

    test('npm metadata and nested files are not agent configs', function () {
        assert.equal(guard().isAgentConfigFile('package.json'), false);
        assert.equal(guard().isAgentConfigFile('package-lock.json'), false);
        assert.equal(guard().isAgentConfigFile('js/sm.json'), false,
            'agent entry configs live at the repo root only');
        assert.equal(guard().isAgentConfigFile('instructions/x.json'), false);
    });

    test('short non-json root entries (dirs like .git/.fah/docs/site) are not agent configs', function () {
        // Review-blocked regression: for names shorter than 5 chars the old
        // `lastIndexOf('.json') !== file.length - 5` suffix check compared
        // -1 !== -1 and PASSED the name through as an agent — the runner's
        // checkout (actions/checkout creates .git; .fah/docs/site are
        // tracked) would have produced phantom agents .fa/.gi/doc/sit and
        // crashed the release building .fa.json.
        assert.equal(guard().isAgentConfigFile('.git'), false);
        assert.equal(guard().isAgentConfigFile('.fah'), false);
        assert.equal(guard().isAgentConfigFile('docs'), false);
        assert.equal(guard().isAgentConfigFile('site'), false);
    });

    test('agentNamesFromFiles survives a root-shaped runner listing with no phantom names', function () {
        var names = guard().agentNamesFromFiles([
            '.git', '.github', '.fah', 'docs', 'site', 'js', 'setup',
            'AGENTS.md', 'LICENSE', 'README.md', 'package.json',
            'versions.json', 'sm.json', 'pr_review.json',
        ]);
        assert.deepEqual(names, ['pr_review', 'sm'],
            'short root entries must never leak in as phantom agents — ' +
            'allAgents() feeds this straight into buildPack()');
    });

    test('toAgentName strips only the .json suffix', function () {
        assert.equal(guard().toAgentName('sm.json'), 'sm');
        assert.equal(guard().toAgentName('createRepoTasks.json'), 'createRepoTasks');
    });

    test('agentNamesFromFiles maps a multi-file listing to sorted agent names', function () {
        var names = guard().agentNamesFromFiles([
            'story_development.json', 'versions.json', 'package.json',
            'sm.json', 'js/helpers.json', 'README.md',
        ]);
        assert.deepEqual(names, ['sm', 'story_development'],
            'the ledger, npm metadata and non-root files are all excluded');
    });

    test('an empty listing yields an empty agent set', function () {
        assert.deepEqual(guard().agentNamesFromFiles(['versions.json', 'package.json']), []);
    });
});

// ── release builder wiring (ci/release_packs.mjs) ────────────────────────────

suite('release builder wiring', function () {

    var builder = file_read({ path: 'ci/release_packs.mjs' });

    test('the builder imports the guard module', function () {
        assert.ok(builder.indexOf('pack_release_guard.cjs') !== -1,
            'ci/release_packs.mjs must import ci/pack_release_guard.cjs');
    });

    test('agent discovery goes through the ledger-aware classifier', function () {
        assert.ok(builder.indexOf('agentNamesFromFiles(readdirSync(ROOT))') !== -1,
            'allAgents() must classify via agentNamesFromFiles — the old inline ' +
            'filter swept versions.json in as a phantom "versions" agent');
    });

    test('a changed ledger file never marks anything affected (via the guard classifier)', function () {
        var affected = builder.indexOf('function computeAffectedSet()');
        var classified = builder.indexOf('isAgentConfigFile(file)', affected);
        assert.ok(classified !== -1,
            'computeAffectedSet must route root-entry classification through ' +
            'isAgentConfigFile: every merged ledger PR puts versions.json into ' +
            'the base...HEAD diff, and the old sweep turned that into a ' +
            'phantom affected agent');
        assert.ok(builder.indexOf('toAgentName(file)', affected) !== -1,
            'the affected-set path must derive agent names via toAgentName — ' +
            'one classification path, one test surface');
        assert.equal(builder.indexOf("!file.includes('/') && !file.startsWith('package')", affected), -1,
            'the hand-rolled inline copy of isAgentConfigFile+toAgentName must ' +
            'go — a second classifier drifts from the unit-tested one and the ' +
            'phantom-agent class returns through the affected-set door');
    });

    test('the builder still wires the launch contract', function () {
        assert.ok(builder.indexOf('pack_launch_contract.cjs') !== -1,
            'gh-690 must not regress the dm.ai#595 launch surface wiring');
    });
});

// ── release workflow wiring (agent-pack-release.yml) ─────────────────────────

suite('release workflow wiring', function () {

    var wf = file_read({ path: '.github/workflows/agent-pack-release.yml' });

    test('R4: the concurrency group serializes release runs', function () {
        assert.ok(wf.indexOf('group: agent-pack-release') !== -1,
            'gh-690 asked whether the group was missing — it exists and must stay');
        assert.ok(wf.indexOf('cancel-in-progress: false') !== -1,
            'releases must queue, never cancel mid-publish');
    });

    test('R3: queued runs reset to current main before computing the affected set', function () {
        var reset = wf.indexOf('git reset --hard origin/main');
        assert.ok(reset !== -1,
            'a run queued behind another checked out its own trigger SHA and ' +
            'bumped from a stale ledger — the sm_github/pr_review 0.1.24 ' +
            'off-by-one and the duplicate release');
        var build = wf.indexOf('node ci/release_packs.mjs');
        assert.ok(build !== -1 && reset < build,
            'the reset must happen BEFORE the affected-set computation');
        assert.ok(wf.indexOf("github.event_name == 'push'") !== -1,
            'the reset is gated to push events — manual dispatch may target a branch');
    });

    test('R2 guard 1: main-already-carries-it skips the push entirely', function () {
        var guardDiff = wf.indexOf('git diff --quiet HEAD origin/main -- versions.json');
        assert.ok(guardDiff !== -1, 'the nothing-changed guard must exist');
        var push = wf.indexOf('git push origin HEAD:main');
        assert.ok(push !== -1 && guardDiff < push,
            'the guard must run BEFORE the push (skip, not push an empty/duplicate ledger)');
        assert.ok(wf.indexOf('::notice::main already carries the target agent versions') !== -1,
            'the skip must be visible in the run log');
    });

    test('R2 guard 2: the ledger is rebased onto fresh main right before the direct push', function () {
        var firstGuard = wf.indexOf('git diff --quiet HEAD origin/main -- versions.json');
        var rebase = wf.indexOf('git rebase origin/main');
        var push = wf.indexOf('git push origin HEAD:main');
        assert.ok(rebase !== -1 && rebase > firstGuard,
            'main may move while the run builds — rebase after the guard');
        assert.ok(push > rebase,
            'rebase must precede the push so a concurrent merge is never a non-fast-forward');
    });

    test('R2: a rejected direct push degrades to a warning and never fails the release', function () {
        var push = wf.indexOf('git push origin HEAD:main');
        var tail = wf.slice(push);
        assert.ok(/if ! git push origin HEAD:main/.test(wf),
            'the push must be guarded so a rejection cannot fail the run after publishing');
        assert.ok(tail.indexOf('::warning::direct ledger push rejected') !== -1,
            'the rejected push must still surface as a warning — the next release recomputes from main');
    });

    test('R2: the ledger lands by direct push — no PR round-trip (#724)', function () {
        assert.ok(wf.indexOf('gh pr create') === -1,
            'the version ledger must not open a chore PR (queue through conveyor gates)');
        assert.ok(wf.indexOf('gh pr merge') === -1,
            'no PR means no merge step to bypass the empty-diff guard');
    });

    test('R2: --auto merge is gone — it merges server-side, bypassing the guard', function () {
        assert.ok(wf.indexOf('--auto') === -1,
            '`gh pr merge --auto` fires the moment checks pass with no chance ' +
            'to re-verify the diff — exactly how #689 merged empty');
    });
});

// ── version ledger hygiene (gh-690 audit) ────────────────────────────────────

suite('version ledger hygiene', function () {

    var ledger = JSON.parse(file_read({ path: 'versions.json' }));

    test('the ledger carries no phantom "versions" key', function () {
        assert.ok(!Object.prototype.hasOwnProperty.call(ledger, 'versions'),
            'the old agent-discovery sweep bumped versions.json as an agent ' +
            'named "versions" — the bogus key shipped in the ledger and a ' +
            'phantom versions-<v>.zip shipped in every release (gh-690 audit)');
    });

    test('every ledger key maps to a real root entry config', function () {
        var keys = Object.keys(ledger);
        assert.ok(keys.length > 2, 'the ledger should list the agent fleet');
        for (var i = 0; i < keys.length; i++) {
            var src = file_read({ path: keys[i] + '.json' });
            assert.ok(src && src.length > 0,
                'ledger key ' + keys[i] + ' has no root ' + keys[i] + '.json entry config');
        }
    });

    test('ledger versions are semver strings', function () {
        var keys = Object.keys(ledger);
        for (var i = 0; i < keys.length; i++) {
            assert.ok(/^\d+\.\d+\.\d+$/.test(ledger[keys[i]]),
                keys[i] + ' version must be semver, got: ' + ledger[keys[i]]);
        }
    });
});

// ── gh-812: version uniqueness + require sanity gate wiring ──────────────────

suite('gh-812 release integrity wiring', function () {

    var builder = file_read({ path: 'ci/release_packs.mjs' });
    var wf = file_read({ path: '.github/workflows/agent-pack-release.yml' });

    test('the builder imports the require sanity gate module', function () {
        assert.ok(builder.indexOf('pack_require_gate.cjs') !== -1,
            'ci/release_packs.mjs must import ci/pack_require_gate.cjs — the ' +
            'release self-test asserting every packed require resolves inside ' +
            'the zip (gh-812 AC1/AC3)');
    });

    test('the builder imports the version guard module', function () {
        assert.ok(builder.indexOf('pack_version_guard.cjs') !== -1,
            'ci/release_packs.mjs must import ci/pack_version_guard.cjs — two ' +
            'releases with differing pack content must never share a version ' +
            'string (gh-812 AC2)');
    });

    test('the gate runs on every built zip, after the launch augment', function () {
        var augmentCall = builder.indexOf('augmentLaunchSurface(agent, zip)');
        var gateCall = builder.indexOf('assertZipRequires(zip)');
        assert.ok(gateCall !== -1, 'the builder must run the require gate');
        assert.ok(augmentCall !== -1, 'the builder must augment the launch surface');
        assert.ok(gateCall > augmentCall,
            'the gate must see the FINAL payload — launch extras (verdict.sh ' +
            'is shell, but future contract files may not be) are folded in by ' +
            'the augment, so gating before it tests a zip that never ships');
    });

    test('unresolved requires FAIL the release (throw → non-zero step)', function () {
        var defStart = builder.indexOf('function assertZipRequires(');
        assert.ok(defStart !== -1, 'the builder must define the require gate');
        var body = builder.slice(defStart, defStart + 2600);
        assert.ok(body.indexOf('throw new Error') !== -1,
            'the gate must throw on unresolved requires so the build step exits ' +
            'non-zero BEFORE the ledger commit and the gh release create');
        var publish = wf.indexOf('gh release create');
        var buildStep = wf.indexOf('node ci/release_packs.mjs');
        assert.ok(buildStep !== -1 && buildStep < publish,
            'the gate lives in the build step — it must run before the publish step');
    });

    test('the workflow hands the previous release tag to the builder', function () {
        assert.ok(wf.indexOf('--prev-release-tag') !== -1,
            'the builder needs the last agents-rel-* tag to read the SHIPPED ' +
            'catalog and same-version zips — versions.json on main is a ' +
            'best-effort ledger that never landed (gh-812 root cause)');
        var base = wf.indexOf('steps.base.outputs.ref');
        var prev = wf.indexOf('--prev-release-tag');
        assert.ok(base !== -1 && prev !== -1,
            'the base-ref step output feeds the prev-release-tag argument');
    });

    test('the build step can call gh (token in env) for the shipped-state reads', function () {
        var buildStep = wf.indexOf('node ci/release_packs.mjs');
        var head = wf.slice(0, buildStep);
        var envBlock = head.lastIndexOf('env:');
        assert.ok(envBlock !== -1 && head.slice(envBlock, buildStep).indexOf('GH_TOKEN') !== -1,
            'the previous-release downloads are gh calls — the build step needs GH_TOKEN');
    });

    test('gh-812 rework: a failed shipped-catalog read FAILS the release (no silent ledger fallback)', function () {
        var fnStart = builder.indexOf('function shippedCatalog()');
        assert.ok(fnStart !== -1, 'shippedCatalog must exist');
        var body = builder.slice(fnStart, builder.indexOf('function shippedZipManifest(', fnStart));
        assert.ok(body.indexOf('throw new Error') !== -1,
            'the shipped catalog IS the version-uniqueness base — a failed read ' +
            'must fail the release, not silently fall back to the versions.json ' +
            'ledger that caused gh-812 (review thread 2: a gh outage is transient, ' +
            'a silently degraded release is the failure mode this pipeline prevents)');
        assert.ok(body.indexOf('::error::') !== -1,
            'the degradation must surface at ::error:: level, not a log line');
    });

    test('gh-812 rework: the ledger fallback is an explicit --allow-unverified-base decision', function () {
        assert.ok(builder.indexOf("hasFlag('--allow-unverified-base')") !== -1,
            'the fallback needs an explicit operator flag — a deviation from the ' +
            'version-uniqueness guarantee must be a human decision, not a log line');
        var fnStart = builder.indexOf('function shippedCatalog()');
        var body = builder.slice(fnStart, builder.indexOf('function shippedZipManifest(', fnStart));
        assert.ok(body.indexOf('::warning::') !== -1,
            'with the flag the degraded release stays visible as a warning');
    });

    test('gh-812 rework: a failed shipped-zip read FAILS the release instead of skipping the drift check', function () {
        var fnStart = builder.indexOf('function shippedZipManifest(');
        assert.ok(fnStart !== -1, 'shippedZipManifest must exist');
        var body = builder.slice(fnStart, builder.indexOf('function zipManifestText(', fnStart));
        assert.ok(body.indexOf('throw new Error') !== -1,
            'a missing shipped zip silently disabled the payload-drift check ' +
            '(fingerprintsDiffer(null, …) === false → shipped at the candidate ' +
            'version) — it must fail the release instead (review thread 2)');
        assert.ok(body.indexOf('::error::') !== -1, 'error-level, not a quiet warning');
        assert.ok(body.indexOf('gh release download') === -1,
            'no per-agent gh round-trip — the zips are already on disk from the ' +
            'batched download (review thread 6), which also collapses the ' +
            'transient-failure surface this test guards');
    });

    test('gh-812 rework: shipped zips are fetched in ONE batched download, not ~68 per agent', function () {
        var fnStart = builder.indexOf('function shippedCatalog()');
        var body = builder.slice(fnStart, builder.indexOf('function shippedZipManifest(', fnStart));
        assert.ok(body.indexOf("--pattern '*.zip'") !== -1,
            'one `gh release download --pattern *.zip` per release replaces the ' +
            'serial per-agent downloads (review thread 6)');
        var downloads = builder.split('gh release download').length - 1;
        assert.equal(downloads, 2,
            'exactly two gh downloads remain: catalog.json + the batched zips');
    });

    test('gh-812 rework: the workflow keeps the strict default (no --allow-unverified-base)', function () {
        assert.ok(wf.indexOf('allow-unverified-base') === -1,
            'the release must fail on unreadable shipped state by default — ' +
            'the flag is for deliberate manual overrides only');
    });

    test('gh-812 rework: the drift re-version deletes the stale zip + .sha256 BEFORE rebuilding (one zip per agent in dist/)', function () {
        var branchStart = builder.indexOf('next = resolveShipVersion(next, true)');
        assert.ok(branchStart !== -1, 'the payload-drift re-version branch must exist');
        var branchEnd = builder.indexOf('assertZipRequires(zip);', branchStart);
        assert.ok(branchEnd !== -1, 'the non-drift path must follow the branch');
        var branch = builder.slice(branchStart, branchEnd);
        var delZip = branch.indexOf('rmSync(zip, { force: true });');
        var delSidecar = branch.indexOf('rmSync(`${zip}.sha256`, { force: true });');
        var rebuild = branch.indexOf('const rezipped = buildPack(agent, next)');
        assert.ok(delZip !== -1,
            'the drifted <agent>-<shippedVersion>.zip must be deleted from dist/ — ' +
            'the publish step uploads dist/*.zip wholesale, so a stale artifact ' +
            'republishes the exact two-packs-one-version collision gh-812 forbids');
        assert.ok(delSidecar !== -1, 'the stale .sha256 sidecar must be deleted too');
        assert.ok(rebuild !== -1, 'the re-version path must rebuild at the final version');
        assert.ok(delZip < rebuild && delSidecar < rebuild,
            'both stale artifacts must be removed BEFORE the rebuild so dist/ ' +
            'never holds two zips for one agent at publish time');
        assert.ok(branch.indexOf('zipPath: rezipped') !== -1,
            'the branch must ship the REBUILT zip, never the stale first build');
    });

    test('gh-812 rework: the untrusted tag name reaches the script only via env indirection', function () {
        var buildStep = wf.indexOf('node ci/release_packs.mjs');
        assert.ok(buildStep !== -1, 'the build step must exist');
        var runStart = wf.lastIndexOf('run: |', buildStep);
        var envStart = wf.lastIndexOf('env:', runStart);
        assert.ok(envStart !== -1 && envStart < runStart, 'the build step declares an env block');
        var envBlock = wf.slice(envStart, runStart);
        var script = wf.slice(runStart, buildStep);
        assert.ok(script.indexOf('${{') === -1,
            'no ${{ }} template expansion inside the run: block — Actions ' +
            'interpolates BEFORE bash parses, so a crafted agents-rel-* tag ' +
            'name could break out of the quoting in a contents:write job ' +
            '(review thread 3)');
        assert.ok(envBlock.indexOf('PREV_RELEASE_TAG: ${{ steps.base.outputs.ref }}') !== -1,
            'the prev-release tag reaches the script through env, not interpolation');
        assert.ok(envBlock.indexOf('BASE_REF: ${{ steps.base.outputs.ref }}') !== -1,
            'the base ref is routed through env too — same pre-existing flaw');
    });

    test('gh-812 rework: the tag format is validated before the builder runs', function () {
        var buildStep = wf.indexOf('node ci/release_packs.mjs');
        var runStart = wf.lastIndexOf('run: |', buildStep);
        var script = wf.slice(runStart, buildStep);
        assert.ok(script.indexOf('^agents-rel-[0-9]{8}-[0-9]{6}$') !== -1,
            'release-base tags are machine-generated (agents-rel-YYYYMMDD-HHMMSS) — ' +
            'anything else in the newest agents-rel-* tag must be rejected');
        assert.ok(script.indexOf('::error::unexpected agents-rel tag format') !== -1,
            'the rejection must be visible in the run summary');
    });
});
