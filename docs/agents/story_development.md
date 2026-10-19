# story development

Implements a story end to end: checks out the repository, writes the code and tests, and opens a pull request linked to the story.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartReview` — when `true`, automatically trigger the PR review workflow after this agent finishes.
- `autoStartReviewConfigFile` — agent config file used for the auto-started review workflow.
- `branchCreateFnPath` — path to a JS hook that creates the feature branch (two-branch flow customization).
- `cacheToReleases` — when enabled, caches the workspace into a git release so later runs restore instead of re-cloning.
- `autoSaveCommitMessage` — optional template for the periodic WIP auto-save commit made by the timer (default `{ticketKey} WIP auto-save {timestamp}`; also `formats.commitMessage.autoSave` in the project config). Use it when the target repo's commit-msg hook requires a tracker key, e.g. `AB#{ticketKey} WIP auto-save {timestamp}`.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `customStatuses` — status name overrides for this workflow (maps logical statuses to project-specific names).
- `providerTransientBackoffSec` — backoff seconds before the one bounded resume of the persisted fa session when the leg died in a whole-provider-chain outage (HTTP 5xx/429 "Provider chain exhausted"; default `90`). The outage resume fires even with the feedback loop disabled globally; `feedbackLoop.missingResponse.enabled: false` opts out. When the resume fails, the reset comment names the failing models and codes instead of guessing a rate limit.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `removeLabels` — list of labels removed from the ticket after a successful run.
- `scmProvider` — SCM provider override (`github`, `gitlab`, …) for this run.
- `targetRepository` — repository override block (`owner`, `repo`, `baseBranch`, `workingDir`) — run the work against this repository instead of the project default.
