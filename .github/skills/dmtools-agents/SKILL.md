---
name: dmtools-agents
description: >
  Setup, configuration, and customization of dmtools GraalJS agents
  (smAgent, configLoader, unit tests). Use this when asked to configure
  agents for a project, add a new project config, write agent rules,
  customize branch/commit/PR formats, set up per-project SM schedules,
  or run/write agent unit tests.
---

# DMTools Agents — Integration & Customization Guide

## Overview

The `agents/` directory (git submodule → `IstiN/dmtools-agents`) contains
GraalJS scripts and JSON configs that orchestrate AI automation via dmtools.

Key files:
```
agents/
  js/
    smAgent.js          — SM orchestrator (JSRunner entry point)
    configLoader.js     — config discovery, merging, template utilities
    config.js           — shared constants (STATUSES, LABELS, ISSUE_TYPES…)
    unit-tests/         — test framework + test files
  sm.json               — SM rules config (JSRunner)
  sm_merge.json         — SM merge-phase rules
  *.json                — individual agent configs (Teammate/Expert/etc.)
  instructions/         — shared instruction markdown files
  prompts/              — shared prompt markdown files
```

---

## Quick Setup: New Project

### Step 1 — Create `.dmtools/config.js` at the repo root

```js
// .dmtools/config.js
module.exports = {
  // GitHub repository (required for SM to trigger workflows)
  repository: {
    owner: 'my-org',
    repo: 'my-repo'
  },

  // Jira project (required for JQL interpolation)
  jira: {
    project: 'MYPROJ',
    parentTicket: 'MYPROJ-1'   // epic/parent for {parentTicket} in JQLs
  },

  // Git defaults
  git: {
    baseBranch: 'main'
  }
};
```

### Step 2 — Run the SM agent

```bash
dmtools run agents/sm.json
```

`{jiraProject}` and `{parentTicket}` in all JQL rules are automatically
replaced from config. `owner`/`repo` from config override sm.json defaults.

---

## Multi-Project Setup (per-folder structure)

For repos with multiple Jira projects under separate folders
(e.g. `projects/ALPHA/`, `projects/BETA/`):

### Option A — `agentConfigsDir` (recommended, zero-maintenance)

Each project folder gets:
```
projects/ALPHA/
  sm.json                  ← minimal launcher
  .dmtools/config.js       ← all project config + rules
  StoryAgent.json          ← agent JSON configs
  BugCreation.json
```

**`projects/ALPHA/sm.json`** — identical template for every project:
```json
{
  "name": "JSRunner",
  "params": {
    "jsPath": "agents/js/smAgent.js",
    "jobParams": { "agentConfigsDir": "projects/ALPHA" }
  }
}
```

**`projects/ALPHA/.dmtools/config.js`** — all project logic lives here:
```js
module.exports = {
  repository: { owner: 'my-org', repo: 'alpha-repo' },
  jira: { project: 'ALPHA', parentTicket: 'ALPHA-1' },
  git: { baseBranch: 'main' },

  // Path to this folder — used to resolve short configFile names in rules
  agentConfigsDir: 'projects/ALPHA',

  // SM rules — configFile is a SHORT name, resolved to agentConfigsDir/name
  smRules: [
    {
      description: 'Generate test cases',
      jql: "project = {jiraProject} AND status = 'Ready For Testing'",
      configFile: 'TestCasesGenerator.json',   // resolves to projects/ALPHA/TestCasesGenerator.json
      skipIfLabel: 'sm_tc_triggered',
      addLabel: 'sm_tc_triggered'
    },
    {
      description: 'Review stories',
      jql: "project = {jiraProject} AND status = 'In Review'",
      configFile: 'StoryAgent.json',
      enabled: true
    }
  ]
};
```

Adding a new project = create new folder with sm.json + config.js. Nothing else changes.

### Option B — Per-rule `configPath` in a single SM

One shared `sm.json` targeting multiple projects:
```json
{
  "name": "JSRunner",
  "params": {
    "jsPath": "agents/js/smAgent.js",
    "jobParams": {
      "rules": [
        {
          "jql": "project = {jiraProject} AND status = 'Ready'",
          "configFile": "agents/story_development.json",
          "configPath": "projects/ALPHA/.dmtools/config.js"
        },
        {
          "jql": "project = {jiraProject} AND status = 'Ready'",
          "configFile": "agents/story_development.json",
          "configPath": "projects/BETA/.dmtools/config.js"
        }
      ]
    }
  }
}
```

Each rule loads its own config. `{jiraProject}` resolves independently per rule.

---

## Config File Reference

All fields and their merge behavior:

```js
module.exports = {
  // ── Repository ──────────────────────────────────────────────────────────
  repository: {
    owner: 'my-org',          // GitHub org/user
    repo: 'my-repo'           // Repository name
  },

  // ── Jira ────────────────────────────────────────────────────────────────
  jira: {
    project: 'MYPROJ',        // Used in {jiraProject} JQL placeholder
    parentTicket: 'MYPROJ-1', // Used in {parentTicket} JQL placeholder

    // FULL REPLACEMENT when provided (not merged with defaults)
    statuses: {
      IN_REVIEW: 'In Review', DONE: 'Done', PO_REVIEW: 'PO REVIEW',
      BA_ANALYSIS: 'BA Analysis',  // target status after all question subtasks are Done
      /* ... */
    },
    issueTypes: {
      STORY: 'Story', BUG: 'Bug', TASK: 'Task', SUBTASK: 'Subtask',
      TEST_CASE: 'Test Case'   // customize if your Jira uses e.g. 'XRay Test'
    },

    // FULL REPLACEMENT when provided — controls question subtask fetching & creation
    questions: {
      // JQL to find question subtasks. {ticketKey} is replaced at runtime.
      // Override if your project uses a different issue type or label filter.
      fetchJql: 'parent = {ticketKey} AND issuetype = Subtask ORDER BY created ASC',
      // Jira custom field name that holds the answer on a question subtask.
      answerField: 'Answer'
    }
  },

  // ── Git ─────────────────────────────────────────────────────────────────
  git: {
    baseBranch: 'main',
    authorName: 'AI Teammate',
    authorEmail: 'agent@example.com',
    branchPrefix: {
      development: 'ai',
      test: 'test',
      feature: 'feature'
    }
  },

  // ── Commit & PR formats ─────────────────────────────────────────────────
  formats: {
    commitMessage: {
      development:    '{ticketKey} {ticketSummary}',
      testAutomation: '{ticketKey} test: automate {ticketSummary}',
      rework:         '{ticketKey} Rework: address PR review comments'
    },
    prTitle: {
      development:    '{ticketKey} {ticketSummary}',
      rework:         '{ticketKey} {ticketSummary} (rework)'
    }
  },

  // ── Labels ───────────────────────────────────────────────────────────────
  // FULL REPLACEMENT when provided
  labels: {
    AI_GENERATED: 'ai_generated',
    AI_DEVELOPED: 'ai_developed'
    // … add project-specific labels
  },

  // ── Confluence URL overrides ─────────────────────────────────────────────
  confluence: {
    templateStory:         'https://my-wiki/pages/123/Story-Template',
    templateJiraMarkdown:  'https://my-wiki/pages/456/Jira-Markdown',
    templateSolutionDesign:'https://my-wiki/pages/789/Solution-Design',
    templateQuestions:     'https://my-wiki/pages/101/Questions'
  },

  // ── SM Rules (FULL REPLACEMENT when provided) ────────────────────────────
  agentConfigsDir: 'projects/MYPROJ',  // base dir for short configFile names
  smRules: [ /* ... see above ... */ ],
  smMergeRules: [ /* ... */ ],

  // ── Instruction overrides ────────────────────────────────────────────────
  // additionalInstructions: appended to agent's base instructions
  additionalInstructions: {
    story_description: [
      'https://my-wiki/pages/story-template'
    ],
    story_solution: [
      'https://my-wiki/pages/solution-design',
      './instructions/custom-rules.md'
    ]
  },

  // instructionOverrides: REPLACES the agent's entire instructions array
  instructionOverrides: {
    story_development: [
      'https://my-wiki/pages/dev-guide',
      './agents/instructions/development/implementation_instructions.md'
    ]
  }
};
```

---

## Rule Fields Reference

```js
{
  jql:            "project = {jiraProject} AND status = 'Ready'",  // required
  configFile:     "StoryAgent.json",      // required — short name (+ agentConfigsDir) or full path
  configPath:     "projects/X/.dmtools/config.js",  // optional — per-rule config override
  description:    "Develop stories",     // optional — shown in logs
  targetStatus:   "In Development",      // optional — transition before triggering
  workflowFile:   "ai-teammate.yml",     // optional — default: ai-teammate.yml
  workflowRef:    "main",                // optional — default: main
  skipIfLabel:    "sm_dev_triggered",    // optional — idempotency: skip if ticket has label
  addLabel:       "sm_dev_triggered",    // optional — add after trigger
  enabled:        true,                  // optional — false to disable without deleting
  limit:          10,                    // optional — max tickets per run
  localExecution: false                  // optional — run postJSAction in-process (no GitHub trigger)
}
```

---

## Config Discovery Order

`configLoader.loadProjectConfig(params)` searches in this order:

1. `params.configPath` — explicit path in jobParams
2. `params.customParams.configPath` — from agent JSON customParams
3. `params.agentConfigsDir + "/.dmtools/config.js"` — when agentConfigsDir is set
4. `../.dmtools/config.js` — submodule layout (agents/ is a submodule)
5. `.dmtools/config.js` — co-located layout (agents/ in same repo)
6. Built-in defaults

The resolved `_configPath` is propagated into `encoded_config.customParams.configPath`
when smAgent triggers downstream workflows — so postJSAction scripts also find
the correct project config automatically.

---

## Customizing Branch, Commit, and PR Formats

Override in `.dmtools/config.js`:

```js
git: {
  branchPrefix: { development: 'feature', test: 'test' },
  baseBranch: 'develop'
},
formats: {
  commitMessage: {
    development: 'feat({ticketKey}): {ticketSummary}'
  },
  prTitle: {
    development: '[{ticketKey}] {ticketSummary}'
  }
}
```

Available template variables: `{ticketKey}`, `{ticketSummary}`, `{result}`.

---

## Running Unit Tests

```bash
# All tests
dmtools run agents/js/unit-tests/run_all.json

# configLoader only
dmtools run agents/js/unit-tests/run_configLoader.json

# smAgent only
dmtools run agents/js/unit-tests/run_smAgent.json
```

Tests use `loadModule(path, requireFn, mocks)` from `testRunner.js` to isolate
modules and inject mock globals (`file_read`, `jira_search_by_jql`, etc.)
without touching the real environment.

See `agents/js/unit-tests/README.md` for how to write new tests.

---

## targetRepository — Trigger Workflows in a Different Repo

Use when the SM runs in repo A but should trigger workflows in repo B
(e.g. agents isolated repo triggering a product repo):

```js
// In .dmtools/config.js
// OR as customParams in encoded_config
{
  targetRepository: {
    owner: 'product-org',
    repo: 'product-repo',
    baseBranch: 'main',
    workingDir: 'product-repo'  // checkout dir in workflow
  }
}
```

---

## Submodule vs Co-located Layout

**Submodule layout** (agents in separate repo, checked out as submodule):
```
my-project/
  agents/          ← git submodule → IstiN/dmtools-agents
  .dmtools/
    config.js      ← discovered via ../agents → ../.dmtools/config.js
```

**Co-located layout** (agents and project in same repo):
```
my-project/
  agents/          ← copied or checked out here
  .dmtools/
    config.js      ← discovered via .dmtools/config.js
```

Both layouts are auto-discovered. No configuration needed.

---

## Jira Automation — Triggering Agents

Use Jira automation's **"Send web request"** action to trigger a GitHub Actions workflow.

The workflow (`ai-teammate.yml`) accepts three inputs:
- `config_file` — path to the agent JSON config inside the repo
- `concurrency_key` — ticket key for deduplication (e.g. `PROJ-123`)
- `encoded_config` — optional JSON override (URL-encoded) for `inputJql`, `configPath`, etc.

**Jira automation action → Send web request:**

```
POST https://api.github.com/repos/{repo-owner}/{repo}/actions/workflows/ai-teammate.yml/dispatches
```

Headers:
```
Authorization: Bearer {{YOUR_GITHUB_PAT}}
Content-Type: application/json
```

---

### Option A — Hardcoded agent (one automation rule = one agent)

The simplest setup. Each Jira automation rule triggers a specific agent.
`config_file` is hardcoded; `agentConfigsDir` routes to the right project config.

```json
{
  "ref": "main",
  "inputs": {
    "config_file": "agents/story_development.json",
    "concurrency_key": "{{issue.key}}",
    "encoded_config": "{{#urlEncode}}{
  \"params\": {
    \"inputJql\": \"key = {{issue.key}}\",
    \"initiator\": \"{{initiator.name}}\",
    \"customParams\": {
      \"agentConfigsDir\": \"projects/{{issue.project.key}}\"
    }
  }
}{{/urlEncode}}"
  }
}
```

---

### Option B — Agent chosen by user input (one rule = many agents)

The user picks the agent from a Jira automation prompt (`userInputs.agentName`).
`config_file` is built from the input — e.g. `agents/story_development.json`.

```json
{
  "ref": "main",
  "inputs": {
    "config_file": "agents/{{userInputs.agentName}}.json",
    "concurrency_key": "{{issue.key}}",
    "encoded_config": "{{#urlEncode}}{
  \"params\": {
    \"inputJql\": \"key = {{issue.key}}\",
    \"initiator\": \"{{initiator.name}}\",
    \"request\": \"{{userInputs.requestInput.jsonEncode}}\",
    \"customParams\": {
      \"agentConfigsDir\": \"projects/{{issue.project.key}}\"
    }
  }
}{{/urlEncode}}"
  }
}
```

User sees a Jira prompt: _"Agent name?"_ → types `story_development` → triggers `agents/story_development.json`.

---

### How multi-project routing works

`agentConfigsDir: "projects/{{issue.project.key}}"` is the only thing that differs per project.
It resolves at runtime (e.g. `projects/ALPHA`) and tells configLoader where to find the config:

```
agents-repo/
  agents/                      ← shared agent JSONs (config_file always points here)
    story_development.json
    bug_creation.json
    ...
  projects/
    ALPHA/
      .dmtools/config.js       ← repository/jira/git config for ALPHA
    BETA/
      .dmtools/config.js       ← repository/jira/git config for BETA
```

**`projects/ALPHA/.dmtools/config.js`:**
```js
module.exports = {
  repository: { owner: 'my-org', repo: 'alpha-repo' },
  jira: { project: 'ALPHA', parentTicket: 'ALPHA-1' },
  git: { baseBranch: 'main' },
  agentConfigsDir: 'projects/ALPHA'
};
```

Adding a new project = add one folder with `config.js`. Agent JSONs and automation rules stay unchanged.

---

### Trigger summary

| Scenario | `config_file` | `encoded_config` extras |
|---|---|---|
| Single repo, one agent | `agents/story_development.json` (hardcoded) | `inputJql` only |
| Single repo, user picks agent | `agents/{{userInputs.agentName}}.json` | `inputJql` + optional `request` |
| Multi-project, hardcoded agent | `agents/story_development.json` | + `agentConfigsDir: "projects/{{issue.project.key}}"` |
| Multi-project, user picks agent | `agents/{{userInputs.agentName}}.json` | + `agentConfigsDir: "projects/{{issue.project.key}}"` |
| SM on schedule | — | GitHub Actions cron, no Jira automation needed |
