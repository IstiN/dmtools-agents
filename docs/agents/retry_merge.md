# retry merge

Retries a pull request merge that previously failed (for example due to temporary CI flakiness) and reports the outcome.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `autoStartRework` — auto start rework.
- `autoStartReworkConfigFile` — auto start rework config file.
- `checkOpenPR` — check open pr.
- `removeLabel` — remove label.
- `testCaseMerge` — test case merge.
