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

    test('a changed ledger file never marks anything affected', function () {
        var affected = builder.indexOf('function computeAffectedSet()');
        var skip = builder.indexOf('isLedgerFile', affected);
        assert.ok(skip !== -1,
            'computeAffectedSet must skip the ledger: every merged ledger PR ' +
            'puts versions.json into the base...HEAD diff, and the old sweep ' +
            'turned that into a phantom affected agent');
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

    test('R2 guard 1: main-already-carries-it skips PR creation', function () {
        var guardDiff = wf.indexOf('git diff --quiet HEAD origin/main -- versions.json');
        assert.ok(guardDiff !== -1, 'the nothing-changed guard must exist');
        var create = wf.indexOf('gh pr create');
        assert.ok(create !== -1 && guardDiff < create,
            'the guard must run BEFORE the PR is created (skip, not close)');
        assert.ok(wf.indexOf('::notice::main already carries the target agent versions') !== -1,
            'the skip must be visible in the run log');
    });

    test('R2 guard 2: the empty-diff re-check runs after the checks finish, before merging', function () {
        var firstGuard = wf.indexOf('git diff --quiet HEAD origin/main -- versions.json');
        var watch = wf.indexOf('gh pr checks');
        var secondGuard = nthIndexOf(wf, 'git diff --quiet HEAD origin/main -- versions.json', 2);
        var merge = wf.lastIndexOf('gh pr merge');
        assert.ok(watch !== -1 && watch > firstGuard,
            'the run must wait for the required checks before re-checking');
        assert.ok(secondGuard !== -1 && secondGuard > watch,
            'the guard must be RE-RUN after the checks finish — main may have ' +
            'moved while the PR waited (#689 was cut before #688 landed)');
        assert.ok(merge > secondGuard,
            'only a still-different ledger may proceed to merge');
    });

    test('R2: an empty-diff PR is closed, not merged, and the close never fails the release', function () {
        var close = wf.indexOf('gh pr close');
        var secondGuard = nthIndexOf(wf, 'git diff --quiet HEAD origin/main -- versions.json', 2);
        assert.ok(close !== -1 && close > secondGuard,
            'the empty-diff outcome must be a close');
        var tail = wf.slice(close);
        assert.ok(tail.indexOf('::warning::') !== -1,
            'a failing close (PR already merged by the machine loop, say) must ' +
            'degrade to a warning — the release is already published by then');
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
