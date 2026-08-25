# bug test automation

Writes automated tests for a bug: generates test code from the bug context, runs it locally, and opens a PR with the new tests.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `autoStartReview` — auto start review.
- `autoStartReviewConfigFile` — auto start review config file.
- `checkOpenPR` — check open pr.
- `customStatuses` — custom statuses.
- `removeLabel` — remove label.
- `testFilesGlob` — test files glob.
