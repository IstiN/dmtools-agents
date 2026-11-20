# maintainer execute

Structural quality pass — EXECUTE phase. Implements an owner-approved
structural plan produced by the plan phase (`docs/agents/maintainer.md`),
makes each fixed problem class unrepresentable, removes interim guards and
absorbed tests, and opens a pull request. The owner's edited version of the
plan wins over the original.

## Trigger

- `sm.json` rule: ticket label `ai_maintainer_execute` →
  `agents/maintainer_execute.json` (skip label
  `sm_maintainer_execute_triggered`).
- Manual: `workflow_dispatch` on `ai-teammate.yml` with
  `config_file=agents/maintainer_execute.json`.

## Inputs

- The approved plan, prepared in `input/<KEY>/` from the ticket
  (owner edits come back through the tracker context pipeline).
- The case card and findings are in the ticket history (plan-phase leg).

## Runtime

Same development runtime as the dev agents: WIP timer
(`timerAutoCommitAndSave.js`), branch bootstrap
(`preCliDevelopmentSetup.js`), PR pipeline (`developTicketAndCreatePR.js`),
`responseTarget: "scm"` so `outputs/response.md` becomes the PR body.

## Outputs

- Structural commits on the feature branch + the pull request.
- `outputs/response.md` — PR body: plan reference, per-finding
  unrepresentability mechanism, guards removed, tests changed, related
  fixes taken/filed.
- `outputs/blocked.json` — only if the plan is missing from input or
  internally contradictory.

## Parameters

- `maintainerPhase` — `"execute"` (this agent); selects the execute appendix
  via `agents/js/conditions/isMaintainerExecute.js`.
- `removeLabel` — `sm_maintainer_execute_triggered`.
- Development-runtime parameters (branching, autoSave commit message,
  `targetRepository`, …) follow the `story_development` conventions.

## Acceptance

For every fixed finding the PR names the mechanism that makes the problem
class unrepresentable. A guard may ship only if the PR explicitly lists it
as debt with the structural target.
