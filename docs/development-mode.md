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

A deterministic pre-leg rule reads the ticket text and routes:

```
plan  if  deliverable-modules ≥ planIfModulesAtLeast (2)
       OR acceptance bullets ≥ planIfAcceptanceBulletsAtLeast (5)
       OR body tokens ≥ planIfBodyTokensAtLeast (800)
else  default
```

- Signal extraction is a pure function over title+body (golden-tested).
- `developmentModeConfig.adaptive.shadowMode: true` ⇒ decide + log only
  (`would plan: …`), never act — used to accumulate routing evidence
  before enabling real routing.
- Thresholds are config, calibrated offline against closed-issue replays;
  the rule is deliberately conservative — inconclusive signals route
  `default`.
- Adaptive never spawns sub-agents.

---

## 3. Config surface

```jsonc
// leg workflow config, params.customParams (same layer as feedbackLoop)
"developmentMode": "default" | "plan" | "adaptive",
"developmentModeConfig": {
  "plan":    { "appendixFile": "optional override path" },
  "adaptive": {
    "planIfModulesAtLeast": 2,
    "planIfAcceptanceBulletsAtLeast": 5,
    "planIfBodyTokensAtLeast": 800,
    "shadowMode": false
  },
  "spawn": { "enabled": false, "maxAgents": 3, "minTasks": 4,
             "gateCommand": "dart test && dart analyze" }
}
```

Unknown `developmentModeConfig` keys are ignored (forward compatibility);
wrong types are warned-and-ignored.

---

## 4. Operational contract

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

---

## 5. Not implemented (by design)

- **Sub-agent fan-out** (`spawn` slice): a planned extension where a
  plan's tasks are handed to parallel scoped sub-legs merged behind a
  test gate. Config defaults to `enabled: false` and the code path does
  not exist; field presence is forward-declaration only.
- **Issue normalization** (pre-leg canonical spec): planned future
  groundwork — a restructuring pass ahead of profile selection. The
  profiles work fully without it.