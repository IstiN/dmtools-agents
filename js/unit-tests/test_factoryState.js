/**
 * Unit tests for js/factoryState.js — the factory-state snapshot builder and
 * the release-asset publisher (owner 2026-09-23, OPT-IN via statePublish).
 *
 * Pure functions only: no tool globals needed; the publisher takes an `exec`
 * capturer. assert = the harness global (equal/deepEqual/ok/contains).
 */

var assert = globalThis.assert;

var machineAuthorModule = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
var reworkLatchModule = loadModule('js/common/reworkLatch.js', makeRequire({ './legRunVocab.js': legRunVocabReal() }), {});
var fsModule = loadModule('js/factoryState.js',
    makeRequire({
        './common/machineAuthor.js': machineAuthorModule,
        './common/reworkLatch.js': reworkLatchModule
    }), {});

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

suite('factoryState — merged_recent (7d window)', function () {
  var NOW = '2026-10-01T13:10:00Z';
  function merged(n, mergedAt) {
    return { number: n, title: 'm' + n, labels: [],
      head: { ref: 'b' + n, sha: 'sha' + n }, user: { login: 'bot' },
      created_at: '2026-09-29T08:00:00Z', merged_at: mergedAt };
  }

  test('merged within 7d land (newest first); older drops out', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      mergedPrs: [merged(41, '2026-09-23T01:00:00Z'),   // >7d — dropped
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
  test('gh-1150 AC1: merged PRs at 48h and 6d stay in merged_recent with prev stamps, history, and tokens; >7d excluded', function () {
    assert.equal(fsModule.MERGED_WINDOW_MS, 7 * 24 * 60 * 60 * 1000,
      'MERGED_WINDOW_MS is 7 days (604800000 ms)');
    var prev = {
      lanes: {
        merged_recent: [
          { pr: 52, labels: [], reviewedAt: '2026-09-29T10:00:00Z',
            approvedAt: '2026-09-29T11:00:00Z', validatingAt: '2026-09-29T12:00:00Z',
            history: [{ state: 'pr_created', at: '2026-09-29T08:00:00Z' },
                      { state: 'review', at: '2026-09-29T10:00:00Z' },
                      { state: 'merged_recent', at: '2026-09-29T13:10:00Z' }] },
          { pr: 53, labels: [], reviewedAt: '2026-09-25T10:00:00Z',
            approvedAt: '2026-09-25T11:00:00Z', validatingAt: '2026-09-25T12:00:00Z',
            history: [{ state: 'pr_created', at: '2026-09-25T08:00:00Z' },
                      { state: 'merged_recent', at: '2026-09-25T13:10:00Z' }] }
        ]
      }
    };
    var tokens = {
      'pr-52': [{ leg: 'dev', at: '2026-09-29T09:00:00Z', prompt: 100, completion: 50, total: 150 }],
      'pr-53': [{ leg: 'review', at: '2026-09-25T10:00:00Z', prompt: 200, completion: 80, total: 280 }],
      'pr-54': [{ leg: 'dev', at: '2026-09-22T09:00:00Z', prompt: 300, completion: 90, total: 390 }]
    };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev, tokens: tokens,
      mergedPrs: [
        merged(52, '2026-09-29T13:10:00Z'), // 48h ago (inside 7d)
        merged(53, '2026-09-25T13:10:00Z'), // 6d ago (inside 7d)
        merged(54, '2026-09-23T13:10:00Z')  // 8d ago (outside 7d)
      ],
      prs: [], runs: []
    });
    assert.deepEqual(st.lanes.merged_recent.map(function (c) { return c.pr; }), [52, 53]);
    var c52 = st.lanes.merged_recent[0];
    assert.equal(c52.reviewedAt, '2026-09-29T10:00:00Z');
    assert.equal(c52.approvedAt, '2026-09-29T11:00:00Z');
    assert.equal(c52.validatingAt, '2026-09-29T12:00:00Z');
    assert.equal(c52.history.length, 3);
    assert.equal(c52.tokens.length, 1);
    var c53 = st.lanes.merged_recent[1];
    assert.equal(c53.reviewedAt, '2026-09-25T10:00:00Z');
    assert.equal(c53.history.length, 2);
    assert.equal(c53.tokens.length, 1);
  });

  test('gh-1150 REG: merged_recent caps at MERGED_LANE_CAP (50 newest) and stays under command-size ceiling', function () {
    assert.equal(fsModule.MERGED_LANE_CAP, 50, 'MERGED_LANE_CAP is 50');
    var nowMs = Date.parse(NOW);
    var manyMerged = [];
    var prevMerged = [];
    var tokens = {};
    for (var i = 1; i <= 100; i++) {
      var num = 1000 + i;
      var mAt = new Date(nowMs - i * 3600 * 1000).toISOString();
      var cAt = new Date(nowMs - (i + 4) * 3600 * 1000).toISOString();
      manyMerged.push({
        number: num,
        title: 'feat(factoryState): extend MERGED_WINDOW_MS to 7d (gh-' + num + ')',
        labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }, { name: 'ai_pr_reviewed' }],
        head: { ref: 'feat/gh-' + num, sha: '4a844d855d9286f7ebb7176bddd49577fc6ce2' + (i < 10 ? '0' + i : i) },
        user: { login: 'dmtools-factory-bot' },
        created_at: cAt,
        merged_at: mAt
      });
      prevMerged.push({
        pr: num,
        labels: ['pr_approved', 'ai_validating', 'ai_pr_reviewed'],
        reviewedAt: cAt, approvedAt: cAt, validatingAt: cAt,
        checks: {
          verdict: 'success', at: mAt,
          url: 'https://github.com/IstiN/dmtools-agents/actions/runs/123456789' + i,
          runId: 1234567890 + i, name: 'Unit Tests', sha: 'sha' + num,
          conclusion: 'success', runStartedAt: cAt, updatedAt: mAt
        },
        history: [
          { state: 'pr_created', at: cAt },
          { state: 'review', at: cAt },
          { state: 'approved_queue', at: cAt },
          { state: 'validating', at: cAt },
          { state: 'merged_recent', at: mAt }
        ]
      });
      tokens['pr-' + num] = [
        { leg: 'story_development', at: cAt, prompt: 120000, completion: 5000, total: 125000, cacheRead: 90000, model: 'claude-opus-4-7' }
      ];
    }
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'IstiN', repo: 'dmtools-agents' },
      now: NOW,
      prev: { lanes: { merged_recent: prevMerged } },
      mergedPrs: manyMerged,
      prs: [], runs: [], tokens: tokens
    });
    assert.equal(st.lanes.merged_recent.length, 50, 'capped at MERGED_LANE_CAP (50)');
    assert.equal(st.counts.merged_recent, 50, 'counts match capped lane');
    assert.equal(st.lanes.merged_recent[0].pr, 1001, 'newest merge kept first');
    assert.equal(st.lanes.merged_recent[49].pr, 1050, '50th newest merge kept');
    var jsonBytes = JSON.stringify(st).length;
    assert.ok(jsonBytes < 96752, 'state JSON (' + jsonBytes + 'B) stays under 96,752B ceiling');
    var putCmd = fsModule.publishCommands(st, { repo: 'IstiN/dmtools-agents' })[1];
    assert.ok(putCmd.indexOf('-F content=@- <<__FA_EOF__') > 0, 'PUT streams base64 via stdin heredoc');
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
    // while they sit in the 7d merged_recent window — the terminalAt
    // path must not append a second merged_recent entry per tick, or
    // HISTORY_CAP (100) evicts the card's real pipeline timeline.
    var prev = { lanes: { validating: [{ pr: 17,
      labels: ['pr_approved', 'ai_validating'],
      history: [{ state: 'pr_created' },
                { state: 'validating', at: '2026-10-03T08:00:00Z' }] }] } };
    var merged = { number: 17, title: 't17', labels: [],
      head: { ref: 'b17', sha: 'sha17' }, user: { login: 'bot' },
      created_at: '2026-10-03T05:00:00Z', merged_at: '2026-10-03T09:30:00Z' };
    var st = null;
    for (var i = 0; i < 110; i++) {  // > HISTORY_CAP ticks in the window
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

  test('history is capped at HISTORY_CAP (100) so snapshot cannot grow unbounded (gh-1150 AC3)', function () {
    assert.equal(fsModule.HISTORY_CAP, 100, 'HISTORY_CAP is 100');
    var fifty = [];
    for (var j = 0; j < 50; j++) fifty.push({ state: 'review', at: NOW });
    var prev50 = { lanes: { pr_created: [{ pr: 160, labels: [], history: fifty }] } };
    var st50 = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev50,
      prs: [pr(160, ['ai_pr_reviewed'])], runs: []
    });
    assert.equal(st50.lanes.review[0].history.length, 51,
      '50carried + 1 transition stays intact under 100 cap');

    var long = [];
    for (var i = 0; i < 120; i++) long.push({ state: 's' + i, at: NOW });
    var prev = { lanes: { pr_created: [{ pr: 16, labels: [], history: long }] } };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prev: prev,
      prs: [pr(16, ['ai_pr_reviewed'])], runs: []
    });
    assert.equal(st.lanes.review[0].history.length, 100, 'capped at 100');
    assert.equal(st.lanes.review[0].history[0].state, 's21', 'retains most recent 100 entries');
    assert.equal(st.lanes.review[0].history[99].state, 'review');
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
    for (var i = 0; i < 120; i++) long.push({ state: 'inbox', at: NOW });
    var prev = { backlog: { inbox: [{ issue: 28, labels: [], bucket: 'inbox',
      history: long }] } };
    var st = build([issue(28, [])], { prev: prev });
    assert.equal(st.backlog.inbox[0].history.length, 100);
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

  test('statePublish.tokensAsset overrides the fixed asset (multi-factory shared branch)', function () {
    var seen = [];
    var map = fsModule.fetchTokensFromBranch('o/r',
      { tag: 'factory-data', tokensAsset: 'factoryB-tokens.json' },
      function (a) { seen.push(a.command); return { output: TOKENS }; });
    assert.ok(map && map['pr-31'], 'map still validates through tokensMapOf');
    assert.contains(seen[0], 'data/factoryB-tokens.json?ref=factory-data',
      'the override asset is probed');
    assert.ok(seen[0].indexOf('fa-tokens.json') === -1,
      'the fixed default must NOT be probed when tokensAsset is set');
  });

  test('tokensAsset absent → the fixed gh-781 default (back-compat)', function () {
    var seen = [];
    fsModule.fetchTokensFromBranch('o/r', { tag: 'factory-data' },
      function (a) { seen.push(a.command); return { output: TOKENS }; });
    assert.contains(seen[0], 'data/fa-tokens.json?ref=factory-data');
  });

  test('tokensAsset rides a tag override too (both knobs compose)', function () {
    var seen = [];
    fsModule.fetchTokensFromBranch('o/r',
      { tag: 'factory-data-eu', tokensAsset: 'factoryB-tokens.json' },
      function (a) { seen.push(a.command); return { output: TOKENS }; });
    assert.contains(seen[0], 'data/factoryB-tokens.json?ref=factory-data-eu');
  });
});

// ── rework — contentsOf (shared gh Contents CONTENT probe) ───────────────────
// One home for the probe/decode transport (gh-first whitelist + in-shell
// base64 decode): fetchPreviousState, fetchTokensFromBranch and the
// updateHistory index read all ride it.

suite('factoryState — contentsOf (shared transport)', function () {
  test('returns the decoded content from one gh Contents probe', function () {
    var seen = [];
    var raw = fsModule.contentsOf('o/r', 'data/fa-tokens.json',
      { tag: 'factory-data' }, function (a) {
        seen.push(a.command);
        return { output: '{"pr-31":[]}' };
      });
    assert.equal(raw, '{"pr-31":[]}');
    assert.equal(seen.length, 1, 'one probe per call');
    assert.equal(seen[0],
      'gh api repos/o/r/contents/data/fa-tokens.json?ref=factory-data --jq .content | base64 -d',
      'gh-first whitelist + in-shell base64 decode, pinned in ONE place');
  });

  test('transport miss → null, never a throw (404 / rate limit)', function () {
    assert.equal(fsModule.contentsOf('o/r', 'data/x.json', {},
      function () { throw new Error('Not Found (HTTP 404)'); }), null, '404 → null');
    assert.equal(fsModule.contentsOf('o/r', 'data/x.json', {},
      function () { throw new Error('API rate limit exceeded'); }), null,
      'rate limit → null');
  });

  test('empty exec response → empty string (callers JSON.parse-guard it)', function () {
    assert.equal(fsModule.contentsOf('o/r', 'data/x.json', {},
      function () { return undefined; }), '');
  });
});

// ── rework — tokensLegCount (the 🪙 provenance line) ─────────────────────────

suite('factoryState — tokensLegCount', function () {
  test('sums rows across keys (pr + issue keys alike)', function () {
    assert.equal(fsModule.tokensLegCount({
      'pr-31': [{ leg: 'dev' }, { leg: 'review' }],
      'issue-7': [{ leg: 'rework' }]
    }), 3, '2 pr rows + 1 issue row');
  });

  test('null / empty / non-array values → 0 (decorative, never fatal)', function () {
    assert.equal(fsModule.tokensLegCount(null), 0);
    assert.equal(fsModule.tokensLegCount({}), 0);
    assert.equal(fsModule.tokensLegCount({ 'pr-31': 'not-an-array' }), 0);
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

  function withHistoryIndex(snaps, run) {
    var seen = [];
    var cfg = { repo: 'IstiN/flutter_agent_harness', asset: 'fa-state.json' };
    if (snaps.keep !== undefined) cfg.historyKeep = snaps.keep;
    fsModule.updateHistory(ST, cfg, function (a) {
      seen.push(a.command);
      if (a.command.indexOf('--jq .sha') > 0) return { output: 'feedface\n' };
      if (a.command.indexOf('--jq .content') > 0) {
        return { output: JSON.stringify(snaps.old) };
      }
      return undefined;
    });
    var idxPut = seen[seen.length - 1];
    var urls = [];
    idxPut.replace(/"url":"([^"]+)"/g, function (_, u) { urls.push(u); return u; });
    run(seen, idxPut, urls);
  }

  test('updateHistory: existing index — append, carry sha, trim to keep', function () {
    var KEEP = 3;
    var old = { schema: 1, repo: 'IstiN/flutter_agent_harness',
      asset: 'fa-state.json',
      snapshots: [
        { ts: 't3', tick: 'a3', stamp: 's3', url: 'u3' },
        { ts: 't2', tick: 'a2', stamp: 's2', url: 'u2' },
        { ts: 't1', tick: 'a1', stamp: 's1', url: 'u1' }
      ] };
    withHistoryIndex({ keep: KEEP, old: old }, function (seen, idxPut, urls) {
      assert.ok(idxPut.indexOf("-f sha='feedface'") > 0, 'update carries probed sha');
      assert.ok(idxPut.match(/"snapshots":\[(.*)\]/), 'index payload present');
      assert.equal(urls.length, KEEP, 'trimmed to historyKeep');
      assert.ok(urls[0].indexOf('fa-state-20260923-2235.json') > 0,
                'newest snapshot first');
    });
  });

  test('gh-1150 AC2: updateHistory default HISTORY_KEEP is 500 when cfg.historyKeep is omitted and streams via stdin', function () {
    assert.equal(fsModule.HISTORY_KEEP, 500, 'HISTORY_KEEP is 500');
    var snaps = [];
    for (var i = 0; i < 505; i++) {
      snaps.push({
        ts: '2026-10-21T20:41:09.805Z',
        tick: '2026-10-21T20:41:09.805Z',
        stamp: '20261021-2041',
        url: 'https://raw.githubusercontent.com/IstiN/flutter_agent_harness/factory-data/data/fa-state-s' + i + '.json'
      });
    }
    var old = {
      schema: 1, repo: 'IstiN/flutter_agent_harness',
      asset: 'fa-state.json', snapshots: snaps
    };
    withHistoryIndex({ old: old }, function (seen, idxPut, urls) {
      assert.equal(urls.length, 500, 'trimmed to default HISTORY_KEEP (500)');
      assert.ok(urls[0].indexOf('fa-state-20260923-2235.json') > 0, 'newest snapshot first');
      assert.ok(urls[499].indexOf('fa-state-s498.json') > 0, '500th entry is s498 (1 new + 499 carried)');
      assert.ok(idxPut.indexOf('-F content=@-') > 0 && idxPut.indexOf('<<__FA_EOF__') > 0,
        'REG: history PUT streams base64 over stdin heredoc so 500-entry index never hits argv MAX_ARG_STRLEN');
      var argvHead = idxPut.split('<<__FA_EOF__')[0];
      assert.ok(argvHead.length < 1024, 'gh api argv stays tiny (<1KB) regardless of 500-entry index size');
    });
  });
});

// ── gh-806: reworkInFlight — the rework in-flight latch rides the snapshot ──

suite('factoryState — reworkInFlight (gh-806 latch persistence)', function () {
  var HEAD = '23dacd10deadbeefcafe0123456789abcdef0123';
  var T0 = '2026-10-09T04:01:00.000Z';
  var T0_MS = Date.parse(T0);
  var LEG_WF = '.github/workflows/ai-teammate.yml';

  function baseInput(extra) {
    var input = {
      repoInfo: { owner: 'acme', repo: 'factory' },
      prs: [], mergedPrs: [], issues: [], runs: [],
      now: T0
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { input[k] = extra[k]; });
    }
    return input;
  }

  test('snapshot carries reworkInFlight (stable shape, empty by default)', function () {
    var state = fsModule.buildFactoryState(baseInput({}));
    assert.deepEqual(state.reworkInFlight, {});
  });

  test('prev snapshot latch is carried forward', function () {
    var prev = { lanes: {}, reworkInFlight: { ['pr-1428@' + HEAD]: { head: HEAD, at: T0 } } };
    var state = fsModule.buildFactoryState(baseInput({ prev: prev }));
    assert.ok(state.reworkInFlight['pr-1428@' + HEAD], 'latch survives the tick');
    assert.equal(state.reworkInFlight['pr-1428@' + HEAD].head, HEAD);
  });

  test('this tick\u2019s live map merges over the prev snapshot (arm mid-tick persists)', function () {
    var HEAD2 = 'bbbbbbbbdeadbeefcafe0123456789abcdef0123';
    var prev = { lanes: {}, reworkInFlight: { ['pr-1428@' + HEAD]: { head: HEAD, at: T0 } } };
    var state = fsModule.buildFactoryState(baseInput({
      prev: prev,
      reworkInFlight: { ['pr-1429@' + HEAD2]: { head: HEAD2, at: T0 } }
    }));
    assert.ok(state.reworkInFlight['pr-1428@' + HEAD], 'prev entry kept');
    assert.ok(state.reworkInFlight['pr-1429@' + HEAD2], 'live entry merged');
  });

  test('stale latch (older than 45 min, no active run) is pruned (AC3)', function () {
    var prev = { lanes: {}, reworkInFlight: { ['pr-1428@' + HEAD]: { head: HEAD, at: T0 } } };
    var state = fsModule.buildFactoryState(baseInput({
      prev: prev,
      now: '2026-10-09T05:00:00.000Z'
    }));
    assert.deepEqual(state.reworkInFlight, {}, 'stale latch self-heals');
  });

  test('latch past the stale window with an ACTIVE leg run survives', function () {
    var prev = { lanes: {}, reworkInFlight: { ['pr-1428@' + HEAD]: { head: HEAD, at: T0 } } };
    var state = fsModule.buildFactoryState(baseInput({
      prev: prev,
      now: '2026-10-09T05:00:00.000Z',
      runs: [{ status: 'in_progress', head_sha: HEAD, path: LEG_WF }]
    }));
    assert.ok(state.reworkInFlight['pr-1428@' + HEAD],
      'a really-flying leg must not invite a duplicate');
  });

  test('latch whose leg run CONCLUDED after the arm is pruned (AC2)', function () {
    var prev = { lanes: {}, reworkInFlight: { ['pr-1428@' + HEAD]: { head: HEAD, at: T0 } } };
    var state = fsModule.buildFactoryState(baseInput({
      prev: prev,
      runs: [{
        status: 'completed', conclusion: 'failure',
        head_sha: HEAD, path: LEG_WF,
        updated_at: '2026-10-09T04:20:00.000Z'
      }]
    }));
    assert.deepEqual(state.reworkInFlight, {}, 'terminated leg clears the latch');
  });

  test('a concluded run that PREDATES the arm does not clear the latch', function () {
    var prev = { lanes: {}, reworkInFlight: { ['pr-1428@' + HEAD]: { head: HEAD, at: T0 } } };
    var state = fsModule.buildFactoryState(baseInput({
      prev: prev,
      runs: [{
        status: 'completed', conclusion: 'success',
        head_sha: HEAD, path: LEG_WF,
        updated_at: '2026-10-09T03:00:00.000Z'
      }]
    }));
    assert.ok(state.reworkInFlight['pr-1428@' + HEAD], 'old run is not this leg');
  });

  test('garbage latch entries from snapshot drift are dropped (never wedge the armer)', function () {
    var prev = {
      lanes: {},
      reworkInFlight: {
        'bogus': { head: HEAD, at: T0 },
        ['pr-1428@' + HEAD]: { head: HEAD }
      }
    };
    var state = fsModule.buildFactoryState(baseInput({ prev: prev }));
    assert.deepEqual(state.reworkInFlight, {});
  });
});

// ── gh-998: zombiesSwept — the leak-rate counter rides the snapshot (I5) ────
// Live fa #1563 (head f3d58647): a leaked in_progress placeholder pinned the
// gate 40+ min with 58 green siblings. The sweper heals such zombies
// (js/common/checkRunZombies.js + js/smAgent.js); the counter must be
// visible in the factory-state payload so operators see the leak rate, not
// just the fix.

suite('factoryState — zombiesSwept (gh-998 leak-rate metric)', function () {
  var T0 = '2026-10-17T19:00:00.000Z';

  function baseInput(extra) {
    var input = {
      repoInfo: { owner: 'acme', repo: 'factory' },
      prs: [], mergedPrs: [], issues: [], runs: [],
      now: T0
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { input[k] = extra[k]; });
    }
    return input;
  }

  test('stable shape: 0 when the sweeper never fired and no prev carries', function () {
    var state = fsModule.buildFactoryState(baseInput({}));
    assert.equal(state.zombiesSwept, 0);
  });

  test('this tick\u2019s sweep count lands in the payload', function () {
    var state = fsModule.buildFactoryState(baseInput({ zombiesSwept: 2 }));
    assert.equal(state.zombiesSwept, 2);
  });

  test('the counter is CUMULATIVE across snapshots (prev + this tick)', function () {
    var prev = { lanes: {}, zombiesSwept: 5 };
    var state = fsModule.buildFactoryState(baseInput({ prev: prev, zombiesSwept: 3 }));
    assert.equal(state.zombiesSwept, 8, 'operators see the leak rate, not just the last tick');
  });

  test('a malformed carry restarts at this tick\u2019s count (no NaN poisoning)', function () {
    var prev = { lanes: {}, zombiesSwept: 'bogus' };
    var state = fsModule.buildFactoryState(baseInput({ prev: prev, zombiesSwept: 1 }));
    assert.equal(state.zombiesSwept, 1);
    var prevNaN = { lanes: {}, zombiesSwept: NaN };
    var stateNaN = fsModule.buildFactoryState(baseInput({ prev: prevNaN }));
    assert.equal(stateNaN.zombiesSwept, 0);
  });

  test('a malformed THIS-tick count counts as 0 (the saneCount guard, both call sites)', function () {
    var prev = { lanes: {}, zombiesSwept: 4 };
    var stateStr = fsModule.buildFactoryState(baseInput({ prev: prev, zombiesSwept: 'bogus' }));
    assert.equal(stateStr.zombiesSwept, 4, 'string tick count contributes 0, carry survives');
    var stateNaN = fsModule.buildFactoryState(baseInput({ prev: prev, zombiesSwept: NaN }));
    assert.equal(stateNaN.zombiesSwept, 4, 'NaN tick count contributes 0, carry survives');
  });

  // Review-thread recipe (IstiN, PR #1012 thread PRRT_kwDORYAuYs6to_5g): pin
  // the exact prev shapes so every new call-site line in buildFactoryState
  // executes under each shape, and assert on the payload field name the
  // snapshot consumers read (`zombiesSwept` in the built state JSON).
  test('recipe shapes: null/missing prev, cumulative carry, combined malformed — payload field pinned', function () {
    // 1. prev = null + zombiesSwept absent → 0 (stable shape, no NaN)
    var stateNull = fsModule.buildFactoryState(baseInput({ prev: null }));
    assert.equal(stateNull.zombiesSwept, 0);
    var stateNoPrev = fsModule.buildFactoryState(baseInput({}));
    assert.equal(stateNoPrev.zombiesSwept, 0);
    // 2. prev = { zombiesSwept: 3 } + zombiesSwept: 2 → 5 (cumulative carry)
    var stateCarry = fsModule.buildFactoryState(
      baseInput({ prev: { lanes: {}, zombiesSwept: 3 }, zombiesSwept: 2 }));
    assert.equal(stateCarry.zombiesSwept, 5, 'cumulative carry: 3 + 2');
    // 3. malformed carry on BOTH sides (prev.zombiesSwept = 'x', zombiesSwept = NaN) → 0, not NaN
    var stateBad = fsModule.buildFactoryState(
      baseInput({ prev: { lanes: {}, zombiesSwept: 'x' }, zombiesSwept: NaN }));
    assert.equal(stateBad.zombiesSwept, 0, 'double-malformed restarts at 0, never NaN');
  });
});

// ── gh-816 — merge-lane citation integrity ───────────────────────────────────
// The lane cite is the discharge evidence watchers and audits read. Two
// integrity rules (gh-816):
//   1. REAL validation runs (repo CI via push/pull_request/schedule events +
//      the machine's own validation-workflow dispatch) are cited freshest
//      first; SM side-run legs (review/develop/rework dispatches of other
//      workflows) are auxiliary evidence, never the discharge cite.
//   2. The merged_recent lane PERSISTS the checks record at merge time
//      (run id + name + sha + conclusion) instead of dropping it.
suite('factoryState — merge-lane citation integrity (gh-816)', function () {
  var NOW = '2026-10-09T12:30:00Z';
  var HEAD = '0096ba5c9212a7bb6df03471dbe54d7ab32ff4b2';

  // Real validation runs on the merged head (the #1437 timeline): full CI
  // (push event) and the dynamic PR-validation dispatch (the deployment's
  // validation workflow) — both green pre-merge.
  function realRun(over) {
    return Object.assign({
      id: 37925202998, name: 'CI', event: 'push',
      path: '.github/workflows/ci.yml', head_sha: HEAD,
      status: 'completed', conclusion: 'success',
      created_at: '2026-10-09T11:50:00Z', updated_at: '2026-10-09T11:56:44Z',
      html_url: 'http://run/ci'
    }, over || {});
  }
  function dynRun(over) {
    return realRun(Object.assign({
      id: 37921773706, name: 'PR acme/factory#1437', event: 'workflow_dispatch',
      path: '.github/workflows/quality.yml',
      created_at: '2026-10-09T11:05:00Z', updated_at: '2026-10-09T11:12:19Z',
      html_url: 'http://run/dyn'
    }, over || {}));
  }
  // SM side-run leg: a review leg dispatched on the SAME head — newer than
  // both real runs, which is exactly how it stole the cite (gh-816).
  function legRun(over) {
    return realRun(Object.assign({
      id: 37923501714, name: 'review (SM)', event: 'workflow_dispatch',
      path: '.github/workflows/ai-teammate.yml',
      created_at: '2026-10-09T11:20:00Z', updated_at: '2026-10-09T11:24:00Z',
      html_url: 'http://run/review'
    }, over || {}));
  }
  function openPr(sha) {
    return { number: 1437, title: 'feat: t', labels: [],
      head: { ref: 'ai/1437', sha: sha || HEAD }, user: { login: 'bot' },
      created_at: '2026-10-09T10:00:00Z' };
  }
  function mergedPr(sha) {
    return { number: 1437, title: 'feat: t', labels: [],
      head: { ref: 'ai/1437', sha: sha || HEAD }, user: { login: 'bot' },
      created_at: '2026-10-09T10:00:00Z', merged_at: '2026-10-09T11:57:03Z' };
  }
  function build(extra) {
    var input = Object.assign({
      repoInfo: { owner: 'acme', repo: 'factory' },
      prs: [openPr()], mergedPrs: [], issues: [],
      runs: [legRun(), dynRun(), realRun()],
      now: NOW
    }, extra || {});
    return fsModule.buildFactoryState(input);
  }

  // ── 1. lane writer preference: real runs beat fresher SM side-runs ────────

  test('cite prefers the real validation run over a fresher SM side-run leg (gh-816 repro)', function () {
    var st = build({ prs: [openPr()] });
    var card = st.lanes.pr_created[0];
    assert.ok(card.checks, 'a real green run exists → a discharge cite exists');
    // rework thread 2: among real runs the machine's own validation
    // workflow (quality.yml path match) outranks every other real run —
    // score, not recency, picks between two honest evidences.
    assert.equal(card.checks.runId, 37921773706,
      'the validation-workflow dispatch (quality.yml) is the cite — ' +
      'score 2 outranks the plain-real CI push run');
    assert.equal(card.checks.name, 'PR acme/factory#1437');
    assert.equal(card.checks.verdict, 'success');
    assert.notEqual(card.checks.runId, 37923501714,
      'the review (SM) side-run must never be the discharge cite');
  });

  test('an SM side-run alone is never a discharge cite (checks stay null)', function () {
    var st = build({ runs: [legRun()] });
    var card = st.lanes.pr_created[0];
    assert.equal(card.checks, null,
      'no real validation run on the head → no cite (review leg is not validation)');
    assert.equal(st.lanes.pr_validation.length, 0,
      'a review leg in flight must not read as validation in flight');
  });

  test('the side-run leg rides the cite as auxiliary evidence (never the cite itself)', function () {
    var st = build({ prs: [openPr()] });
    var aux = st.lanes.pr_created[0].checks.auxiliary;
    assert.ok(aux, 'the leg is preserved as auxiliary evidence');
    assert.equal(aux.runId, 37923501714);
    assert.equal(aux.name, 'review (SM)');
    // rework thread 4: auxiliary speaks the cite's vocabulary — verdict
    // (status, or conclusion when terminal) — never a third name.
    assert.equal(aux.verdict, 'success');
    assert.equal(aux.conclusion, 'success');
    assert.equal(aux.at, '2026-10-09T11:20:00Z');
    assert.equal(aux.url, 'http://run/review');
  });

  test('freshest run wins within a score tier (same score → recency decides)', function () {
    var st = build({ runs: [
      realRun(),
      realRun({ id: 37925202997, updated_at: '2026-10-09T11:40:00Z',
        html_url: 'http://run/ci-older' })
    ] });   // same workflow, same event, same tier → freshest decides
    assert.equal(st.lanes.pr_created[0].checks.runId, 37925202998,
      'freshest first within a tier');
  });

  test('within a tier the freshest terminal decides even when it is red (truth wins)', function () {
    var st = build({ runs: [
      realRun({ conclusion: 'failure', updated_at: '2026-10-09T12:00:00Z',
        html_url: 'http://run/ci-red' }),
      realRun({ id: 37925202997, updated_at: '2026-10-09T11:50:00Z',
        html_url: 'http://run/ci-green' })
    ] });
    var checks = st.lanes.pr_created[0].checks;
    assert.equal(checks.verdict, 'failure');
    assert.equal(checks.runId, 37925202998, 'red real beats older green real');
  });

  // ── rework thread 2 (IMPORTANT): score-first citing among real runs ──────
  // The runs list is repo-wide (every workflow), so an unrelated repo
  // workflow (labeler/docs/lint on push/pull_request/schedule) is fail-open
  // real too — but it must only cite when nothing better exists: the
  // machine's own validation workflow (ciWorkflow path match, score 2)
  // outranks every bare real run (score 1), however fresh.

  function noiseRun(over) {   // an unrelated repo workflow, non-dispatch
    return realRun(Object.assign({
      id: 424242, name: 'labeler', event: 'pull_request',
      path: '.github/workflows/labeler.yml',
      created_at: '2026-10-09T12:00:00Z', updated_at: '2026-10-09T12:10:00Z',
      html_url: 'http://run/labeler'
    }, over || {}));
  }

  test('the validation workflow outranks a FRESHER unrelated repo workflow (score beats recency)', function () {
    var st = build({ runs: [noiseRun(), dynRun()] });
    assert.equal(st.lanes.pr_created[0].checks.runId, 37921773706,
      'labeler completed 20s later but the quality.yml dispatch is the cite');
    assert.equal(st.lanes.pr_created[0].checks.name, 'PR acme/factory#1437');
  });

  test('an in-flight validation dispatch outranks a green unrelated repo workflow (score tier first)', function () {
    var st = build({ runs: [
      noiseRun(),   // green, terminal, fresher
      dynRun({ status: 'in_progress', conclusion: null,
        updated_at: '2026-10-09T12:15:00Z', html_url: 'http://run/dyn-live' })
    ] });
    var card = st.lanes.pr_validation[0];
    assert.ok(card, 'the card sits in pr_validation — real validation in flight');
    assert.equal(card.checks.runId, 37921773706,
      'the machine\'s validation IN FLIGHT is the cite — a green unrelated ' +
      'workflow must not front for it');
    assert.equal(card.checks.verdict, 'in_progress',
      'the board reads the honest in-flight state');
    assert.deepEqual(st.lanes.pr_validation.map(function (c) {
      return c.pr;
    }), [1437], 'pr_validation lights because REAL validation is in flight');
  });

  test('an unrelated repo workflow still cites when nothing better exists (documented fail-open residual)', function () {
    var st = build({ runs: [noiseRun()] });
    assert.equal(st.lanes.pr_created[0].checks.runId, 424242,
      'fail-open stays: a non-dispatch run is assumed real when it is all ' +
      'the head has (dynamic per-PR validation workflows have arbitrary ' +
      'paths — the residual mis-cite risk is owned in the classifier)');
  });

  test('cancelled real runs are never the cite (gh-191 semantics hold for real runs)', function () {
    var st = build({ runs: [realRun({ conclusion: 'cancelled',
        updated_at: '2026-10-09T12:10:00Z' }), dynRun()] });
    assert.equal(st.lanes.pr_created[0].checks.runId, 37921773706,
      'newest terminal NON-cancelled real run decides');
  });

  test('an active real CI run is a valid in-flight cite (pr_validation lane)', function () {
    var st = build({ runs: [realRun({ status: 'in_progress',
        conclusion: null })] });
    assert.deepEqual(st.lanes.pr_validation.map(function (c) { return c.pr; }), [1437]);
    assert.equal(st.lanes.pr_validation[0].checks.verdict, 'in_progress');
    assert.equal(st.lanes.pr_validation[0].checks.runId, 37925202998);
  });

  test('dispatched runs without a path fail open as real (payload shape drift)', function () {
    var st = build({ runs: [{ event: 'workflow_dispatch', head_sha: HEAD,
      status: 'completed', conclusion: 'success', id: 42, name: 'quality',
      created_at: '2026-10-09T11:00:00Z', updated_at: '2026-10-09T11:05:00Z',
      html_url: 'http://run/42' }] });
    assert.equal(st.lanes.pr_created[0].checks.runId, 42,
      'a path-less dispatch is assumed real — never silently uncitable');
  });

  test('ciWorkflow knob: the named validation workflow dispatch is real, other dispatches are legs', function () {
    var st = build({
      ciWorkflow: 'mycheck.yml',
      runs: [dynRun({ path: '.github/workflows/mycheck.yml' }), legRun()]
    });
    assert.equal(st.lanes.pr_created[0].checks.runId, 37921773706,
      'the machine\'s own validation dispatch is a real cite');
  });

  // ── 2. merged_recent persists the checks record (gh-816 ask 2) ────────────

  test('merged card persists the real checks record at merge time (run id + name + sha + conclusion)', function () {
    var st = build({ prs: [], mergedPrs: [mergedPr()] });
    var card = st.lanes.merged_recent[0];
    assert.ok(card.checks, 'checks record must NOT be dropped at the merge transition');
    assert.equal(card.checks.runId, 37921773706,
      'the score-2 validation dispatch is the persisted cite');
    assert.equal(card.checks.name, 'PR acme/factory#1437');
    assert.equal(card.checks.sha, HEAD);
    assert.equal(card.checks.conclusion, 'success');
    assert.equal(card.checks.verdict, 'success');
  });

  test('merged card falls back to the carried record when the runs list rotated past the head', function () {
    var prev = { lanes: { validating: [{ pr: 1437, labels: ['pr_approved', 'ai_validating'],
      checks: { verdict: 'success', runId: 99, name: 'CI', sha: HEAD,
        conclusion: 'success', at: '2026-10-09T11:56:44Z',
        url: 'http://run/carried' } }] } };
    var st = build({ prs: [], mergedPrs: [mergedPr()], runs: [], prev: prev });
    var checks = st.lanes.merged_recent[0].checks;
    assert.ok(checks, 'carried record survives the merge');
    assert.equal(checks.runId, 99);
    assert.equal(checks.conclusion, 'success');
    assert.equal(checks.carried, undefined,
      'a TERMINAL carried record is a resolved verdict — no marker needed');
  });

  // ── rework thread 3 (suggestion): carried ACTIVE records must not read live ──
  // If the head's runs rotate out of the repo-wide window between the last
  // open-life snapshot and the merge tick, the carried record is all the
  // audit trail gets — an in-flight copy would pin "validation in flight"
  // on the merged card for the whole 24h window. Carry it, but marked.

  test('a carried in-flight record rides the merged card marked carried (never reads live)', function () {
    var prev = { lanes: { validating: [{ pr: 1437, labels: ['pr_approved', 'ai_validating'],
      checks: { verdict: 'in_progress', runId: 99, name: 'CI', sha: HEAD,
        conclusion: null, at: '2026-10-09T11:50:00Z',
        url: 'http://run/stale' } }] } };
    var st = build({ prs: [], mergedPrs: [mergedPr()], runs: [], prev: prev });
    var checks = st.lanes.merged_recent[0].checks;
    assert.ok(checks, 'the audit record still rides — never dropped');
    assert.equal(checks.runId, 99);
    assert.equal(checks.conclusion, null);
    assert.equal(checks.carried, true,
      'an ACTIVE carried record is marked unverified — the board can tell ' +
      'it apart from a live verdict');
  });

  test('merged card prefers a fresh real cite over the stale carried record', function () {
    var prev = { lanes: { validating: [{ pr: 1437, labels: ['pr_approved', 'ai_validating'],
      checks: { verdict: 'in_progress', runId: 99, name: 'CI', sha: HEAD,
        conclusion: null, at: '2026-10-09T11:50:00Z', url: 'http://run/stale' } }] } };
    var st = build({ prs: [], mergedPrs: [mergedPr()], prev: prev });
    assert.equal(st.lanes.merged_recent[0].checks.runId, 37921773706,
      'the runs list still names the head → the exact discharge run is resolved');
  });

  test('merged card with neither fresh nor carried evidence stays checks-null (no invention)', function () {
    var st = build({ prs: [], mergedPrs: [mergedPr()], runs: [legRun()] });
    assert.equal(st.lanes.merged_recent[0].checks, null,
      'a side-run alone still never becomes the discharge cite');
  });

  test('merged card persists the checks record across the whole 24h window (re-derived ticks)', function () {
    var prev = { lanes: { validating: [{ pr: 1437, labels: ['pr_approved', 'ai_validating'],
      checks: { verdict: 'success', runId: 99, name: 'CI', sha: HEAD,
        conclusion: 'success', at: '2026-10-09T11:56:44Z', url: 'http://run/99' } }] } };
    var st = null;
    for (var i = 0; i < 5; i++) {   // ticks 2..N: prev is the MERGED card
      st = build({ prs: [], mergedPrs: [mergedPr()], runs: [],
        prev: st ? { lanes: { merged_recent: [st.lanes.merged_recent[0]] } } : prev });
    }
    assert.equal(st.lanes.merged_recent[0].checks.runId, 99,
      'the record rides the merged card tick-over-tick — never dropped again');
  });
});

// ── gh-825 — model passthrough (normalizeTokens keeps `model`) ───────────────
// awf 233263e emits "model":"<id>" in token rows (empty until fa#1460 ships
// the ledger field). normalizeTokens previously dropped the field silently —
// unknown keys were tolerated, never carried. The board's model column and
// the pricing engine both read row.model, so the passthrough is explicit now.

suite('factoryState — model passthrough in normalizeTokens (gh-825)', function () {
  function norm(rows) {
    var map = fsModule.normalizeTokens({ 'pr-31': rows });
    return map['pr-31'];
  }

  test('a row\'s model string rides the normalized row', function () {
    var rows = norm([{ leg: 'dev', at: 't', prompt: 1, completion: 2,
      model: 'claude-sonnet-4-5' }]);
    assert.equal(rows[0].model, 'claude-sonnet-4-5');
  });

  test('absent / null / empty model normalize to null (pre-fa#1460 reality)', function () {
    var rows = norm([
      { leg: 'a', at: 't', prompt: 1, completion: 1 },
      { leg: 'b', at: 't', prompt: 1, completion: 1, model: null },
      { leg: 'c', at: 't', prompt: 1, completion: 1, model: '' }
    ]);
    assert.equal(rows[0].model, null, 'absent → null');
    assert.equal(rows[1].model, null, 'null → null');
    assert.equal(rows[2].model, null, 'empty string (upstream "model":""") → null');
  });

  test('non-string models coerce to string (defensive — ledger drift)', function () {
    var rows = norm([{ leg: 'a', at: 't', prompt: 1, completion: 1, model: 42 }]);
    assert.equal(rows[0].model, '42');
  });

  test('array-form input keeps model too (the local-file shape)', function () {
    var map = fsModule.normalizeTokens([
      { pr: 34, leg: 'rework', at: 't', prompt: 1, completion: 2,
        model: 'gpt-5-codex' }
    ]);
    assert.equal(map['pr-34'][0].model, 'gpt-5-codex');
  });
});

// ── gh-825 rework (review thread 1, BLOCKING) — cacheRead passthrough ────────
// normTokenRow builds a FRESH row object; the model passthrough rode it but
// the cache count did not — so priceTokens always saw cacheRead === undefined
// and the cache term of the cost rule priced as 0 in the tick path (the
// rowCost unit tests passed raw rows, bypassing normalizeTokens). The cache
// count now normalizes alongside model.

suite('factoryState — cacheRead passthrough in normalizeTokens (gh-825 rework)', function () {
  function norm(rows) {
    var map = fsModule.normalizeTokens({ 'pr-31': rows });
    return map['pr-31'];
  }

  test('camelCase cacheRead rides the normalized row', function () {
    var rows = norm([{ leg: 'dev', at: 't', prompt: 1, completion: 2,
      cacheRead: 500000 }]);
    assert.equal(rows[0].cacheRead, 500000);
  });

  test('snake_case cache_read rides as producer-drift tolerance', function () {
    var rows = norm([{ leg: 'dev', at: 't', prompt: 1, completion: 2,
      cache_read: 700000 }]);
    assert.equal(rows[0].cacheRead, 700000, 'normalized to the camelCase key');
  });

  test('camelCase wins when both spellings ride one row', function () {
    var rows = norm([{ leg: 'dev', at: 't', prompt: 1, completion: 2,
      cacheRead: 500000, cache_read: 700000 }]);
    assert.equal(rows[0].cacheRead, 500000);
  });

  test('absent → null (honest unknown); a REPORTED zero stays 0', function () {
    var rows = norm([
      { leg: 'a', at: 't', prompt: 1, completion: 1 },
      { leg: 'b', at: 't', prompt: 1, completion: 1, cacheRead: 0 }
    ]);
    assert.equal(rows[0].cacheRead, null, 'absent → null');
    assert.equal(rows[1].cacheRead, 0, 'reported none ≠ not reported');
  });

  test('REVIEWER REPRO — the cost rule\'s cache term through the tick path: 1M cache reads @ $0.3/Mtok prices $0.30', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: '2026-10-03T13:10:00Z',
      prs: [{ number: 31, title: 't', labels: [],
        head: { ref: 'b', sha: 's' }, user: { login: 'bot' },
        created_at: '2026-10-03T06:00:00Z' }], runs: [],
      pricing: { rates: (function () {
          var r = Object.create(null);
          r['claude-sonnet-4-5'] = { input: 3, output: 15, cacheRead: 0.3 };
          return r;
        })(), defaultRates: null, models: 1 },
      tokens: { 'pr-31': [{ leg: 'dev', at: '2026-10-03T07:00:00Z',
        prompt: 1000000, completion: 1000000, cacheRead: 1000000,
        total: 3000000, model: 'claude-sonnet-4-5' }] }
    });
    var row = st.lanes.pr_created[0].tokens[0];
    assert.equal(row.cacheRead, 1000000, 'the cache count survived normalization');
    assert.equal(row.cost, 3 + 15 + 0.3,
      'in + out + cache — the term that priced as 0 before the fix');
  });

  test('snake_case cache_read prices through buildFactoryState too', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: '2026-10-03T13:10:00Z',
      prs: [{ number: 31, title: 't', labels: [],
        head: { ref: 'b', sha: 's' }, user: { login: 'bot' },
        created_at: '2026-10-03T06:00:00Z' }], runs: [],
      pricing: { rates: (function () {
          var r = Object.create(null);
          r['m'] = { input: 0, output: 0, cacheRead: 0.5 };
          return r;
        })(), defaultRates: null, models: 1 },
      tokens: { 'pr-31': [{ leg: 'dev', at: '2026-10-03T07:00:00Z',
        prompt: 0, completion: 0, cache_read: 2000000, total: 0,
        model: 'm' }] }
    });
    assert.equal(st.lanes.pr_created[0].tokens[0].cost, 1,
      '2M cache reads @ $0.5/Mtok');
  });
});

// ── gh-825 — the hardcoded model pricing config ──────────────────────────────
// ONE home: data/model-pricing.json at the repo root (hand-maintained, no
// secrets, no live APIs). Rates are USD per MILLION tokens; "default" prices
// models missing from the table (null = unknown models stay unpriced).

suite('factoryState — parseModelPricing (gh-825 schema)', function () {
  var TABLE = {
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
    'claude-haiku-4-5': { input: 1, output: 5 },
    'gpt-5-codex': { input: '1.25', output: '10' },   // numeric strings ride
    'default': null
  };

  test('a well-formed table parses to {rates, defaultRates, models}', function () {
    var p = fsModule.parseModelPricing(TABLE);
    assert.equal(p.models, 3);
    assert.equal(p.rates['claude-sonnet-4-5'].input, 3);
    assert.equal(p.rates['claude-sonnet-4-5'].cacheRead, 0.3);
    assert.equal(p.rates['claude-haiku-4-5'].cacheRead, 0, 'cacheRead optional → 0');
    assert.equal(p.rates['gpt-5-codex'].input, 1.25, 'numeric strings coerce');
    assert.equal(p.defaultRates, null, '"default": null — unknowns stay unpriced');
  });

  test('garbage shapes → null (bad JSON already failed the parse; shape garbage here)', function () {
    assert.equal(fsModule.parseModelPricing(null), null);
    assert.equal(fsModule.parseModelPricing('x'), null);
    assert.equal(fsModule.parseModelPricing(42), null);
    assert.equal(fsModule.parseModelPricing([]), null, 'array payload → null');
  });

  test('a table with NO usable rate entries → null (malformed config in disguise)', function () {
    assert.equal(fsModule.parseModelPricing({}), null,
      'empty table can never move Σ$ — report it as unusable');
    assert.equal(fsModule.parseModelPricing({ 'm': 'cheap' }), null,
      'entry that is not an object is not a rate');
    assert.equal(fsModule.parseModelPricing({ 'default': {} }), null,
      'a default without usable rates is still nothing');
  });

  test('invalid entries are skipped, valid ones survive (one bad model must not blank the table)', function () {
    var p = fsModule.parseModelPricing({
      'good': { input: 3, output: 15 },
      'no-output': { input: 3 },
      'negative': { input: -1, output: 15 },
      'nan': { input: 'abc', output: 15 },
      'array-entry': [3, 15],
      'null-entry': null
    });
    assert.equal(p.models, 1, 'only `good` survived');
    assert.ok(p.rates.good && !p.rates['no-output'] && !p.rates.negative &&
      !p.rates.nan && !p.rates['array-entry'] && !p.rates['null-entry']);
  });

  test('a bad cacheRead falls back to 0 (never poisons the whole entry)', function () {
    var p = fsModule.parseModelPricing({
      'm': { input: 3, output: 15, cacheRead: 'nope' }
    });
    assert.equal(p.models, 1);
    assert.equal(p.rates.m.cacheRead, 0);
  });

  test('a configured default prices unknown models (prototype-safe model buckets)', function () {
    var p = fsModule.parseModelPricing({
      'default': { input: 2, output: 8 }
    });
    assert.equal(p.models, 0);
    assert.deepEqual(p.defaultRates, { input: 2, output: 8, cacheRead: 0 });
  });

  test('__proto__ as a model id stays a plain bucket (rows are untrusted input)', function () {
    // JSON.parse — the REALISTIC untrusted path (a hand-edited or upstream
    // file) — creates '__proto__' as an OWN data key (an object literal
    // would set a prototype instead, which is why the table validates
    // through parseModelPricing, never on raw literals)
    var p = fsModule.parseModelPricing(
      JSON.parse('{"__proto__": {"input": 1, "output": 2}}'));
    assert.equal(p.models, 1, 'the model id became a data bucket');
    assert.equal(p.rates['__proto__'].output, 2);
  });
});

suite('factoryState — readModelPricing (absent is quiet, unusable warns)', function () {
  test('parses a committed table through the reader', function () {
    var res = fsModule.readModelPricing('data/model-pricing.json', function () {
      return '{"claude-sonnet-4-5":{"input":3,"output":15,"cacheRead":0.3},"default":null}';
    });
    assert.ok(res && res.pricing, 'outcome object returned');
    assert.equal(res.pricing.rates['claude-sonnet-4-5'].output, 15);
  });

  test('absent file (null / empty / reader throws) → null — a QUIET miss, no warn', function () {
    assert.equal(fsModule.readModelPricing('x', function () { return null; }), null);
    assert.equal(fsModule.readModelPricing('x', function () { return ''; }), null);
    assert.equal(fsModule.readModelPricing('x', function () { return '   '; }), null);
    assert.equal(fsModule.readModelPricing('x', function () {
      throw new Error('ENOENT');
    }), null, 'unreadable file = absent — pricing is optional');
    assert.equal(fsModule.readModelPricing(null, function () { return '{}'; }), null);
  });

  test('present but bad JSON → {error} — the caller warns, the tick stays green', function () {
    var res = fsModule.readModelPricing('x', function () { return '{oops'; });
    assert.ok(res && res.error, 'error outcome returned (not a throw)');
    assert.ok(String(res.error).length > 0, 'the reason is loggable');
  });

  test('present but shape-garbage → {error} too', function () {
    assert.ok(fsModule.readModelPricing('x', function () { return '[]'; }).error);
    assert.ok(fsModule.readModelPricing('x', function () { return '"str"'; }).error);
    assert.ok(fsModule.readModelPricing('x', function () { return '{}'; }).error,
      'an empty table is unusable — same warn path');
  });
});

suite('factoryState — ratesFor + rowCost (the cost rule)', function () {
  var PRICING = {
    rates: (function () {
      var r = Object.create(null);
      r['claude-sonnet-4-5'] = { input: 3, output: 15, cacheRead: 0.3 };
      return r;
    })(),
    defaultRates: null,
    models: 1
  };

  test('ratesFor: known model → its rates', function () {
    assert.equal(fsModule.ratesFor(PRICING, 'claude-sonnet-4-5').input, 3);
  });

  test('ratesFor: absent model → null (tokens only, per AC2)', function () {
    assert.equal(fsModule.ratesFor(PRICING, null), null);
    assert.equal(fsModule.ratesFor(PRICING, ''), null);
    assert.equal(fsModule.ratesFor(null, 'claude-sonnet-4-5'), null);
  });

  test('ratesFor: unknown model with "default": null → null (cost omitted)', function () {
    assert.equal(fsModule.ratesFor(PRICING, 'gpt-9'), null);
  });

  test('ratesFor: unknown model with a configured default → the default rates', function () {
    var p = { rates: Object.create(null), defaultRates: { input: 2, output: 8, cacheRead: 0 } };
    assert.equal(fsModule.ratesFor(p, 'gpt-9').output, 8);
  });

  test('rowCost: cost = input/1e6*in + output/1e6*out + cacheRead/1e6*cache', function () {
    var rates = { input: 3, output: 15, cacheRead: 0.3 };
    var cost = fsModule.rowCost(
      { prompt: 1000000, completion: 1000000, cacheRead: 1000000 }, rates);
    assert.equal(cost, 3 + 15 + 0.3);
  });

  test('rowCost: cache_read snake_case falls back (producer-drift tolerance)', function () {
    var rates = { input: 3, output: 15, cacheRead: 0.3 };
    assert.equal(fsModule.rowCost({ prompt: 0, completion: 0, cache_read: 1000000 }, rates), 0.3);
  });

  test('rowCost: absent token counts price as 0 (row still costed on what it reports)', function () {
    var rates = { input: 3, output: 15, cacheRead: 0 };
    assert.equal(fsModule.rowCost({ prompt: 1000000 }, rates), 3,
      'completion/cache absent → only the prompt term');
  });

  test('rowCost: rounds to 1e-6 USD — float noise never reaches the board', function () {
    var rates = { input: 0.3, output: 0.7, cacheRead: 0 };
    var cost = fsModule.rowCost({ prompt: 48210, completion: 12980 }, rates);
    assert.equal(cost, Math.round((0.3 / 1e6 * 48210 + 0.7 / 1e6 * 12980) * 1e6) / 1e6);
    assert.ok(Math.abs(cost - (0.3 / 1e6 * 48210 + 0.7 / 1e6 * 12980)) < 1e-9);
  });

  test('rowCost: missing inputs → null (never a fake 0)', function () {
    assert.equal(fsModule.rowCost(null, { input: 1, output: 1 }), null);
    assert.equal(fsModule.rowCost({ prompt: 1 }, null), null);
  });
});

// ── gh-825 — pricing wired through buildFactoryState ─────────────────────────
// Rows gain model always and cost when priced; the snapshot gains the
// board header's global Σ$ rollup (state.costs) over the WHOLE tokens
// ledger — merged cards leave the board after 24h, their spend must
// still count, so the window is applied to row `at`, not to lanes.

suite('factoryState — priceTokens through buildFactoryState (gh-825)', function () {
  var NOW = '2026-10-03T13:10:00Z';
  var NOW_MS = Date.parse(NOW);
  var SONNET = { input: 3, output: 15, cacheRead: 0.3 };

  function pricing(over) {
    var rates = Object.create(null);
    rates['claude-sonnet-4-5'] = over || SONNET;
    return { rates: rates, defaultRates: null, models: 1 };
  }
  function pr(n) {
    return { number: n, title: 't' + n, labels: [],
      head: { ref: 'b' + n, sha: 'sha' + n }, user: { login: 'bot' },
      created_at: '2026-10-03T06:00:00Z' };
  }
  function cardFor(st, n) {
    return st.lanes.pr_created.filter(function (c) { return c.pr === n; })[0];
  }

  test('rows of a known-model card carry model + $cost; the card Σ$ is the rows\' sum', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: pricing(),
      tokens: { 'pr-31': [
        { leg: 'dev', at: '2026-10-03T07:00:00Z', prompt: 1000000,
          completion: 1000000, total: 2000000, model: 'claude-sonnet-4-5' },
        { leg: 'review', at: '2026-10-03T09:00:00Z', prompt: 500000,
          completion: 0, total: 500000, model: 'claude-sonnet-4-5' }
      ] }
    });
    var rows = cardFor(st, 31).tokens;
    assert.equal(rows[0].cost, 3 + 15, 'in/1e6*in + out/1e6*out per row');
    assert.equal(rows[1].cost, 1.5);
    assert.equal(st.costs.usd14d, 19.5, 'global Σ$ = both rows (board header)');
    assert.equal(st.costs.pricedLegs, 2);
    assert.equal(st.costs.windowDays, 14);
  });

  test('unknown model → model kept, cost omitted, tokens shown (AC2)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: pricing(),
      tokens: { 'pr-31': [
        { leg: 'dev', at: '2026-10-03T07:00:00Z', prompt: 1000,
          completion: 500, total: 1500, model: 'mystery-model' }
      ] }
    });
    var row = cardFor(st, 31).tokens[0];
    assert.equal(row.model, 'mystery-model', 'the model still renders');
    assert.notOk('cost' in row, 'no $ for an unknown model');
    assert.notOk('costs' in st, 'nothing priced → no Σ$ rollup at all');
  });

  test('absent model (pre-fa#1460 rows) → tokens only (AC2/L2 replay)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: pricing(),
      tokens: { 'pr-31': [
        { leg: 'dev', at: '2026-10-03T07:00:00Z', prompt: 1000,
          completion: 500, total: 1500 }
      ] }
    });
    assert.equal(cardFor(st, 31).tokens[0].model, null);
    assert.notOk('cost' in cardFor(st, 31).tokens[0]);
    assert.notOk('costs' in st);
  });

  test('multi-key ledger: Σ$ spans every card, the 14d window drops stale rows', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: pricing(),
      tokens: {
        'pr-31': [
          { leg: 'dev', at: '2026-10-03T07:00:00Z', prompt: 1000000,
            completion: 0, total: 1000000, model: 'claude-sonnet-4-5' },
          { leg: 'old', at: '2026-09-19T07:00:00Z', prompt: 1000000,
            completion: 0, total: 1000000, model: 'claude-sonnet-4-5' }   // >14d
        ],
        'pr-32': [
          { leg: 'dev', at: '2026-09-19T13:10:01Z', prompt: 1000000,
            completion: 0, total: 1000000, model: 'claude-sonnet-4-5' }   // just inside
        ]
      }
    });
    // 14d window: now − 14d = 2026-09-19T13:10:00Z, so 13:10:01Z is inside
    // (13d23h59m59s old) and 07:00:00Z is 6h past the cut — excluded.
    assert.equal(st.costs.usd14d, 6, 'two in-window rows (3+3), the 14d-old one dropped');
    assert.equal(st.costs.pricedLegs, 2);
    assert.equal(cardFor(st, 31).tokens[1].cost, 3,
      'per-row $ is the row\'s price regardless of the header window — ' +
      'only the Σ$ rollup applies the 14d cut');
  });

  test('undated rows still price per-row but the rollup stays unpublished (lying-$0.00 guard)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: pricing(),
      tokens: { 'pr-31': [
        { leg: 'dev', at: null, prompt: 1000000, completion: 0,
          total: 1000000, model: 'claude-sonnet-4-5' }
      ] }
    });
    assert.equal(cardFor(st, 31).tokens[0].cost, 3,
      'the row\'s $ is always data');
    assert.notOk('costs' in st,
      'gh-825 rework (review thread 2): nothing priced IN the window → ' +
      'no rollup — the pill never renders a lying Σ$0.00');
  });

  test('gh-825 rework: priced rows OUTSIDE the window price per-row but publish no rollup', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: pricing(),
      tokens: { 'pr-31': [
        { leg: 'old', at: '2026-09-01T07:00:00Z', prompt: 1000000,
          completion: 0, total: 1000000, model: 'claude-sonnet-4-5' }
      ] }
    });
    assert.equal(cardFor(st, 31).tokens[0].cost, 3);
    assert.notOk('costs' in st, 'priced-but-stale ledger → no lying $0.00');
  });

  test('gh-825 rework: a sub-cent in-window Σ$ stays unpublished (0.0049 → no rollup)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: pricing(),
      tokens: { 'pr-31': [
        { leg: 'a', at: '2026-10-03T07:00:00Z', prompt: 1000,
          completion: 0, total: 1000, model: 'claude-sonnet-4-5' },
        { leg: 'b', at: '2026-10-03T08:00:00Z', prompt: 634,
          completion: 0, total: 634, model: 'claude-sonnet-4-5' }
      ] }
    });
    // (1000+634)/1e6*3 = 0.004902 → rounds to $0.00
    assert.ok(cardFor(st, 31).tokens[0].cost > 0, 'rows are priced');
    assert.notOk('costs' in st,
      'the rollup would round to $0.00 — suppressed, per review thread 2');
  });

  test('no pricing input → rows unchanged, no costs key (additive schema)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [],
      tokens: { 'pr-31': [
        { leg: 'dev', at: '2026-10-03T07:00:00Z', prompt: 1000,
          completion: 500, total: 1500, model: 'claude-sonnet-4-5' }
      ] }
    });
    assert.notOk('cost' in cardFor(st, 31).tokens[0]);
    assert.notOk('costs' in st, 'pricing off/bad → the header rollup is absent');
  });

  test('issue-keyed rows price too (backlog twins share the ledger)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prs: [], runs: [],
      machineAuthor: 'ai-teammate',
      issues: [{ number: 33, title: 'i33', labels: [], user: { login: 'ba' },
        html_url: 'http://issues/33', assignees: [{ login: 'ai-teammate' }] }],
      pricing: pricing(),
      tokens: { 'issue-33': [{ leg: 'dev', at: '2026-10-03T07:00:00Z',
        prompt: 1000000, completion: 0, total: 1000000,
        model: 'claude-sonnet-4-5' }] }
    });
    assert.equal(st.backlog.in_dev[0].tokens[0].cost, 3);
    assert.equal(st.costs.usd14d, 3);
  });

  test('a default rate prices unknown models (catch-all table)', function () {
    var p = { rates: Object.create(null),
      defaultRates: { input: 2, output: 8, cacheRead: 0 }, models: 0 };
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: p,
      tokens: { 'pr-31': [{ leg: 'dev', at: '2026-10-03T07:00:00Z',
        prompt: 1000000, completion: 0, total: 1000000, model: 'gpt-9' }] }
    });
    assert.equal(cardFor(st, 31).tokens[0].cost, 2);
    assert.equal(st.costs.usd14d, 2);
  });

  test('Σ$ rounds to cents in the rollup (row costs keep 1e-6 precision)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], pricing: pricing(),
      tokens: { 'pr-31': [
        { leg: 'a', at: '2026-10-03T07:00:00Z', prompt: 48210, completion: 0,
          total: 48210, model: 'claude-sonnet-4-5' },
        { leg: 'b', at: '2026-10-03T08:00:00Z', prompt: 12980, completion: 0,
          total: 12980, model: 'claude-sonnet-4-5' }
      ] }
    });
    assert.equal(st.costs.usd14d, 0.18,
      '(48210+12980)/1e6*3 = 0.18357 → 0.18');
  });
});

suite('factoryState — normalizeMutexSnapshot (gh-1000 phantom-holder bookkeeping)', function () {
    test('absent/garbage blob → zeroed counters, empty alarms', function () {
        assert.deepEqual(fsModule.normalizeMutexSnapshot(null),
            { mutexSelfHeals: 0, phantomHolderTicks: 0, consecutivePhantomTicks: 0, alarms: [] });
        assert.deepEqual(fsModule.normalizeMutexSnapshot('junk'),
            { mutexSelfHeals: 0, phantomHolderTicks: 0, consecutivePhantomTicks: 0, alarms: [] });
    });

    test('numeric strings coerce; negatives and NaN drop to 0', function () {
        var out = fsModule.normalizeMutexSnapshot({
            mutexSelfHeals: '2', phantomHolderTicks: -1, consecutivePhantomTicks: 'x'
        });
        assert.equal(out.mutexSelfHeals, 2);
        assert.equal(out.phantomHolderTicks, 0);
        assert.equal(out.consecutivePhantomTicks, 0);
    });

    test('alarm tail caps at the last 5 entries', function () {
        var alarms = [1, 2, 3, 4, 5, 6, 7].map(function (i) { return { at: 't' + i }; });
        var out = fsModule.normalizeMutexSnapshot({ alarms: alarms });
        assert.equal(out.alarms.length, 5);
        assert.equal(out.alarms[0].at, 't3');
        assert.equal(out.alarms[4].at, 't7');
    });

    test('buildFactoryState carries state.mutex only when the SM published one', function () {
        var base = { repoInfo: { owner: 'o', repo: 'r' }, now: '2026-10-17T20:00:00Z',
            prs: [], runs: [] };
        var withMutex = fsModule.buildFactoryState(Object.assign({}, base, {
            mutex: { mutexSelfHeals: 1, phantomHolderTicks: 1, consecutivePhantomTicks: 1,
                alarms: [{ type: 'phantom_mutex_holder' }] }
        }));
        assert.equal(withMutex.mutex.mutexSelfHeals, 1);
        assert.equal(withMutex.mutex.alarms.length, 1);
        var without = fsModule.buildFactoryState(base);
        assert.equal(without.mutex, undefined, 'absent input.mutex → no mutex key');
    });
});

// ── gh-1036: characterization pin for the CRAP refactor ─────────────────────
// These tests pin the exact observable behaviour of buildFactoryState's paths
// before the pure-helper extraction (same snapshot shape, same card fields,
// same cite/carry semantics) so the refactor is provably behaviour-preserving.

suite('factoryState — gh-1036 characterization pin (buildFactoryState)', function () {
    var NOW = '2026-10-10T12:00:00Z';

    function build(opts) {
        return fsModule.buildFactoryState(Object.assign({
            repoInfo: { owner: 'acme', repo: 'widgets' },
            now: NOW, issues: [], prs: [], mergedPrs: [], runs: [], checkNames: []
        }, opts || {}));
    }

    test('snapshot top-level key order is pinned (schema 2 shape)', function () {
        assert.deepEqual(Object.keys(build()), [
            'schema', 'factory', 'repo', 'tick', 'checks', 'reworkInFlight',
            'zombiesSwept', 'lanes', 'counts', 'backlog', 'backlogCounts'
        ]);
        var rates = Object.create(null);
        rates['m'] = { input: 3, output: 15, cacheRead: 0.3 };
        var priced = build({ pricing: { rates: rates, defaultRates: null, models: 1 },
            tokens: { 'pr-1': [{ leg: 'dev', at: NOW, prompt: 1000000,
                completion: 0, total: 1000000, model: 'm' }] },
            prs: [{ number: 1, title: 't', labels: [], head: { ref: 'r', sha: 's1' },
                user: { login: 'b' }, created_at: '2026-10-10T11:00:00Z' }] });
        assert.deepEqual(Object.keys(priced).slice(-1), ['costs'],
            'costs still lands last, after backlogCounts');
    });

    test('merged PR with head: the live run cite rides the terminal card', function () {
        var st = build({
            runs: [{ event: 'workflow_dispatch',
                path: '.github/workflows/quality.yml',
                head_sha: 'm1', status: 'completed', conclusion: 'success',
                created_at: '2026-10-10T11:00:00Z', html_url: 'http://run/m1' }],
            mergedPrs: [{ number: 9, title: 'merged with head',
                head: { ref: 'ai/9', sha: 'm1' }, user: { login: 'bot' },
                labels: [], created_at: '2026-10-10T10:00:00Z',
                merged_at: '2026-10-10T11:30:00Z' }]
        });
        var card = st.lanes.merged_recent[0];
        assert.equal(card.head, 'm1');
        assert.equal(card.branch, 'ai/9');
        assert.equal(card.checks.verdict, 'success');
        assert.equal(card.checks.conclusion, 'success');
        assert.equal(card.checks.carried, undefined);
        assert.equal(card.mergedAt, '2026-10-10T11:30:00Z');
    });

    test('merged PR without head: unresolved carried record is marked carried, resolved rides as-is', function () {
        var prev = { lanes: { review: [
            { pr: 7, checks: { verdict: 'in_progress', conclusion: null } },
            { pr: 8, checks: { verdict: 'success', conclusion: 'success' } }
        ] } };
        var mergedPrs = [7, 8].map(function (n) {
            return { number: n, title: 'm', user: { login: 'bot' }, labels: [],
                created_at: '2026-10-10T09:00:00Z',
                merged_at: '2026-10-10T11:00:00Z' };
        });
        var st = build({ prev: prev, mergedPrs: mergedPrs });
        var byPr = {};
        st.lanes.merged_recent.forEach(function (c) { byPr[c.pr] = c; });
        assert.equal(byPr[7].checks.carried, true);
        assert.equal(byPr[7].checks.verdict, 'in_progress');
        assert.equal(byPr[8].checks.carried, undefined);
        assert.equal(byPr[8].checks.verdict, 'success');
    });

    test('dev_done + blocked issue stays only in the blocked backlog bucket', function () {
        var st = build({
            machineAuthor: 'ai-teammate',
            issues: [{ number: 31, title: 'done but blocked',
                labels: [{ name: 'ai_developed' }, { name: 'blocked' }],
                user: { login: 'u' }, assignees: [] }]
        });
        assert.deepEqual(st.lanes.development, []);
        assert.deepEqual(st.backlog.blocked.map(function (c) { return c.issue; }), [31]);
        assert.deepEqual(st.backlog.inbox, []);
    });

    test('devIssues fallback feeds the development lane', function () {
        var st = build({
            issues: null,
            devIssues: [{ number: 44, title: 'dev',
                labels: [{ name: 'agent:dev' }],
                user: { login: 'u' }, assignees: [] }]
        });
        assert.deepEqual(st.lanes.development.map(function (c) { return c.issue; }), [44]);
    });
});

// ── gh-1036: direct tests for the pure helpers extracted from ───────────────
// buildFactoryState — the same behaviour the pre-refactor closures had,
// pinned at the helper boundary (cite tiers, terminal/active picks, card
// identity, latch carry, state shell key order).

suite('factoryState — gh-1036 extracted helpers', function () {
    var NOW = '2026-10-10T12:00:00Z';

    test('headVerdict: tier-2 ciWorkflow path run outranks a fresher tier-1 real run', function () {
        var runs = [
            { event: 'push', path: '.github/workflows/labeler.yml', head_sha: 's1',
              status: 'completed', conclusion: 'success',
              created_at: '2026-10-10T11:59:00Z', updated_at: '2026-10-10T11:59:00Z',
              html_url: 'http://run/t1' },
            { event: 'workflow_dispatch', path: '.github/workflows/quality.yml',
              head_sha: 's1', status: 'completed', conclusion: 'failure',
              created_at: '2026-10-10T11:00:00Z', updated_at: '2026-10-10T11:00:00Z',
              html_url: 'http://run/t2' }
        ];
        var v = fsModule.headVerdict(runs, 'quality.yml', 's1');
        assert.equal(v.verdict, 'failure', 'the validation-workflow cite wins however stale');
        assert.equal(v.url, 'http://run/t2');
        assert.equal(v.runId, null, 'no run id on the payload → honest null');
    });

    test('headVerdict: active run cites only when nothing terminal; cancelled never decides', function () {
        var active = [{ event: 'push', head_sha: 's2', status: 'in_progress',
            created_at: '2026-10-10T11:00:00Z', html_url: 'http://run/a' }];
        var v = fsModule.headVerdict(active, 'quality.yml', 's2');
        assert.equal(v.verdict, 'in_progress');
        assert.equal(v.conclusion, null);
        var cancelled = [{ event: 'push', head_sha: 's3', status: 'completed',
            conclusion: 'cancelled', created_at: '2026-10-10T11:00:00Z',
            html_url: 'http://run/c' }];
        assert.equal(fsModule.headVerdict(cancelled, 'quality.yml', 's3'), null);
    });

    test('headVerdict: the freshest side-run leg rides as checks.auxiliary', function () {
        var runs = [
            { event: 'push', head_sha: 's4', status: 'completed', conclusion: 'success',
              created_at: '2026-10-10T10:00:00Z', html_url: 'http://run/cite' },
            { event: 'workflow_dispatch', path: '.github/workflows/ai-teammate.yml',
              head_sha: 's4', status: 'completed', conclusion: 'success',
              created_at: '2026-10-10T11:00:00Z', updated_at: '2026-10-10T11:00:00Z',
              html_url: 'http://run/leg', name: 'dev', id: 42 }
        ];
        var v = fsModule.headVerdict(runs, 'quality.yml', 's4');
        assert.equal(v.verdict, 'success');
        assert.equal(v.auxiliary.url, 'http://run/leg');
        assert.equal(v.auxiliary.runId, 42);
        assert.equal(v.auxiliary.name, 'dev');
    });

    test('runCite pins the audit record shape (gh-769 clocks always present)', function () {
        var cite = fsModule.runCite({ status: 'completed', conclusion: 'success',
            created_at: '2026-10-10T10:00:00Z', html_url: 'http://run/1',
            id: 7, name: 'Quality', head_sha: 'sha9',
            run_started_at: '2026-10-10T10:01:00Z', updated_at: '2026-10-10T10:05:00Z' });
        assert.deepEqual(cite, {
            verdict: 'success', at: '2026-10-10T10:00:00Z', url: 'http://run/1',
            runId: 7, name: 'Quality', sha: 'sha9', conclusion: 'success',
            runStartedAt: '2026-10-10T10:01:00Z', updatedAt: '2026-10-10T10:05:00Z'
        });
        var active = fsModule.runCite({ status: 'queued', created_at: 't', html_url: 'u' });
        assert.equal(active.verdict, 'queued');
        assert.equal(active.conclusion, null);
        assert.equal(active.runId, null);
        assert.equal(active.runStartedAt, null);
        assert.equal(active.updatedAt, null);
    });

    test('issueEntry: null/numberless/done issues do not board; blocked done stays', function () {
        var ctx = {
            pix: { issue: {}, issueState: {} }, tmap: {}, machineAuthor: null,
            hasPrev: false, now: NOW,
            lanes: { development: [] },
            backlog: { in_dev: [], queued: [], blocked: [], inbox: [] },
            issueHistory: {}
        };
        assert.equal(fsModule.issueEntry(null, ctx), undefined);
        assert.equal(fsModule.issueEntry({ title: 'no number' }, ctx), undefined);
        fsModule.issueEntry({ number: 1, title: 'done', labels: [{ name: 'ai_developed' }],
            user: { login: 'u' }, assignees: [] }, ctx);
        assert.equal(ctx.lanes.development.length, 0);
        assert.equal(ctx.backlog.inbox.length, 0, 'dev_done leaves the board');
        fsModule.issueEntry({ number: 2, title: 'done+blocked',
            labels: [{ name: 'ai_developed' }, { name: 'blocked' }],
            user: { login: 'u' }, assignees: [] }, ctx);
        assert.deepEqual(ctx.backlog.blocked.map(function (c) { return c.issue; }), [2]);
        fsModule.issueEntry({ number: 3, title: 'in dev', labels: [{ name: 'agent:dev' }],
            user: { login: 'u' }, assignees: [] }, ctx);
        assert.deepEqual(ctx.lanes.development.map(function (c) { return c.issue; }), [3]);
        assert.equal(ctx.lanes.development[0].history,
            ctx.issueHistory[3], 'lane card shares the history array');
    });

    test('devStartedAtCarry: prev stamp wins; first snapshot with prev stamps now; else undefined', function () {
        assert.equal(fsModule.devStartedAtCarry({ devStartedAt: 'T0' }, true, NOW), 'T0');
        assert.equal(fsModule.devStartedAtCarry(null, true, NOW), NOW);
        assert.equal(fsModule.devStartedAtCarry(null, false, NOW), undefined);
    });

    test('mergedChecksFor: live cite wins; unresolved carry is marked, terminal carry rides as-is', function () {
        var pr = { number: 5, head: { ref: 'b', sha: 's5' } };
        var live = fsModule.mergedChecksFor(pr, null, function () {
            return { verdict: 'success', conclusion: 'success' };
        });
        assert.equal(live.conclusion, 'success');
        assert.equal(live.carried, undefined);
        var unresolved = fsModule.mergedChecksFor({}, { checks: { verdict: 'in_progress' } },
            function () { return null; });
        assert.equal(unresolved.carried, true);
        assert.equal(unresolved.verdict, 'in_progress');
        var terminal = fsModule.mergedChecksFor({}, { checks: { verdict: 'success', conclusion: 'success' } },
            function () { return null; });
        assert.equal(terminal.carried, undefined);
        assert.equal(fsModule.mergedChecksFor({}, null, function () { return null; }), null);
    });

    test('mergeLatchCarry: live entries merge over prev; malformed latches drop', function () {
        var out = fsModule.mergeLatchCarry({ a: 1, b: 2 }, { b: 3, c: 4 });
        assert.deepEqual(out, { a: 1, b: 3, c: 4 });
        assert.deepEqual(fsModule.mergeLatchCarry('garbage', null), {});
    });

    test('buildState: header key order pinned, body appended after', function () {
        var st = fsModule.buildState({ repoInfo: { owner: 'o', repo: 'r' } }, NOW,
            { checks: [] });
        assert.deepEqual(Object.keys(st), ['schema', 'factory', 'repo', 'tick', 'checks']);
        assert.equal(st.factory, 'r');
        assert.equal(st.repo, 'o/r');
        var noRepo = fsModule.buildState({}, NOW, {});
        assert.equal(noRepo.factory, 'unknown');
        assert.equal(noRepo.repo, null);
        var dry = fsModule.buildState({ dryRun: true, processed: ['a'] }, NOW, {});
        assert.equal(dry.tick.dryRun, true);
        assert.deepEqual(dry.tick.processed, ['a']);
    });
});

// ── gh-1108 — REG guards: schema stays 2, degradation stays honest, ──────────
// merged cards keep their rows (the agents factory's token stream rides all
// of these; a regression here blanks the board's TOKENS · R/W line).

suite('factoryState — gh-1108 REG guards (agents token stream)', function () {
  var NOW = '2026-10-03T13:10:00Z';
  function pr(n) {
    return { number: n, title: 't' + n, labels: [],
      head: { ref: 'b' + n, sha: 'sha' + n }, user: { login: 'bot' },
      created_at: '2026-10-03T06:00:00Z' };
  }
  var TOKENS = { 'pr-31': [
    { leg: 'review', at: '2026-10-03T09:00:00Z',
      prompt: 2000, completion: 300, total: 2300, cacheRead: 1500, model: '' },
    { leg: 'rework', at: '2026-10-03T11:00:00Z',
      prompt: 3000, completion: 700, total: 3700, cacheRead: 2500, model: '' }
  ] };

  test('REG-schema-1: tokens present ⇒ schema stays 2 (additive-key contract)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], tokens: TOKENS
    });
    assert.equal(st.schema, 2, 'card.tokens rides schema 2 — no version bump');
    assert.equal(st.lanes.pr_created[0].tokens.length, 2);
  });

  test('AC1: card rows match the normTokenRow contract exactly (snake + camel)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prs: [pr(31)], runs: [],
      tokens: {
        'pr-31': TOKENS['pr-31'].concat([{
          leg: 'dev', at: '2026-10-03T12:00:00Z',
          prompt: 10, completion: 5, total: 15, cache_read: 900, model: '' }])
      }
    });
    var rows = st.lanes.pr_created[0].tokens;
    assert.equal(rows.length, 3);
    rows.forEach(function (row) {
      assert.deepEqual(Object.keys(row).sort(),
        ['at', 'cacheRead', 'completion', 'leg', 'model', 'prompt', 'total']);
    });
    assert.equal(rows[0].model, null, "model '' normalizes to null — honest unknown");
    assert.equal(rows[2].cacheRead, 900, 'snake cache_read survives end-to-end');
  });

  test('AC2: tokens source absent ⇒ token-less cards, no failure, no partial rows', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31), pr(32)], runs: [], tokens: null
    });
    assert.equal(st.schema, 2);
    assert.equal(st.lanes.pr_created.length, 2, 'the tick still publishes');
    st.lanes.pr_created.concat(st.lanes.merged_recent).forEach(function (card) {
      assert.notOk('tokens' in card, 'no partial token rows on ' + card.pr);
    });
    assert.equal(fsModule.tokensLegCount(null), 0, 'the 🪙 leg count stays 0');
  });

  test('AC2: a malformed tokens source degrades the same way', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW,
      prs: [pr(31)], runs: [], tokens: { 'pr-31': 'not-an-array' }
    });
    assert.notOk('tokens' in st.lanes.pr_created[0]);
  });

  test('AC6: merged_recent cards inside the 7d window keep their tokens rows', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prs: [], runs: [],
      tokens: TOKENS,
      mergedPrs: [{ number: 31, title: 'merged', labels: [],
        user: { login: 'bot' },
        created_at: '2026-10-03T06:00:00Z',
        merged_at: '2026-10-03T12:30:00Z' }]
    });
    var card = st.lanes.merged_recent[0];
    assert.ok(card, 'merged inside the window');
    assert.equal(card.tokens.length, 2, 'tmap keyed pr-31 attaches post-merge');
    assert.equal(card.tokens[1].leg, 'rework');
  });

  test('AC6: a merged PR outside the window keeps the join silent (no orphan rows)', function () {
    var st = fsModule.buildFactoryState({
      repoInfo: { owner: 'o', repo: 'r' }, now: NOW, prs: [], runs: [],
      tokens: TOKENS,
      mergedPrs: [{ number: 31, title: 'old merge', labels: [],
        user: { login: 'bot' },
        created_at: '2026-09-20T06:00:00Z',
        merged_at: '2026-09-25T12:30:00Z' }]
    });
    assert.equal(st.lanes.merged_recent.length, 0,
      'outside the window the card (and its rows) drop — E1 honesty');
  });
});

// ── gh-1198 CRAP extraction: updateHistory helpers ──────────────────────────

suite('factoryState — updateHistory helpers (gh-1198 extraction)', function () {
  var CFG = { repo: 'IstiN/flutter_agent_harness', asset: 'fa-state.json' };

  test('helpers exist (extraction landed)', function () {
    ['historyIndexPath', 'existingHistorySha', 'currentHistorySnaps',
     'historyEntry', 'validSnapshots'].forEach(function (name) {
      assert.equal(typeof fsModule[name], 'function', name + ' exported');
    });
  });

  test('historyIndexPath: the -history.json sibling of the snapshot base', function () {
    assert.equal(fsModule.historyIndexPath('fa-state'), 'data/fa-state-history.json');
  });

  suite('existingHistorySha (sha probe)', function () {
    test('returns the probed sha when the index exists', function () {
      var cmds = [];
      var sha = fsModule.existingHistorySha('IstiN/flutter_agent_harness',
        'data/fa-state-history.json', 'factory-data', function (a) {
          cmds.push(a.command);
          return { output: 'feedface\n' };
        });
      assert.equal(sha, 'feedface');
      assert.equal(cmds.length, 1);
      assert.ok(cmds[0].indexOf('--jq .sha') > 0);
      assert.ok(cmds[0].indexOf('data/fa-state-history.json') > 0);
      assert.ok(cmds[0].indexOf('?ref=factory-data') > 0);
    });

    test("a 'Not Found' string is data (first publish) — degrades to ''", function () {
      var sha = fsModule.existingHistorySha('o/r', 'data/x-history.json', 'factory-data',
        function () { return { output: 'Not Found (404)\n' }; });
      assert.equal(sha, '');
    });

    test('a transport throw degrades to empty sha (first-publish shape)', function () {
      var sha = fsModule.existingHistorySha('o/r', 'data/x-history.json', 'factory-data',
        function () { throw new Error('rate limit'); });
      assert.equal(sha, '');
    });
  });

  suite('currentHistorySnaps (index read)', function () {
    test('parses the snapshots array out of the probed index', function () {
      var snaps = [{ ts: 't1', url: 'u1' }, { ts: 't2', url: 'u2' }];
      var out = fsModule.currentHistorySnaps('o/r', 'data/x-history.json', CFG,
        function () { return { output: JSON.stringify({ schema: 1, snapshots: snaps }) }; });
      assert.deepEqual(out, snaps);
    });

    test('an empty probe parses as an empty index ({} fallback)', function () {
      var out = fsModule.currentHistorySnaps('o/r', 'data/x-history.json', CFG,
        function () { return { output: '' }; });
      assert.deepEqual(out, []);
    });

    test('invalid JSON degrades to [] — the index is rebuilt, never fatal', function () {
      var out = fsModule.currentHistorySnaps('o/r', 'data/x-history.json', CFG,
        function () { return { output: '{nope' }; });
      assert.deepEqual(out, []);
    });

    test('a snapshot-less index object degrades to []', function () {
      var out = fsModule.currentHistorySnaps('o/r', 'data/x-history.json', CFG,
        function () { return { output: JSON.stringify({ schema: 1 }) }; });
      assert.deepEqual(out, []);
    });
  });

  test('validSnapshots keeps only entries with a url (shape-drift tolerance, multi-item)', function () {
    assert.deepEqual(
      fsModule.validSnapshots([{ url: 'u1' }, null, {}, { ts: 't' }, { url: 'u2' }]),
      [{ url: 'u1' }, { url: 'u2' }]);
    assert.deepEqual(fsModule.validSnapshots([]), []);
    assert.deepEqual(fsModule.validSnapshots(null), []);
  });

  test('historyEntry: the new head entry shape (ts, tick, stamp, url)', function () {
    var state = { repo: 'o/r', tick: { at: '2026-09-23T22:35:55Z' } };
    var entry = fsModule.historyEntry('o/r', 'factory-data', 'fa-state', '20260923-2235', state);
    assert.equal(entry.tick, '2026-09-23T22:35:55Z');
    assert.equal(entry.stamp, '20260923-2235');
    assert.equal(entry.url,
      'https://raw.githubusercontent.com/o/r/factory-data/data/fa-state-20260923-2235.json');
    assert.ok(entry.ts, 'ts is stamped');
  });

  test('historyEntry tolerates a stateless tick payload', function () {
    var entry = fsModule.historyEntry('o/r', 'factory-data', 'fa-state', 's', null);
    assert.equal(entry.tick, '');
  });

  suite('updateHistory — exec call order is unchanged (characterization)', function () {
    var ST = fsModule.buildFactoryState({
      repoInfo: { owner: 'IstiN', repo: 'flutter_agent_harness' },
      prs: [], runs: [], now: '2026-09-23T22:35:55Z'
    });

    test('fresh publish: snapshot PUT → sha probe → index PUT (three calls, no content probe)', function () {
      var seen = [];
      fsModule.updateHistory(ST, CFG, function (a) {
        seen.push(a.command);
        if (a.command.indexOf('--jq .sha') > 0) throw new Error('Not Found');
        return undefined;
      });
      assert.equal(seen.length, 3);
      assert.ok(seen[0].indexOf('data/fa-state-20260923-2235.json') > 0, 'snapshot lands first');
      assert.ok(seen[1].indexOf('--jq .sha') > 0, 'sha probe second');
      assert.ok(seen[2].indexOf('data/fa-state-history.json') > 0, 'index PUT third');
    });

    test('existing index: snapshot PUT → sha probe → content probe → index PUT, sha rides the PUT', function () {
      var seen = [];
      fsModule.updateHistory(ST, CFG, function (a) {
        seen.push(a.command);
        if (a.command.indexOf('--jq .sha') > 0) return { output: 'feedface\n' };
        if (a.command.indexOf('--jq .content') > 0) {
          return { output: JSON.stringify({ schema: 1, snapshots: [{ url: 'u1' }] }) };
        }
        return undefined;
      });
      assert.equal(seen.length, 4, 'the content probe only fires when the index exists');
      assert.ok(seen[3].indexOf("-f sha='feedface'") > 0, 'the probed sha rides the index PUT');
    });
  });
});

// ── gh-1227 CRAP — branch characterization for prevIndex / normalizeTokens /
// priceTokens / buildFactoryState input defaults, locked before the helper
// extraction. Every assertion pins CURRENT behavior.

suite('factoryState — prevIndex (gh-1227 characterization)', function () {
  test('null / missing prev → empty index', function () {
    var empty = { pr: {}, issue: {}, prLane: {}, issueState: {} };
    assert.deepEqual(fsModule.prevIndex(null), empty);
    assert.deepEqual(fsModule.prevIndex({}), empty);
    assert.deepEqual(fsModule.prevIndex({ lanes: null }), empty);
  });

  test('null lane value is skipped', function () {
    var ix = fsModule.prevIndex({ lanes: { review: null } });
    assert.deepEqual(ix.pr, {});
    assert.deepEqual(ix.issue, {});
  });

  test('null card inside a lane is skipped', function () {
    var card = { pr: 1 };
    var ix = fsModule.prevIndex({ lanes: { review: [null, card] } });
    assert.equal(ix.pr[1], card);
    assert.equal(ix.prLane[1], 'review');
  });

  test('ix.issue is last-lane-wins; issueState keeps the FIRST lane', function () {
    var devCard = { issue: 7, dev: true };
    var reviewCard = { issue: 7, review: true };
    var ix = fsModule.prevIndex({
      lanes: { development: [devCard], review: [reviewCard] }
    });
    assert.equal(ix.issue[7], reviewCard, 'a later lane overwrites the issue entry');
    assert.equal(ix.issueState[7], 'development', 'issueState is first-writer-wins');
  });

  test('a card carrying both pr and issue lands in both indexes', function () {
    var card = { pr: 5, issue: 6 };
    var ix = fsModule.prevIndex({ lanes: { development: [card] } });
    assert.equal(ix.pr[5], card);
    assert.equal(ix.prLane[5], 'development');
    assert.equal(ix.issue[6], card);
    assert.equal(ix.issueState[6], 'development');
  });

  test('backlog card wins over the lane card and owns the issue state', function () {
    var laneCard = { issue: 9 };
    var backlogCard = { issue: 9 };
    var ix = fsModule.prevIndex({
      lanes: { review: [laneCard] },
      backlog: { blocked: [backlogCard] }
    });
    assert.equal(ix.issue[9], backlogCard);
    assert.equal(ix.issueState[9], 'blocked');
  });

  test('backlog null cards, issueless cards and missing buckets are skipped', function () {
    var keeper = { issue: 11 };
    var ix = fsModule.prevIndex({
      lanes: {},
      backlog: { blocked: [null, { nolabel: true }, keeper], in_dev: null, queued: [null] }
    });
    assert.equal(ix.issue[11], keeper);
    assert.equal(ix.issueState[11], 'blocked');
    assert.deepEqual(Object.keys(ix.issue), ['11']);
  });
});

suite('factoryState — normalizeTokens (gh-1227 characterization)', function () {
  test('null / undefined / primitive input → empty map', function () {
    assert.deepEqual(fsModule.normalizeTokens(null), {});
    assert.deepEqual(fsModule.normalizeTokens(undefined), {});
    assert.deepEqual(fsModule.normalizeTokens(42), {});
    assert.deepEqual(fsModule.normalizeTokens('x'), {});
  });

  test('array form: null rows and keyless rows are skipped', function () {
    var map = fsModule.normalizeTokens([
      { pr: 1, at: 'a', prompt: 1, completion: 1 },
      null,
      { issue: 2, at: 'b', prompt: 1, completion: 1 },
      { leg: 'keyless' }
    ]);
    assert.deepEqual(Object.keys(map), ['pr-1', 'issue-2']);
  });

  test('a row carrying both pr and issue keys under pr', function () {
    var map = fsModule.normalizeTokens([{ pr: 3, issue: 4, at: 'a', prompt: 0, completion: 0 }]);
    assert.deepEqual(Object.keys(map), ['pr-3']);
  });

  test('map form: non-array values are skipped, empty arrays kept', function () {
    var map = fsModule.normalizeTokens({
      'pr-1': [{ at: 'a', prompt: 1, completion: 1 }],
      junk: 'nope',
      'pr-2': null,
      empty: []
    });
    assert.deepEqual(Object.keys(map), ['pr-1', 'empty']);
  });

  test('rows sort by at ascending; a missing at sorts first', function () {
    var map = fsModule.normalizeTokens({ 'pr-1': [
      { at: '2026-10-02', prompt: 1, completion: 1 },
      { prompt: 1, completion: 1 },
      { at: '2026-10-01', prompt: 1, completion: 1 }
    ] });
    assert.deepEqual(map['pr-1'].map(function (r) { return r.at || null; }),
      [null, '2026-10-01', '2026-10-02']);
  });
});

suite('factoryState — priceTokens (gh-1227 characterization)', function () {
  var NOW = '2026-10-03T13:10:00Z';
  var NOW_MS = Date.parse(NOW);

  function pricing(over) {
    var rates = Object.create(null);
    rates['claude-sonnet-4-5'] = over || { input: 3, output: 15, cacheRead: 0.3 };
    return { rates: rates, defaultRates: null, models: 1 };
  }
  function row(over) {
    return Object.assign({
      leg: 'dev', at: '2026-10-03T07:00:00Z',
      prompt: 1000000, completion: 1000000, total: 2000000,
      model: 'claude-sonnet-4-5'
    }, over || {});
  }

  test('no pricing → null', function () {
    assert.equal(fsModule.priceTokens({ 'pr-1': [row()] }, null, NOW_MS), null);
    assert.equal(fsModule.priceTokens({ 'pr-1': [row()] }, undefined, NOW_MS), null);
  });

  test('null tmap → null', function () {
    assert.equal(fsModule.priceTokens(null, pricing(), NOW_MS), null);
  });

  test('non-array key value, null row and model-less row are skipped', function () {
    var tmap = {
      'pr-1': null,
      'pr-2': [null, row({ model: null })],
      'pr-3': [row()]
    };
    var summary = fsModule.priceTokens(tmap, pricing(), NOW_MS);
    assert.equal(summary.pricedLegs, 1, 'only pr-3 priced');
    assert.ok('cost' in tmap['pr-3'][0]);
    assert.equal(tmap['pr-2'][0], null, 'null row untouched');
    assert.equal('cost' in tmap['pr-2'][1], false, 'model-less row untouched');
  });

  test('unknown model → nothing priced → null rollup', function () {
    var tmap = { 'pr-1': [row({ model: 'mystery-model' })] };
    assert.equal(fsModule.priceTokens(tmap, pricing(), NOW_MS), null);
    assert.equal('cost' in tmap['pr-1'][0], false);
  });

  test('out-of-window and undated rows price per-row but stay out of Σ$', function () {
    var tmap = {
      'pr-1': [
        row({ at: '2026-09-10T07:00:00Z' }),   // >14d old
        row({ at: null }),                      // undated
        row()                                   // in window
      ]
    };
    var summary = fsModule.priceTokens(tmap, pricing(), NOW_MS);
    assert.equal(summary.usd14d, 18, 'only the in-window row (3+15)');
    assert.equal(summary.pricedLegs, 1);
    assert.equal(summary.windowDays, 14);
    assert.ok('cost' in tmap['pr-1'][0], 'stale row still priced');
    assert.ok('cost' in tmap['pr-1'][1], 'undated row still priced');
  });

  test('a Σ$ that rounds to $0.00 suppresses the rollup (row cost stays)', function () {
    var tmap = { 'pr-1': [row({ prompt: 100, completion: 100, total: 200 })] };
    var summary = fsModule.priceTokens(tmap, pricing(), NOW_MS);
    assert.equal(summary, null, 'no lying Σ$0.00 pill');
    assert.equal(tmap['pr-1'][0].cost, 0.0018);
  });
});

suite('factoryState — buildFactoryState input defaults (gh-1227 characterization)', function () {
  var NOW = '2026-10-03T13:10:00Z';

  test('empty input builds an empty board (every list default applies)', function () {
    var st = fsModule.buildFactoryState({});
    assert.equal(st.schema, 2);
    fsModule.LANE_ORDER.forEach(function (lane) {
      assert.deepEqual(st.lanes[lane], [], lane + ' defaults to []');
    });
    fsModule.BACKLOG_BUCKETS.forEach(function (b) {
      assert.equal(st.backlogCounts[b], 0, b + ' defaults to 0');
    });
    assert.equal('costs' in st, false, 'no pricing → no Σ$ rollup');
    assert.deepEqual(st.reworkInFlight, {});
    assert.equal(st.machineAuthor, undefined);
  });

  test('devIssues feeds the board when issues is absent', function () {
    var st = fsModule.buildFactoryState({
      now: NOW,
      devIssues: [{ number: 5, title: 't', labels: [], state: 'open' }]
    });
    var inBoard = st.lanes.development.concat(
      Object.keys(st.backlog).reduce(function (acc, k) { return acc.concat(st.backlog[k]); }, []));
    assert.ok(inBoard.some(function (c) { return c.issue === 5; }), 'issue 5 boarded via devIssues');
  });

  test('issues wins over devIssues when both ride', function () {
    var st = fsModule.buildFactoryState({
      now: NOW,
      issues: [{ number: 1, title: 'from issues', labels: [], state: 'open' }],
      devIssues: [{ number: 2, title: 'from devIssues', labels: [], state: 'open' }]
    });
    var all = Object.keys(st.backlog).reduce(function (acc, k) { return acc.concat(st.backlog[k]); }, []);
    assert.ok(all.some(function (c) { return c.issue === 1; }), 'issues item boarded');
    assert.ok(!all.some(function (c) { return c.issue === 2; }), 'devIssues item ignored');
  });
});

suite('factoryState — gh-1227 extracted helpers (pure units)', function () {
  test('tokenRowKey: pr wins, issue next, neither → null', function () {
    assert.equal(fsModule.tokenRowKey({ pr: 1, issue: 2 }), 'pr-1');
    assert.equal(fsModule.tokenRowKey({ issue: 2 }), 'issue-2');
    assert.equal(fsModule.tokenRowKey({}), null);
    assert.equal(fsModule.tokenRowKey({ pr: null, issue: null }), null);
  });

  test('tokenRowAtAsc: ascending at, missing at sorts first', function () {
    assert.equal(fsModule.tokenRowAtAsc({ at: 'a' }, { at: 'b' }) < 0, true);
    assert.equal(fsModule.tokenRowAtAsc({ at: 'b' }, { at: 'a' }) > 0, true);
    assert.equal(fsModule.tokenRowAtAsc({ at: 'a' }, { at: 'a' }), 0);
    assert.equal(fsModule.tokenRowAtAsc({}, { at: 'a' }) < 0, true, 'missing at first');
    assert.equal(fsModule.tokenRowAtAsc({ at: 'a' }, {}) > 0, true);
  });

  test('priceRowInPlace: skips null / model-less / unknown-model rows, prices the rest', function () {
    var pricing = (function () {
      var rates = Object.create(null);
      rates['claude-sonnet-4-5'] = { input: 3, output: 15, cacheRead: 0.3 };
      return { rates: rates, defaultRates: null, models: 1 };
    })();
    assert.equal(fsModule.priceRowInPlace(null, pricing), false);
    assert.equal(fsModule.priceRowInPlace({ model: null }, pricing), false);
    var unknown = { model: 'mystery', prompt: 1, completion: 1 };
    assert.equal(fsModule.priceRowInPlace(unknown, pricing), false);
    assert.equal('cost' in unknown, false);
    var priced = { model: 'claude-sonnet-4-5', prompt: 1000000, completion: 0 };
    assert.equal(fsModule.priceRowInPlace(priced, pricing), true);
    assert.equal(priced.cost, 3);
  });

  test('inCostWindow: undated, unparsable, stale → false; fresh → true', function () {
    var NOW_MS = Date.parse('2026-10-03T13:10:00Z');
    assert.equal(fsModule.inCostWindow({ at: null }, NOW_MS), false);
    assert.equal(fsModule.inCostWindow({}, NOW_MS), false);
    assert.equal(fsModule.inCostWindow({ at: 'not-a-date' }, NOW_MS), false);
    assert.equal(fsModule.inCostWindow({ at: '2026-09-10T07:00:00Z' }, NOW_MS), false, '>14d');
    assert.equal(fsModule.inCostWindow({ at: '2026-10-03T07:00:00Z' }, NOW_MS), true);
  });

  test('indexLaneCards / indexBacklogCards mirror prevIndex (direct)', function () {
    var ix = { pr: {}, issue: {}, prLane: {}, issueState: {} };
    var card = { pr: 1, issue: 2 };
    fsModule.indexLaneCards(ix, { review: [card], junk: null });
    assert.equal(ix.pr[1], card);
    assert.equal(ix.prLane[1], 'review');
    assert.equal(ix.issue[2], card);
    assert.equal(ix.issueState[2], 'review');

    var twin = { issue: 3 };
    fsModule.indexBacklogCards(ix, { backlog: { blocked: [twin], queued: [null, {}] } });
    assert.equal(ix.issue[3], twin);
    assert.equal(ix.issueState[3], 'blocked');
  });

  test('boardInputs: every optional list degrades, overrides win', function () {
    var defaults = fsModule.boardInputs({});
    assert.deepEqual(defaults.prs, []);
    assert.deepEqual(defaults.mergedPrs, []);
    assert.deepEqual(defaults.issues, []);
    assert.deepEqual(defaults.runs, []);
    assert.deepEqual(defaults.checkNames, []);
    assert.ok(!isNaN(Date.parse(defaults.now)), 'now defaults to the wall clock');

    var custom = fsModule.boardInputs({
      prs: [{ number: 1 }], mergedPrs: [{ number: 2 }],
      devIssues: [{ number: 3 }], runs: [{ id: 4 }],
      checkNames: ['ci'], now: '2026-10-03T13:10:00Z'
    });
    assert.equal(custom.prs.length, 1);
    assert.equal(custom.mergedPrs.length, 1);
    assert.equal(custom.issues.length, 1, 'devIssues is the issues source');
    assert.equal(custom.runs.length, 1);
    assert.deepEqual(custom.checkNames, ['ci']);
    assert.equal(custom.now, '2026-10-03T13:10:00Z');
  });

  test('carryReworkLatch: merges the prev carry with the live map, prunes stale', function () {
    var HEAD = '23dacd10deadbeefcafe0123456789abcdef0123';
    var NOW_MS = Date.parse('2026-10-03T13:10:00Z');
    var ARMED_AT = NOW_MS - 10 * 60 * 1000;   // armed 10 min ago — inside the 45m window
    var latched = fsModule.carryReworkLatch({
      prev: { reworkInFlight: {} },
      reworkInFlight: { ['pr-1@' + HEAD]: { head: HEAD, at: ARMED_AT } }
    }, NOW_MS, []);
    assert.ok(latched['pr-1@' + HEAD], 'fresh latch survives');

    var empty = fsModule.carryReworkLatch({ reworkInFlight: {} }, NOW_MS, []);
    assert.deepEqual(empty, {}, 'no prev → live map only');
  });
});
