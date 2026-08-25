# bug fix batch coordinator

Collects several related bugs into one batch epic so they can be fixed together in a single development pass.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `batchSize` — maximum number of items processed in one batch.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
