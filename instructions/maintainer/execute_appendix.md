## EXECUTE phase appendix (maintainerPhase: execute)

This appendix is on your prompt chain because this leg runs the EXECUTE
phase. The plan phase is over; the owner approved — and possibly edited —
the plan. From here:

1. **Read the approved plan from `input/<KEY>/`.** The owner's edited
   version wins over the original posted plan in every disagreement. If the
   input does not contain the plan, do not guess: post ONE comment asking
   for it, write `outputs/blocked.json`, and stop.
2. **Execute the approved steps in order.** Finish a step completely before
   starting the next. Landable units are the milestone GROUPS the plan
   marks — an individual step is transit, not a landing. Do not
   improve beyond the plan: the scope rule in
   `instructions/maintainer/general_guidelines.md` applies (tiny adjacent
   fix → take and list; bigger → file an issue).
3. **If a plan step references code that has moved** since the plan was
   written: adapt locally when the intent is unambiguous; otherwise stop
   with the blocked contract and name the contradiction.
4. **Structural changes, not guards.** For every fixed finding, the
   finished state must make the problem class unrepresentable
   (visibility, extraction, single sanctioned path, state shape). "A guard
   is not a fix" — if you catch yourself adding a check where a shape
   change belongs, go back and change the shape.
5. **Hygiene in the same branch:** remove interim guards and absorbed
   tests; update or delete tests that pin the old structure per
   `instructions/maintainer/test_guidelines.md`.
6. **Verification cadence — mid-rework states are transit, not
   architecture:**
   - Per step: `dart analyze` (whole-tree, seconds). Nothing else — do not
     try to select "affected" tests: the affected set is transitive and
     any selection is a guess.
   - Full suite: at the milestones the plan marks as landable groups, and
     always before finishing. Never after each step. Run it — do not
     assume.
   - A red suite at a milestone is reconciled there by the test_guidelines
     case-1/case-2 rule. Do not chase green on transit: a mid-rework fix
     lands in a shape the next step demolishes.
7. **PR description (`outputs/response.md`) must contain:**
   - reference to the approved plan (ticket key + step list covered),
   - per-finding one-liner: finding → unrepresentability mechanism,
   - guards removed (list) and tests changed (list, with the case-1/case-2
     explanation from test_guidelines where a pin was rewritten),
   - related fixes taken (tiny) and related fixes filed (issue keys),
   - anything the owner edited in the plan that you adapted, and how.

The common completion rules bind: `git_completion_guard.md` and
`completion_post_check.md` — prove the work landed before writing any
summary.
