/*
 * Factory Board — value-stream flow analytics (gh-769, owner 2026-10-06).
 *
 * The board showed WHERE a card sat but not the shape of its flow: the
 * drawer repeated 'PR created' once per rework cycle, rework was
 * invisible, validating time mixed real CI wall-time with queue wait,
 * tokens hid in the drawer, and nothing said what happens NEXT for a
 * card. This module is the pure analytics layer behind the Lean
 * value-stream surfaces:
 *
 *   phaseRail    history [{state, at}] → named phases with boundaries
 *                (rounds collapse: 3× 'PR created' renders as ONE phase,
 *                ×3, with the time split into first pass vs rework);
 *   reworkOf     rail → {rounds, ms} per card;
 *   ciSplit      checks {at, runStartedAt?, updatedAt?} → {queueMs, ciMs}
 *                — CI wall-time vs queue wait (runner backlog / mutex);
 *   tokenTotals  card.tokens → Σ per leg (board-level token visibility);
 *   nextStep     card + lane → what happens next / what's blocking;
 *   flowSummary  all cards → the board-level value-stream strip.
 *
 * Everything degrades to honest unknowns (null / 0) on missing data —
 * schema-1 snapshots and pre-v3 cards render fine. Pure logic, zero DOM:
 * app.js renders the returned numbers; unit tests load the same file via
 * loadModule. Dual-exported — window.FACTORY_FLOW in the browser,
 * module.exports under the test harness.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.FACTORY_FLOW = api; }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // checks verdicts that mean the run is still in flight (mirrors
  // js/factoryState.js ACTIVE_RUN_STATES / steps.js usage)
  var ACTIVE_VERDICTS = ['queued', 'in_progress', 'waiting', 'pending'];

  // schema-2 card timestamp field → phase state — the drawer's history
  // fallback for cards accumulated before card.history existed (mirrors
  // app.js TS_TO_STATE / js/factoryState.js LANE_ENTERED_AT, kept in sync
  // deliberately)
  var TS_TO_STATE = [
    { k: 'devStartedAt', state: 'development' },
    { k: 'prCreated',    state: 'pr_created' },
    { k: 'reviewedAt',   state: 'review' },
    { k: 'approvedAt',   state: 'approved_queue' },
    { k: 'validatingAt', state: 'validating' },
    { k: 'mergedAt',     state: 'merged_recent' }
  ];

  function parseMs(iso) {
    var t = Date.parse(iso);
    return isNaN(t) ? null : t;
  }

  // ── token totals (gh-769 #3: token spend visible beyond the drawer) ────────
  // {prompt, completion, total, legs: {leg: {prompt, completion, total}}}
  // or null when the card carries no token rows — tokens stay OPTIONAL,
  // factories that don't report them render without the chip.
  function tokenTotals(card) {
    var rows = card && card.tokens;
    if (!rows || !rows.length) return null;
    var out = { prompt: 0, completion: 0, total: 0, legs: {} };
    rows.forEach(function (r) {
      if (!r) return;
      var p = +r.prompt || 0, c = +r.completion || 0, t = +r.total || (p + c);
      out.prompt += p; out.completion += c; out.total += t;
      var leg = r.leg || '—';
      var b = out.legs[leg];
      if (!b) { b = out.legs[leg] = { prompt: 0, completion: 0, total: 0 }; }
      b.prompt += p; b.completion += c; b.total += t;
    });
    return out;
  }

  // ── CI wall-time vs queue wait (gh-769 #6) ──────────────────────────────────
  // checks.at  = run created_at (the clock started ticking — queue or CI)
  // runStartedAt = run_started_at (a runner actually picked it up)
  // updatedAt  = updated_at (terminal runs: the CI clock STOPPED here)
  // Returns {queueMs, ciMs, running}; unknown parts stay null. A completed
  // run without runStartedAt can't be split honestly → null.
  function ciSplit(card, nowMs) {
    var c = card && card.checks;
    if (!c || !c.at) return null;
    var created = parseMs(c.at);
    if (created == null) return null;
    var running = ACTIVE_VERDICTS.indexOf(c.verdict) >= 0;
    var start = c.runStartedAt ? parseMs(c.runStartedAt) : null;
    if (start == null) {
      if (!running) return null;                    // can't split — no fake
      // queued so far: everything since creation is wait
      return { queueMs: Math.max(0, nowMs - created), ciMs: null, running: true };
    }
    var queueMs = Math.max(0, start - created);
    if (running) {
      return { queueMs: queueMs, ciMs: Math.max(0, nowMs - start), running: true };
    }
    var end = c.updatedAt ? parseMs(c.updatedAt) : null;
    return { queueMs: queueMs,
             ciMs: end == null ? null : Math.max(0, end - start),
             running: false };
  }

  // ── phase rail (gh-769 #4: named phases with boundaries, no repeats) ───────
  // entries [{state, at(ms|null)}] oldest first (cardHistory's shape).
  // Occurrence i lasts until occurrence i+1 STARTS (positional, regardless
  // of state); the last occurrence runs to now unless the card is terminal.
  // Repeated (non-consecutive) states collapse into ONE phase:
  //   {state, rounds, from, totalMs, reworkRounds, reworkMs} —
  // rounds = entries collapsed; reworkRounds = rounds - 1; reworkMs sums
  // ONLY the re-visited occurrences (the first pass stays first-pass time).
  function phaseRail(entries, nowMs, terminal) {
    if (!entries || !entries.length) return [];
    var durs = entries.map(function (e, i) {
      if (e.at == null) return null;
      var next = entries[i + 1];
      if (next && next.at != null) return Math.max(0, next.at - e.at);
      if (next) return null;                        // next has no stamp yet
      return terminal ? null : Math.max(0, nowMs - e.at);
    });
    var order = [], byState = {};
    entries.forEach(function (e, i) {
      var g = byState[e.state];
      if (!g) {
        g = byState[e.state] = { state: e.state, rounds: 0, from: null,
                                 totalMs: 0, reworkRounds: 0, reworkMs: 0 };
        order.push(e.state);
      }
      g.rounds += 1;
      if (g.from == null && e.at != null) g.from = e.at;
      if (durs[i] != null) g.totalMs += durs[i];
      if (g.rounds > 1) {                           // re-visit = rework round
        g.reworkRounds += 1;
        if (durs[i] != null) g.reworkMs += durs[i];
      }
    });
    return order.map(function (s) {
      var g = byState[s];
      return { state: g.state, rounds: g.rounds, from: g.from,
               totalMs: g.totalMs || null,
               reworkRounds: g.reworkRounds,
               reworkMs: g.reworkMs || null };
    });
  }

  // rail → {rounds, ms} — the per-card rework analytics line
  function reworkOf(rail) {
    var out = { rounds: 0, ms: 0 };
    (rail || []).forEach(function (p) {
      out.rounds += p.reworkRounds;
      out.ms += p.reworkMs || 0;
    });
    return out;
  }

  // ── what happens next / what's blocking (gh-769 #2) ────────────────────────
  // {next, detail, blocking} — short strings for the card + drawer. null
  // for merged cards (nothing next) and unknown lanes.
  function nextStep(card, laneId, ctx) {
    if (!card || !laneId) return null;
    if (card.mergedAt || laneId === 'merged_recent') return null;
    var red = card.checks &&
      ['failure', 'timed_out', 'startup_failure'].indexOf(card.checks.verdict) >= 0;
    switch (laneId) {
      case 'blocked':
        return { next: 'unblock', detail: 'owner hold', blocking: true };
      case 'development':
      case 'in_dev':
        return { next: 'pr', detail: 'dev leg running', blocking: false };
      case 'queued':
        return { next: 'dev', detail: null, blocking: false };
      case 'inbox':
        return { next: 'triage', detail: null, blocking: false };
      case 'pr_created':
        return red
          ? { next: 'rework', detail: 'CI red', blocking: true }
          : { next: 'validation', detail: null, blocking: false };
      case 'pr_validation':
        return red
          ? { next: 'rework', detail: 'CI red', blocking: true }
          : { next: 'review', detail: 'CI running', blocking: false };
      case 'review':
        return { next: 'approve', detail: null, blocking: false };
      case 'approved_queue': {
        var pos = card.queuePos;
        var len = ctx && ctx.queueLen;
        var detail = pos
          ? ('queue #' + pos + (len > 1 ? ' of ' + len : '') +
             (pos === 1 ? ' — next on the mutex' : ''))
          : 'FIFO queue';
        return { next: 'merge', detail: detail, blocking: true };
      }
      case 'validating':
        return { next: 'merge', detail: 'green CI merges', blocking: false };
      default:
        return null;
    }
  }

  // card → [{state, at(ms|null)}] — snapshot history preferred, schema-2
  // timestamp fields as the fallback (pre-v3 cards still get a rail)
  function entriesOf(card) {
    if (card.history && card.history.length) {
      return card.history.map(function (h) {
        return { state: h.state, at: h.at ? parseMs(h.at) : null };
      });
    }
    return TS_TO_STATE.filter(function (m) { return card[m.k]; })
      .map(function (m) { return { state: m.state, at: parseMs(card[m.k]) }; });
  }

  // ── board-level value-stream summary (gh-769 #5) ───────────────────────────
  // Aggregates the per-card analytics across every PR card on the board:
  //   phases {state, cards, totalMs}  — where the flow's time actually goes
  //   rework {rounds, ms}             — Σ rework over all cards
  //   tokens {prompt, completion, total, legs} | null
  //   lead {n, avgMs, maxMs}          — prCreated → merge|now
  function flowSummary(cards, nowMs) {
    var out = { cards: 0, phases: [], ix: {}, rework: { rounds: 0, ms: 0 },
                tokens: null, lead: { n: 0, totalMs: 0, avgMs: null, maxMs: null } };
    (cards || []).forEach(function (card) {
      if (!card) return;
      out.cards += 1;
      var rail = phaseRail(entriesOf(card), nowMs, !!card.mergedAt);
      rail.forEach(function (p) {
        var a = out.ix[p.state];
        if (!a) {
          a = out.ix[p.state] = { state: p.state, cards: 0, totalMs: 0 };
          out.phases.push(a);
        }
        a.cards += 1;
        if (p.totalMs != null) a.totalMs += p.totalMs;
      });
      var rw = reworkOf(rail);
      out.rework.rounds += rw.rounds;
      out.rework.ms += rw.ms;
      var tt = tokenTotals(card);
      if (tt) {
        if (!out.tokens) {
          out.tokens = { prompt: 0, completion: 0, total: 0, legs: {} };
        }
        out.tokens.prompt += tt.prompt;
        out.tokens.completion += tt.completion;
        out.tokens.total += tt.total;
        Object.keys(tt.legs).forEach(function (leg) {
          var b = out.tokens.legs[leg];
          if (!b) { b = out.tokens.legs[leg] = { prompt: 0, completion: 0, total: 0 }; }
          b.prompt += tt.legs[leg].prompt;
          b.completion += tt.legs[leg].completion;
          b.total += tt.legs[leg].total;
        });
      }
      var start = card.prCreated ? parseMs(card.prCreated) : null;
      if (start != null) {
        var end = card.mergedAt ? parseMs(card.mergedAt) : nowMs;
        if (end != null) {
          var lead = Math.max(0, end - start);
          out.lead.n += 1;
          out.lead.totalMs += lead;
          if (out.lead.maxMs == null || lead > out.lead.maxMs) out.lead.maxMs = lead;
        }
      }
    });
    out.ix = undefined;   // internal index — not part of the contract
    if (out.lead.n) out.lead.avgMs = Math.round(out.lead.totalMs / out.lead.n);
    else { out.lead.avgMs = null; out.lead.maxMs = null; }
    return out;
  }

  return { tokenTotals: tokenTotals, ciSplit: ciSplit, phaseRail: phaseRail,
           reworkOf: reworkOf, nextStep: nextStep, flowSummary: flowSummary,
           entriesOf: entriesOf,
           ACTIVE_VERDICTS: ACTIVE_VERDICTS, TS_TO_STATE: TS_TO_STATE };
});
