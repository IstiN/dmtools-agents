# bug fix batch development

Fixes a whole batch of related bugs in one branch: reads the batch epic context, implements all fixes with tests, and opens a single pull request.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
