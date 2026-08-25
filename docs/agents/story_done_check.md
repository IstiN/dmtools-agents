# story done check

Verifies that a story can move to Done: checks that tests passed and PRs merged, then transitions the ticket or reports what is missing.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `customStatuses` — status name overrides for this workflow (maps logical statuses to project-specific names).
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
