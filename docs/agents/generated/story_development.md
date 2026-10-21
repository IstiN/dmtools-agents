# Story Development

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

_Human doc: [`agents/docs/agents/story_development.md`](agents/docs/agents/story_development.md)_

## Attributes

| Attribute | Value |
|---|---|
| Job | `Teammate` |
| Config | `story_development.json` |
| ContextId | `story_development` |
| outputType | `none` |
| skipAIProcessing | `true` |

## Prompt snapshot

Full prompt / instruction set: [`agents/snapshots/story_development.md`](agents/snapshots/story_development.md)

## Actions

### preJSAction: `checkWipLabel.js`

_Check WIP Label Pre-Action_

- Source: `agents/js/checkWipLabel.js`
- Parameters (customParams):
  - `adoTextFormat`
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `checkOpenPR`
  - `configPath`
  - `customStatuses`
  - `featureBranchEnabled`
  - `prSearchFnPath`
  - `scmProvider`
  - `stageFallback`
  - `targetRepository`
  - `trackerProvider`

### preCliJSAction: `preCliDevelopmentSetup.js`

_Pre-CLI Development Setup Action_

- Source: `agents/js/preCliDevelopmentSetup.js`
- Writes:
  - `input/<KEY>/merge_conflicts.md`
- Side effects:
  - post ticket comment (via tracker)
  - git push
  - git checkout
  - git merge
- Parameters (customParams):
  - `adoTextFormat`
  - `aiRepository`
  - `artefactRepository`
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `childQuestions`
  - `commentMarkup`
  - `configPath`
  - `contexts`
  - `customStatuses`
  - `featureBranchEnabled`
  - `feedbackLoop.qualityGates.gates`
  - `fields`
  - `jql`
  - `parentContextFetch`
  - `prSearchFnPath`
  - `restoreFromReleases`
  - `scmProvider`
  - `setupCommands`
  - `stageFallback`
  - `targetRepository`
  - `targetRepository.workingDir`
  - `trackerProvider`


### postJSAction: `developTicketAndCreatePR.js`

_Develop Ticket and Create PR Action_

- Source: `agents/js/developTicketAndCreatePR.js`
- Side effects:
  - git push
  - git checkout
- Parameters (customParams):
  - `adoTextFormat`
  - `aiRepository`
  - `artefactRepository`
  - `autoStartReview`
  - `autoStartReviewConfigFile`
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `cacheToReleases`
  - `commentMarkup`
  - `configPath`
  - `contentOutput`
  - `contentOutput.target`
  - `customStatuses`
  - `featureBranchEnabled`
  - `feedbackLoop`
  - `localTeammate`
  - `managedSubmodules`
  - `prSearchFnPath`
  - `projectKey`
  - `providerTransientBackoffSec`
  - `pushSubmodules`
  - `removeLabel`
  - `removeLabels`
  - `removeLabels.forEach`
  - `scmProvider`
  - `smFallback`
  - `stageFallback`
  - `targetRepository`
  - `targetRepository.workingDir`
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
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `cacheToReleases`
  - `cacheToReleases.releaseNameTemplate`
  - `cacheToReleases.releaseTagTemplate`
  - `configPath`
  - `customStatuses`
  - `featureBranchEnabled`
  - `prSearchFnPath`
  - `scmProvider`
  - `stageFallback`
  - `targetRepository`

## LLM step

- outputType: `none`
- Prompt snapshot: `agents/snapshots/story_development.md`

## Custom params

- `removeLabel`: `"sm_story_development_triggered"`
- `adoTextFormat` _(used by JS action)_
- `branchCreateFnPath` _(used by JS action)_
- `branchNamingFnPath` _(used by JS action)_
- `checkOpenPR` _(used by JS action)_
- `configPath` _(used by JS action)_
- `customStatuses` _(used by JS action)_
- `featureBranchEnabled` _(used by JS action)_
- `prSearchFnPath` _(used by JS action)_
- `scmProvider` _(used by JS action)_
- `stageFallback` _(used by JS action)_
- `targetRepository` _(used by JS action)_
- `trackerProvider` _(used by JS action)_
- `aiRepository` _(used by JS action)_
- `artefactRepository` _(used by JS action)_
- `childQuestions` _(used by JS action)_
- `commentMarkup` _(used by JS action)_
- `contexts` _(used by JS action)_
- `feedbackLoop.qualityGates.gates` _(used by JS action)_
- `fields` _(used by JS action)_
- `jql` _(used by JS action)_
- `parentContextFetch` _(used by JS action)_
- `restoreFromReleases` _(used by JS action)_
- `setupCommands` _(used by JS action)_
- `targetRepository.workingDir` _(used by JS action)_
- `autoStartReview` _(used by JS action)_
- `autoStartReviewConfigFile` _(used by JS action)_
- `cacheToReleases` _(used by JS action)_
- `contentOutput` _(used by JS action)_
- `contentOutput.target` _(used by JS action)_
- `feedbackLoop` _(used by JS action)_
- `localTeammate` _(used by JS action)_
- `managedSubmodules` _(used by JS action)_
- `projectKey` _(used by JS action)_
- `providerTransientBackoffSec` _(used by JS action)_
- `pushSubmodules` _(used by JS action)_
- `removeLabels` _(used by JS action)_
- `removeLabels.forEach` _(used by JS action)_
- `smFallback` _(used by JS action)_
- `autoSaveCommitMessage` _(used by JS action)_
- `cacheToReleases.releaseNameTemplate` _(used by JS action)_
- `cacheToReleases.releaseTagTemplate` _(used by JS action)_

---
_Generated by js/agentDocGenerator.js_