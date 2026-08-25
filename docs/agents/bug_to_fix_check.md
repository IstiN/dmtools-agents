# bug to fix check

Gate check: decides whether a bug has everything needed (reproduction details, environment, approval) to be taken into development.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
