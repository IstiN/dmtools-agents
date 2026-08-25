# createRepoTasksMulti

Same as createRepoTasks but fans out across multiple repositories in one run.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `blockedStatus` — status name used for blocked tasks.
- `blocksRelationship` — link type name that marks a blocking relationship between tickets.
- `labels` — labels applied to created tickets.
