# pr review

Reviews a pull request like a senior reviewer: analyzes the diff, checks conventions and risks, and posts inline review comments plus a verdict.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `aiRepository` — ai repository.
- `allowApproveWithSuggestions` — allow approve with suggestions.
- `autoStartRework` — auto start rework.
- `autoStartReworkConfigFile` — auto start rework config file.
- `checkOpenPR` — check open pr.
- `configPath` — config path.
- `maxReviewThreadsBeforeForceApprove` — max review threads before force approve.
- `onApproved` — on approved.
- `projectKey` — project key.
- `removeLabel` — remove label.
