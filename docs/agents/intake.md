# intake

Product intake: analyzes a raw request against existing epics and stories, then creates the missing epics/stories and posts an analysis comment.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
