# task done check

Gate check: verifies that all stories of a task are done before the task itself moves to Done.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
