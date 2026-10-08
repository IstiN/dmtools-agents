/**
 * Unit tests for js/factoryState.js — the factory-state snapshot builder and
 * the release-asset publisher (owner 2026-09-23, OPT-IN via statePublish).
 *
 * Pure functions only: no tool globals needed; the publisher takes an `exec`
 * capturer. assert = the harness global (equal/deepEqual/ok/contains).
 */

var assert = globalThis.assert;

var machineAuthorModule = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
var fsModule = loadModule('js/factoryState.js',
    makeRequire({ './common/machineAuthor.js': machineAuthorModule }), {});

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

  test('no machine labels → pr_created (schema 2 rename of schema 1 fresh)', function () {
    assert.equal(fsModule.laneOf({ labels: [{ name: 'dependencies' }] }), 'pr_created');
    assert.equal(fsModule.laneOf({ labels: [] }), 'pr_created');
  });

  test('string labels tolerated (list_prs shape drift)', function () {
    assert.equal(fsModule.laneOf({ labels: ['ai_validating'] }), 'validating');
  });

  test('active dispatched validation run on the PR head → pr_validation (gh-716 lane 2)', function () {
    assert.equal(fsModule.laneOf({ labels: [], checks: { verdict: 'in_progress' } }), 'pr_validation');
    assert.equal(fsModule.laneOf({ labels: [], checks: { verdict: 'queued' } }), 'pr_validation');
    assert.equal(fsModule.laneOf({ labels: [], checks: { verdict: 'waiting' } }), 'pr_validation');
  });

  test('machine labels win over an active validation run (review/approved/armed stay put)', function () {
    assert.equal(fsModule.laneOf({ labels: [{ name: 'ai_pr_reviewed' }],
      checks: { verdict: 'in_progress' } }), 'review');
    assert.equal(fsModule.laneOf({ labels: [{ name: 'pr_approved' }],
      checks: { verdict: 'queued' } }), 'approved_queue');
    assert.equal(fsModule.laneOf({ labels: [{ name: 'ai_validating' }],
      checks: { verdict: 'in_progress' } }), 'validating');
  });

  test('terminal or absent checks → pr_created', function () {
    assert.equal(fsModule.laneOf({ labels: [], checks: { verdict: 'failure' } }), 'pr_created');
    assert.equal(fsModule.laneOf({ labels: [], checks: { verdict: 'success' } }), 'pr_created');
    assert.equal(fsModule.laneOf({ labels: [], checks: null }), 'pr_created');
  });

  test('LANE_ORDER is the pipeline order (schema 2; pr_validation between pr_created and review)', function () {
    assert.deepEqual(fsModule.LANE_ORDER, ['development', 'pr_created', 'pr_validation',
      'review', 'approved_queue', 'validating', 'merged_recent']);
  });

  test('LANE_ENTERED_AT maps every LABEL-stamped lane to its entering timestamp; pr_validation is derived (history fallback)', function () {
    assert.equal(fsModule.LANE_ENTERED_AT.development, 'devStartedAt');
    assert.equal(fsModule.LANE_ENTERED_AT.pr_created, 'prCreated');
    assert.equal(fsModule.LANE_ENTERED_AT.review, 'reviewedAt');
    assert.equal(fsModule.LANE_ENTERED_AT.approved_queue, 'approvedAt');
    assert.equal(fsModule.LANE_ENTERED_AT.validating, 'validatingAt');
    assert.equal(fsModule.LANE_ENTERED_AT.merged_recent, 'mergedAt');
    // pr_validation mirrors an in-flight CI run, not a label — no dedicated
    // timestamp; the board ages it from the card's newest history entry.
    assert.equal(fsModule.LANE_ENTERED_AT.pr_validation, undefined);
  });
});

// ── buildFactoryState (schema 2) ─────────────────────────────────────────────

suite('factoryState — buildFactoryState', function () {
  var PRS = [
    { number: 817, title: 'fix(hub): relay', labels: [
        { name: 'pr_approved' }, { name: 'ai_validating' }],
      head: { ref: 'fix/794', sha: 'sha817' }, user: { login: 'bot' },
      created_at: '2026-10-01T06:00:00Z' },
    { number: 828, title: 'feat(tui): transcript', labels: [
        { name: 'pr_approved' }, { name: 'ai_validated' }],
      head: { ref: 'ai/807', sha: 'sha828' }, user: { login: 'bot' },
      created_at: '2026-10-01T08:30:00Z' },
    { number: 860, title: 'fix(tests): nightly', labels: [{ name: 'ai_pr_reviewed' }],
      head: { ref: 'ai/809', sha: 'sha860' }, user: { login: 'bot' },
      created_at: '2026-10-01T09:00:00Z' },
    { number: 870, title: 'chore: x', labels: [], head: { ref: 'x', sha: 'sha870' },
      created_at: '2026-10-01T12:40:00Z' }
  ];
  var RUNS = [
    { event: 'workflow_dispatch', head_sha: 'sha817', status: 'completed',
      conclusion: 'failure', created_at: '2026-09-23T16:55:00Z',
      html_url: 'http://run/1' },
    { event: 'workflow_dispatch', head_sha: 'sha828', status: 'in_progress',
      created_at: '2026-09-23T17:49:00Z', html_url: 'http://run/2' }
  ];

  function build(opts) {
    return fsModule.buildFactoryState(Object.assign({
      repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' },
      prs: PRS, runs: RUNS, checkNames: ['Quality gate'],
      now: '2026-10-01T13:00:00Z'
    }, opts || {}));
  }

  test('schema 2; lanes populated per labels; approved FIFO 1-based', function () {
    var st = build();
    assert.equal(st.schema, 2);
    assert.equal(st.repo, 'IstiN/flutter_agent_harness');
    assert.deepEqual(st.lanes.validating.map(function (c) { return c.pr; }), [817]);
    assert.deepEqual(st.lanes.approved_queue.map(function (c) { return c.pr; }), [828]);
    assert.equal(st.lanes.approved_queue[0].queuePos, 1);
    assert.deepEqual(st.lanes.review.map(function (c) { return c.pr; }), [860]);
    assert.deepEqual(st.lanes.pr_created.map(function (c) { return c.pr; }), [870]);
    assert.equal(st.counts.validating, 1);
    assert.equal(st.counts.approved_queue, 1);
    // schema 2 lanes present (empty) even without issue/merged inputs
    assert.deepEqual(st.lanes.development, []);
    assert.deepEqual(st.lanes.merged_recent, []);
    assert.equal(st.counts.development, 0);
    assert.equal(st.counts.merged_recent, 0);
  });

  test('head verdict: terminal non-cancelled wins over active', function () {
    var st = build();
    assert.equal(st.lanes.validating[0].checks.verdict, 'failure');
    assert.equal(st.lanes.validating[0].checks.url, 'http://run/1');
    // 828 has an ACTIVE dispatched run → in_progress verdict
    assert.equal(st.lanes.approved_queue[0].checks.verdict, 'in_progress');
  });

  test('checks carry runStartedAt/updatedAt when the run reports them (gh-769: CI vs queue-wait split)', function () {
    var st = build({
      prs: [
        { number: 890, title: 'feat: split', labels: [{ name: 'ai_validating' },
            { name: 'pr_approved' }],
          head: { ref: 'ai/890', sha: 'sha890' }, user: { login: 'bot' },
          created_at: '2026-10-01T12:00:00Z' },
        { number: 891, title: 'feat: queued', labels: [],
          head: { ref: 'ai/891', sha: 'sha891' }, user: { login: 'bot' },
          created_at: '2026-10-01T12:05:00Z' }
      ],
      runs: [
        // completed mutex run: created → started → updated all known
        { event: 'workflow_dispatch', head_sha: 'sha890', status: 'completed',
          conclusion: 'success', created_at: '2026-10-01T12:10:00Z',
          run_started_at: '2026-10-01T12:13:00Z', updated_at: '2026-10-01T12:25:00Z',
          html_url: 'http://run/890' },
        // queued head run: run_started_at still null
        { event: 'workflow_dispatch', head_sha: 'sha891', status: 'queued',
          created_at: '2026-10-01T12:06:00Z', html_url: 'http://run/891' }
      ]
    });
    var done = st.lanes.validating[0].checks;
    assert.equal(done.verdict, 'success');
    assert.equal(done.runStartedAt, '2026-10-01T12:13:00Z');
    assert.equal(done.updatedAt, '2026-10-01T12:25:00Z');
    var queued = st.lanes.pr_validation[0].checks;
    assert.equal(queued.verdict, 'queued');
    assert.equal(queued.runStartedAt, null, 'GitHub reports null until a runner picks it up');
    assert.equal(queued.updatedAt, null);
  });

  test('checks omit runStartedAt/updatedAt when the run payload lacks them (old payloads, honest unknowns)', function () {
    var st = build();
    assert.equal(st.lanes.validating[0].checks.runStartedAt, null);
    assert.equal(st.lanes.approved_queue[0].checks.updatedAt, null);
  });

  test('prCreated is the GitHub created_at field (exact from snapshot 1)', function () {
    var st = build();
    assert.equal(st.lanes.pr_created[0].prCreated, '2026-10-01T12:40:00Z');
    assert.equal(st.lanes.validating[0].prCreated, '2026-10-01T06:00:00Z');
  });

  test('empty repo → all lanes empty, counts zeroed', function () {
    var st = build({ prs: [], runs: [] });
    assert.equal(st.counts.pr_created, 0);
    assert.deepEqual(st.lanes.validating, []);
  });

  test('PRs with an active dispatched run on the head and no machine labels → pr_validation lane (gh-716 lane 2)', function () {
    var st = build({
      prs: [
        { number: 880, title: 'feat: a', labels: [],
          head: { ref: 'ai/880', sha: 'sha880' }, user: { login: 'bot' },
          created_at: '2026-10-01T12:00:00Z' },
        { number: 881, title: 'feat: b', labels: [],
          head: { ref: 'ai/881', sha: 'sha881' }, user: { login: 'bot' },
          created_at: '2026-10-01T12:05:00Z' },
        { number: 882, title: 'chore: idle', labels: [],
          head: { ref: 'ai/882', sha: 'sha882' }, user: { login: 'bot' },
          created_at: '2026-10-01T12:06:00Z' }
      ],
      runs: [
        { event: 'workflow_dispatch', head_sha: 'sha880', status: 'in_progress',
          created_at: '2026-10-01T12:01:00Z', html_url: 'http://run/880' },
        { event: 'workflow_dispatch', head_sha: 'sha881', status: 'queued',
          created_at: '2026-10-01T12:02:00Z', html_url: 'http://run/881' }
      ]
    });
    // 2+ validating cards, FIFO-free order = PR number (multi-item case)
    assert.deepEqual(st.lanes.pr_validation.map(function (c) { return c.pr; }), [880, 881]);
    assert.equal(st.lanes.pr_validation[0].checks.verdict, 'in_progress');
    assert.equal(st.lanes.pr_validation[0].checks.url, 'http://run/880');
    assert.equal(st.lanes.pr_validation[1].checks.verdict, 'queued');
    // no active run on the head → stays pr_created
    assert.deepEqual(st.lanes.pr_created.map(function (c) { return c.pr; }), [882]);
    assert.equal(st.counts.pr_validation, 2);
    assert.equal(st.counts.pr_created, 1);
  });

  test('pr_validation history: pr_created → pr_validation transition is stamped against the previous snapshot', function () {
    var prev = { lanes: { pr_created: [{ pr: 880, labels: [],
      history: [{ state: 'pr_created', at: '2026-10-01T12:00:00Z' }] }] } };
    var st = build({
      prs: [{ number: 880, title: 't', labels: [],
        head: { ref: 'ai/880', sha: 'sha880' }, user: { login: 'bot' },
        created_at: '2026-10-01T12:00:00Z' }],
      runs: [{ event: 'workflow_dispatch', head_sha: 'sha880', status: 'in_progress',
        created_at: '2026-10-01T12:01:00Z', html_url: 'http://run/880' }],
      prev: prev
    });
    var card = st.lanes.pr_validation[0];
    assert.deepEqual(card.history.map(function (h) { return h.state; }),
      ['pr_created', 'pr_validation']);
    assert.equal(card.history[1].at, '2026-10-01T13:00:00Z',
      'the transition is stamped at this tick');
  });

  test('pr_created card with a COMPLETED dispatched run stays pr_created (validation no longer in flight)', function () {
    var st = build({
      prs: [{ number: 883, title: 't', labels: [],
        head: { ref: 'ai/883', sha: 'sha883' }, user: { login: 'bot' },
        created_at: '2026-10-01T12:00:00Z' }],
      runs: [{ event: 'workflow_dispatch', head_sha: 'sha883', status: 'completed',
        conclusion: 'failure', created_at: '2026-10-01T12:01:00Z',
        html_url: 'http://run/883' }]
    });
    assert.deepEqual(st.lanes.pr_validation, []);
    assert.deepEqual(st.lanes.pr_created.map(function (c) { return c.pr; }), [883]);
    assert.equal(st.lanes.pr_created[0].checks.verdict, 'failure',
      'the failed verdict still rides the card as a red dot');
  });

  test('without a previous snapshot label timestamps stay null (honest unknowns)', function () {
    var st = build();
    var card = st.lanes.validating[0];
    assert.ok(!('reviewedAt' in card) && !card.reviewedAt);
    assert.ok(!card.approvedAt);
    assert.ok(!card.validatingAt);
    // prCreated still exact — GitHub-native field
    assert.equal(card.prCreated, '2026-10-01T06:00:00Z');
  });
});

// ── schema 2 — timestamp accumulation (previous snapshot) ────────────────────

suite('factoryState — lifecycle timestamps (accumulation)', function () {
  var NOW = '2026-10-01T13:10:00Z';
  function pr(n, labels, extra) {
    return Object.assign({ number: n, title: 't' + n, labels: labels,
      head: { ref: 'b' + n, sha: 'sha' + n }, user: { login: 'bot' },
      created_at: '2026-10-01T0' + n + ':00:00Z' }, extra || {});
  }
  function lbl(names) {
    return names.map(function (n) { return { name: n }; });
  }

  test('carried stamps survive; new transitions stamp the tick time', function () {
    var prev = {
      schema: 2, lanes: {
        review: [{ pr: 11, labels: ['ai_pr_reviewed'],
          reviewedAt: '2026-10-01T09:00:00Z' }],
        pr_created: [{ pr: 12, labels: [] }]
      }
    };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      prs: [
        pr(11, lbl(['ai_pr_reviewed'])),                 // still review — carry
        pr(12, lbl(['ai_pr_reviewed']))                  // moved pr_created→review
      ], runs: []
    });
    assert.equal(st.lanes.review[0].pr, 11);
    assert.equal(st.lanes.review[0].reviewedAt, '2026-10-01T09:00:00Z',
      'unchanged card keeps its exact history');
    assert.equal(st.lanes.review[1].pr, 12);
    assert.equal(st.lanes.review[1].reviewedAt, NOW,
      'transition witnessed between ticks stamps the tick time');
  });

  test('label removal clears its stamp (rework cycle resets the clock)', function () {
    var prev = { lanes: { review: [{ pr: 21, labels: ['ai_pr_reviewed'],
      reviewedAt: '2026-10-01T09:00:00Z' }] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      prs: [pr(21, lbl(['agent:rework']))], runs: []
    });
    var card = st.lanes.pr_created[0];
    assert.ok(!card.reviewedAt, 'ai_pr_reviewed gone → stamp dropped');
  });

  test('approvedAt + validatingAt accumulate through the arm transition', function () {
    var prev = { lanes: { approved_queue: [{ pr: 31,
      labels: ['pr_approved'], approvedAt: '2026-10-01T10:00:00Z' }] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      prs: [pr(31, lbl(['pr_approved', 'ai_validating']))], runs: []
    });
    var card = st.lanes.validating[0];
    assert.equal(card.approvedAt, '2026-10-01T10:00:00Z', 'carried');
    assert.equal(card.validatingAt, NOW, 'arm witnessed this tick');
  });
});

// ── schema 2 — merged_recent lane ────────────────────────────────────────────

suite('factoryState — merged_recent (24h window)', function () {
  var NOW = '2026-10-01T13:10:00Z';
  function merged(n, mergedAt) {
    return { number: n, title: 'm' + n, labels: [],
      head: { ref: 'b' + n, sha: 'sha' + n }, user: { login: 'bot' },
      created_at: '2026-09-29T08:00:00Z', merged_at: mergedAt };
  }

  test('merged within 24h land (newest first); older drops out', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      mergedPrs: [merged(41, '2026-09-30T01:00:00Z'),   // >24h — dropped
                  merged(42, '2026-10-01T12:00:00Z'),
                  merged(43, '2026-10-01T09:00:00Z')],
      prs: [], runs: []
    });
    assert.deepEqual(st.lanes.merged_recent.map(function (c) { return c.pr; }),
      [42, 43], 'inside the window, newest merged first');
    assert.equal(st.counts.merged_recent, 2);
    assert.equal(st.lanes.merged_recent[0].mergedAt, '2026-10-01T12:00:00Z');
    assert.equal(st.lanes.merged_recent[0].prCreated, '2026-09-29T08:00:00Z');
  });

  test('merged card inherits label stamps from its open life (cross-lane carry)', function () {
    var prev = { lanes: { validating: [{ pr: 51,
      labels: ['pr_approved', 'ai_validating'],
      approvedAt: '2026-10-01T07:00:00Z', validatingAt: '2026-10-01T08:00:00Z' }] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      mergedPrs: [merged(51, '2026-10-01T09:30:00Z')], prs: [], runs: []
    });
    var card = st.lanes.merged_recent[0];
    assert.equal(card.approvedAt, '2026-10-01T07:00:00Z');
    assert.equal(card.validatingAt, '2026-10-01T08:00:00Z');
    assert.equal(card.mergedAt, '2026-10-01T09:30:00Z');
  });
});

// ── schema 2 — development lane (issue side) ─────────────────────────────────

suite('factoryState — development lane (dev leg, issue side)', function () {
  var NOW = '2026-10-01T13:10:00Z';
  function issue(n, labels) {
    return { number: n, title: 'issue ' + n, labels: lbl(labels),
      user: { login: 'ba' }, html_url: 'http://issues/' + n };
  }
  function lbl(names) {
    return names.map(function (x) { return { name: x }; });
  }

  test('agent:dev without ai_developed → development; ai_developed hands off', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      devIssues: [issue(61, ['agent:dev']),
                  issue(62, ['agent:dev', 'ai_developed'])],
      prs: [], runs: []
    });
    assert.deepEqual(st.lanes.development.map(function (c) { return c.issue; }), [61]);
    assert.equal(st.lanes.development[0].title, 'issue 61');
    assert.equal(st.lanes.development[0].url, 'http://issues/61');
    assert.equal(st.counts.development, 1);
  });

  test('devStartedAt: carried while running, stamped on first sighting', function () {
    var prev = { lanes: { development: [{ issue: 61, labels: ['agent:dev'],
      devStartedAt: '2026-10-01T05:00:00Z' }] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      devIssues: [issue(61, ['agent:dev']), issue(63, ['agent:dev'])],
      prs: [], runs: []
    });
    var byIssue = {};
    st.lanes.development.forEach(function (c) { byIssue[c.issue] = c; });
    assert.equal(byIssue[61].devStartedAt, '2026-10-01T05:00:00Z', 'carried');
    assert.equal(byIssue[63].devStartedAt, NOW, 'new handoff stamped this tick');
  });

  test('devStartedAt carries through the BACKLOG prev card (prevIndex resolves issues there)', function () {
    var prev = { lanes: { development: [] }, backlog: { in_dev: [
      { issue: 64, title: 'i64', labels: ['agent:dev'], bucket: 'in_dev',
        assignee: 'ai-teammate', devStartedAt: '2026-10-02T05:00:00Z',
        history: [{ state: 'in_dev', at: '2026-10-02T05:00:00Z' }] }
    ] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      machineAuthor: 'ai-teammate', prs: [], runs: [],
      issues: [{ number: 64, title: 'issue 64', labels: [{ name: 'agent:dev' }],
        user: { login: 'ba' }, html_url: 'http://issues/64',
        assignees: [{ login: 'ai-teammate' }] }]
    });
    assert.equal(st.lanes.development[0].devStartedAt, '2026-10-02T05:00:00Z',
      'carry must survive prevIndex resolving the issue to its backlog twin');
    assert.equal(st.backlog.in_dev[0].devStartedAt, '2026-10-02T05:00:00Z');
  });

  test('no previous snapshot → devStartedAt null (not a lying now)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      devIssues: [issue(61, ['agent:dev'])], prs: [], runs: []
    });
    assert.ok(!st.lanes.development[0].devStartedAt);
  });
});

// ── v3 — card history (accumulated state timeline) ──────────────────────────

suite('factoryState — v3 card history (accumulation)', function () {
  var NOW = '2026-10-03T13:10:00Z';
  function pr(n, labels) {
    return { number: n, title: 't' + n, labels: (labels || []).map(function (x) {
        return { name: x };
      }), head: { ref: 'b' + n, sha: 'sha' + n }, user: { login: 'bot' },
      created_at: '2026-10-03T0' + n + ':00:00Z' };
  }

  test('first snapshot without prev: current state known, since-when unknown', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(11, ['ai_pr_reviewed'])], runs: []
    });
    var h = st.lanes.review[0].history;
    assert.equal(h.length, 1);
    assert.equal(h[0].state, 'review');
    assert.ok(!h[0].at, 'no lying timestamp before the tick can witness one');
  });

  test('new card between ticks: entry stamped with the tick time', function () {
    var prev = { lanes: { pr_created: [] } };   // hasPrev, but card 12 unseen
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      prs: [pr(12, ['ai_pr_reviewed'])], runs: []
    });
    var h = st.lanes.review[0].history;
    assert.equal(h.length, 1);
    assert.equal(h[0].state, 'review');
    assert.equal(h[0].at, NOW);
  });

  test('witnessed transition appends; earlier entries ride along', function () {
    var prev = { lanes: {
      pr_created: [{ pr: 13, labels: [], history: [{ state: 'pr_created' }] }],
      review: []
    } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      prs: [pr(13, ['ai_pr_reviewed'])], runs: []
    });
    var h = st.lanes.review[0].history;
    assert.equal(h.length, 2);
    assert.equal(h[0].state, 'pr_created');
    assert.ok(!h[0].at, 'carried entry keeps its honest unknown start');
    assert.equal(h[1].state, 'review');
    assert.equal(h[1].at, NOW);
  });

  test('unchanged card keeps its history verbatim', function () {
    var prev = { lanes: { review: [{ pr: 14, labels: ['ai_pr_reviewed'],
      reviewedAt: '2026-10-03T09:00:00Z',
      history: [{ state: 'pr_created' }, { state: 'review', at: '2026-10-03T09:00:00Z' }] }] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      prs: [pr(14, ['ai_pr_reviewed'])], runs: []
    });
    assert.deepEqual(st.lanes.review[0].history, prev.lanes.review[0].history);
  });

  test('merged card appends merged_recent stamped with the exact merged_at', function () {
    var prev = { lanes: { validating: [{ pr: 15,
      labels: ['pr_approved', 'ai_validating'],
      history: [{ state: 'pr_created' }, { state: 'validating', at: '2026-10-03T08:00:00Z' }] }] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      mergedPrs: [{ number: 15, title: 't15', labels: [],
        head: { ref: 'b15', sha: 'sha15' }, user: { login: 'bot' },
        created_at: '2026-10-03T05:00:00Z', merged_at: '2026-10-03T09:30:00Z' }],
      prs: [], runs: []
    });
    var h = st.lanes.merged_recent[0].history;
    assert.equal(h.length, 3);
    assert.equal(h[2].state, 'merged_recent');
    assert.equal(h[2].at, '2026-10-03T09:30:00Z', 'GitHub field, not tick time');
  });

  test('merged card rebuilt tick-over-tick: terminal entry NOT duplicated (real timeline survives)', function () {
    // merged cards are RE-DERIVED from the previous snapshot every tick
    // while they sit in the 24h merged_recent window — the terminalAt
    // path must not append a second merged_recent entry per tick, or
    // HISTORY_CAP (24) evicts the card's real pipeline timeline within
    // ~4h at the 10-min cadence.
    var prev = { lanes: { validating: [{ pr: 17,
      labels: ['pr_approved', 'ai_validating'],
      history: [{ state: 'pr_created' },
                { state: 'validating', at: '2026-10-03T08:00:00Z' }] }] } };
    var merged = { number: 17, title: 't17', labels: [],
      head: { ref: 'b17', sha: 'sha17' }, user: { login: 'bot' },
      created_at: '2026-10-03T05:00:00Z', merged_at: '2026-10-03T09:30:00Z' };
    var st = null;
    for (var i = 0; i < 31; i++) {   // > HISTORY_CAP ticks in the window
      st = fsModule.buildFactoryState({
        repoInfo: { owner: 'o', repo: 'r' },
        now: '2026-10-03T13:10:00Z',
        prev: st || prev, mergedPrs: [merged], prs: [], runs: []
      });
    }
    var h = st.lanes.merged_recent[0].history;
    assert.deepEqual(h.map(function (e) { return e.state; }),
      ['pr_created', 'validating', 'merged_recent'],
      'real pipeline timeline must survive repeated ticks');
    var terminals = h.filter(function (e) { return e.state === 'merged_recent'; });
    assert.equal(terminals.length, 1, 'exactly one terminal entry');
    assert.equal(terminals[0].at, '2026-10-03T09:30:00Z');
  });

  test('history is capped (snapshot cannot grow unbounded)', function () {
    var long = [];
    for (var i = 0; i < 40; i++) long.push({ state: 'review', at: NOW });
    var prev = { lanes: { pr_created: [{ pr: 16, labels: [], history: long }] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      prs: [pr(16, ['ai_pr_reviewed'])], runs: []
    });
    assert.ok(st.lanes.review[0].history.length <= 24, 'capped at 24');
  });
});

// ── v3 — backlog (issue lanes) ───────────────────────────────────────────────

suite('factoryState — v3 backlog (issue lanes)', function () {
  var NOW = '2026-10-03T13:10:00Z';
  function issue(n, labels, extra) {
    return Object.assign({ number: n, title: 'issue ' + n,
      labels: (labels || []).map(function (x) { return { name: x }; }),
      user: { login: 'ba' }, html_url: 'http://issues/' + n }, extra || {});
  }
  var AI = 'ai-teammate';

  function build(issues, opts) {
    return fsModule.buildFactoryState(Object.assign({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      issues: issues, machineAuthor: AI, prs: [], runs: []
    }, opts || {}));
  }

  test('blocked label wins over assignment and agent:dev (owner hold)', function () {
    var st = build([issue(21, ['blocked', 'agent:dev'],
      { assignees: [{ login: AI }] })]);
    assert.deepEqual(st.backlog.blocked.map(function (c) { return c.issue; }), [21]);
    assert.equal(st.backlogCounts.blocked, 1);
    assert.deepEqual(st.backlogCounts.in_dev, 0);
  });

  test('assigned to the machine author → in_dev; agent:dev unlabeled → queued', function () {
    var st = build([issue(22, ['agent:dev'], { assignees: [{ login: AI }] }),
                    issue(23, ['agent:dev'])]);
    assert.deepEqual(st.backlog.in_dev.map(function (c) { return c.issue; }), [22]);
    assert.deepEqual(st.backlog.queued.map(function (c) { return c.issue; }), [23]);
  });

  test('machineAuthor LIST: assignment to ANY list entry buckets in_dev (gh-728)', function () {
    var st = build([issue(30, [], { assignees: [{ login: 'github-actions[bot]' }] })],
      { machineAuthor: 'ai-teammate,github-actions[bot]' });
    assert.deepEqual(st.backlog.in_dev.map(function (c) { return c.issue; }), [30],
      'a login listed in the knob marks the issue as machine-owned');
    var st2 = build([issue(31, [], { assignees: [{ login: 'ai-teammate' }] })],
      { machineAuthor: 'ai-teammate,github-actions[bot]' });
    assert.deepEqual(st2.backlog.in_dev.map(function (c) { return c.issue; }), [31],
      'the first entry still buckets');
    var st3 = build([issue(32, [], { assignees: [{ login: 'some-human' }] })],
      { machineAuthor: 'ai-teammate,github-actions[bot]' });
    assert.deepEqual(st3.backlog.inbox.map(function (c) { return c.issue; }), [32],
      'foreign assignees stay inbox');
  });

  test('unconfigured machineAuthor (null) → no assignment bucketing (no silent default)', function () {
    // resolveMachineAuthor returns null on purpose when a deployment has
    // no machineAuthor knob — that must NOT collapse into the hardcoded
    // 'ai-teammate' login, or an issue assigned to a same-named user
    // lands in "In dev · assigned" without the deployment opting in.
    var st = build([issue(29, [], { assignees: [{ login: 'ai-teammate' }] })],
      { machineAuthor: null });
    assert.deepEqual(st.backlog.inbox.map(function (c) { return c.issue; }), [29],
      'null knob = no assignment bucketing');
    var optIn = build([issue(29, [], { assignees: [{ login: 'ai-teammate' }] })],
      { machineAuthor: 'ai-teammate' });
    assert.deepEqual(optIn.backlog.in_dev.map(function (c) { return c.issue; }), [29],
      'explicit knob still buckets');
  });

  test('plain open issue → inbox; card carries title, assignee, labels, url', function () {
    var st = build([issue(24, [], { assignees: [{ login: 'human' }],
      title: 'inbox card' })]);
    var c = st.backlog.inbox[0];
    assert.equal(c.issue, 24);
    assert.equal(c.title, 'inbox card');
    assert.equal(c.assignee, 'human');
    assert.equal(c.url, 'http://issues/24');
    assert.equal(c.bucket, 'inbox');
  });

  test('agent:dev issues ALSO feed the development lane (single source)', function () {
    var st = build([issue(25, ['agent:dev'], { assignees: [{ login: AI }] })]);
    assert.deepEqual(st.lanes.development.map(function (c) { return c.issue; }), [25]);
    assert.deepEqual(st.backlog.in_dev.map(function (c) { return c.issue; }), [25]);
  });

  test('ai_developed hands off: leaves development lane AND gets no machine bucket', function () {
    var st = build([issue(26, ['agent:dev', 'ai_developed'])]);
    assert.deepEqual(st.lanes.development, []);
    assert.deepEqual(st.backlog.queued, [], 'ai_developed is PR-side now');
    assert.deepEqual(st.backlog.inbox, []);
  });

  test('issue history accumulates over bucket changes (shared by lane + backlog)', function () {
    var prev = { lanes: {}, backlog: { inbox: [
      { issue: 27, labels: [], bucket: 'inbox', history: [{ state: 'inbox' }] }
    ] } };
    var st = build([issue(27, ['agent:dev'])], { prev: prev });
    var hBacklog = st.backlog.queued[0].history;
    assert.equal(hBacklog.length, 2);
    assert.equal(hBacklog[0].state, 'inbox');
    assert.equal(hBacklog[1].state, 'queued');
    assert.equal(hBacklog[1].at, NOW);
    assert.deepEqual(st.lanes.development[0].history, hBacklog,
      'lane card and backlog card share one history');
  });

  test('no issues input → backlog present but empty (schema stable)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prs: [], runs: []
    });
    assert.deepEqual(st.backlog, { in_dev: [], queued: [], blocked: [], inbox: [] });
    assert.deepEqual(st.backlogCounts,
      { in_dev: 0, queued: 0, blocked: 0, inbox: 0 });
  });

  test('backlog history capped identically', function () {
    var long = [];
    for (var i = 0; i < 40; i++) long.push({ state: 'inbox', at: NOW });
    var prev = { backlog: { inbox: [{ issue: 28, labels: [], bucket: 'inbox',
      history: long }] } };
    var st = build([issue(28, [])], { prev: prev });
    assert.ok(st.backlog.inbox[0].history.length <= 24);
  });

  test('backlog buckets cap at BACKLOG_CAP newest (snapshot bounded, counts honest)', function () {
    // github_search_issues returns ONE page (no perPage) — an over-page
    // repo truncates at the source, so the snapshot must present a
    // bounded, self-consistent view: counts == what the snapshot holds.
    var many = [];
    for (var i = 1; i <= 60; i++) many.push(issue(i, []));
    var st = build(many);
    assert.equal(st.backlog.inbox.length, 50, 'capped per bucket');
    assert.equal(st.backlogCounts.inbox, 50, 'counts match the snapshot');
    assert.equal(st.backlog.inbox[0].issue, 11, 'oldest dropped…');
    assert.equal(st.backlog.inbox[49].issue, 60, '…newest kept');
  });
});

// ── v3 — tokens (optional per-leg usage) ─────────────────────────────────────

suite('factoryState — v3 tokens (optional per-leg usage)', function () {
  var NOW = '2026-10-03T13:10:00Z';
  function pr(n) {
    return { number: n, title: 't' + n, labels: [],
      head: { ref: 'b' + n, sha: 'sha' + n }, user: { login: 'bot' },
      created_at: '2026-10-03T06:00:00Z' };
  }
  var TOKENS = {
    'pr-31': [
      { leg: 'story_development', at: '2026-10-03T07:00:00Z',
        prompt: 1000, completion: 500, total: 1500 },
      { leg: 'pr_review', at: '2026-10-03T09:00:00Z',
        prompt: 2000, completion: 800, total: 2800 }
    ]
  };

  test('tokens map attaches to the matching PR card', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31), pr(32)], tokens: TOKENS, runs: []
    });
    var withT = st.lanes.pr_created.filter(function (c) { return c.pr === 31; })[0];
    var without = st.lanes.pr_created.filter(function (c) { return c.pr === 32; })[0];
    assert.equal(withT.tokens.length, 2);
    assert.equal(withT.tokens[1].total, 2800);
    assert.ok(!('tokens' in without), 'additive schema — unmatched cards stay clean');
  });

  test('token rows keyed by issue attach to backlog cards', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prs: [], runs: [],
      machineAuthor: 'ai-teammate',
      issues: [{ number: 33, title: 'i33', labels: [], user: { login: 'ba' },
        html_url: 'http://issues/33', assignees: [{ login: 'ai-teammate' }] }],
      tokens: { 'issue-33': [{ leg: 'dev', at: '2026-10-03T07:00:00Z',
        prompt: 10, completion: 5, total: 15 }] }
    });
    assert.equal(st.backlog.in_dev[0].tokens.length, 1);
  });

  test('array-form tokens input (rows carry pr/issue fields) is normalized', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prs: [pr(34)], runs: [],
      tokens: [{ pr: 34, leg: 'rework', at: '2026-10-03T08:00:00Z',
        prompt: 1, completion: 2, total: 3 }]
    });
    var card = st.lanes.pr_created[0];
    assert.equal(card.tokens.length, 1);
    assert.equal(card.tokens[0].leg, 'rework');
  });

  test('rows sort by `at` ascending inside a key', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prs: [pr(35)], runs: [],
      tokens: { 'pr-35': [
        { leg: 'late', at: '2026-10-03T10:00:00Z', prompt: 1, completion: 1, total: 2 },
        { leg: 'early', at: '2026-10-03T07:00:00Z', prompt: 1, completion: 1, total: 2 }
      ] }
    });
    assert.equal(st.lanes.pr_created[0].tokens[0].leg, 'early');
    assert.equal(st.lanes.pr_created[0].tokens[1].leg, 'late');
  });
});

// ── v3 — readTokensFile (optional factory-published usage feed) ──────────────

suite('factoryState — readTokensFile', function () {
  test('parses the map from file content', function () {
    var map = fsModule.readTokensFile('outputs/token_usage/factory_tokens.json',
      function () { return '{"pr-31":[{"leg":"dev","at":"t","prompt":1,"completion":2,"total":3}]}'; });
    assert.ok(map && map['pr-31'] && map['pr-31'][0].total === 3);
  });

  test('missing file / reader throws / invalid JSON → null (never fails the tick)', function () {
    assert.equal(fsModule.readTokensFile('x', function () { throw new Error('nope'); }), null);
    assert.equal(fsModule.readTokensFile('x', function () { return 'not json'; }), null);
    assert.equal(fsModule.readTokensFile('x', function () { return '{"pr-1":42}'; }), null,
      'map values must be arrays');
    assert.equal(fsModule.readTokensFile(null, function () { return '{}'; }), null);
  });
});

// ── fetchPreviousState (accumulation source) ─────────────────────────────────

suite('factoryState — fetchPreviousState', function () {
  test('probes the data branch and parses; miss → null', function () {
    var seen = [];
    var exec = function (a) {
      seen.push(a.command);
      if (a.command.indexOf('Not Found') >= 0) throw new Error('Not Found');
      return { output: JSON.stringify({ schema: 2, lanes: { review: [] } }) };
    };
    var prev = fsModule.fetchPreviousState('o/r',
      { tag: 'factory-data', asset: 'fa-state.json' }, exec);
    assert.ok(prev && prev.lanes, 'parsed snapshot returned');
    assert.equal(seen[0],
      'gh api repos/o/r/contents/data/fa-state.json?ref=factory-data --jq .content | base64 -d',
      'one gh probe against the data branch');

    var miss = fsModule.fetchPreviousState('o/r',
      { asset: 'fa-state.json' }, function () { throw new Error('Not Found'); });
    assert.equal(miss, null, 'any miss degrades to null');
  });
});

// ── gh-781 — fetchTokensFromBranch (factory-published per-leg tokens) ────────

suite('factoryState — fetchTokensFromBranch', function () {
  var TOKENS = '{"pr-31":[{"leg":"dev","at":"2026-10-08T10:00:00Z","prompt":10,"completion":5,"total":15}],' +
    '"issue-7":[{"leg":"review","at":"2026-10-08T11:00:00Z","prompt":1,"completion":2,"total":3}]}';

  test('fetches data/fa-tokens.json off the data branch and returns the map', function () {
    var seen = [];
    var map = fsModule.fetchTokensFromBranch('o/r',
      { tag: 'factory-data' }, function (a) {
        seen.push(a.command);
        return { output: TOKENS };
      });
    assert.ok(map && map['pr-31'] && map['pr-31'][0].total === 15, 'pr rows returned');
    assert.ok(map['issue-7'] && map['issue-7'][0].leg === 'review',
      'multi-key map survives (issue keys ride along pr keys)');
    assert.equal(seen.length, 1, 'one gh probe per tick');
    assert.equal(seen[0],
      'gh api repos/o/r/contents/data/fa-tokens.json?ref=factory-data --jq .content | base64 -d',
      'one gh probe: data/fa-tokens.json @ factory-data');
  });

  test('any miss → null, never a throw (404 / garbage JSON / rate limit)', function () {
    assert.equal(fsModule.fetchTokensFromBranch('o/r', {},
      function () { throw new Error('Not Found (HTTP 404)'); }), null, '404 → null');
    assert.equal(fsModule.fetchTokensFromBranch('o/r', {},
      function () { throw new Error('API rate limit exceeded'); }), null, 'rate limit → null');
    assert.equal(fsModule.fetchTokensFromBranch('o/r', {},
      function () { return { output: 'not json at all' }; }), null, 'garbage → null');
  });

  test('non-map shapes → null (array payload, scalar payload, no array values, empty map)', function () {
    assert.equal(fsModule.fetchTokensFromBranch('o/r', {},
      function () { return { output: '[]' }; }), null, 'array payload → null');
    assert.equal(fsModule.fetchTokensFromBranch('o/r', {},
      function () { return { output: '42' }; }), null, 'scalar payload → null');
    assert.equal(fsModule.fetchTokensFromBranch('o/r', {},
      function () { return { output: '{"pr-31":"not-an-array"}' }; }), null,
      'map without array values → null');
    assert.equal(fsModule.fetchTokensFromBranch('o/r', {},
      function () { return { output: '{}' }; }), null, 'empty map → null');
  });

  test('tag override rides the fetch (multi-factory data branches)', function () {
    var seen = [];
    fsModule.fetchTokensFromBranch('o/r', { tag: 'factory-data-eu' },
      function (a) { seen.push(a.command); return { output: TOKENS }; });
    assert.contains(seen[0], 'data/fa-tokens.json?ref=factory-data-eu');
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
    assert.ok(cmds[1].indexOf(' [skip ci]') > 0,
              'publish message carries [skip ci] — no phantom runs on factory-data (gh-676)');
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

// ── time-travel history ──────────────────────────────────────────────────────

suite('factoryState — history (board time travel)', function () {
  var ST = fsModule.buildFactoryState({
    repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' },
    prs: [], runs: [], now: '2026-09-23T22:35:55Z'
  });

  test('stampOf: tick timestamp → snapshot stamp', function () {
    assert.equal(fsModule.stampOf(ST), '20260923-2235');
  });

  test('snapshot PUT: unique name, gh-first, create (no sha)', function () {
    var c = fsModule.snapshotPutCommand(ST,
      { repo: 'IstiN/flutter_agent_harness', asset: 'fa-state.json' },
      '20260923-2235');
    assert.ok(c.indexOf('gh api -X PUT') === 0, 'first token must be gh');
    assert.ok(c.indexOf('data/fa-state-20260923-2235.json') > 0);
    assert.ok(c.indexOf('-f sha=') === -1, 'snapshot is a create — no sha');
    assert.ok(c.indexOf('| base64)') > 0, 'payload rides base64');
    assert.ok(c.indexOf(' [skip ci]') > 0,
              'snapshot message carries [skip ci] — no phantom runs (gh-676)');
  });

  test('history PUT: sha rides only when the index already exists', function () {
    var idx = { schema: 1, snapshots: [] };
    var create = fsModule.historyPutCommand(ST,
      { repo: 'IstiN/flutter_agent_harness', asset: 'fa-state.json' }, idx, '');
    assert.ok(create.indexOf('data/fa-state-history.json') > 0);
    assert.ok(create.indexOf('-f sha=') === -1);
    var update = fsModule.historyPutCommand(ST,
      { repo: 'IstiN/flutter_agent_harness', asset: 'fa-state.json' }, idx, 'abc123');
    assert.ok(update.indexOf("-f sha='abc123'") > 0, 'update must carry the sha');
    assert.ok(create.indexOf(' [skip ci]') > 0 && update.indexOf(' [skip ci]') > 0,
              'history messages carry [skip ci] — no phantom runs (gh-676)');
  });

  test('updateHistory: first run creates the index with one snapshot', function () {
    var seen = [];
    var url = fsModule.updateHistory(ST,
      { repo: 'IstiN/flutter_agent_harness', asset: 'fa-state.json' },
      function (a) {
        seen.push(a.command);
        if (a.command.indexOf('--jq .sha') > 0) {
          throw new Error('Not Found'); // probe misses → first publish
        }
        return undefined;
      });
    assert.equal(seen.length, 3, 'snapshot PUT + sha probe + index PUT');
    assert.ok(seen[0].indexOf('data/fa-state-20260923-2235.json') > 0,
              'snapshot lands first');
    assert.ok(seen[1].indexOf('--jq .sha') > 0, 'index sha probe second');
    var idxPut = seen[2];
    assert.ok(idxPut.indexOf('data/fa-state-history.json') > 0);
    assert.ok(idxPut.indexOf('-f sha=') === -1, 'create has no sha');
    assert.ok(idxPut.indexOf('"snapshots":[{"') > 0, 'one snapshot inside');
    assert.ok(url.indexOf('/data/fa-state-history.json') > 0);
  });

  test('updateHistory: existing index — append, carry sha, trim to keep', function () {
    var KEEP = 3;
    var old = { schema: 1, repo: 'IstiN/flutter_agent_harness',
      asset: 'fa-state.json',
      snapshots: [
        { ts: 't3', tick: 'a3', stamp: 's3', url: 'u3' },
        { ts: 't2', tick: 'a2', stamp: 's2', url: 'u2' },
        { ts: 't1', tick: 'a1', stamp: 's1', url: 'u1' }
      ] };
    var seen = [];
    fsModule.updateHistory(ST,
      { repo: 'IstiN/flutter_agent_harness', asset: 'fa-state.json',
        historyKeep: KEEP },
      function (a) {
        seen.push(a.command);
        if (a.command.indexOf('--jq .sha') > 0) return { output: 'feedface\n' };
        if (a.command.indexOf('--jq .content') > 0) {
          return { output: JSON.stringify(old) };
        }
        return undefined;
      });
    var idxPut = seen[seen.length - 1];
    assert.ok(idxPut.indexOf("-f sha='feedface'") > 0, 'update carries probed sha');
    var m = idxPut.match(/"snapshots":\[(.*)\]/);
    assert.ok(m, 'index payload present');
    var urls = [];
    idxPut.replace(/"url":"([^"]+)"/g, function (_, u) { urls.push(u); return u; });
    assert.equal(urls.length, KEEP, 'trimmed to historyKeep');
    assert.ok(urls[0].indexOf('fa-state-20260923-2235.json') > 0,
              'newest snapshot first');
  });

});
