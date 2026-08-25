# story test automation

Writes automated tests for a story: generates test code from the acceptance criteria, runs it, and opens a PR with the new tests.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `autoStartReview` — auto start review.
- `autoStartReviewConfigFile` — auto start review config file.
- `checkOpenPR` — check open pr.
- `customStatuses` — custom statuses.
- `removeLabel` — remove label.
- `testFilesGlob` — test files glob.
