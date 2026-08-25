# bug merged

Notifies the team when a bug fix PR is merged and moves the bug ticket to its post-merge status.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
