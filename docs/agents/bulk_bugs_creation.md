# bulk bugs creation

Creates many bug tickets at once from a single test failure analysis: drafts each bug and creates them in bulk with links back to the source.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `batchSize` — maximum number of items processed in one batch.
- `failedReasonField` — tracker field that stores the failure reason.
- `failedTCsJql` — JQL selecting the failed test cases to convert into bugs.
- `feedbackLoop` — feedback-loop options (how review comments are collected and reapplied).
- `openBugsJql` — JQL selecting the open bugs to include.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `smTriggerLabel` — label that marks the ticket as triggered by the SM rule.
