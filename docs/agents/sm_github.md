# sm github

The GitHub-issues state engine for the machine loop: a pure-JS SM (scrum-master) rule pack that reconciles issue/PR state every tick — re-fires dead dev/rework legs on red CI, dispatches review when a developed PR goes green, and merges approved PRs oldest-first (FIFO) one per tick. State lives in issue/PR labels; the engine is deterministic (no LLM).

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `repository` — target `owner/repo` the rules reconcile.
- `workflowFile` — the runner workflow dispatched for legs (default `ai-teammate.yml`).
- `removeLabel` / `removeLabels` — label(s) stripped from the issue after the rule fires (idempotency).
- `localTeammate` — run the target config's action in-process instead of dispatching a workflow.
- `branchPrefix` — PR head-branch prefix linking PRs to `gh-<n>` issues (default `ai/gh-`).
- `maxWorkflows` — global dispatch cap per tick (default 1).
- `dryRun` — log the plan without acting.
