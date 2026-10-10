/**
 * Unit tests for js/common/redConvergence.js (gh-832 red-verdict
 * convergence: counter, reset conditions, park threshold).
 *
 * Pure module — no tool globals; loadModule with no mocks.
 */

var assert = globalThis.assert;

var redConvergence = loadModule('js/common/redConvergence.js', makeRequire({}), {});

suite('redConvergence: streakFromRuns (consecutive-red counter)', function () {

    function run(id, conclusion, head, extra) {
        var r = { id: id, event: 'workflow_dispatch', head_sha: head || 'shaX',
                  status: 'completed', conclusion: conclusion,
                  created_at: '2026-10-10T0' + (id % 10) + ':00:00Z',
                  updated_at: '2026-10-10T0' + (id % 10) + ':30:00Z' };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) r[k] = extra[k]; } }
        return r;
    }

    test('empty / null inputs degrade to 0 (fail open — no park on a degraded read)', function () {
        assert.equal(redConvergence.streakFromRuns([], 'shaX'), 0);
        assert.equal(redConvergence.streakFromRuns(null, 'shaX'), 0);
        assert.equal(redConvergence.streakFromRuns(undefined, 'shaX'), 0);
        assert.equal(redConvergence.streakFromRuns([run(1, 'failure')], null), 0);
        assert.equal(redConvergence.streakFromRuns([run(1, 'failure')], ''), 0);
    });

    test('a single red run on the head — streak 1 (the current verdict counts)', function () {
        assert.equal(redConvergence.streakFromRuns([run(1, 'failure')], 'shaX'), 1);
        assert.equal(redConvergence.streakFromRuns([run(1, 'timed_out')], 'shaX'), 1);
    });

    test('N trailing reds on the same head — streak N (unordered input is sorted newest-first)', function () {
        var runs = [run(1, 'failure'), run(2, 'timed_out'), run(3, 'failure')];
        // Deliberately shuffled: the counter must not depend on list order.
        assert.equal(redConvergence.streakFromRuns([runs[2], runs[0], runs[1]], 'shaX'), 3);
    });

    test('AC2 green reset: a success run older than the trailing reds breaks the streak', function () {
        // #1453 shape: red, red, then a green rerun, then red — only the
        // trailing red counts.
        var runs = [run(4, 'failure'), run(3, 'success'), run(2, 'failure'), run(1, 'failure')];
        assert.equal(redConvergence.streakFromRuns(runs, 'shaX'), 1,
            'the green between the reds resets the counter — two reds separated by a green are NOT consecutive');
    });

    test('AC2 head change: reds on another head never count', function () {
        var runs = [run(2, 'failure', 'shaNEW'), run(1, 'failure', 'shaOLD')];
        assert.equal(redConvergence.streakFromRuns(runs, 'shaNEW'), 1,
            'a fresh head starts a fresh streak by construction (SHA-filtered)');
        assert.equal(redConvergence.streakFromRuns(runs, 'shaOLD'), 1);
    });

    test('gh-755: cancelled runs are never a verdict — skipped, they neither count nor reset', function () {
        // red, cancelled (kicker race), red — the cancelled run must not
        // break the streak, and must not add to it.
        var runs = [run(3, 'failure'), run(2, 'cancelled'), run(1, 'failure')];
        assert.equal(redConvergence.streakFromRuns(runs, 'shaX'), 2);
    });

    test('push-event and other-workflow runs never participate (dispatch-only counter)', function () {
        var runs = [
            run(4, 'failure'),
            { id: 3, event: 'push', head_sha: 'shaX', status: 'completed',
              conclusion: 'failure', created_at: '2026-10-10T03:00:00Z' },
            { id: 2, event: 'workflow_dispatch', head_sha: 'shaX', status: 'in_progress',
              conclusion: null, created_at: '2026-10-10T02:00:00Z' },
            run(1, 'failure')
        ];
        assert.equal(redConvergence.streakFromRuns(runs, 'shaX'), 2,
            'in-flight and push-event runs are not verdict words');
    });

    test('a green NEWEST run ends the streak even over older reds', function () {
        var runs = [run(3, 'success'), run(2, 'failure'), run(1, 'failure')];
        assert.equal(redConvergence.streakFromRuns(runs, 'shaX'), 0,
            'the current verdict is green — the fail path would not even run');
    });

    test('missing conclusion / unparsable timestamps never crash the walk', function () {
        var runs = [
            { id: 2, event: 'workflow_dispatch', head_sha: 'shaX', status: 'completed',
              conclusion: 'failure' },
            { id: 1, event: 'workflow_dispatch', head_sha: 'shaX', status: 'completed',
              conclusion: null }
        ];
        assert.equal(redConvergence.streakFromRuns(runs, 'shaX'), 1);
    });
});

suite('redConvergence: parkCapOf / shouldPark (park threshold)', function () {

    test('default cap is 2 — the SECOND consecutive red parks (gh-832 AC1)', function () {
        assert.equal(redConvergence.parkCapOf({}), 2);
        assert.equal(redConvergence.parkCapOf(null), 2);
        assert.equal(redConvergence.parkCapOf(undefined), 2);
    });

    test('jobParams.redHeadParkCap tunes the threshold per deployment', function () {
        assert.equal(redConvergence.parkCapOf({ redHeadParkCap: 3 }), 3);
        assert.equal(redConvergence.parkCapOf({ redHeadParkCap: '4' }), 4);
    });

    test('0 / false disable the park (escape hatch — old never-park behavior)', function () {
        assert.equal(redConvergence.parkCapOf({ redHeadParkCap: 0 }), 2,
            '0 falls back to the default (a disabled park is expressed as false)');
        assert.equal(redConvergence.parkCapOf({ redHeadParkCap: false }), 0);
        assert.equal(redConvergence.parkCapOf({ redHeadParkCap: 'false' }), 0);
    });

    test('shouldPark fires at streak >= cap and never when disabled', function () {
        assert.ok(redConvergence.shouldPark(2, 2), 'streak 2 at cap 2 → park (AC1)');
        assert.ok(redConvergence.shouldPark(3, 2), 'a deeper streak still parks');
        assert.ok(!redConvergence.shouldPark(1, 2), 'streak 1 → no park yet — one red is not a loop');
        assert.ok(!redConvergence.shouldPark(2, 0), 'cap 0 → park disabled');
        assert.ok(!redConvergence.shouldPark(0, 2), 'no streak → no park');
    });
});
