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
