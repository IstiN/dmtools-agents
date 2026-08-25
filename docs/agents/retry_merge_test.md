# retry merge test

Test variant of retry_merge used to exercise the retry-merge flow safely.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartRework` — when `true`, automatically trigger the rework workflow when the review asks for changes.
- `autoStartReworkConfigFile` — agent config file used for the auto-started rework workflow.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `testCaseMerge` — merge behavior overrides specific to test-case automation PRs.
