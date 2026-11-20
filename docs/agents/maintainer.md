# maintainer

Structural quality pass — PLAN phase. Analyzes a subsystem that accumulated
many changes and degraded, finds theoretical/structural problems, and posts
an evidence-based fix plan to the ticket for owner approval. **Makes no code
changes** — the fixes run in the execute leg
(`docs/agents/maintainer_execute.md`) only after the owner approves (and may
edit) the plan.

The role framing is the ownership sentence (Anthropic prompting guidance,
"Say who owns the code"): the agent works as the long-term maintainer of the
codebase, which measurably flips its behavior from adding workarounds to
consolidating and restructuring. Dev legs keep the opposite (guest) framing
on purpose — the two roles are complements, not settings of one agent.

## Trigger

- `sm.json` rule: ticket label `ai_maintainer_plan` → `agents/maintainer.json`
  (skip label `sm_maintainer_triggered`).
- Manual: `workflow_dispatch` on `ai-teammate.yml` with
  `config_file=agents/maintainer.json`.

## Inputs

- The ticket description acts as the case card: symptom ("many changes
  landed, quality degraded"), the scope (subsystem/module or change window),
  and any signals to honor (gate reports, issue cluster).
- Prepared context in `input/<KEY>/` per the common context pipeline.

## Outputs

- `outputs/maintainer-findings.md` — per finding: symptom, structural root
  cause (file/symbol/line + quote), why it keeps producing bugs, target
  structure, unrepresentability mechanism, risk.
- `outputs/maintainer-plan.md` — numbered, independently landable steps with
  deletions, test changes, risks.
- A ticket comment with the condensed findings + plan and the approval ask.
- No branch, no commits, no PR.

## Parameters

Configured via `customParams` in the agent JSON or the project
`.dmtools/config.js` (project values win).

- `maintainerPhase` — `"plan"` (this agent); `"execute"` on
  `maintainer_execute.json`. Selects the prompt appendix via
  `agents/js/conditions/isMaintainerExecute.js`.
- `removeLabel` — label removed after a successful run
  (`sm_maintainer_triggered`).
- `targetRepository` — repository override block, same semantics as the
  development agents.

## Next

Owner approval → label `ai_maintainer_execute` → `maintainer_execute.json`.
