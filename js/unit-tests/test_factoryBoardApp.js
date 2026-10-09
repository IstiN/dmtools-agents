/**
 * Unit tests for site/factory/app.js — source-level regression guards.
 *
 * app.js is a browser IIFE (needs document/window), so it cannot be
 * loadModule'd like the pure modules (steps.js, flow.js). These tests read
 * the source and pin the STRUCTURE the review threads called out, so a
 * future edit can't silently reintroduce the exact defects:
 *
 *   thread 1 (BLOCKING) — the flowHtml token chip interpolates snapshot
 *      tokens[].leg names into a title attribute; unescaped it is an XSS
 *      sink (the file's own ?fixture= threat model declares card data
 *      untrusted).
 *   thread 3 — a cache-stale index.html without <section id="flow"> must
 *      degrade like the missing flow.js script does, not kill the board.
 *   thread 6 — the drawer's ciSplit row label derives from the card's
 *      state (RUNNING_LABELS), and the phase rail is computed ONCE per
 *      drawer open, shared by the history and value-stream sections.
 */

var assert = globalThis.assert;

var APP_SRC = file_read({ path: 'site/factory/app.js' })
  // whitespace-insensitive matching — the assertions are about structure,
  // not formatting
  .replace(/\s+/g, ' ');

suite('factoryBoardApp — flowHtml token chip escaping (BLOCKING, review thread 1)', function () {
  test('legs string interpolated into the title attribute goes through esc()', function () {
    assert.notContains(APP_SRC,
      'title="\' + Object.keys(s.tokens.legs)',
      'snapshot tokens[].leg interpolated RAW into a title attribute — ' +
      'a leg containing `"` breaks out of the attribute (XSS)');
    assert.contains(APP_SRC,
      'title="\' + esc(Object.keys(s.tokens.legs)',
      'the chip title must escape the legs string, exactly like tokChipHtml ' +
      'esc()s the same data and drawerFlowHtml esc()s each leg key');
  });
});

suite('factoryBoardApp — #flow cache-drift guard (review thread 3)', function () {
  test('a missing #flow element degrades to a no-op stub like the missing flow.js script', function () {
    assert.contains(APP_SRC,
      "document.getElementById('flow') || { innerHTML: '', hidden: true }",
      'skeleton()/render()/fail() all write flowEl.innerHTML — unguarded, a ' +
      'cache-stale index.html without <section id="flow"> throws on first ' +
      'paint and the whole board (error banner included) never renders');
  });
});

suite('factoryBoardApp — drawer value-stream row (review thread 6)', function () {
  test('the ciSplit row label derives from the card state, not a hard-coded validating', function () {
    assert.contains(APP_SRC, 'RUNNING_LABELS',
      'the state → label map exists (pr_validation validating / validating ' +
      'mutex / review last run)');
    assert.notContains(APP_SRC, "rows.push([ 'validating'",
      'the drawer may not label every card with checks "validating" — a ' +
      'review-lane card sits in Review, not in CI');
    assert.notContains(APP_SRC, "rows.push(['validating'",
      'the drawer may not label every card with checks "validating" — a ' +
      'review-lane card sits in Review, not in CI');
  });

  test('the phase rail is computed once per drawer open, shared by both sections', function () {
    var uses = APP_SRC.split('FLOW.phaseRail(FLOW.entriesOf(').length - 1;
    assert.equal(uses, 1,
      'openDrawer computes terminal + rail exactly once; drawerHistoryHtml ' +
      'and drawerFlowHtml consume the same rail (provably consistent)');
  });
});

// ── gh-825 — model + $cost surfaces ──────────────────────────────────────────
// The drawer's token table gains model + $ columns (card Σ$ on the total
// row), the token chip gains the card Σ$, the flow strip chip gains the
// board Σ$, and the header gains the tick-published global Σ$ pill. Model
// ids come from report input — every interpolation escapes like leg names.

suite('factoryBoardApp — drawer token table model + $ columns (gh-825)', function () {
  test('model ids interpolate through esc() — snapshot data is untrusted', function () {
    assert.contains(APP_SRC, "esc(t.model)",
      'the drawer token table escapes the model id, exactly like t.leg');
    assert.notContains(APP_SRC, "+ t.model +",
      'a raw t.model interpolation is an XSS sink (model comes from the ' +
      'tokens ledger — the ?fixture= threat model declares card data ' +
      'untrusted)');
  });

  test('per-row and total $ cells render through fmtUsd (numeric — but one formatting path)', function () {
    assert.contains(APP_SRC, 'function fmtUsd(',
      'one USD formatter: < $0.01 keeps 4 decimals (a leg is often a ' +
      'fraction of a cent), 2 decimals above');
    assert.contains(APP_SRC, 'esc(fmtUsd(t.cost))',
      'the per-row $ cell uses it');
  });
});

suite('factoryBoardApp — header global Σ$ pill (gh-825)', function () {
  test('the cost pill degrades to a stub when a cache-stale index.html lacks #cost-pill', function () {
    assert.contains(APP_SRC,
      "document.getElementById('cost-pill') ||",
      'cache-drift guard (review thread 3 pattern): a stale index.html ' +
      'without the pill must not throw on first paint');
  });

  test('an absent state.costs hides the pill (tokens-only factories stay clean)', function () {
    assert.contains(APP_SRC, 'costPill.hidden = true',
      'no costs in the snapshot → no pill, never a lying $0.00');
  });
});
