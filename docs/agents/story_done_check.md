# story done check

Verifies that a story really can move to Done: checks tests passed and PRs merged, then transitions the ticket or reports what is missing.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `customStatuses` — custom statuses.
- `removeLabel` — remove label.
