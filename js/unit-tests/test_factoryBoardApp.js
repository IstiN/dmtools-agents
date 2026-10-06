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
