# story test automation

Writes automated tests for a story: generates test code from the acceptance criteria, runs it, and opens a PR with the new tests.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartReview` — when `true`, automatically trigger the PR review workflow after this agent finishes.
- `autoStartReviewConfigFile` — agent config file used for the auto-started review workflow.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `customStatuses` — status name overrides for this workflow (maps logical statuses to project-specific names).
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `testFilesGlob` — glob that selects which test files belong to this automation scope.
