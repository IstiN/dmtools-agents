---
name: setup-dark-factory
description: >
  Runbook for setting up a Dark Factory: an automated development repository
  where Jira intake, dmtools agents, GitHub workflows, branch protections,
  required quality gates, labels, and merge automation work together to deliver
  changes through PRs. Use when bootstrapping a new repo for autonomous
  development agents or troubleshooting why SM/intake/development agents did
  not start.
---

# Setup Dark Factory

## Definition

A **Dark Factory** is a repository setup where software delivery is driven by
tracker state instead of manual handoffs:

1. Product work enters through a tracker intake parent.
2. The SM agent scans tracker rules on a schedule.
3. Specialized agents refine, design, implement, review, rework, test, and merge.
4. GitHub quality gates protect `main`.
5. Labels and workflow runs provide locks, approvals, retries, and auditability.

The goal is not just "agents can run"; the goal is a closed automation loop:
**intake ticket -> agent dispatch -> PR -> required checks -> label approval ->
merge -> next tracker state**.

---

## Golden path

### 1. Create the product repository

Start with a normal repo that already has a clear product goal.

Required repo-level content:

```text
README.md                         # what the product is and how to run it
.dmtools/config.js                 # project-specific Dark Factory config
agents/                            # dmtools-agents submodule
.github/workflows/ai-teammate.yml  # runs one agent config
.github/workflows/sm.yml           # scheduled/manual SM loop
.github/workflows/merge-trigger.yml
.github/workflows/auto-update-prs.yml
.github/workflows/<quality>.yml     # required PR quality gates
```

Write the product goal before enabling automation. Agents need a target state,
acceptance rules, and project-specific context. Do not rely on generic prompts
to infer product intent.

### 2. Attach the agents repository as a submodule

Use `dmtools-agents` as the reusable automation layer.

```bash
git submodule add git@github.com:IstiN/dmtools-agents.git agents
git submodule update --init --recursive
```

In GitHub Actions, checkout with submodules:

```yaml
- uses: actions/checkout@v4
  with:
    submodules: true
    token: ${{ secrets.PAT_TOKEN }}
```

Use a PAT if private submodules or cross-repo workflow dispatches are involved.

### 3. Configure `.dmtools/config.js`

Keep project-specific config in the target repo, not in `agents/`.

Minimum:

```js
module.exports = {
  repository: {
    owner: 'OWNER',
    repo: 'REPO'
  },

  jira: {
    project: 'PROJ',
    parentTicket: 'PROJ-1'
  },

  git: {
    baseBranch: 'main',
    authorName: 'AI Teammate',
    authorEmail: 'agent.ai.native@gmail.com'
  },

  scm: {
    provider: 'github'
  }
};
```

Add project prompts and instruction composition here:

```js
module.exports = {
  // ...
  cliPrompts: {
    story_development: [
      './.dmtools/prompts/project_goal.md',
      './.dmtools/prompts/architecture.md',
      './agents/instructions/development/implementation_instructions.md'
    ],
    pr_review: [
      './.dmtools/prompts/review_focus.md',
      './agents/instructions/review/core.md',
      './agents/instructions/scm/github_pr_review_format.md'
    ]
  }
};
```

### 4. Prepare the tracker project

Create or choose:

- A Jira project key.
- An intake parent ticket, usually an Epic or parent Task.
- Workflow statuses used by `agents/sm.json`.
- Required issue types: Task, Story, Bug, Subtask, Test Case.
- Custom fields required by your agents, e.g. Acceptance Criteria, Solution,
  Answer, Diagrams.

The default SM rules expect statuses similar to:

```text
Backlog
PO Review
BA Analysis
Solution Architecture
Ready For Development
In Review
In Rework
Merged
Ready For Testing
In Testing
Done
```

For intake, verify the exact JQL before expecting agents to start:

```jql
project = PROJ
AND issuetype in ('Task')
AND status in ('Backlog')
AND parent = PROJ-1
```

If your Jira starts new tasks in `To Do`, either move the task to `Backlog` or
override the SM rule in project config to include `To Do`.

### 5. Add GitHub workflows

#### `ai-teammate.yml`

This is the worker workflow. SM dispatches it with:

- `config_file`
- `encoded_config`
- `concurrency_key`
- optional `project_key`

It must provide:

- Jira credentials.
- GitHub PAT credentials.
- AI provider credentials.
- `SOURCE_GITHUB_WORKSPACE`.
- `SOURCE_GITHUB_REPOSITORY`.
- `DMTOOLS_INTEGRATIONS`.
- `CLI_ALLOWED_COMMANDS`.

Use `DMTOOLS_INTEGRATIONS` narrowly. For GitHub + Jira automation:

```yaml
DMTOOLS_INTEGRATIONS: "jira,github,file"
```

Add `ai,cli,figma,confluence` only when the configured agents actually need
them. Do not leave obsolete providers like `ado` in a GitHub-only project.

#### `sm.yml`

This is the scheduled/manual orchestrator.

```yaml
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:
```

It runs:

```bash
dmtools --debug run agents/sm.json --ciRunUrl "${CI_RUN_URL}"
```

Important: a new workflow file only becomes available for schedule/manual runs
after it is merged to the default branch.

#### `merge-trigger.yml`

Run merge retry after required checks succeed:

```yaml
on:
  workflow_run:
    workflows: ["<Required Checks Workflow Name>"]
    types: [completed]
```

It should run:

```bash
dmtools run agents/sm_merge.json --ciRunUrl "${CI_RUN_URL}"
```

#### `auto-update-prs.yml`

After `main` changes, update open PR branches so required checks can re-run on
up-to-date branches:

```bash
gh pr update-branch "$pr" --repo "${{ github.repository }}"
```

Expect this to skip fork PRs or conflicted PRs.

#### Required quality gates

Create a project-specific required-check workflow. Examples:

- Flutter: `flutter pub get`, `flutter analyze`, `flutter test --coverage`,
  golden tests, `flutter build web`.
- Node: `npm ci`, `npm test`, `npm run build`.
- Java: `./gradlew test build`.

Use a stable job name because branch protection references the job/check name,
not just the workflow filename.

Example:

```yaml
name: Flutter Required Checks

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  flutter-checks:
    name: Flutter checks
    runs-on: ubuntu-latest
    steps:
      # setup, analyze, test, build
```

The required status check in branch protection is `Flutter checks`.

### 6. Configure GitHub secrets and variables

Secrets:

```text
PAT_TOKEN
JIRA_EMAIL
JIRA_API_TOKEN
GEMINI_API_KEY              # or other selected AI provider secret
COPILOT_GITHUB_TOKEN        # if using Copilot provider
FIGMA_TOKEN                 # only if Figma agents need it
```

Variables:

```text
JIRA_BASE_PATH
JIRA_AUTH_TYPE
JIRA_TRANSFORM_CUSTOM_FIELDS_TO_NAMES
JIRA_EXTRA_FIELDS_PROJECT
JIRA_EXTRA_FIELDS
DMTOOLS_CACHE_ENABLED
GEMINI_MODEL
GEMINI_DEFAULT_MODEL
GEMINI_BASE_PATH
AI_AGENT_PROVIDER
COPILOT_MODEL
PROMPT_CHUNK_TOKEN_LIMIT
```

GitHub does not expose secret values through the API. If migrating from another
repo, copy secret names via GitHub and source values from a local secure env
file or secret manager. Never print secret values in logs.

### 7. Protect `main`

Use a branch ruleset or branch protection rule.

Recommended for label-based Dark Factory approval:

- Require pull request before merging.
- Do **not** require human PR approvals if approval is represented by a tracker
  label such as `pr_approved`.
- Require status checks to pass.
- Require branch to be up to date before merging.
- Add the exact required job/check name, e.g. `Flutter checks`.
- Require conversation resolution if review threads are part of your review flow.
- Require linear history if you use squash/rebase merge.
- Block force pushes.
- Restrict deletions.

Do not enable deployment gates unless the deployment happens before merge.
Most product deploys run after merge to `main`; they should not gate PR merge.

### 8. Smoke-test the factory

Before trusting the factory:

1. Open a tiny PR.
2. Verify the required check appears and blocks merge until success.
3. Verify the required check succeeds.
4. Verify `merge-trigger.yml` runs after check success.
5. Add the expected approval label (`pr_approved`) to a test tracker ticket.
6. Verify merge retry behavior.
7. Create one intake child under the intake parent.
8. Run `SM Agent` manually.
9. Verify SM logs show the matching JQL and dispatch to `ai-teammate.yml`.
10. Verify the agent adds/removes lock labels correctly.

---

## Troubleshooting checklist

### SM ran successfully but no agent started

Check the JQL directly:

```bash
dmtools jira_search_by_jql \
  "project = PROJ AND issuetype in ('Task') AND status in ('Backlog') AND parent = PROJ-1"
```

Common causes:

- Ticket is in `To Do`, but SM rule expects `Backlog`.
- Ticket is not a Task.
- Ticket is linked to the intake Epic but not a child via Jira `parent`.
- `.dmtools/config.js` points to the wrong `jira.project` or `parentTicket`.
- Lock label already exists, e.g. `sm_task_intake_triggered`.
- SM rule is disabled or overridden incorrectly.
- Workflow file was added in a PR but not merged to default branch.

### Agent workflow is not visible in Actions

GitHub only shows new workflow files after they exist on the default branch.
Merge the workflow PR into `main`, then refresh Actions.

### Required check does not appear on the PR

Check:

- Workflow listens to `pull_request`.
- PR targets the protected branch.
- The job has a stable `name`.
- Branch protection uses the exact check name, e.g. `Flutter checks`.
- The workflow file is on the PR branch and valid YAML.

### PR is blocked even though tests passed

Check:

- Required branch-up-to-date is enabled; update branch from `main`.
- Required status check name matches the actual job name.
- Another rule, code scanning gate, deployment gate, or human approval gate is
  enabled accidentally.
- PR comes from a fork and `gh pr update-branch` cannot push to it.

### Merge trigger ran but did not merge

Check:

- Tracker ticket is in the expected status, usually `In Review`.
- Tracker ticket has `pr_approved`.
- The PR can be found by ticket key in branch/title/body according to project
  config.
- Required checks are green on the current head SHA.
- Branch protection does not require human approval.
- `PAT_TOKEN` can merge PRs and bypass no required rule accidentally.

### Auto-update PR workflow failed

Common causes:

- `PAT_TOKEN` missing or lacks repo permissions.
- Branch belongs to a fork and is not writable.
- PR has merge conflicts.
- GitHub mergeability is temporarily `UNKNOWN`; retry later.

### Submodule checkout failed

Check:

- `actions/checkout` has `submodules: true`.
- Private submodule access uses `token: ${{ secrets.PAT_TOKEN }}`.
- The PAT has access to both the product repo and `dmtools-agents`.

### Secrets were "copied" but agents fail auth

Secret values cannot be read back from GitHub. Copying names is not enough.
Set values from a trusted local env file or secret manager.

---

## Typical mistakes

- Building a nice app/demo but leaving production data mocked.
- Copying project-specific Jira keys, statuses, repo names, or business rules
  into `agents/` instead of `.dmtools/config.js`.
- Forgetting that `To Do` and `Backlog` are different Jira statuses.
- Creating an Epic/intake ticket but not making child Tasks use it as `parent`.
- Leaving ADO variables/integrations in a GitHub-only repo.
- Requiring human PR approvals while the intended approval mechanism is a label.
- Protecting `main` before adding a required-check workflow with a stable job name.
- Using the workflow name as the required check when GitHub exposes the job name.
- Expecting scheduled workflows to run from a branch before merge to default.
- Forgetting `Actions -> General -> Workflow permissions -> Read and write`.
- Using `GITHUB_TOKEN` where a PAT is needed for submodules, cross-workflow
  dispatch, or protected operations.
- Not smoke-testing with a tiny PR before launching real intake.
- Not reading SM logs with `--debug`; a successful SM run can still match zero
  tickets.

---

## Minimal done criteria

A Dark Factory setup is not complete until:

- `.dmtools/config.js` resolves the correct repo, project, and intake parent.
- GitHub secrets/variables are present and verified without printing values.
- `ai-teammate.yml` can run manually for one config.
- `sm.yml` can run manually and scan Jira successfully.
- Required PR checks block and then unblock a test PR.
- `merge-trigger.yml` runs after required checks pass.
- `auto-update-prs.yml` runs after `main` changes.
- One real intake child triggers an agent dispatch.
- Labels are used as locks and approvals according to the SM rules.
- `main` cannot be changed except through the protected PR flow.
