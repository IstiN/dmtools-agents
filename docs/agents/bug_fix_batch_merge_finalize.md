# bug fix batch merge finalize

Finalizes a merged batch-fix PR: updates the batch epic, links results back to each bug, and moves the batch tickets forward.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
