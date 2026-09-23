/**
 * Unit tests for js/factoryState.js — the factory-state snapshot builder and
 * the release-asset publisher (owner 2026-09-23, OPT-IN via statePublish).
 *
 * Pure functions only: no tool globals needed; the publisher takes an `exec`
 * capturer. assert = the harness global (equal/deepEqual/ok/contains).
 */

var assert = globalThis.assert;

var fsModule = loadModule('js/factoryState.js', makeRequire({}), {});

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

  test('head verdict: terminal non-cancelled wins over active', function () {
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

  test('commands: gh-only (whitelist), branch bootstrap + graphql commit', function () {
    var cmds = fsModule.publishCommands(ST, { repo: 'IstiN/flutter_agent_harness',
      tag: 'factory-data', asset: 'fa-state.json' });
    assert.equal(cmds.length, 2);
    assert.ok(cmds[0].indexOf('gh api -X POST repos/IstiN/flutter_agent_harness/git/refs') === 0,
              'first token must be gh (CLI whitelist)');
    assert.ok(cmds[0].indexOf('refs/heads/factory-data') > 0);
    assert.ok(cmds[1].indexOf('-X PUT repos/IstiN/flutter_agent_harness/contents/data/fa-state.json') > 0,
              'publish must use the plain-Rest Contents API (gh GraphQL transports parse/break)');
    assert.ok(cmds[1].indexOf('| base64') > 0, 'payload rides base64 — quoting-proof');
    assert.ok(cmds[1].indexOf('-f branch=factory-data') > 0);
    assert.ok(cmds[1].indexOf('-f sha=') === -1,
              'no probed sha — first publish creates the file');
  });

  test('publish runs exec per command and returns the raw.githubusercontent URL', function () {
    var seen = [];
    var url = fsModule.publishFactoryState(ST, { repo: 'IstiN/flutter_agent_harness',
      tag: 'factory-data', asset: 'fa-state.json' },
      function (a) {
        seen.push(a.command);
        if (a.command.indexOf('/contents/') > 0 &&
            a.command.indexOf('-X PUT') === -1) {
          return { output: 'deadbeef123\n' };
        }
        return undefined;
      });
    assert.equal(url,
      'https://raw.githubusercontent.com/IstiN/flutter_agent_harness/factory-data/data/fa-state.json');
    assert.equal(seen.length, 3, 'sha probe + bootstrap + PUT');
    assert.ok(seen[0].indexOf('/contents/') > 0 && seen[0].indexOf('--jq .sha') > 0,
              'sha probe first');
    var put = seen.filter(function (c) { return c.indexOf('-X PUT') > 0; })[0];
    assert.ok(put, 'PUT present');
    assert.ok(put.indexOf("-f sha='deadbeef123'") > 0,
              'probed sha rides the PUT');
    assert.ok(seen.filter(function (c) {
      return c.indexOf('gh api -X POST repos/IstiN/flutter_agent_harness/git/refs') === 0;
    }).length === 1, 'branch bootstrap present');
  });

  test('defaults: branch factory-data, asset <factory>-state.json', function () {
    var cmds = fsModule.publishCommands(ST, {});
    assert.ok(cmds[0].indexOf('refs/heads/factory-data') > 0);
    assert.ok(cmds[1].indexOf('data/flutter_agent_harness-state.json') > 0);
  });

});
