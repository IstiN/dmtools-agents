# bug done check

Verifies that a bug can move to Done: checks that linked tests passed and the fix PR merged, then transitions the ticket or reports what is missing.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
