/**
 * Unit tests for js/common/branchLegGuard.js — the gh-1028 branch-keyed
 * in-flight leg probe: an ACTIVE ai-teammate run whose head_branch IS the
 * dispatch branch keeps ANY new leg off that branch, regardless of the
 * run's head sha. Live evidence (dmtools-agents PR #1017 / gh-1000,
 * 2026-10-18 08:04–08:09Z): TWO concurrent rework legs for ONE rework
 * cycle — the PR-armed run (title 'workflow_dispatch # rework', no anchor
 * token the title guards could see) pushed, the head moved
 * (c2e0d28f → 94988905), the (pr, head) latch (gh-806) keyed a NEW head
 * and the issue-armed dispatch fired 5 min later — two legs raced every
 * push on ai/gh-1000.
 *
 *   AC1  an issue-armed and PR-armed rework for the SAME PR dispatch
 *        exactly one leg — the branch probe sees the first leg's run no
 *        matter which arm the second dispatch came from (both dispatch
 *        paths land the leg ON the PR branch, workflowRef={branch}).
 *   AC2  a head move between dispatches does NOT bypass the probe: the
 *        match keys on head_branch, never on head_sha.
 *
 * Pure module — no tool globals; loadModule with no mocks.
 */

var assert = globalThis.assert;

var guard = loadModule('js/common/branchLegGuard.js', makeRequire({}), {});

var LEG_PATH = '.github/workflows/ai-teammate.yml';
var OTHER_PATH = '.github/workflows/quality.yml';
var BRANCH = 'ai/gh-1000';
var HEAD_OLD = 'c2e0d28f00000000000000000000000000000000';
var HEAD_NEW = '9498890500000000000000000000000000000000';
var NOW_MS = Date.parse('2026-10-18T08:09:31.000Z');

function run(status, opts) {
    opts = opts || {};
    var r = {
        status: status,
        head_branch: opts.branch !== undefined ? opts.branch : BRANCH,
        head_sha: opts.head || HEAD_NEW,
        path: opts.path || LEG_PATH
    };
    if (opts.updatedAt) r.updated_at = opts.updatedAt;
    if (opts.createdAt) r.created_at = opts.createdAt;
    return r;
}

// ── the gate ────────────────────────────────────────────────────────────────

suite('branchLegGuard — hasActiveLegRunOnBranch', function () {
    test('AC1/AC2: an in-flight leg run on the branch suppresses even after a head move (different head_sha)', function () {
        var runs = [run('in_progress', { head: HEAD_OLD })];
        var verdict = guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS });
        assert.ok(verdict,
            'the first leg was dispatched on the OLD head — the second arm must still see it');
    });

    test('an active run on a DIFFERENT branch does not suppress', function () {
        var runs = [run('in_progress', { branch: 'ai/gh-999' })];
        assert.notOk(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }));
    });

    test('a COMPLETED leg run on the branch does not suppress (the leg is gone)', function () {
        var runs = [run('completed', { head: HEAD_OLD, updatedAt: '2026-10-18T08:04:00.000Z' })];
        assert.notOk(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }));
    });

    test('a FAILED-conclusion leg run on the branch does not suppress', function () {
        var runs = [run('completed', { head: HEAD_OLD, updatedAt: '2026-10-18T08:04:00.000Z' })];
        runs[0].conclusion = 'failure';
        assert.notOk(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }));
    });

    test('an active run of a DIFFERENT workflow on the branch does not suppress', function () {
        var runs = [run('in_progress', { path: OTHER_PATH })];
        assert.notOk(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }));
    });

    test('multi-item lists: any single active branch match wins (2+ items, not just the first)', function () {
        var runs = [
            run('completed', { branch: 'ai/gh-1', updatedAt: '2026-10-18T07:00:00.000Z' }),
            run('in_progress', { branch: BRANCH, head: HEAD_OLD })
        ];
        assert.ok(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }),
            'the match is a list-wide some(), not a first-entry check');
    });

    test('runs without head_branch never match (title-only run payloads stay inert)', function () {
        var runs = [{ status: 'in_progress', path: LEG_PATH }];
        assert.notOk(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }));
    });

    test('null/empty inputs are safe: no runs, no branch, garbage runs', function () {
        assert.notOk(guard.hasActiveLegRunOnBranch(null, BRANCH, { nowMs: NOW_MS }));
        assert.notOk(guard.hasActiveLegRunOnBranch([], BRANCH, { nowMs: NOW_MS }));
        assert.notOk(guard.hasActiveLegRunOnBranch([null, {}, 'x'], BRANCH, { nowMs: NOW_MS }));
        assert.notOk(guard.hasActiveLegRunOnBranch([run('in_progress')], null, { nowMs: NOW_MS }));
        assert.notOk(guard.hasActiveLegRunOnBranch([run('in_progress')], '', { nowMs: NOW_MS }));
    });

    test('every active status counts: queued / waiting / pending, not only in_progress', function () {
        ['queued', 'waiting', 'pending'].forEach(function (status) {
            var runs = [run(status, { head: HEAD_OLD, updatedAt: new Date(NOW_MS).toISOString() })];
            assert.ok(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }),
                status + ' run owns the branch too');
        });
    });

    test('a queued run stuck past the stale window is inert (dead dispatch self-heals)', function () {
        var runs = [run('queued', {
            updatedAt: '2026-10-18T01:00:00.000Z', // ~7h old, past the 6h non-running stale bound
            createdAt: '2026-10-18T01:00:00.000Z'
        })];
        assert.notOk(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }));
    });

    test('an in_progress run NEVER ages out — a live leg owns the branch past any window', function () {
        var runs = [run('in_progress', { updatedAt: '2026-10-17T20:00:00.000Z' })];
        assert.ok(guard.hasActiveLegRunOnBranch(runs, BRANCH, { nowMs: NOW_MS }));
    });

    test('stale aging is opt-in by default: without nowMs the queued run counts (fail-safe toward suppression)', function () {
        var runs = [run('queued', { updatedAt: '2026-10-18T01:00:00.000Z' })];
        assert.ok(guard.hasActiveLegRunOnBranch(runs, BRANCH, {}),
            'a clock-less caller degrades to fail-closed — one deferred dispatch beats a stacked leg');
    });
});

// ── predicates ──────────────────────────────────────────────────────────────

suite('branchLegGuard — predicates', function () {
    test('isLegRun matches the ai-teammate.yml path suffix and rejects other workflows', function () {
        assert.ok(guard.isLegRun(run('in_progress'), 'ai-teammate.yml'));
        assert.ok(guard.isLegRun({ path: 'x/y/ai-teammate.yml' }, 'ai-teammate.yml'));
        assert.notOk(guard.isLegRun({ path: OTHER_PATH }, 'ai-teammate.yml'));
        assert.notOk(guard.isLegRun({}, 'ai-teammate.yml'));
        assert.notOk(guard.isLegRun(null, 'ai-teammate.yml'));
        // configurable workflow file (a deployment that renames the leg)
        assert.ok(guard.isLegRun({ path: 'x/teammate-v2.yml' }, 'teammate-v2.yml'));
    });

    test('matchesBranch is exact and type-tolerant', function () {
        assert.ok(guard.matchesBranch({ head_branch: BRANCH }, BRANCH));
        assert.ok(guard.matchesBranch({ head_branch: 1000 }, '1000'));
        assert.notOk(guard.matchesBranch({ head_branch: 'ai/gh-100' }, BRANCH));
        assert.notOk(guard.matchesBranch({ head_branch: 'ai/gh-10000' }, BRANCH));
        assert.notOk(guard.matchesBranch({}, BRANCH));
    });
});
