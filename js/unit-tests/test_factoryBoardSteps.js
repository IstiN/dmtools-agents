/**
 * Unit tests for site/factory/steps.js — the factory board's per-card
 * pipeline stepper (gh-726: dots → labeled stepper, done/current/pending/
 * failed states).
 *
 * Pure functions only — no DOM, no tool globals. The same module ships to
 * the browser (window.FACTORY_STEPS) and loads here via loadModule.
 */

var assert = globalThis.assert;

var steps = loadModule('site/factory/steps.js');

function statesById(list) {
  var m = {};
  list.forEach(function (s) { m[s.id] = s.state; });
  return m;
}

suite('factoryBoardSteps — step order + names', function () {
  test('six named steps in pipeline order: dev → pr → valid → review → approve → merge', function () {
    assert.deepEqual(steps.STEPS.map(function (s) { return s.id; }),
      ['dev', 'pr', 'valid', 'review', 'approve', 'merge']);
    assert.deepEqual(steps.STEPS.map(function (s) { return s.name; }),
      ['dev', 'pr', 'valid', 'review', 'approve', 'merge']);
  });

  test('every step carries the schema-2 timestamp field that proves it', function () {
    var ts = {};
    steps.STEPS.forEach(function (s) { ts[s.id] = s.ts; });
    assert.deepEqual(ts, {
      dev: 'devStartedAt', pr: 'prCreated', valid: 'validatingAt',
      review: 'reviewedAt', approve: 'approvedAt', merge: 'mergedAt'
    });
  });
});

suite('factoryBoardSteps — lane → current step', function () {
  test('every pipeline lane maps to exactly one step', function () {
    ['development', 'pr_created', 'pr_validation', 'review',
     'approved_queue', 'validating', 'merged_recent'].forEach(function (lane) {
      assert.ok(steps.LANE_STEP[lane], 'lane ' + lane + ' has a current step');
    });
  });

  test('both validation lanes (head + mutex) light the valid step', function () {
    assert.equal(steps.LANE_STEP.pr_validation, 'valid');
    assert.equal(steps.LANE_STEP.validating, 'valid');
  });

  test('a card in review shows review as current, earlier steps done, later pending', function () {
    var card = { prCreated: '2026-10-03T09:58:00Z', reviewedAt: '2026-10-03T10:30:00Z' };
    var st = statesById(steps.stepStates(card, 'review'));
    assert.equal(st.dev, 'done');
    assert.equal(st.pr, 'done');
    assert.equal(st.review, 'current');
    assert.equal(st.approve, 'pending');
    assert.equal(st.merge, 'pending');
  });

  test('an in-flight head validation shows valid as current, not failed', function () {
    var card = { prCreated: '2026-10-03T11:45:00Z',
                 checks: { verdict: 'in_progress', at: '2026-10-03T11:52:00Z' } };
    var st = statesById(steps.stepStates(card, 'pr_validation'));
    assert.equal(st.pr, 'done');
    assert.equal(st.valid, 'current');
    assert.equal(st.review, 'pending');
  });

  test('a queued PR (approved, waiting for the mutex) shows approve as current', function () {
    var card = { prCreated: 't1', reviewedAt: 't2', approvedAt: 't3' };
    var st = statesById(steps.stepStates(card, 'approved_queue'));
    assert.equal(st.review, 'done');
    assert.equal(st.approve, 'current');
    assert.equal(st.merge, 'pending');
  });
});

suite('factoryBoardSteps — failed state', function () {
  ['failure', 'timed_out', 'startup_failure'].forEach(function (verdict) {
    test('checks verdict ' + verdict + ' paints the valid step failed', function () {
      var card = { prCreated: 't1', checks: { verdict: verdict, at: 't2' } };
      var st = statesById(steps.stepStates(card, 'pr_created'));
      assert.equal(st.pr, 'current');
      assert.equal(st.valid, 'failed');
      assert.equal(st.review, 'pending');
    });
  });

  test('a success verdict never paints failed', function () {
    var card = { prCreated: 't1', checks: { verdict: 'success', at: 't2' } };
    var st = statesById(steps.stepStates(card, 'pr_created'));
    assert.notOk(st.valid === 'failed');
  });

  test('terminal merged card overrides everything — all steps done, none failed/current', function () {
    var card = { prCreated: 't1', reviewedAt: 't2', approvedAt: 't3',
                 validatingAt: 't4', mergedAt: 't5',
                 checks: { verdict: 'failure', at: 't4' } };
    steps.stepStates(card, 'merged_recent').forEach(function (s) {
      assert.equal(s.state, 'done');
    });
  });
});

suite('factoryBoardSteps — monotonic fill from later timestamps', function () {
  test('a later-stage timestamp marks earlier un-stamped steps done (no zigzag)', function () {
    // approved without a reviewedAt stamp (label time lost) — review must
    // still read done, not pending-behind-current
    var card = { prCreated: 't1', approvedAt: 't3' };
    var st = statesById(steps.stepStates(card, 'approved_queue'));
    assert.equal(st.review, 'done');
    assert.equal(st.approve, 'current');
  });
});

suite('factoryBoardSteps — merged + backlog cards', function () {
  test('merged card: every step done, positions readable at a glance', function () {
    var card = { prCreated: 't1', reviewedAt: 't2', approvedAt: 't3',
                 validatingAt: 't4', mergedAt: 't5' };
    var list = steps.stepStates(card, 'merged_recent');
    assert.equal(list.length, 6);
    list.forEach(function (s) { assert.equal(s.state, 'done'); });
  });

  test('backlog in_dev card: dev current, everything else pending', function () {
    var card = { devStartedAt: 't1' };
    var st = statesById(steps.stepStates(card, 'in_dev'));
    assert.equal(st.dev, 'current');
    assert.equal(st.pr, 'pending');
    assert.equal(st.merge, 'pending');
  });

  test('backlog queued/blocked/inbox cards have no current step — all pending', function () {
    ['queued', 'blocked', 'inbox'].forEach(function (bucket) {
      steps.stepStates({ labels: ['agent:dev'] }, bucket).forEach(function (s) {
        assert.equal(s.state, 'pending', bucket + ' · ' + s.id);
      });
    });
  });
});

suite('factoryBoardSteps — timestamps for tooltips', function () {
  test('done/current steps carry their timestamp; pending carry null', function () {
    var card = { devStartedAt: '2026-10-03T11:02:00Z', prCreated: '2026-10-03T11:40:00Z' };
    var list = steps.stepStates(card, 'pr_created');
    var st = {};
    list.forEach(function (s) { st[s.id] = s; });
    assert.equal(st.dev.at, '2026-10-03T11:02:00Z');
    assert.equal(st.pr.at, '2026-10-03T11:40:00Z');
    assert.equal(st.merge.at, null);
  });

  test('the full fixture lane set — every card yields a readable 6-step strip', function () {
    var fixture = JSON.parse(file_read({ path: 'site/factory/visual-check/fixture.json' }));
    Object.keys(fixture.lanes).forEach(function (laneId) {
      fixture.lanes[laneId].forEach(function (card) {
        var list = steps.stepStates(card, laneId);
        assert.equal(list.length, 6, laneId + ' card has 6 steps');
        list.forEach(function (s) {
          assert.ok(['done', 'current', 'pending', 'failed'].indexOf(s.state) >= 0,
            'state is one of the four known states');
        });
        // a reviewer must be able to name the position: exactly one current
        // step for pipeline lanes
        var cur = list.filter(function (s) { return s.state === 'current'; });
        assert.ok(cur.length <= 1, laneId + ' has at most one current step');
      });
    });
  });
});
