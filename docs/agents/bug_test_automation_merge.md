# bug test automation merge

Merges an approved bug-test-automation PR and updates the bug ticket with the result.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `onlyAttemptMerge` — when `true`, only attempt the merge and report the result without further ticket transitions.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `storyTestMerge` — merge behavior overrides specific to story test automation PRs.
