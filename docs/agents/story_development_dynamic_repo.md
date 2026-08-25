# story development dynamic repo

Story development variant that resolves the target repository dynamically from the ticket instead of using a fixed project repository.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `targetRepository` — repository override block (`owner`, `repo`, `baseBranch`, `workingDir`) — run the work against this repository instead of the project default.
