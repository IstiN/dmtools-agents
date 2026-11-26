# bug development dynamic repo

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
