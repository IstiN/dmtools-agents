# intake

Product intake: analyzes a raw request against existing epics and stories, then creates the missing epics/stories and posts an analysis comment.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `issuePlanning` (GitHub) — `{ devLabel, plannedLabel, maxParallel }`, defaults `agent:dev`, `ai_planned`, `1`; shared with the GitHub SM rule `plan-advance`.

## GitHub

On a GitHub tracker the created entries are **sub-issues**: Bugs, Epics and top-level Stories of the
processed issue, Stories with a parent of their new Epic. Issue types, Story Points, priority,
attachments and links do not exist there and are skipped.

- The `blockedBy` order is recorded in a plan comment on every parent (hidden marker), and each parent
  is labeled `issuePlanning.plannedLabel`. The SM rule `plan-advance` then starts the sub-issues whose
  blockers are closed — in order, at most `maxParallel` at a time — and closes a parent when all of its
  sub-issues are closed. An Epic's own `blockedBy` holds back all of its Stories.
- Re-runs are safe: each sub-issue carries a hidden marker of its entry, and an entry whose sub-issue
  already exists (by marker, else by title) is reused. A parent is labeled planned only when every
  entry exists, so after a partial failure the agent is simply run again.
- Requirement: no runtime ships a sub-issue tool yet, so sub-issues are read and attached through the
  REST API with the GitHub CLI — the runner needs `gh` installed and authenticated (`GH_TOKEN`).
