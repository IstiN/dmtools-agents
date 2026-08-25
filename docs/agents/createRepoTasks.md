# createRepoTasks

Creates repository housekeeping tasks (setup, CI, docs) as tracker tickets for a new or onboarding repository.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `blockedStatus` — status name used for blocked tasks.
- `blocksRelationship` — link type name that marks a blocking relationship between tickets.
- `labels` — labels applied to created tickets.
