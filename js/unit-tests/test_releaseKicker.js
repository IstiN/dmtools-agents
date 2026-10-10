/**
 * Unit tests: the agent-pack release kicker (gh-844, live incident
 * 2026-10-10) — ci/release_kicker_guard.cjs + ci/release_kicker.mjs +
 * .github/workflows/agent-pack-release-kicker.yml.
 *
 * Incident: the agent-pack-release.yml push trigger silently skipped two
 * consecutive main merges (14:24Z #841, ~16:00Z #843) — the push event is
 * the ONLY trigger plane, so a server-side dropped event left agents-side
 * fixes dead in main for 2.75h (#826 hung) until an operator dispatch.
 *
 * Invariants:
 *   K1 detection — each tick compares main HEAD vs the latest agents-rel-*
 *      tag; a merge touching non-ignored paths with no release run pending
 *      re-dispatches the release workflow (the belt).
 *   K2 idempotent — an in-flight/queued release run suppresses the dispatch;
 *      main HEAD == tag commit no-ops; the release workflow's own ledger
 *      guard dedupes the rest (AC2).
 *   K3 paths-ignore parity — the ignore set is PARSED from
 *      agent-pack-release.yml (single source of truth, AC3): docs/.github/
 *      site-only changes never cut a release, .md files still do.
 *   K4 cadence — the schedule fires at least every 15 min (AC1: no fix waits
 *      >15 min in main without a release cut).
 *
 * Uses: loadModule(), file_read(), suite(), test(), assert
 */

'use strict';

/* global loadModule, assert, test, suite, file_read */

function guard() {
    return loadModule('ci/release_kicker_guard.cjs');
}

var RELEASE_WF_PATH = '.github/workflows/agent-pack-release.yml';
var KICKER_WF_PATH = '.github/workflows/agent-pack-release-kicker.yml';

// ── K3: the ignore set has a single source of truth ──────────────────────────

suite('release kicker: paths-ignore is parsed from the release workflow', function () {

    test('the guard parses the push paths-ignore out of agent-pack-release.yml', function () {
        var wf = file_read({ path: RELEASE_WF_PATH });
        var ignored = guard().pathsIgnoreFromWorkflow(wf);
        assert.deepEqual(ignored, ['.github/**', 'docs/**', 'site/**'],
            'the kicker must ignore EXACTLY what the push trigger ignores — ' +
            'a drifted hardcoded copy would either skip real releases or cut ' +
            'releases for CI-only changes (gh-844 AC3)');
    });

    test('no paths-ignore block yields an empty list', function () {
        assert.deepEqual(guard().pathsIgnoreFromWorkflow('name: x\non:\n  push:\n'), []);
    });

    test('the guard does not carry a hardcoded copy of the ignore list', function () {
        var src = file_read({ path: 'ci/release_kicker_guard.cjs' });
        assert.ok(src.indexOf("'.github/**'") === -1,
            'the ignore patterns must come from pathsIgnoreFromWorkflow — ' +
            'a hardcoded duplicate drifts from the push trigger (K3)');
    });

    test('the kicker runner imports the guard', function () {
        var src = file_read({ path: 'ci/release_kicker.mjs' });
        assert.ok(src.indexOf('release_kicker_guard.cjs') !== -1,
            'ci/release_kicker.mjs must decide through ci/release_kicker_guard.cjs, ' +
            'the same CJS-guard + ESM-runner split as pack_release_guard.cjs');
    });
});

// ── K1: main-ahead detection (pure logic) ────────────────────────────────────

suite('release kicker: path classification', function () {

    var IGNORED = ['.github/**', 'docs/**', 'site/**'];

    test('agents-relevant files demand a release (#841 files)', function () {
        assert.equal(guard().isIgnoredPath('js/common/reworkConsumption.js', IGNORED), false);
        assert.equal(guard().isIgnoredPath('js/smAgent.js', IGNORED), false);
        assert.equal(guard().isIgnoredPath('js/unit-tests/test_smAgent.js', IGNORED), false);
        assert.equal(guard().isIgnoredPath('sm_github.json', IGNORED), false);
    });

    test('markdown is NOT ignored — instruction packs ship .md (workflow note)', function () {
        assert.equal(guard().isIgnoredPath('README.md', IGNORED), false);
        assert.equal(guard().isIgnoredPath('instructions/common/x.md', IGNORED), false);
    });

    test('paths-ignore entries are excluded (AC3)', function () {
        assert.equal(guard().isIgnoredPath('.github/workflows/agent-pack-release.yml', IGNORED), true);
        assert.equal(guard().isIgnoredPath('.github/workflows/x.yml', IGNORED), true);
        assert.equal(guard().isIgnoredPath('docs/readme.md', IGNORED), true);
        assert.equal(guard().isIgnoredPath('site/index.html', IGNORED), true);
    });

    test('a docs-only or .github-only diff never kicks a release', function () {
        assert.equal(guard().filterRelevantFiles(['docs/a.md', '.github/workflows/y.yml'], IGNORED).length, 0);
        assert.equal(guard().filterRelevantFiles(['docs/a.md', 'js/smAgent.js'], IGNORED).length, 1);
    });
});

// ── K1/K2: the kick decision (L2 replays the 2026-10-10 14:24-17:05 gap) ────

suite('release kicker: decideKick', function () {

    var IGNORED = ['.github/**', 'docs/**', 'site/**'];
    var HEAD = 'aaa111';
    var TAG = 'bbb222';

    test('main HEAD == release tag commit → noop', function () {
        var d = guard().decideKick({
            mainHead: HEAD, releaseCommit: HEAD,
            changedFiles: ['js/smAgent.js'], activeReleaseRuns: 0, ignored: IGNORED
        });
        assert.equal(d.action, 'noop');
        assert.equal(d.reason, 'main-already-released');
    });

    test('only ignored paths changed → noop (AC3)', function () {
        var d = guard().decideKick({
            mainHead: HEAD, releaseCommit: TAG,
            changedFiles: ['docs/a.md', '.github/workflows/ci.yml'], activeReleaseRuns: 0, ignored: IGNORED
        });
        assert.equal(d.action, 'noop');
        assert.equal(d.reason, 'only-ignored-paths');
    });

    test('a pending/in-flight release run suppresses the dispatch (AC2)', function () {
        var d = guard().decideKick({
            mainHead: HEAD, releaseCommit: TAG,
            changedFiles: ['js/smAgent.js'], activeReleaseRuns: 1, ignored: IGNORED
        });
        assert.equal(d.action, 'noop');
        assert.equal(d.reason, 'release-run-pending');
    });

    test('L2 replay: the 14:24 #841 merge would have kicked at ~14:34', function () {
        var d = guard().decideKick({
            mainHead: HEAD, releaseCommit: TAG,
            // the actual #841 merge content (all outside paths-ignore):
            changedFiles: [
                'js/common/reworkConsumption.js',
                'js/smAgent.js',
                'js/unit-tests/test_reworkConsumption.js',
                'sm_github.json'
            ],
            activeReleaseRuns: 0, ignored: IGNORED
        });
        assert.equal(d.action, 'dispatch', 'main ahead on release-relevant paths with ' +
            'no release run pending — the belt must fire (gh-844 capability surface)');
        assert.ok(d.reason === 'main-ahead' || d.reason === 'main-ahead-on-release-paths',
            'reason: ' + d.reason);
        assert.equal(d.relevantCount, 4);
    });

    test('no release tag yet → dispatch (first release, the builder no-ops if empty)', function () {
        var d = guard().decideKick({
            mainHead: HEAD, releaseCommit: '',
            changedFiles: null, activeReleaseRuns: 0, ignored: IGNORED
        });
        assert.equal(d.action, 'dispatch');
        assert.equal(d.reason, 'no-release-tag');
    });

    test('diff unavailable → dispatch (never silently skip — the gh-844 bug class)', function () {
        var d = guard().decideKick({
            mainHead: HEAD, releaseCommit: TAG,
            changedFiles: null, activeReleaseRuns: 0, ignored: IGNORED
        });
        assert.equal(d.action, 'dispatch');
        assert.equal(d.reason, 'diff-unavailable');
    });

    test('multi-item gap: a 2-commit pile-up still kicks exactly once', function () {
        var d = guard().decideKick({
            mainHead: HEAD, releaseCommit: TAG,
            changedFiles: ['js/a.js', 'js/b.js', 'docs/x.md'], activeReleaseRuns: 0, ignored: IGNORED
        });
        assert.equal(d.action, 'dispatch');
        assert.equal(d.relevantCount, 2, 'docs/x.md must not count toward the decision');
    });
});

// ── K4 + wiring: the kicker workflow ─────────────────────────────────────────

suite('release kicker workflow wiring', function () {

    var wf = file_read({ path: KICKER_WF_PATH });

    test('the kicker workflow exists with schedule + manual dispatch', function () {
        assert.ok(wf && wf.length > 0, KICKER_WF_PATH + ' must exist');
        assert.ok(wf.indexOf('schedule:') !== -1, 'the belt ticks on a schedule');
        assert.ok(wf.indexOf('workflow_dispatch:') !== -1, 'operators can fire it by hand');
    });

    test('K4: the cadence is at most every 15 minutes (AC1)', function () {
        var m = /cron:\s*['"]?\*\/(\d+)\s+/.exec(wf);
        assert.ok(m, 'expected an every-N-minutes schedule cron');
        assert.ok(parseInt(m[1], 10) <= 15,
            'AC1: no agents-side fix may wait >15 min in main — cadence is */' + m[1]);
    });

    test('the tick runs the kicker runner through the guard', function () {
        assert.ok(wf.indexOf('node ci/release_kicker.mjs') !== -1,
            'the workflow must invoke ci/release_kicker.mjs');
        assert.ok(wf.indexOf('actions: write') !== -1,
            'dispatching the release workflow needs the actions:write scope');
    });

    test('the runner dispatches agent-pack-release.yml (idempotent path)', function () {
        var src = file_read({ path: 'ci/release_kicker.mjs' });
        assert.ok(/\['workflow',\s*'run'/.test(src) && src.indexOf('agent-pack-release.yml') !== -1,
            "the kicker must re-dispatch the release workflow on main (gh workflow run agent-pack-release.yml)");
        assert.ok(src.indexOf('::notice::') !== -1 || src.indexOf('::warning::') !== -1,
            'each tick decision must be visible in the run log (AC1 metric line)');
    });

    test('ticks do not overlap (concurrency, queued not cancelled)', function () {
        assert.ok(/group:\s*agent-pack-release-kicker/.test(wf),
            'concurrent ticks could double-dispatch');
        assert.ok(wf.indexOf('cancel-in-progress: false') !== -1,
            'a running tick must finish — cancel would drop a real dispatch');
    });

    test('the release workflow keeps its push trigger (belt AND suspenders)', function () {
        var wfRel = file_read({ path: RELEASE_WF_PATH });
        assert.ok(wfRel.indexOf('push:') !== -1 && wfRel.indexOf('branches: [main]') !== -1,
            'the kicker is the belt for a dropped push event — the push ' +
            'trigger itself must stay (gh-844 non-goal: do not touch the ' +
            'release workflow internals)');
    });
});
