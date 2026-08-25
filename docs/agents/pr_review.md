# pr review

Reviews a pull request like a senior reviewer: analyzes the diff, checks conventions and risks, and posts inline review comments plus a verdict.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `aiRepository` — repository the AI CLI works in when it differs from the PR repository.
- `allowApproveWithSuggestions` — when `true`, the reviewer may approve a PR while leaving non-blocking suggestions.
- `autoStartRework` — when `true`, automatically trigger the rework workflow when the review asks for changes.
- `autoStartReworkConfigFile` — agent config file used for the auto-started rework workflow.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `configPath` — path to the project `.dmtools/config.js` to load for this run.
- `maxReviewThreadsBeforeForceApprove` — maximum open review threads before the reviewer is forced to an approve/reject verdict.
- `onApproved` — action to run when the review approves (e.g. trigger merge).
- `projectKey` — tracker project key override.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
