# bug test automation rework

Reworks a bug-test-automation PR after review: reads the review comments, fixes the test code, and pushes the updates.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartReview` — when `true`, automatically trigger the PR review workflow after this agent finishes.
- `autoStartReviewConfigFile` — agent config file used for the auto-started review workflow.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `testFilesGlob` — glob that selects which test files belong to this automation scope.
