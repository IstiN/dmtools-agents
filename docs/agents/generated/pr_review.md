# Pr Review

Reviews a pull request like a senior reviewer: analyzes the diff, checks conventions and risks, and posts inline review comments plus a verdict.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `cacheToReleases` — when enabled, the autocommit timer snapshots accumulated CLI output into a git release asset.
- `scmProvider` — SCM provider override (`github`, `gitlab`, …) for this run.
- `targetRepository` — repository override block (`owner`, `repo`, `baseBranch`, `workingDir`) — run the review against this repository instead of the project default.

- `aiRepository` — repository the AI CLI works in when it differs from the PR repository.
- `allowApproveWithSuggestions` — when `true`, the reviewer may approve a PR while leaving non-blocking suggestions.
- `autoStartRework` — when `true`, automatically trigger the rework workflow when the review asks for changes.
- `autoStartReworkConfigFile` — agent config file used for the auto-started rework workflow.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `configPath` — path to the project `.dmtools/config.js` to load for this run.
- `customStatuses` — legacy per-invocation override for individual `STATUSES` keys (e.g. `{ "IN_REWORK": "Ready For Development" }`); prefer the project-wide `jira.statuses` override in `.dmtools/config.js` for a project-wide remap instead.
- `formalGithubReview` — when `true`, in addition to the existing `pr_approved` label, formally submit a native GitHub PR review: `REQUEST_CHANGES` when the AI does not approve, or dismiss any prior `REQUEST_CHANGES` review when the AI approves. Does not change the `pr_approved` label lifecycle.
- `maxReviewThreadsBeforeForceApprove` — maximum open review threads before the reviewer is forced to an approve/reject verdict.
- `onApproved` — action to run when the review approves (e.g. trigger merge).
- `projectKey` — tracker project key override.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).

_Human doc: [`agents/docs/agents/pr_review.md`](agents/docs/agents/pr_review.md)_

## Attributes

| Attribute | Value |
|---|---|
| Job | `Teammate` |
| Config | `pr_review.json` |
| ContextId | `pr_review` |
| outputType | `none` |
| skipAIProcessing | `true` |

## Prompt snapshot

Full prompt / instruction set: [`agents/snapshots/pr_review.md`](agents/snapshots/pr_review.md)

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

### preCliJSAction: `preparePRForReview.js`

_Prepare PR for Review Action (preCliJSAction for pr_review agent)_

- Source: `agents/js/preparePRForReview.js`
- Side effects:
  - post ticket comment (via tracker)
- Parameters (customParams):
  - `adoTextFormat`
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `childQuestions`
  - `commentMarkup`
  - `configPath`
  - `contexts`
  - `customStatuses`
  - `featureBranchEnabled`
  - `fields`
  - `jql`
  - `parentContextFetch`
  - `prSearchFnPath`
  - `scmProvider`
  - `stageFallback`
  - `targetRepository`
  - `trackerProvider`


### postJSAction: `postPRReviewComments.js`

_Post PR Review Comments Action_

- Source: `agents/js/postPRReviewComments.js`
- Side effects:
  - add label "sm_story_rework_triggered" (via tracker)
  - add label "agent:rework" (via tracker)
  - post ticket comment (via tracker)
  - move ticket to status (via tracker)
  - assign ticket (via tracker)
- Parameters (customParams):
  - `adoTextFormat`
  - `aiRepository`
  - `allowApproveWithSuggestions`
  - `autoStartRework`
  - `autoStartReworkConfigFile`
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `commentMarkup`
  - `configPath`
  - `contentOutput`
  - `contentOutput.target`
  - `customStatuses`
  - `featureBranchEnabled`
  - `formalGithubReview`
  - `localTeammate`
  - `maxReviewThreadsBeforeForceApprove`
  - `onApproved`
  - `prSearchFnPath`
  - `projectKey`
  - `removeLabel`
  - `scmProvider`
  - `smFallback`
  - `stageFallback`
  - `targetRepository`
  - `trackerProvider`


## LLM step

- outputType: `none`
- Prompt snapshot: `agents/snapshots/pr_review.md`

### Output schemas

- `pr_review.json`
  - required: `recommendation`, `summary`, `generalComment`, `inlineComments`, `issueCounts`


## Custom params

- `removeLabel`: `"sm_story_review_triggered"`
- `allowApproveWithSuggestions`: `true`
- `checkOpenPR`: `true`
- `adoTextFormat` _(used by JS action)_
- `branchCreateFnPath` _(used by JS action)_
- `branchNamingFnPath` _(used by JS action)_
- `configPath` _(used by JS action)_
- `customStatuses` _(used by JS action)_
- `featureBranchEnabled` _(used by JS action)_
- `prSearchFnPath` _(used by JS action)_
- `scmProvider` _(used by JS action)_
- `stageFallback` _(used by JS action)_
- `targetRepository` _(used by JS action)_
- `trackerProvider` _(used by JS action)_
- `childQuestions` _(used by JS action)_
- `commentMarkup` _(used by JS action)_
- `contexts` _(used by JS action)_
- `fields` _(used by JS action)_
- `jql` _(used by JS action)_
- `parentContextFetch` _(used by JS action)_
- `aiRepository` _(used by JS action)_
- `autoStartRework` _(used by JS action)_
- `autoStartReworkConfigFile` _(used by JS action)_
- `contentOutput` _(used by JS action)_
- `contentOutput.target` _(used by JS action)_
- `formalGithubReview` _(used by JS action)_
- `localTeammate` _(used by JS action)_
- `maxReviewThreadsBeforeForceApprove` _(used by JS action)_
- `onApproved` _(used by JS action)_
- `projectKey` _(used by JS action)_
- `smFallback` _(used by JS action)_

---
_Generated by js/agentDocGenerator.js_