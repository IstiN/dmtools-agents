# Pr Rework

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

_Human doc: [`agents/docs/agents/pr_rework.md`](agents/docs/agents/pr_rework.md)_

## Attributes

| Attribute | Value |
|---|---|
| Job | `Teammate` |
| Config | `pr_rework.json` |
| ContextId | `pr_rework` |
| outputType | `none` |
| skipAIProcessing | `true` |

## Prompt snapshot

Full prompt / instruction set: [`agents/snapshots/pr_rework.md`](agents/snapshots/pr_rework.md)

## Actions

### preJSAction: `checkWipLabel.js`

_Check WIP Label Pre-Action_

- Source: `agents/js/checkWipLabel.js`
- Parameters (customParams):
  - `branchCreateFnPath`
  - `checkOpenPR`
  - `dryRun`

### preCliJSAction: `preCliReworkSetup.js`

_Pre-CLI Rework Setup Action (preCliJSAction for pr_rework agent)_

- Source: `agents/js/preCliReworkSetup.js`
- Writes:
  - `outputs/pr_base_branch.txt`
- Side effects:
  - post ticket comment (via tracker)
  - move ticket to status (via tracker)
  - git merge
- Parameters (customParams):
  - `aiRepository`
  - `allowApproveWithSuggestions`
  - `artefactRepository`
  - `branchCreateFnPath`
  - `branchSyncFnPath`
  - `childQuestions`
  - `commentMarkup`
  - `contexts`
  - `dryRun`
  - `feedbackLoop.qualityGates.gates`
  - `fields`
  - `importantBlocksApproval`
  - `jql`
  - `maxReviewThreadsBeforeForceApprove`
  - `parentContextFetch`
  - `restoreFromReleases`
  - `scmProvider`
  - `setupCommands`
  - `targetRepository`


### postJSAction: `pushReworkChanges.js`

_Push Rework Changes Post-Action_

- Source: `agents/js/pushReworkChanges.js`
- Side effects:
  - add label "agent:rework" (via tracker)
  - post ticket comment (via tracker)
  - move ticket to status (via tracker)
  - assign ticket (via tracker)
  - git checkout
  - git merge
  - git push
- Parameters (customParams):
  - `aiRepository`
  - `artefactRepository`
  - `autoStartReview`
  - `autoStartReviewConfigFile`
  - `cacheToReleases`
  - `commentMarkup`
  - `configPath`
  - `contentOutput`
  - `contentOutput.target`
  - `dryRun`
  - `feedbackLoop`
  - `localTeammate`
  - `managedSubmodules`
  - `projectKey`
  - `providerTransientBackoffSec`
  - `pushSubmodules`
  - `removeLabel`
  - `removeLabels`
  - `scmProvider`
  - `smFallback`
  - `squashReworkWip`
  - `targetRepository`
  - `trackerProvider`

### timerJSAction: `timerAutoCommitAndSave.js`

_Timer JS Action — Auto-commit, push, and save session artefacts_

- Source: `agents/js/timerAutoCommitAndSave.js`
- Side effects:
  - git push
  - git merge
- Parameters (customParams):
  - `aiRepository`
  - `artefactRepository`
  - `autoSaveCommitMessage`
  - `cacheToReleases`
  - `cacheToReleases.releaseNameTemplate`
  - `cacheToReleases.releaseTagTemplate`
  - `scmProvider`
  - `targetRepository`

## LLM step

- outputType: `none`
- Prompt snapshot: `agents/snapshots/pr_rework.md`

## Custom params

- `removeLabels`:

  ```json
  [
    "sm_story_rework_triggered",
    "sm_story_review_triggered",
    "agent:rework"
  ]
  ```
- `checkOpenPR`: `true`
- `branchCreateFnPath` _(used by JS action)_
- `dryRun` _(used by JS action)_
- `aiRepository` _(used by JS action)_
- `allowApproveWithSuggestions` _(used by JS action)_
- `artefactRepository` _(used by JS action)_
- `branchSyncFnPath` _(used by JS action)_
- `childQuestions` _(used by JS action)_
- `commentMarkup` _(used by JS action)_
- `contexts` _(used by JS action)_
- `feedbackLoop.qualityGates.gates` _(used by JS action)_
- `fields` _(used by JS action)_
- `importantBlocksApproval` _(used by JS action)_
- `jql` _(used by JS action)_
- `maxReviewThreadsBeforeForceApprove` _(used by JS action)_
- `parentContextFetch` _(used by JS action)_
- `restoreFromReleases` _(used by JS action)_
- `scmProvider` _(used by JS action)_
- `setupCommands` _(used by JS action)_
- `targetRepository` _(used by JS action)_
- `autoStartReview` _(used by JS action)_
- `autoStartReviewConfigFile` _(used by JS action)_
- `cacheToReleases` _(used by JS action)_
- `configPath` _(used by JS action)_
- `contentOutput` _(used by JS action)_
- `contentOutput.target` _(used by JS action)_
- `feedbackLoop` _(used by JS action)_
- `localTeammate` _(used by JS action)_
- `managedSubmodules` _(used by JS action)_
- `projectKey` _(used by JS action)_
- `providerTransientBackoffSec` _(used by JS action)_
- `pushSubmodules` _(used by JS action)_
- `removeLabel` _(used by JS action)_
- `smFallback` _(used by JS action)_
- `squashReworkWip` _(used by JS action)_
- `trackerProvider` _(used by JS action)_
- `autoSaveCommitMessage` _(used by JS action)_
- `cacheToReleases.releaseNameTemplate` _(used by JS action)_
- `cacheToReleases.releaseTagTemplate` _(used by JS action)_

---
_Generated by js/agentDocGenerator.js_