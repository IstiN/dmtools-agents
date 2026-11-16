# gh-1503 — SP-based adaptive mode selection (in-leg estimate → threshold → plan/default)

SP estimate: **5** (multi-module wiring: new module + seam + postJSAction label + 3 configs + docs; design settled by the issue; no migrations, one repo). Threshold 3 ⇒ plan mode.

## Tasks

### T1 — SP threshold + record parsing module ✅
**What**: new `js/common/developmentModeAdaptive.js`:
- `resolvePlanThreshold(customParams)` → `{threshold, source}`; reads
  `developmentModeConfig.adaptive.planThreshold`; default `3`; invalid type / out of
  range 1..13 / non-integer ⇒ warn + default (same warn-and-survive pattern as the knob).
- `parseScopeEstimateRecord(text)` → `{sp, threshold, mode, reason, outcome}` | `null`;
  malformed / missing fields / non-numeric sp ⇒ `null` (fail safe to direct).
- `materializeAdaptiveAppendix(ctx)` → writes `.dmtools/development-mode-sp-appendix.md`
  (engine default text, embedded; threshold value interpolated; escalation rule
  references `.dmtools/development-mode-plan-appendix.md`; completion rule: merge
  `outcome` into `outputs/<KEY>/scope_estimate.json` before response.md) and
  co-materializes the plan appendix file; removes stale state for `default`/`plan`.
**Verify**: unit tests — threshold valid/default/invalid paths; record parse valid +
malformed (no sp, sp:"5", truncated JSON) → null; materialized file contains the
threshold number and both file paths; default mode leaves no appendix files.
**DONE** 16/16 UT green (d9fd3434d).

### T2 — Seam: adaptive routes through the adaptive appendix ✅
**What**: `js/developTicketAndCreatePR.js` `initDevelopmentContext` — `adaptive`
materializes the adaptive appendix (in-leg decision) instead of running the pre-leg signal
rule; `developmentMode.js` logs the resolved sub-mode (`adaptive:sp`); the signal
extractor stays exported for legacy consumers + the calibration harness (unused by
this repo's routing); docs invariant updated (byte-identical promise applies to
`default` only; `adaptive` legs always carry the adaptive appendix by design).
**Verify**: IT-style unit test on `initDevelopmentContext` with fake params:
`adaptive` → adaptive appendix exists, no pre-leg routing decision logged; `plan` → plan
appendix only; `default` → neither; stale-file cleanup across mode switches.

### T3 — Label stamping on escalation ✅
**What**: `developTicketAndCreatePR.js` post-processing (mirrors the ai_concerns
pattern): read `outputs/<KEY>/scope_estimate.json` via `readOutputFileDetailed`;
`mode === "plan"` ⇒ add informational label `dev-plan-escalated`; absent/unparsable
⇒ no-op; read/label failure ⇒ warn, never fail the leg.
**Verify**: unit test — record mode=plan stamps label; record absent → no label;
malformed → no label, no throw.

### T4 — Enable adaptive for this repo's dev legs ✅
**What**: `story_development.json` (+ `bug_development.json` if it routes through the
same action): `customParams.developmentMode: "adaptive"`,
`customParams.developmentModeConfig.adaptive.planThreshold: 3`.
**Verify**: JSON valid; values present; `node -e` load check.

### T5 — Docs ✅
**What**: `docs/development-mode.md` — §2.3 rewritten (in-leg adaptive decision replaces
pre-leg signals; signals kept for legacy consumers/harness), §3 config surface
(+`planThreshold` default 3), §4 calibration note (offline decision-log replay
replaces signal-threshold tables for this repo), invariant correction from T2.
**Verify**: doc self-consistent; no stale claims vs code.

### T6 — Full suite + PR ✅ (push/PR in flight)
**What**: register the new test in `run_all.json`; run the full unit suite; fix
fallout; commit per-task messages (`gh-1503: …`); push branch; PR
("Implements #1503" — no closing keywords per the completion guard).
**Verify**: full suite green; PR open with the branch diff.

## Decisions
- Adaptive semantics: `planThreshold` present ⇒ in-leg SP mode; the legacy signal
  rule is NOT deleted (other consumers + harness), this repo's routing stops using it.
- The adaptive appendix co-materializes the plan appendix so escalation needs no second
  pass; direct legs just ignore it.
- Record lives in `outputs/<KEY>/scope_estimate.json` (existing outputs convention);
  `model`/`legs_spent` derived offline from fa-tokens lines (per issue).
- Label `dev-plan-escalated` is informational (same class as `ai_concerns`).

## Open questions
- RESOLVED: bug_development delegates to developTicketAndCreatePR.action() — one seam covers both; both configs wired.
- RESOLVED: dynamic_repo template stays `default` (consumer repos opt in per issue scope).
