/**
 * Unit tests for js/factoryState.js — the factory-state snapshot builder and
 * the release-asset publisher (owner 2026-09-23, OPT-IN via statePublish).
 *
 * Pure functions only: no tool globals needed; the publisher takes an `exec`
 * capturer.
 */

var assert = globalThis.assert;
var fsModule = loadModule('js/factoryState.js', makeRequire({}));

// ── laneOf ───────────────────────────────────────────────────────────────────

suite('factoryState — lanes', function () {
  test('ai_validating wins over everything (armed = validating)', function () {
    var lane = fsModule.laneOf({ labels: [
      { name: 'pr_approved' }, { name: 'ai_validating' }, { name: 'ai_validated' }
    ]});
    assert.equal(lane, 'validating');
  });

  test('pr_approved without arm → approved_queue', function () {
    var lane = fsModule.laneOf({ labels: [{ name: 'pr_approved' }, { name: 'ai_validated' }] });
    assert.equal(lane, 'approved_queue');
  });

  test('ai_pr_reviewed only → review', function () {
    var lane = fsModule.laneOf({ labels: [{ name: 'ai_pr_reviewed' }] });
    assert.equal(lane, 'review');
  });

  test('no machine labels → fresh', function () {
    assert.equal(fsModule.laneOf({ labels: [{ name: 'dependencies' }] }), 'fresh');
    assert.equal(fsModule.laneOf({ labels: [] }), 'fresh');
  });

  test('string labels tolerated (list_prs shape drift)', function () {
    assert.equal(fsModule.laneOf({ labels: ['ai_validating'] }), 'validating');
  });
});

// ── buildFactoryState ────────────────────────────────────────────────────────

suite('factoryState — buildFactoryState', function () {
  var PRS = [
    { number: 817, title: 'fix(hub): relay', labels: [
        { name: 'pr_approved' }, { name: 'ai_validating' }],
      head: { ref: 'fix/794', sha: 'sha817' }, user: { login: 'bot' } },
    { number: 828, title: 'feat(tui): transcript', labels: [
        { name: 'pr_approved' }, { name: 'ai_validated' }],
      head: { ref: 'ai/807', sha: 'sha828' }, user: { login: 'bot' } },
    { number: 860, title: 'fix(tests): nightly', labels: [{ name: 'ai_pr_reviewed' }],
      head: { ref: 'ai/809', sha: 'sha860' }, user: { login: 'bot' } },
    { number: 870, title: 'chore: x', labels: [], head: { ref: 'x', sha: 'sha870' } }
  ];
  var RUNS = [
    { event: 'workflow_dispatch', head_sha: 'sha817', status: 'completed',
      conclusion: 'failure', created_at: '2026-09-23T16:55:00Z',
      html_url: 'http://run/1' },
    { event: 'workflow_dispatch', head_sha: 'sha828', status: 'in_progress',
      created_at: '2026-09-23T17:49:00Z', html_url: 'http://run/2' }
  ];

  test('lanes populated per labels; approved FIFO positions 1-based', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' },
      prs: PRS, runs: RUNS, checkNames: ['Quality gate'], now: '2026-09-23T18:00:00Z'
    });
    assert.equal(st.schema, 1);
    assert.equal(st.repo, 'IstiN/flutter_agent_harness');
    assert.deepEqual(st.lanes.validating.map(function (c) { return c.pr; }), [817]);
    assert.deepEqual(st.lanes.approved_queue.map(function (c) { return c.pr; }), [828]);
    assert.equal(st.lanes.approved_queue[0].queuePos, 1);
    assert.deepEqual(st.lanes.review.map(function (c) { return c.pr; }), [860]);
    assert.deepEqual(st.lanes.fresh.map(function (c) { return c.pr; }), [870]);
    assert.equal(st.counts.validating, 1);
    assert.equal(st.counts.approved_queue, 1);
  });

  test('head verdict: terminal non-cancelled wins over active; null when none', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, prs: PRS, runs: RUNS,
      now: '2026-09-23T18:00:00Z'
    });
    assert.equal(st.lanes.validating[0].checks.verdict, 'failure');
    assert.equal(st.lanes.validating[0].checks.url, 'http://run/1');
    // 828 has an ACTIVE dispatched run → in_progress verdict
    assert.equal(st.lanes.approved_queue[0].checks.verdict, 'in_progress');
  });

  test('empty repo → all lanes empty, counts zeroed', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, prs: [], runs: [],
      now: '2026-09-23T18:00:00Z'
    });
    assert.equal(st.counts.fresh, 0);
    assert.deepEqual(st.lanes.validating, []);
  });
});

// ── publisher ────────────────────────────────────────────────────────────────

suite('factoryState — publishFactoryState', function () {
  var ST = fsModule.buildFactoryState({
    repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' },
    prs: [], runs: [], now: '2026-09-23T18:00:00Z'
  });

  test('commands: create-once + upload --clobber; url is the CDN link', function () {
    var cmds = fsModule.publishCommands(ST, { repo: 'IstiN/flutter_agent_harness',
      tag: 'factory-state', asset: 'fa-state.json' });
    assert.equal(cmds.length, 2);
    assert.ok(cmds[0].indexOf('gh release create factory-state') === 0);
    assert.ok(cmds[0].indexOf('--prerelease') > 0);
    assert.ok(cmds[1].indexOf('gh release upload factory-state /tmp/fa-state.json') === 0);
    assert.ok(cmds[1].indexOf('--clobber') > 0);
  });

  test('publish runs exec per command and returns the public URL', function () {
    var seen = [];
    var url = fsModule.publishFactoryState(ST, { repo: 'IstiN/flutter_agent_harness',
      tag: 'factory-state', asset: 'fa-state.json' },
      function (a) { seen.push(a.command); });
    assert.equal(url,
      'https://github.com/IstiN/flutter_agent_harness/releases/latest/download/fa-state.json');
    assert.ok(seen[0].indexOf('printf %s ') === 0);          // write tmp json
    assert.ok(seen[1].indexOf('gh release create') === 0);
    assert.ok(seen[2].indexOf('gh release upload') === 0);   // uses same tmp
    assert.ok(seen[3].indexOf('rm -f ') === 0);
  });

  test('defaults: tag factory-state, asset <factory>-state.json', function () {
    var cmds = fsModule.publishCommands(ST, {});
    assert.ok(cmds[0].indexOf('factory-state') > 0);
    assert.ok(cmds[1].indexOf('flutter_agent_harness-state.json') > 0);
  });
});
