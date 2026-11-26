# Bug Development Dynamic Repo

Bug development variant that resolves the target repository dynamically from the ticket instead of using a fixed project repository: the fix is implemented, pushed and proposed through a pull request against the repository named by the ticket.

It extends `bug_development.json` — all prompts, instructions, environment variables, the WIP auto-commit timer and the bug post-action outcomes (blocked, already fixed, interrupted, normal fix) are inherited; only the pre-CLI setup and post-action hooks are wrapped.

## How it works

Each JS hook is a separate GraalJS invocation in dmtools, so params mutations do not survive between hooks. The wrappers therefore run `resolveRepoFromTicket` and the base action in the same call, via the shared `js/common/dynamicRepoSetup.js` helper (also used by `story_development_dynamic_repo` and `story_test_automation_dynamic_repo`):

- `preCliDevelopmentSetupDynamicRepo.js` — thin wrapper: resolves the repo, writes the resolved `workingDir` to `.dmtools-target-workingdir`, then runs `preCliDevelopmentSetup` (branch setup in the resolved repository).
- `postDevelopBugDynamicRepo.js` — re-resolves the repo, then runs `developBugAndCreatePR` (commit, push, PR creation and ticket updates against the resolved repository).

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `repoNameStrategy` — how the repository name is derived from the ticket (default `fromSummary`: the leading `[repo-name]` tag of the summary).
- `repositoriesFile` — path to the repository metadata file (default `.dmtools/repositories.json`), mapping repo name to `branch`, `gitlabGroup`/owner and optional `workingDir`.
- `dependenciesDir` — base directory for cloned repositories (default `./dependencies`); `workingDir` defaults to `{dependenciesDir}/{repo}` when the repositories file does not specify one.
- `targetRepository` — explicit repository override block (`owner`, `repo`, `baseBranch`, `workingDir`); when set, the resolver's result is applied on top of the project defaults via `configLoader`.

All other `bug_development` parameters (`developmentMode`, `responseTarget`, `setupCommands`, …) apply unchanged.

- `removeLabel` — defaults to `sm_bug_development_dynamic_repo_triggered` in this variant (the parent's `sm_bug_development_triggered` is overridden). The post-action removes it on every terminal outcome so the ticket is never locked out of the lane; it must equal the dispatching rule's label (see below).

## SM wiring

Add a rule to the project's SM config (`smRules` / `smRuleOverrides`) pointing `configFile` at `agents/bug_development_dynamic_repo.json`, with `skipIfLabel` and `addLabel` set to `sm_bug_development_dynamic_repo_triggered` — the same value as the variant's `customParams.removeLabel`, so the rule re-arms after an interrupted run or a rework. To use a different label, override `customParams.removeLabel` (in this config or via `agentParamPatches`) with that same value. Disable the default bug rule (`smRuleOverrides["agents/bug_development.json"].enabled: false`) so the two rules do not both pick up the same bug.

_Human doc: [`agents/docs/agents/bug_development_dynamic_repo.md`](agents/docs/agents/bug_development_dynamic_repo.md)_

## Attributes

| Attribute | Value |
|---|---|
| Job | `Teammate` |
| Config | `bug_development_dynamic_repo.json` |
| ContextId | `bug_development_dynamic_repo` |
| outputType | `—` |
| skipAIProcessing | `false` |

## Prompt snapshot

Full prompt / instruction set: [`agents/snapshots/bug_development_dynamic_repo.md`](agents/snapshots/bug_development_dynamic_repo.md)

## Actions


### preCliJSAction: `preCliDevelopmentSetupDynamicRepo.js`

_Pre-CLI Development Setup — Dynamic Repository variant_

- Source: `agents/js/preCliDevelopmentSetupDynamicRepo.js`
- Parameters (customParams):
  - `aiRepository`
  - `artefactRepository`
  - `branchCreateFnPath`
  - `childQuestions`
  - `commentMarkup`
  - `contexts`
  - `dependenciesDir`
  - `developmentMode`
  - `developmentModeConfig`
  - `developmentModeConfig.adaptive`
  - `developmentModeConfig.plan`
  - `dryRun`
  - `feedbackLoop`
  - `feedbackLoop.qualityGates.gates`
  - `fields`
  - `jql`
  - `parentContextFetch`
  - `repoNameStrategy`
  - `repositoriesFile`
  - `restoreFromReleases`
  - `scmProvider`
  - `setupCommands`
  - `squashReworkWip`
  - `targetRepository`
  - `targetRepository.workingDir`


### postJSAction: `postDevelopBugDynamicRepo.js`

_Develop Bug and Create PR Post-Action — Dynamic Repository variant_

- Source: `agents/js/postDevelopBugDynamicRepo.js`
- Side effects:
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
  - `customStatuses`
  - `dependenciesDir`
  - `developmentMode`
  - `developmentModeConfig`
  - `developmentModeConfig.adaptive`
  - `developmentModeConfig.plan`
  - `dryRun`
  - `feedbackLoop`
  - `localTeammate`
  - `managedSubmodules`
  - `projectKey`
  - `providerTransientBackoffSec`
  - `pushSubmodules`
  - `removeLabel`
  - `removeLabels`
  - `removeLabels.forEach`
  - `repoNameStrategy`
  - `repositoriesFile`
  - `scmProvider`
  - `smFallback`
  - `squashReworkWip`
  - `targetRepository`
  - `targetRepository.workingDir`
  - `trackerProvider`


## LLM step

- outputType: `none`
- Prompt snapshot: `agents/snapshots/bug_development_dynamic_repo.md`

## Custom params

- `removeLabel`: `"sm_bug_development_dynamic_repo_triggered"`
- `aiRepository` _(used by JS action)_
- `artefactRepository` _(used by JS action)_
- `branchCreateFnPath` _(used by JS action)_
- `childQuestions` _(used by JS action)_
- `commentMarkup` _(used by JS action)_
- `contexts` _(used by JS action)_
- `dependenciesDir` _(used by JS action)_
- `developmentMode` _(used by JS action)_
- `developmentModeConfig` _(used by JS action)_
- `developmentModeConfig.adaptive` _(used by JS action)_
- `developmentModeConfig.plan` _(used by JS action)_
- `dryRun` _(used by JS action)_
- `feedbackLoop` _(used by JS action)_
- `feedbackLoop.qualityGates.gates` _(used by JS action)_
- `fields` _(used by JS action)_
- `jql` _(used by JS action)_
- `parentContextFetch` _(used by JS action)_
- `repoNameStrategy` _(used by JS action)_
- `repositoriesFile` _(used by JS action)_
- `restoreFromReleases` _(used by JS action)_
- `scmProvider` _(used by JS action)_
- `setupCommands` _(used by JS action)_
- `squashReworkWip` _(used by JS action)_
- `targetRepository` _(used by JS action)_
- `targetRepository.workingDir` _(used by JS action)_
- `autoStartReview` _(used by JS action)_
- `autoStartReviewConfigFile` _(used by JS action)_
- `cacheToReleases` _(used by JS action)_
- `configPath` _(used by JS action)_
- `contentOutput` _(used by JS action)_
- `contentOutput.target` _(used by JS action)_
- `customStatuses` _(used by JS action)_
- `localTeammate` _(used by JS action)_
- `managedSubmodules` _(used by JS action)_
- `projectKey` _(used by JS action)_
- `providerTransientBackoffSec` _(used by JS action)_
- `pushSubmodules` _(used by JS action)_
- `removeLabels` _(used by JS action)_
- `removeLabels.forEach` _(used by JS action)_
- `smFallback` _(used by JS action)_
- `trackerProvider` _(used by JS action)_

---
_Generated by js/agentDocGenerator.js_