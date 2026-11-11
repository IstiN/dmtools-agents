# Development mode (`developmentMode`) — what it is and how dev legs use it

> Canonical explanation for the dev-leg development modes. Base material for skills, agents and humans: everything needed to understand or operate the knob without reading the epic. Epic: #1440 · knob: #1435 (merged, #1441) · plan-mode execution: #1436 · adaptive: #1437 · rollout: #1438.

## One paragraph

A dev leg (the agent that takes a ticket and produces a branch + PR) can run in three modes selected by one leg-config field — `customParams.developmentMode`: **`default`** (today's behavior: read ticket → work → PR), **`plan`** (always decompose first: write a numbered task plan, verify each task, keep the plan committed as state), **`adaptive`** (decide plan-vs-default per ticket from measurable signals). The field is inert-by-design until wired: missing or unknown value ⇒ `default`, exactly the pre-knob behavior.

## Why it exists (measured, not vibes)

Local A/B on this repo's own work patterns + 100-issue calibration (2026-11-10):

- On **big/architectural tickets** the plan is self-paying: −5% billed, −22% wall, +24% tests on the pilot; historically ~1 in 2 big tickets had rework laps that a staged plan plausibly trims.
- On **small tickets** the plan is pure overhead: +32% billed median (≈ +1–2 min) with no offsetting gain.
- Text-only signals cannot reliably separate the two classes (precision ceiling ≈0.61–0.74) — see docs calibration note in #1437.
- Practical consequence: **this repo runs `plan`** (its ticket population is plan-heavy); the `adaptive` knob exists for mixed-population consumer repos where shielding small tickets is the whole point.

## The three modes — exact semantics

### `default`
Unchanged behavior. No plan artifacts, no appendix in the prompt, no thresholds consulted. Regression-guarded: a default-mode leg is byte-identical to the pre-knob engine.

### `plan`
The leg's prompt gains one appendix (engine-shipped text, per-workflow override via `developmentModeConfig.plan.appendixFile`). The protocol it imposes:

1. **Decompose before editing**: read the ticket, emit numbered tasks T1..Tn — each with `what` and `verify` (how to check). Written to `outputs/<KEY>/plan.md` **and** `.dmtools/plan-snapshot.md`; the snapshot is **committed** (`<KEY>: plan`).
2. **Per-task checkpointing**: after each task — mark `[x]` in both files, commit the plan update, then next task.
3. **Resume rule**: plan exists or branch non-empty at start ⇒ continuation — reconcile checkboxes against the actual diff, execute only pending tasks. Do not redo done work.

The snapshot-committed-early property is deliberate: the plan survives interruption windows and session-cache misses (the transcript restore remains the primary resume mechanism — the plan is insurance, not a replacement).

### `adaptive`
Before the leg launches, a deterministic rule reads the ticket text and picks `plan` or `default`:

```
plan  if  deliverable-modules ≥ 2  OR  acceptance bullets ≥ 5  OR  body tokens ≥ 800
else  default
```

- Thresholds are config (`developmentModeConfig.adaptive.*`), final values calibrated on this repo's issues (#1437 carries the method: expert-labeled replay, decision table, owner review).
- `shadowMode: true` → decide + log only ("would plan: modules=3"), never act — the rollout safe mode, and a standing decision-quality collector for repos that want the stats.
- Calibration finding to keep in mind: this repo's closed issues are 54% plan-worthy, so adaptive ≈ mostly-plan here; the knob earns its keep on consumer repos with small-ticket-dominated traffic.

## Config surface

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
  "spawn": { "enabled": false, "maxAgents": 3, "minTasks": 4, "gateCommand": "dart test && dart analyze" }
}
```

`spawn` (sub-agent fan-out: parent plan → N scoped sub-legs → merge + test gate) is designed (#1440 sub-issue 5, POSTPONED) but **not implemented** — `spawn.enabled` defaults to false and the code path does not exist yet.

## Operational notes

- **Resolution + logging**: the engine validates the field in the same layer that reads `customParams.feedbackLoop`; invalid ⇒ `default` + one warning; the resolved mode is logged per leg (`developmentMode=<resolved>`).
- **Reach**: the knob lives in `initDevelopmentContext` (developTicketAndCreatePR.js) — story_development and bug_development legs inherit it through the shared path.
- **Factory pass-through**: the workflows layer (factory-teammate.yml) selects the config *file*, never its content — new `customParams.*` fields ride untouched; wrapper-side record: dmtools-agentic-workflows#92.
- **Pack version**: this repo's legs resolve the agents pack via `AGENTS_VERSION=latest` → newest `agents-rel-*` release — merged features reach legs on the next release; no pin to bump (if `AGENTS_VERSION` is ever pinned, that pin becomes the bump point).
- **Interruption/retry**: unchanged — session restore (gh-742 family) is primary; the committed plan snapshot additionally survives cache misses.

## Status / what lands next

| Piece | State |
|---|---|
| #1435 knob (inert plumbing + validation) | **merged** (#1441, 2026-11-11) |
| #1436 plan-mode execution | queued |
| #1437 adaptive rule + calibration harness | queued |
| #1438 enable (config flip; plan-vs-adaptive decided at approval) | queued, gated on repo-owner approval |
| sub-agent fan-out | postponed — design-of-record in epic #1440 |
| issue normalization (pre-leg canonical spec) | postponed — future groundwork |

## References
- Epic #1440 (evidence tables: S1/B1/B2/B3 experiments, external research)
- Calibration: #1437 (method + results summary; local dossier `audit/plan-mode-issues/03a`)
- Wrapper pass-through/version-path record: dmtools-agentic-workflows#92
