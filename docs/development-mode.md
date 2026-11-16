# Development Mode — dev leg execution profiles

How a dev leg (ticket → branch → PR) selects its execution profile. One
leg-config field, `params.customParams.developmentMode`, switches the leg
between working an issue directly and working it through an explicit,
committed task plan — with the routing decision optionally made per
ticket. This document defines the knob, the profiles, the config surface
and the operational contract.

---

## 1. The knob

```
params.customParams.developmentMode ∈ { default | plan | adaptive }
```

- Validated where the leg config is read (`developTicketAndCreatePR.js`,
  `initDevelopmentContext` — the same layer as `customParams.feedbackLoop`).
- **Missing, empty or unknown ⇒ `default`** plus one warning naming the
  offending value. The leg never fails because of this field.
- The resolved mode is logged per leg (`developmentMode=<resolved>`).
- Reach: every leg that routes through the shared
  `initDevelopmentContext` path (`story_development`,
  `bug_development`, …).

Design invariant: **the knob is inert by construction.** Profile code is
the only consumer of the resolved mode; `default` semantics are byte-for-
byte the pre-knob behavior (regression-guarded).

---

## 2. Profiles

### 2.1 `default`

Direct execution — no plan artifacts, no prompt appendix, no thresholds.
This is the historical behavior and the routing target for focused,
fully-specified work.

### 2.2 `plan`

The prompt gains an appendix (engine-shipped text; per-workflow override
via `developmentModeConfig.plan.appendixFile`) that imposes a protocol:

1. **Decompose before editing** — the ticket becomes numbered tasks
   `T1..Tn`, each carrying `what` and `verify` (how the step is checked).
2. **Checkpoint per task** — the plan lives in two places:
   `outputs/<KEY>/plan.md` (working copy) and
   `.dmtools/plan-snapshot.md` (committed to the ai branch, `<KEY>: plan`).
   Completing a task marks `[x]` in both and commits
   (`<KEY>: plan update T# done`).
3. **Resume rule** — plan file present or branch non-empty at start ⇒
   continuation: reconcile checkboxes against the actual diff, execute
   only pending tasks.

The committed snapshot is the point: plan state survives interruption
windows and session-cache misses. It complements — never replaces — the
session restore path, which remains the primary resume mechanism.

### 2.3 `adaptive`

An in-leg decision: the agent surveys the ticket and the relevant
code, estimates the work in story points, and self-selects its working mode.

- The leg carries the **scope-estimate appendix** (engine text materialized at
  `.dmtools/development-mode-adaptive-appendix.md`, see
  `js/common/developmentModeAdaptive.js`). It instructs: estimate
  effort/risk/uncertainty on the fibonacci scale 1/2/3/5/8/13 — not file
  count; structural surprises (migrations, second repositories) estimate
  higher; uncertainty resolves up.
- The estimate is recorded as one JSON line in the leg's outputs:
  `outputs/<KEY>/scope_estimate.json` → `{"sp", "threshold", "mode",
  "reason", "outcome"}`. `outcome` is finalized (`completed` | `blocked`)
  before the completion report. `model` and legs-per-ticket are NOT
  agent-written: the harness usage line already carries the model, and the
  leg count is derived offline from those lines.
- **Routing**: `sp >= planThreshold` (config, default **3** — calibrated by
  a paired direct/plan run: SP 1–2 neutral, plan net-positive from SP 3)
  ⇒ the leg reads the plan appendix file (materialized alongside as an
  escalation read; the plan cliPrompts entry stays gated to explicit `plan`
  mode) and follows the plan protocol for the rest of the leg. Below the
  threshold ⇒ direct execution, no plan artifacts. Mid-work re-estimates
  reaching the threshold escalate the same way — never demote.
- A leg that self-selected plan and completes through the PR-comment path
  stamps the informational `dev-plan-escalated` label (legs ending on the
  blocked/already-fixed/interrupted exits leave the decision record as the
  durable signal; a label failure is a warn, never a leg failure).
- `shadowMode: true` ⇒ nothing materializes, nothing routes (the would-act
  line is logged) — carried over from the pre-leg signal era.
- The retired pre-leg signal rule (`planIfModulesAtLeast` /
  `planIfAcceptanceBulletsAtLeast` / `planIfBodyTokensAtLeast`) is retired
  from this repo's routing: text signals calibrated at ≈0.61 precision on
  closed-issue replays and cannot separate design-bearing work from
  mechanical sweeps. The extractor + calibration harness stay for legacy
  pack consumers.
- The prompt-cost shape differs from `plan`: every adaptive leg carries the
  adaptive block (the decision instructions); the full plan appendix enters the
  prompt only for explicit `plan` legs — an escalated adaptive leg reads it
  from disk when it escalates.

## 3. Config surface

```jsonc
// leg workflow config, params.customParams (same layer as feedbackLoop)
"developmentMode": "default" | "plan" | "adaptive",
"developmentModeConfig": {
  "plan":    { "appendixFile": "optional override path" },
  "adaptive": {
    "planThreshold": 3,               // in-leg SP routing threshold; default 3
    "shadowMode": false,                // true = nothing materializes/routes, log only
    // legacy text-signal knobs — parsed for forward compatibility,
    // UNUSED by this repo's routing (kept for legacy pack consumers)
    "planIfModulesAtLeast": 2,
    "planIfAcceptanceBulletsAtLeast": 5,
    "planIfBodyTokensAtLeast": 800
  },
}
```

Unknown `developmentModeConfig` keys are ignored (forward compatibility);
wrong types are warned-and-ignored.

---

## 4. Calibration (offline)

**SP routing (`planThreshold`)**: the threshold is re-tuned from the
per-leg decision records (`outputs/<KEY>/scope_estimate.json`) read offline —
one line per leg carries sp/threshold/mode/outcome; legs-per-ticket and model
come from the harness usage lines. Model bumps shift SP estimates, so the
record carries the model via the usage line — drift is visible per model
generation.

**Legacy (signal thresholds)**:

Threshold validity is expert review of a decision table, not a numeric bar
owner decision: the harness replays the rule over an
expert-labeled sample and the owner tunes thresholds (config-only) from the
disagreement cases.

```bash
node js/adaptiveCalibrationHarness.js <sample.json> \
  [--out adaptive-decision-table.md] \
  [--planIfModulesAtLeast 2] [--planIfAcceptanceBulletsAtLeast 5] [--planIfBodyTokensAtLeast 800]
```

- Sample format: `{ "issues": [ { "key", "title", "body", "label" } ] }` —
  `label` is the expert verdict, exactly `plan` or `default` (anything else
  is flagged invalid and excluded from the stats). A documented example
  sample lives in `examples/adaptive-calibration-sample.example.json`.
- The artifact (markdown, deterministic — no timestamps) lists, per issue:
  signals, would-decide, expert label, agree/disagree, plus a disagreements
  section and agreement/precision/recall numbers (informational only).
- The replay uses the SAME extractor and decision the legs run, so a table
  is faithful to production routing; re-running with different thresholds is
  a config-only diff of the artifact.

---

## 5. Operational contract

- **Factory pass-through** — the workflows layer selects the config
  *file* and hands its path to the engine (`AI_TEAMMATE_CONFIG_FILE`);
  it never reads or transforms content. New `customParams.*` fields ride
  untouched (wrapper-side record: dmtools-agentic-workflows#92).
- **Pack version** — legs resolve the agents pack through
  `vars.AGENTS_VERSION` (`latest` ⇒ newest `agents-rel-*` release; a
  pinned tag ⇒ that tag). A repo riding `latest` picks up profile
  features on the next release; a pinned repo must bump before relying
  on them. The self-hosted engine repo rides `latest` by default.
- **Retry / interruption** — unchanged: session restore is the primary
  resume mechanism; under `plan` the committed snapshot additionally
  covers session-cache misses. Failure handling (missing response,
  rework loops) stays with the existing feedback machinery.

