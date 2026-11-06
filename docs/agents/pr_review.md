# pr review

Reviews a pull request like a senior reviewer: analyzes the diff, checks conventions and risks, and posts inline review comments plus a verdict.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `cacheToReleases` — when enabled, the autocommit timer snapshots accumulated CLI output into a git release asset.
- `scmProvider` — SCM provider override (`github`, `gitlab`, …) for this run.
- `targetRepository` — repository override block (`owner`, `repo`, `baseBranch`, `workingDir`) — run the review against this repository instead of the project default.

- `aiRepository` — repository the AI CLI works in when it differs from the PR repository.
- `allowApproveWithSuggestions` — legacy knob (gh-1351): policy-derived now; setting it against the resolved `reviewPolicy` logs a conflict audit line and the policy wins.
- `autoStartRework` — when `true`, automatically trigger the rework workflow when the review asks for changes.
- `autoStartReworkConfigFile` — agent config file used for the auto-started rework workflow.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `configPath` — path to the project `.dmtools/config.js` to load for this run.
- `customStatuses` — legacy per-invocation override for individual `STATUSES` keys (e.g. `{ "IN_REWORK": "Ready For Development" }`); prefer the project-wide `jira.statuses` override in `.dmtools/config.js` for a project-wide remap instead.
- `formalGithubReview` — when `true`, in addition to the existing `pr_approved` label, formally submit a native GitHub PR review: `REQUEST_CHANGES` when the AI does not approve, or dismiss any prior `REQUEST_CHANGES` review when the AI approves. Does not change the `pr_approved` label lifecycle.
- `maxAutoReworkRounds` — maximum auto-started rework rounds (`rework-round-N` on the ticket, default `3`) before the ticket is labeled `needs-human` and no further rework is chained.
- `maxReviewThreadsBeforeForceApprove` — maximum open review threads before the reviewer is forced to an approve/reject verdict.
- `onApproved` — action to run when the review approves (e.g. trigger merge).
- `projectKey` — tracker project key override.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
