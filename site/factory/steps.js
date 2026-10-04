/*
 * Factory Board — per-card pipeline stepper logic (gh-726).
 *
 * The card status strip is a LABELED stepper, not anonymous dots: six named
 * steps in pipeline order, each in one of four states —
 *   done    the step's timestamp is stamped (or a later step is)
 *   current the card's lane IS this step (pulsing on the board)
 *   pending not reached yet (dim outline)
 *   failed  the latest validation run came back red (red node)
 *
 * Pure logic, zero DOM: the board (app.js) renders the returned states;
 * the unit tests load the same file via loadModule. Dual-exported —
 * window.FACTORY_STEPS in the browser, module.exports under the test
 * harness.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.FACTORY_STEPS = api; }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // The six named steps, in pipeline order. `ts` = the schema-2 card field
  // that proves the step happened (mirrors js/factoryState.js).
  var STEPS = [
    { id: 'dev',     name: 'dev',     ts: 'devStartedAt' },
    { id: 'pr',      name: 'pr',      ts: 'prCreated' },
    { id: 'valid',   name: 'valid',   ts: 'validatingAt' },
    { id: 'review',  name: 'review',  ts: 'reviewedAt' },
    { id: 'approve', name: 'approve', ts: 'approvedAt' },
    { id: 'merge',   name: 'merge',   ts: 'mergedAt' }
  ];

  // lane id → the step that IS the card's current position. Both validation
  // lanes (pr_validation = head run in flight, validating = post-approve
  // mutex run) light the same `valid` step — the strip names the leg, the
  // lane names the window. Backlog buckets carry no current step: an issue
  // not on the PR pipeline yet has no lit node (dev is next only once the
  // dev leg actually started — in_dev).
  var LANE_STEP = {
    development: 'dev',
    pr_created: 'pr',
    pr_validation: 'valid',
    review: 'review',
    approved_queue: 'approve',
    validating: 'valid',
    merged_recent: 'merge',
    in_dev: 'dev'
  };

  // checks verdicts that mean "the validation run came back red" (mirrors
  // app.js verdictClass's bad set)
  var FAILED_VERDICTS = ['failure', 'timed_out', 'startup_failure'];

  // [{id, name, state, at}] — one entry per step, pipeline order.
  //   state: 'done' | 'current' | 'pending' | 'failed'
  //   at:    the step's ISO timestamp, or null when unknown
  function stepStates(card, laneId) {
    card = card || {};
    var currentId = LANE_STEP[laneId] || null;
    var failedValid = card.checks &&
      FAILED_VERDICTS.indexOf(card.checks.verdict) >= 0;
    var merged = !!card.mergedAt;

    // monotonic fill: once ANY later step is stamped, earlier un-stamped
    // steps read done too — a card that reached approve provably passed
    // review even if the reviewedAt label time was lost
    var laterStamped = false;
    var stampedFrom = {};
    for (var i = STEPS.length - 1; i >= 0; i--) {
      stampedFrom[STEPS[i].id] = laterStamped || !!card[STEPS[i].ts];
      if (card[STEPS[i].ts]) laterStamped = true;
    }

    return STEPS.map(function (s) {
      var state;
      if (merged) {
        state = 'done';                    // terminal — position is "merged"
      } else if (s.id === 'valid' && failedValid) {
        state = 'failed';                  // the run came back red
      } else if (s.id === currentId) {
        state = 'current';                 // the card's lane — wins over done
      } else if (card[s.ts] || stampedFrom[s.id]) {
        state = 'done';
      } else {
        state = 'pending';
      }
      return { id: s.id, name: s.name, state: state,
               at: card[s.ts] || null };
    });
  }

  return { STEPS: STEPS, LANE_STEP: LANE_STEP,
           FAILED_VERDICTS: FAILED_VERDICTS, stepStates: stepStates };
});
