# bug test automation rework

Reworks a bug-test-automation PR after review: reads review comments, fixes the test code, and pushes the updates.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `autoStartReview` — auto start review.
- `autoStartReviewConfigFile` — auto start review config file.
- `checkOpenPR` — check open pr.
- `removeLabel` — remove label.
- `testFilesGlob` — test files glob.
