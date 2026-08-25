# pr story test automation review

Reviews a story-test-automation pull request: checks test quality against the story acceptance criteria and posts review comments.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartMerge` — when `true`, automatically trigger the merge workflow after an approving review.
- `autoStartMergeConfigFile` — agent config file used for the auto-started merge workflow.
- `autoStartRework` — when `true`, automatically trigger the rework workflow when the review asks for changes.
- `autoStartReworkConfigFile` — agent config file used for the auto-started rework workflow.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
