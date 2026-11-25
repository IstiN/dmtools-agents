# gh-1540 — plan: review phase in-progress state carrier (`ai_reviewing`) + duplicate-leg race guards

Root gap: the review phase has no "in progress" twin of `ai_validating`, arming rules are latch-free,
and the intra-tick dispatch window between two lanes is unguarded; workflow-level concurrency keys on
the anchor instead of the branch. Fix = the ticket's four-part proposal.

- [x] T1. `LABELS.AI_REVIEWING = 'ai_reviewing'` in `js/config.js` (the shared constant both actions read).
  - verify: `grep -n "AI_REVIEWING" js/config.js` → the constant exists; suites that read LABELS stay green.
- [x] T2. TDD matcher guards: every review arming rule skips while `ai_reviewing` is present —
  add `ai_reviewing` to `notLabels` (and `notPrLabels` for the issue-anchored pair) of
  `review-after-dev`, `review-machine-unlinked`, `review-external-once`, `review-on-label`,
  `review-on-issue-label` in `sm_github.json` AND the `sm_gitlab.json` twins.
  - tests FIRST: test_smAgent.js — (a) shape tests reading both JSONs (both anchors covered:
    issue-carrier rules check notLabels+notPrLabels, PR-carrier rules check notLabels);
    (b) functional matcher tests through `sm.action` — a PR/issue carrying `ai_reviewing`
    matches none of the five (0 triggers).
  - verify: `dmtools run js/unit-tests/run_smAgent.json`.
- [x] T3. TDD pre-action carrier: `js/preparePRForReview.js` sets `ai_reviewing` on the PR
  (+ linked issue — ticket via tracker when issue-anchored, branch-parsed issue via SCM when
  PR-anchored) right after PR details resolve; non-fatal, dry-run-safe.
  - tests FIRST: test_preparePRForReview.js — label lands on PR + issue; PR-anchored branch parse
    (`ai/gh-77` → issue 77); a throwing scm.addLabel does not fail the leg; dry run writes nothing.
  - verify: `dmtools run js/unit-tests/run_preparePRForReview.json`.
- [x] T4. TDD verdict-time clear: `js/postPReviewComments.js` removes `ai_reviewing` wherever
  `ai_pr_reviewed` is latched — `finishPRAnchoredReview` (PR + linked issue via SCM) and
  `addReviewMarkers` (ticket + PR); plus the missing-review-data exit clears the ticket-side carrier
  (a leg that ends without a verdict must return the world to "review wanted, not running").
  - tests FIRST: test_postPReviewComments.js — both verdict paths remove the carrier on both
    carriers; missing-data path removes the ticket-side one; all removals quiet/non-fatal.
  - verify: `dmtools run js/unit-tests/run_postPRReviewComments.json`.
- [x] T5. TDD in-tick dispatch latch: `js/sm/workflowDispatch.js` — before the real dispatch,
  consult an in-memory per-tick set keyed `branch::leg`; skip + log when already dispatched this
  tick; record after a successful (non-dry) dispatch; no branch → latch inert. Reset at tick start
  (`smAgent.js initTickState`). Export the latch helpers for tests.
  - tests FIRST: test_smAgent.js — two review rules matching the same world in one tick dispatch
    exactly one (AC2, and the skip log names the latch); two ticks each dispatch one (reset works);
    different legs / different branches / no-branch items are NOT suppressed; dry-run does not record.
  - verify: `dmtools run js/unit-tests/run_smAgent.json`.
- [x] T6. Serialize legs per branch at the workflow level: `.github/workflows/ai-teammate.yml` +
  `workflows/ai-teammate.yml.template` + the doc example in `docs/machine-factory-integration.md` —
  concurrency group keyed by `github.ref` on the dispatch path, per-issue key kept on the events
  path, `cancel-in-progress: false` unchanged.
  - tests FIRST: test_aiTeammateTemplate.js — replace the per-PR-fallback concurrency test with
    AC5 assertions (dispatch path keyed by `github.ref`, event path per-issue, no cancel-in-progress).
  - verify: `dmtools run js/unit-tests/run_aiTeammateTemplate.json && dmtools run js/unit-tests/run_workflowLint.json`.
- [x] T7. Coherence: `js/common/nakedPrReconcile.js` — add `ai_reviewing` to `LIFECYCLE_LABELS`
  (a PR mid-review is not a naked PR; the sweep must not re-arm `agent:review` under a live carrier).
  - tests FIRST: test_nakedPrReconcile.js — a PR carrying only `ai_reviewing` is not naked.
  - verify: `dmtools run js/unit-tests/run_nakedPrReconcile.json`.
- [x] T8. Full suite + close-out: `dmtools run js/unit-tests/run_all.json` green; completion guard;
  `outputs/gh-1540/response.md`.
  - verify: run_all exit 0.

## Decisions
- Latch key = `branch::leg` from `rule.inputs.leg`; items without a branch bypass the latch
  (jira-carrier dispatches share no head, and one rule dispatching several no-branch tickets in a
  tick is legitimate — pinned by test).
- Latch skip does NOT consume labels (a transient suppression is not a fulfillment; the next tick
  re-evaluates under the then-present `ai_reviewing` carrier).
- The latch resets in `initTickState` (module state is per-engine; the explicit reset keeps
  multi-`action()` tests and future in-process reuse correct).
- The missing-review-data exit clears only the ticket-side carrier (no PR is resolved at that point);
  the PR-side carrier after a HARD-killed leg is a documented follow-up (staleness sweep territory,
  same class as the ticket's gh-1097 follow-up).

## Open questions
- none blocking — all four ticket sub-fixes are in scope; the ticket's listed follow-ups stay out.
