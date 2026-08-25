# pr test automation review

Reviews a test-automation pull request and posts structured review comments on it.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartRework` — when `true`, automatically trigger the rework workflow when the review asks for changes.
- `autoStartReworkConfigFile` — agent config file used for the auto-started rework workflow.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
