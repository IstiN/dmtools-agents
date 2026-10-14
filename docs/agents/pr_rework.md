# pr rework

Reworks a pull request after review: reads review comments, implements the requested fixes, and pushes updates to the PR branch.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartReview` — when `true`, automatically trigger the PR review workflow after this agent finishes.
- `autoStartReviewConfigFile` — agent config file used for the auto-started review workflow.
- `branchCreateFnPath` — path to a JS hook that creates the feature branch (two-branch flow customization).
- `branchSyncFnPath` — path to a JS hook that syncs the base branch before rebasing.
- `cacheToReleases` — when enabled, caches the workspace into a git release so later runs restore instead of re-cloning.
- `autoSaveCommitMessage` — optional template for the periodic WIP auto-save commit made by the timer (default `{ticketKey} WIP auto-save {timestamp}`; also `formats.commitMessage.autoSave` in the project config). Use it when the target repo's commit-msg hook requires a tracker key, e.g. `AB#{ticketKey} WIP auto-save {timestamp}`.
- `squashReworkWip` — set `true` to fold the timer's `WIP auto-save` commits (and the rework commit) since the rework base into ONE commit with the `formats.commitMessage.rework` message before the push, using `--force-with-lease`. Skipped (history untouched) when the base is unknown, a merge or a foreign commit is in the range, or there is only one commit. Default off.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `removeLabels` — list of labels removed from the ticket after a successful run.
- `scmProvider` — SCM provider override (`github`, `gitlab`, …) for this run.
- `targetRepository` — repository override block (`owner`, `repo`, `baseBranch`, `workingDir`) — run the work against this repository instead of the project default.
