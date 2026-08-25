# bug development

Implements a bug fix end to end: checks out the repository, analyzes the root cause, writes the fix with tests, and opens a pull request.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `branchCreateFnPath` — path to a JS hook that creates the feature branch (two-branch flow customization).
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `targetRepository` — repository override block (`owner`, `repo`, `baseBranch`, `workingDir`) — run the work against this repository instead of the project default.
