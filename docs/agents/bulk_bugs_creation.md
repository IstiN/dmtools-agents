# bulk bugs creation

Creates many bug tickets at once from a single analysis: drafts each bug and creates them in bulk with links back to the source.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `batchSize` — batch size.
- `failedReasonField` — failed reason field.
- `failedTCsJql` — failed tcs jql.
- `feedbackLoop` — feedback loop.
- `openBugsJql` — open bugs jql.
- `removeLabel` — remove label.
- `smTriggerLabel` — sm trigger label.
