/**
 * Unit tests for site/factory/flow.js — the factory board's value-stream
 * analytics (gh-769: named phases with boundaries, rework rounds, CI
 * wall-time vs queue-wait split, token visibility, next-step hints).
 *
 * Pure functions only — no DOM, no tool globals. The same module ships to
 * the browser (window.FACTORY_FLOW) and loads here via loadModule — the
 * exact pattern of site/factory/steps.js / test_factoryBoardSteps.js.
 */

var assert = globalThis.assert;

var flow = loadModule('site/factory/flow.js');

function iso(s) { return Date.parse(s); }

// pr → review → pr → review → pr → review → approve — two full rework
// rounds (CI red twice), all boundaries known. The positional occurrence
// durations this pins:
//   pr_created 09:00→10:00 (first pass) · 10:30→11:00 (rework 1) ·
//             11:30→11:45 (rework 2) = 1h + 30m + 15m
//   review     10:00→10:30 (first pass) · 11:00→11:30 (rework 1) ·
//             11:45→12:00 (rework 2) = 30m + 30m + 15m
//   approved_queue 12:00→now (live)
var REWORK_ENTRIES = [
  { state: 'pr_created', at: iso('2026-10-03T09:00:00Z') },
  { state: 'review',      at: iso('2026-10-03T10:00:00Z') },
  { state: 'pr_created', at: iso('2026-10-03T10:30:00Z') },
  { state: 'review',      at: iso('2026-10-03T11:00:00Z') },
  { state: 'pr_created', at: iso('2026-10-03T11:30:00Z') },
  { state: 'review',      at: iso('2026-10-03T11:45:00Z') },
  { state: 'approved_queue', at: iso('2026-10-03T12:00:00Z') }
];
// "now" 30m after the last transition; NOT terminal — the live phase runs
var NOW = iso('2026-10-03T12:30:00Z');

suite('factoryFlow — tokenTotals', function () {
  test('null when the card carries no tokens (absent, null, empty)', function () {
    assert.equal(flow.tokenTotals(null), null);
    assert.equal(flow.tokenTotals({}), null);
    assert.equal(flow.tokenTotals({ tokens: [] }), null);
    assert.equal(flow.tokenTotals({ tokens: null }), null);
  });

  test('sums prompt/completion/total across rows and buckets per leg', function () {
    var t = flow.tokenTotals({ tokens: [
      { leg: 'story_development', prompt: 100, completion: 10, total: 110 },
      { leg: 'pr_review', prompt: 50, completion: 5, total: 55 },
      { leg: 'pr_rework', prompt: 30, completion: 5, total: 35 }
    ] });
    assert.equal(t.prompt, 180);
    assert.equal(t.completion, 20);
    assert.equal(t.total, 200);
    assert.equal(t.legs.story_development.total, 110);
    assert.equal(t.legs.pr_review.total, 55);
    assert.equal(t.legs.pr_rework.total, 35);
  });

  test('multi-row legs accumulate; missing numbers count as 0', function () {
    var t = flow.tokenTotals({ tokens: [
      { leg: 'pr_rework', prompt: 10, completion: 2 },
      { leg: 'pr_rework', prompt: 20, completion: 3, total: 23 }
    ] });
    assert.equal(t.legs.pr_rework.total, 35, '10+2=12 then +23');
    assert.equal(t.total, 35);
  });
});

suite('factoryFlow — legs bucket is prototype-safe (review thread 2)', function () {
  test('__proto__ / constructor legs stay own data buckets — totals never corrupt', function () {
    var t = flow.tokenTotals({ tokens: [
      { leg: '__proto__', prompt: 7, completion: 0, total: 7 },
      { leg: 'constructor', prompt: 5, completion: 0, total: 5 },
      { leg: 'pr_rework', prompt: 10, completion: 2, total: 12 }
    ] });
    assert.equal(t.total, 24);
    assert.deepEqual(Object.keys(t.legs).sort(),
      ['__proto__', 'constructor', 'pr_rework'],
      'special keys must not vanish from Object.keys (per-leg chips/drawer)');
    assert.equal(t.legs['__proto__'].total, 7,
      'must be a plain data bucket, not a prototype assignment');
    assert.equal(t.legs['constructor'].total, 5,
      'must not resolve to the inherited Object function');
    assert.equal(t.legs['constructor'].prompt, 5,
      'no NaN from += onto inherited properties');
  });

  test('flowSummary cross-card merge is prototype-safe too', function () {
    var s = flow.flowSummary([
      { tokens: [{ leg: '__proto__', prompt: 7, completion: 0, total: 7 }] },
      { tokens: [{ leg: '__proto__', prompt: 5, completion: 0, total: 5 }] }
    ], NOW);
    assert.equal(s.tokens.total, 12);
    assert.deepEqual(Object.keys(s.tokens.legs), ['__proto__']);
    assert.equal(s.tokens.legs['__proto__'].total, 12, 'both cards accumulate');
  });
});

suite('factoryFlow — ciSplit (CI wall-time vs queue wait, gh-769 #6)', function () {
  test('null without checks, without checks.at, or with a bad date', function () {
    assert.equal(flow.ciSplit({}, 0), null);
    assert.equal(flow.ciSplit({ checks: {} }, 0), null);
    assert.equal(flow.ciSplit({ checks: { verdict: 'queued' } }, 0), null);
    assert.equal(flow.ciSplit({ checks: { at: 'not-a-date' } }, 0), null);
  });

  test('queued run without runStartedAt: everything so far is queue wait', function () {
    var s = flow.ciSplit({ checks: { verdict: 'queued', at: '2026-10-03T12:00:00Z' } },
      iso('2026-10-03T12:10:00Z'));
    assert.equal(s.running, true);
    assert.equal(s.queueMs, 600000);
    assert.equal(s.ciMs, null, 'CI has not started — honest unknown');
  });

  test('in_progress run with runStartedAt splits wait from wall time', function () {
    var s = flow.ciSplit({ checks: { verdict: 'in_progress', at: '2026-10-03T12:00:00Z',
      runStartedAt: '2026-10-03T12:07:00Z' } }, iso('2026-10-03T12:10:00Z'));
    assert.equal(s.running, true);
    assert.equal(s.queueMs, 420000, '7m queued before the runner picked it up');
    assert.equal(s.ciMs, 180000, '3m actually running');
  });

  test('completed run: ciMs closes at updatedAt', function () {
    var s = flow.ciSplit({ checks: { verdict: 'success', at: '2026-10-03T12:00:00Z',
      runStartedAt: '2026-10-03T12:01:00Z', updatedAt: '2026-10-03T12:09:00Z' } },
      iso('2026-10-03T13:00:00Z'));
    assert.equal(s.running, false);
    assert.equal(s.queueMs, 60000);
    assert.equal(s.ciMs, 480000, '8m of CI wall time — clock does NOT keep running');
  });

  test('completed run without runStartedAt → null (honest unknown, no fake split)', function () {
    assert.equal(flow.ciSplit({ checks: { verdict: 'success',
      at: '2026-10-03T12:00:00Z' } }, iso('2026-10-03T13:00:00Z')), null);
  });

  test('completed run without updatedAt: ciMs stays unknown (review thread 9)', function () {
    var s = flow.ciSplit({ checks: { verdict: 'success',
      at: '2026-10-03T12:00:00Z', runStartedAt: '2026-10-03T12:01:00Z' } },
      iso('2026-10-03T13:00:00Z'));
    assert.equal(s.running, false);
    assert.equal(s.queueMs, 60000);
    assert.equal(s.ciMs, null,
      'the CI clock stopped at an unknown time — no fake nowMs - start');
  });


  test('clock skew clamps to 0 — never a negative wait', function () {
    var s = flow.ciSplit({ checks: { verdict: 'in_progress', at: '2026-10-03T12:00:00Z',
      runStartedAt: '2026-10-03T11:59:00Z' } }, iso('2026-10-03T12:10:00Z'));
    assert.equal(s.queueMs, 0);
  });
});

suite('factoryFlow — phaseRail (named phases with boundaries, gh-769 #4)', function () {
  test('empty history → empty rail', function () {
    assert.deepEqual(flow.phaseRail([], NOW, false), []);
    assert.deepEqual(flow.phaseRail(null, NOW, false), []);
  });

  test('a single entry without a timestamp stays honest (from/dur unknown)', function () {
    var rail = flow.phaseRail([{ state: 'inbox', at: null }], NOW, false);
    assert.equal(rail.length, 1);
    assert.equal(rail[0].state, 'inbox');
    assert.equal(rail[0].rounds, 1);
    assert.equal(rail[0].from, null);
    assert.equal(rail[0].totalMs, null);
    assert.equal(rail[0].reworkRounds, 0);
  });

  test('linear history: one phase per state, durations bounded by the next transition', function () {
    var rail = flow.phaseRail([
      { state: 'pr_created', at: iso('2026-10-03T09:00:00Z') },
      { state: 'review', at: iso('2026-10-03T10:00:00Z') },
      { state: 'approved_queue', at: iso('2026-10-03T10:30:00Z') }
    ], NOW, false);
    assert.deepEqual(rail.map(function (p) { return p.state; }),
      ['pr_created', 'review', 'approved_queue']);
    assert.equal(rail[0].totalMs, 3600000, '1h in pr_created');
    assert.equal(rail[1].totalMs, 1800000, '30m in review');
    assert.equal(rail[2].totalMs, 7200000,
      'live tail phase runs to now (10:30 → 12:30 = 2h)');
    rail.forEach(function (p) {
      assert.equal(p.reworkRounds, 0, p.state + ' was visited once');
    });
  });

  test('rework cycle: repeated NON-consecutive states collapse into one phase with round counts', function () {
    var rail = flow.phaseRail(REWORK_ENTRIES, NOW, false);
    assert.deepEqual(rail.map(function (p) { return p.state; }),
      ['pr_created', 'review', 'approved_queue'],
      'first-seen order — no repeated rail entries');
    var pr = rail[0], rev = rail[1];
    assert.equal(pr.rounds, 3, 'pr_created entered 3×');
    assert.equal(pr.reworkRounds, 2, 'entries 2 and 3 are rework rounds');
    assert.equal(rev.rounds, 3);
    assert.equal(rev.reworkRounds, 2);
    assert.equal(pr.from, iso('2026-10-03T09:00:00Z'), 'phase boundary = first entry');
  });

  test('rework time counts only the RE-VISITED occurrences, not the first pass', function () {
    var rail = flow.phaseRail(REWORK_ENTRIES, NOW, false);
    var pr = rail[0];
    assert.equal(pr.totalMs, 3600000 + 1800000 + 900000,
      '1h first pass + 30m rework 1 + 15m rework 2');
    assert.equal(pr.reworkMs, 2700000, 'rework = the two re-visits (45m)');
    var rev = rail[1];
    assert.equal(rev.totalMs, 1800000 + 1800000 + 900000, '30m + 30m + 15m');
    assert.equal(rev.reworkMs, 2700000);
  });

  test('terminal history: the trailing phase has no running clock', function () {
    var rail = flow.phaseRail([
      { state: 'review', at: iso('2026-10-03T09:00:00Z') },
      { state: 'merged_recent', at: iso('2026-10-03T10:00:00Z') }
    ], NOW, true);
    assert.equal(rail[1].totalMs, null, 'merged is terminal — no dur');
  });

  test('the full fixture lane set — every card yields a sane rail', function () {
    var fixture = JSON.parse(file_read({ path: 'site/factory/visual-check/fixture.json' }));
    Object.keys(fixture.lanes).forEach(function (laneId) {
      fixture.lanes[laneId].forEach(function (card) {
        var rail = flow.phaseRail(entriesOfFixture(card), NOW, !!card.mergedAt);
        rail.forEach(function (p) {
          assert.ok(p.rounds >= 1, laneId + ' rounds >= 1');
          assert.ok(p.reworkRounds >= 0);
          assert.ok(p.reworkRounds === p.rounds - 1, 'rework = rounds - 1');
        });
        // every raw entry lands in exactly one phase
        var total = rail.reduce(function (m, p) { return m + p.rounds; }, 0);
        assert.equal(total, entriesOfFixture(card).length,
          laneId + ' phases cover the whole history');
      });
    });
  });

  function entriesOfFixture(card) {
    return (card.history || []).map(function (h) {
      return { state: h.state, at: h.at ? Date.parse(h.at) : null };
    });
  }
});

suite('factoryFlow — entriesOf (chronological guarantee, review thread 4)', function () {
  test('out-of-order history entries sort by timestamp, nulls first', function () {
    var entries = flow.entriesOf({ history: [
      { state: 'pr_created', at: '2026-10-03T10:30:00Z' },
      { state: 'inbox', at: null },
      { state: 'approved_queue', at: '2026-10-03T11:00:00Z' },
      { state: 'review', at: '2026-10-03T10:00:00Z' }
    ] });
    assert.deepEqual(entries.map(function (e) { return e.state; }),
      ['inbox', 'review', 'pr_created', 'approved_queue'],
      'phaseRail durations are positional — they need real time order');
  });

  test('already-chronological history is preserved', function () {
    var entries = flow.entriesOf({ history: [
      { state: 'pr_created', at: '2026-10-03T09:00:00Z' },
      { state: 'review', at: '2026-10-03T10:00:00Z' }
    ] });
    assert.deepEqual(entries.map(function (e) { return e.state; }),
      ['pr_created', 'review']);
  });

  test('the schema-2 timestamp fallback is chronological too', function () {
    var entries = flow.entriesOf({
      reviewedAt: '2026-10-03T10:00:00Z',
      prCreated: '2026-10-03T09:00:00Z'
    });
    assert.deepEqual(entries.map(function (e) { return e.state; }),
      ['pr_created', 'review']);
  });

  test('no history and no timestamps → empty rail', function () {
    assert.deepEqual(flow.entriesOf({}), []);
  });
});

suite('factoryFlow — reworkOf (rework analytics, gh-769 #5)', function () {
  test('sums rounds and rework time across the rail', function () {
    var rail = flow.phaseRail(REWORK_ENTRIES, NOW, false);
    var rw = flow.reworkOf(rail);
    assert.equal(rw.rounds, 4, '2 pr_created + 2 review re-entries');
    assert.equal(rw.ms, 2700000 + 2700000, '45m + 45m');
  });

  test('a clean pipeline has zero rework', function () {
    var rw = flow.reworkOf(flow.phaseRail([
      { state: 'pr_created', at: iso('2026-10-03T09:00:00Z') },
      { state: 'review', at: iso('2026-10-03T10:00:00Z') }
    ], NOW, false));
    assert.deepEqual(rw, { rounds: 0, ms: 0 });
  });
});

suite('factoryFlow — nextStep (what happens next / blocking, gh-769 #2)', function () {
  test('merged card → null (nothing next)', function () {
    assert.equal(flow.nextStep({ mergedAt: '2026-10-03T10:00:00Z' }, 'merged_recent'), null);
    assert.equal(flow.nextStep({}, 'merged_recent'), null);
  });

  test('approved queue: merge is next, the FIFO position is the wait', function () {
    var n = flow.nextStep({ queuePos: 1 }, 'approved_queue', { queueLen: 3 });
    assert.equal(n.next, 'merge');
    assert.equal(n.detail, 'queue #1 of 3 — next on the mutex');
    assert.equal(n.blocking, true);
  });

  test('approved queue mid-pack: waiting behind the mutex', function () {
    var n = flow.nextStep({ queuePos: 2 }, 'approved_queue', { queueLen: 3 });
    assert.equal(n.detail, 'queue #2 of 3');
  });

  test('approved queue without a position still names the merge', function () {
    var n = flow.nextStep({}, 'approved_queue');
    assert.equal(n.next, 'merge');
    assert.equal(n.detail, 'FIFO queue');
  });

  test('validating: green CI merges — progressing, not blocked', function () {
    var n = flow.nextStep({}, 'validating');
    assert.equal(n.next, 'merge');
    assert.equal(n.blocking, false);
  });

  test('review: approve is next', function () {
    var n = flow.nextStep({}, 'review');
    assert.equal(n.next, 'approve');
    assert.equal(n.blocking, false);
  });

  test('pr_created with a red verdict: rework is next and blocking', function () {
    var n = flow.nextStep({ checks: { verdict: 'failure' } }, 'pr_created');
    assert.equal(n.next, 'rework');
    assert.equal(n.detail, 'CI red');
    assert.equal(n.blocking, true);
  });

  test('pr_created clean: validation is next', function () {
    var n = flow.nextStep({}, 'pr_created');
    assert.equal(n.next, 'validation');
    assert.equal(n.blocking, false);
  });

  test('pr_validation queued run says CI queued, not CI running (review thread 5)', function () {
    var n = flow.nextStep({ checks: { verdict: 'queued', at: '2026-10-03T12:00:00Z' } },
      'pr_validation');
    assert.equal(n.next, 'review');
    assert.equal(n.detail, 'CI queued',
      'a run sitting in the queue is idle-wait — exactly the CI-vs-idle ' +
      'confusion gh-769 #6 set out to fix');
  });

  test('pr_validation waiting/pending verdicts also read CI queued', function () {
    var waiting = flow.nextStep({ checks: { verdict: 'waiting' } }, 'pr_validation');
    var pending = flow.nextStep({ checks: { verdict: 'pending' } }, 'pr_validation');
    assert.equal(waiting.detail, 'CI queued');
    assert.equal(pending.detail, 'CI queued');
  });

  test('pr_validation with runStartedAt says CI running', function () {
    var n = flow.nextStep({ checks: { verdict: 'in_progress',
      runStartedAt: '2026-10-03T12:01:00Z' } }, 'pr_validation');
    assert.equal(n.next, 'review');
    assert.equal(n.detail, 'CI running');
  });


  test('issue-side lanes name their next handoff', function () {
    assert.equal(flow.nextStep({}, 'development').next, 'pr');
    assert.equal(flow.nextStep({}, 'in_dev').next, 'pr');
    assert.equal(flow.nextStep({}, 'queued').next, 'dev');
    assert.equal(flow.nextStep({}, 'inbox').next, 'triage');
  });

  test('blocked bucket: owner hold is blocking, nothing flows', function () {
    var n = flow.nextStep({}, 'blocked');
    assert.equal(n.blocking, true);
    assert.equal(n.detail, 'owner hold');
  });

  test('unknown lane → null', function () {
    assert.equal(flow.nextStep({}, 'who-knows'), null);
    assert.equal(flow.nextStep(null, 'review'), null);
  });
});

suite('factoryFlow — flowSummary (board-level value stream)', function () {
  var CARDS = [
    { // clean flow, tokens
      prCreated: '2026-10-03T09:00:00Z', mergedAt: '2026-10-03T11:00:00Z',
      history: [
        { state: 'pr_created', at: '2026-10-03T09:00:00Z' },
        { state: 'review', at: '2026-10-03T10:00:00Z' },
        { state: 'merged_recent', at: '2026-10-03T11:00:00Z' }
      ],
      tokens: [{ leg: 'story_development', prompt: 100, completion: 10, total: 110 }]
    },
    { // rework flow, tokens
      prCreated: '2026-10-03T09:00:00Z',
      history: REWORK_ENTRIES.map(function (e) {
        return { state: e.state, at: new Date(e.at).toISOString() };
      }),
      tokens: [{ leg: 'pr_rework', prompt: 30, completion: 5, total: 35 },
               { leg: 'story_development', prompt: 40, completion: 5, total: 45 }]
    }
  ];

  test('aggregates per-phase totals across cards (multi-card, multi-phase)', function () {
    var s = flow.flowSummary(CARDS, NOW);
    assert.equal(s.cards, 2);
    var byState = {};
    s.phases.forEach(function (p) { byState[p.state] = p; });
    assert.equal(byState.pr_created.cards, 2);
    // card 1: 09:00→10:00 = 1h; card 2 occurrences: 1h + 30m + 15m
    assert.equal(byState.pr_created.totalMs, 3600000 + 6300000);
    assert.equal(byState.review.cards, 2);
    assert.ok(byState.merged_recent, 'merged phase appears from card 1');
  });

  test('sums rework across cards', function () {
    var s = flow.flowSummary(CARDS, NOW);
    assert.equal(s.rework.rounds, 4);
    assert.equal(s.rework.ms, 2700000 + 2700000);
  });

  test('sums tokens across cards, per leg', function () {
    var s = flow.flowSummary(CARDS, NOW);
    assert.equal(s.tokens.total, 110 + 35 + 45);
    assert.equal(s.tokens.legs.story_development.total, 110 + 45);
    assert.equal(s.tokens.legs.pr_rework.total, 35);
  });

  test('lead time: merged cards measure prCreated→mergedAt, open cards →now', function () {
    var s = flow.flowSummary(CARDS, NOW);
    assert.equal(s.lead.n, 2);
    assert.equal(s.lead.maxMs, iso('2026-10-03T12:30:00Z') - iso('2026-10-03T09:00:00Z'),
      'the open rework card has been in flight longest');
    assert.ok(s.lead.avgMs > 0);
  });

  test('empty board → zeroed summary, no NaN anywhere', function () {
    var s = flow.flowSummary([], NOW);
    assert.equal(s.cards, 0);
    assert.deepEqual(s.phases, []);
    assert.deepEqual(s.rework, { rounds: 0, ms: 0 });
    assert.equal(s.tokens, null);
    assert.equal(s.lead.avgMs, null);
    assert.equal(s.lead.maxMs, null);
  });

  test('cards without history fall back to the schema-2 timestamp fields', function () {
    var s = flow.flowSummary([
      { prCreated: '2026-10-03T09:00:00Z', reviewedAt: '2026-10-03T10:00:00Z' }
    ], NOW);
    var byState = {};
    s.phases.forEach(function (p) { byState[p.state] = p; });
    assert.ok(byState.pr_created, 'prCreated maps to the pr_created phase');
    assert.ok(byState.review, 'reviewedAt maps to the review phase');
  });
});
