# Story Test Automation Dynamic Repo

Story test automation variant that resolves the target repository dynamically from the ticket instead of using a fixed project repository. It extends `story_test_automation.json` — all prompts, instructions, environment variables and result processing are inherited; only the pre-CLI setup and post-action hooks are wrapped.

## How it works

Each JS hook is a separate GraalJS invocation in dmtools, so params mutations do not survive between hooks. The wrappers therefore run `resolveRepoFromTicket` and the base action in the same call, via the shared `js/common/dynamicRepoSetup.js` helper (also used by `story_development_dynamic_repo`):

- `preCliStoryTestAutomationSetupDynamicRepo.js` — thin wrapper: resolves the repo, writes the resolved `workingDir` to `.dmtools-target-workingdir` (so CLI shell scripts can find the dependency dir), then runs `preCliStoryTestAutomationSetup` (linked Test Cases → `input/{STORY_KEY}`, `test/{STORY_KEY}` branch checkout in the resolved repository).
- `postStoryTestAutomationResultsDynamicRepo.js` — re-resolves the repo, then runs `postStoryTestAutomationResults` (commit, push, PR creation against the resolved repository).

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `repoNameStrategy` — how the repository name is derived from the ticket (default `fromSummary`: the leading `[repo-name]` tag of the summary).
- `repositoriesFile` — path to the repository metadata file (default `.dmtools/repositories.json`), mapping repo name to `branch`, `gitlabGroup`/owner and optional `workingDir`.
- `dependenciesDir` — base directory for cloned repositories (default `./dependencies`); `workingDir` defaults to `{dependenciesDir}/{repo}` when the repositories file does not specify one.
- `targetRepository` — explicit repository override block (`owner`, `repo`, `baseBranch`, `workingDir`); when set, the resolver's result is applied on top of the project defaults via `configLoader`.

All other `story_test_automation` parameters (`removeLabel`, `testFilesGlob`, `checkOpenPR`, `customStatuses`, `autoStartReview`, `responseTarget`, …) apply unchanged.

## SM wiring

Add a rule to the project's SM config (`smRules` / `smRuleOverrides`) pointing `configFile` at `agents/story_test_automation_dynamic_repo.json` with its own `skipIfLabel` / `addLabel` idempotency pair.

_Human doc: [`agents/docs/agents/story_test_automation_dynamic_repo.md`](agents/docs/agents/story_test_automation_dynamic_repo.md)_

## Attributes

| Attribute | Value |
|---|---|
| Job | `Teammate` |
| Config | `story_test_automation_dynamic_repo.json` |
| ContextId | `story_test_automation_dynamic_repo` |
| outputType | `—` |
| skipAIProcessing | `false` |

## Prompt snapshot

Full prompt / instruction set: [`agents/snapshots/story_test_automation_dynamic_repo.md`](agents/snapshots/story_test_automation_dynamic_repo.md)

## Actions


### preCliJSAction: `preCliStoryTestAutomationSetupDynamicRepo.js`

_Pre-CLI Story Test Automation Setup — Dynamic Repository variant_

- Source: `agents/js/preCliStoryTestAutomationSetupDynamicRepo.js`
- Parameters (customParams):
  - `allowApproveWithSuggestions`
  - `branchCreateFnPath`
  - `dependenciesDir`
  - `dryRun`
  - `importantBlocksApproval`
  - `maxReviewThreadsBeforeForceApprove`
  - `repoNameStrategy`
  - `repositoriesFile`
  - `targetRepository`
  - `testFilesGlob`


### postJSAction: `postStoryTestAutomationResultsDynamicRepo.js`

_Post-Action Story Test Automation — Dynamic Repository variant_

- Source: `agents/js/postStoryTestAutomationResultsDynamicRepo.js`
- Parameters (customParams):
  - `aiRepository`
  - `configPath`
  - `contentOutput`
  - `contentOutput.target`
  - `customStatuses`
  - `dependenciesDir`
  - `dryRun`
  - `localTeammate`
  - `maxReworkRounds`
  - `projectKey`
  - `removeLabel`
  - `repoNameStrategy`
  - `repositoriesFile`
  - `smFallback`
  - `targetRepository`
  - `testFilesGlob`
  - `trackerProvider`


## LLM step

- outputType: `none`
- Prompt snapshot: `agents/snapshots/story_test_automation_dynamic_repo.md`

## Custom params

- `allowApproveWithSuggestions` _(used by JS action)_
- `branchCreateFnPath` _(used by JS action)_
- `dependenciesDir` _(used by JS action)_
- `dryRun` _(used by JS action)_
- `importantBlocksApproval` _(used by JS action)_
- `maxReviewThreadsBeforeForceApprove` _(used by JS action)_
- `repoNameStrategy` _(used by JS action)_
- `repositoriesFile` _(used by JS action)_
- `targetRepository` _(used by JS action)_
- `testFilesGlob` _(used by JS action)_
- `aiRepository` _(used by JS action)_
- `configPath` _(used by JS action)_
- `contentOutput` _(used by JS action)_
- `contentOutput.target` _(used by JS action)_
- `customStatuses` _(used by JS action)_
- `localTeammate` _(used by JS action)_
- `maxReworkRounds` _(used by JS action)_
- `projectKey` _(used by JS action)_
- `removeLabel` _(used by JS action)_
- `smFallback` _(used by JS action)_
- `trackerProvider` _(used by JS action)_

---
_Generated by js/agentDocGenerator.js_