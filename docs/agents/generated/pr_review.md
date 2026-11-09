# Pr Review

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
- `maxAutoReworkRounds` — maximum auto-started rework rounds (`rework-round-N` on the ticket, default `3`; values `<= 0` warn and fall back to `3` — use `autoStartRework: false` to disable) before the ticket is labeled `needs-human` and no further rework is chained.
- `maxReviewThreadsBeforeForceApprove` — maximum open review threads before the reviewer is forced to an approve/reject verdict.
- `onApproved` — action to run when the review approves (e.g. trigger merge).
- `projectKey` — tracker project key override.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).

## Review policy: `reviewPolicy.verification` (gh-1403)

Set in the project `.dmtools/config.js` (e.g. `reviewPolicy: { verification: 'filter' }`); jobParams `reviewPolicy` overrides per run. The resolved table stamped into `review_policy.md` documents the active value.

- `none` (default) — findings post exactly as the review leg raised them. No extra cost, no extra risk.
- `filter` — a second, FRESH-context CLI pass re-verifies each file-referenced finding against the actual PR diff before it is posted, and rewrites the review:
  - `demote` — a still-valid finding loses its tier (no longer gates approval), its body is kept and prefixed with the machine-parsed provenance marker `dmtools:demoted-from-BLOCKING` / `dmtools:demoted-from-IMPORTANT`, the thread is resolved.
  - `drop` — a non-finding is removed, its thread resolved.
  - `keep` (default) — the finding posts unchanged. Round-none tiers (🪶 under the default preset) never enter the filter.
  - Anti-over-suppression guard: when every candidate of a run is dropped/demoted and kept ≪ candidates, a ⚠️ warning is stamped into the review summary — a miscalibrated filter must not silently erase real findings.

**Trial opt-in** (gh-1403): this repository itself opts in via `.dmtools/config.js`; the trial bar is fewer rework laps per PR AND higher precision AND ≈ 0 wrongly-dropped findings. Revert to `none` if the trial fails.

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
  - `checkOpenPR`

### preCliJSAction: `preparePRForReview.js`

_Prepare PR for Review Action (preCliJSAction for pr_review agent)_

- Source: `agents/js/preparePRForReview.js`
- Side effects:
  - post ticket comment (via tracker)
- Parameters (customParams):
  - `allowApproveWithSuggestions`
  - `childQuestions`
  - `commentMarkup`
  - `contexts`
  - `fields`
  - `importantBlocksApproval`
  - `jql`
  - `maxReviewThreadsBeforeForceApprove`
  - `parentContextFetch`
  - `reviewPolicy`
  - `reviewPolicy.identity`


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
  - `aiRepository`
  - `allowApproveWithSuggestions`
  - `autoStartRework`
  - `autoStartReworkConfigFile`
  - `commentMarkup`
  - `configPath`
  - `contentOutput`
  - `contentOutput.target`
  - `customStatuses`
  - `dryRun`
  - `formalGithubReview`
  - `importantBlocksApproval`
  - `localTeammate`
  - `maxAutoReworkRounds`
  - `maxReviewThreadsBeforeForceApprove`
  - `onApproved`
  - `projectKey`
  - `removeLabel`
  - `reviewPolicy`
  - `reviewPolicy.identity`
  - `smFallback`
  - `trackerProvider`


## LLM step

- outputType: `none`
- Prompt snapshot: `agents/snapshots/pr_review.md`

### Output schemas

- `pr_review.json`
  - required: `recommendation`, `summary`, `generalComment`, `inlineComments`, `issueCounts`


## Custom params

- `removeLabel`: `"sm_story_review_triggered"`
- `checkOpenPR`: `true`
- `allowApproveWithSuggestions` _(used by JS action)_
- `childQuestions` _(used by JS action)_
- `commentMarkup` _(used by JS action)_
- `contexts` _(used by JS action)_
- `fields` _(used by JS action)_
- `importantBlocksApproval` _(used by JS action)_
- `jql` _(used by JS action)_
- `maxReviewThreadsBeforeForceApprove` _(used by JS action)_
- `parentContextFetch` _(used by JS action)_
- `reviewPolicy` _(used by JS action)_
- `reviewPolicy.identity` _(used by JS action)_
- `aiRepository` _(used by JS action)_
- `autoStartRework` _(used by JS action)_
- `autoStartReworkConfigFile` _(used by JS action)_
- `configPath` _(used by JS action)_
- `contentOutput` _(used by JS action)_
- `contentOutput.target` _(used by JS action)_
- `customStatuses` _(used by JS action)_
- `dryRun` _(used by JS action)_
- `formalGithubReview` _(used by JS action)_
- `localTeammate` _(used by JS action)_
- `maxAutoReworkRounds` _(used by JS action)_
- `onApproved` _(used by JS action)_
- `projectKey` _(used by JS action)_
- `smFallback` _(used by JS action)_
- `trackerProvider` _(used by JS action)_

---
_Generated by js/agentDocGenerator.js_