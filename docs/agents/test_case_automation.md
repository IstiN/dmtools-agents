# test case automation

Automates a single manual test case: converts it into executable test code and opens a PR with the result.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `autoStartReview` — auto start review.
- `autoStartReviewConfigFile` — auto start review config file.
- `checkOpenPR` — check open pr.
- `removeLabel` — remove label.
- `testFilesGlob` — test files glob.
