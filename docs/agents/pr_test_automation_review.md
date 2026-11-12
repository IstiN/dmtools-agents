# pr test automation review

Reviews a test-automation pull request and posts structured review comments on it.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartRework` — when `true`, automatically trigger the rework workflow when the review asks for changes.
- `autoStartReworkConfigFile` — agent config file used for the auto-started rework workflow.
- `maxAutoReworkRounds` — maximum auto-started rework rounds (`rework-round-N` on the ticket, default `3`) before the ticket is labeled `needs-human` and no further rework is chained.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).

- `responseTarget`: `"scm"` — `outputs/response.md` becomes the PR body/comment, so the output-format prompt is GitHub-Flavored Markdown even on Jira (conditions `isResponseToScm.js` / `isResponseToTracker.js`).
