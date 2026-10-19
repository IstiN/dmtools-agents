# bug development

Implements a bug fix end to end: checks out the repository, analyzes the root cause, writes the fix with tests, and opens a pull request.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `branchCreateFnPath` — path to a JS hook that creates the feature branch (two-branch flow customization).
- `cacheToReleases` — when enabled, the autocommit timer also snapshots accumulated CLI output into a git release asset (restore point on a killed run).
- `autoSaveCommitMessage` — optional template for the periodic WIP auto-save commit made by the timer (default `{ticketKey} WIP auto-save {timestamp}`; also `formats.commitMessage.autoSave` in the project config). Use it when the target repo's commit-msg hook requires a tracker key, e.g. `AB#{ticketKey} WIP auto-save {timestamp}`.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `scmProvider` — SCM provider override (`github`, `gitlab`, …) for this run (autocommit timer and release snapshots route through it).
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `providerTransientBackoffSec` — backoff seconds before the one bounded resume of the persisted fa session when the leg died in a whole-provider-chain outage (HTTP 5xx/429 "Provider chain exhausted"; default `90`). The outage resume fires even with the feedback loop disabled globally; `feedbackLoop.missingResponse.enabled: false` opts out. When the resume fails, the reset comment names the failing models and codes instead of guessing a rate limit.
- `targetRepository` — repository override block (`owner`, `repo`, `baseBranch`, `workingDir`) — run the work against this repository instead of the project default.
