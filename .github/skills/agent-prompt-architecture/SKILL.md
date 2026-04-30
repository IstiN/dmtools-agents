---
name: agent-prompt-architecture
description: >
  Guidance for keeping dmtools-agents prompt/config architecture generic and
  project-safe. Use when refactoring agent prompts, composing cliPrompt/cliPrompts,
  moving project rules into target repos, adding .dmtools config fields, or changing
  GraalJS agent code.
---

# Agent Prompt Architecture

## Core rule

`dmtools-agents` is a generic agents repository. It must not contain customer,
project, repository, ticket, branch, or technology rules that belong to a target
project.

Put reusable behavior here. Put project context in the target repo.

## Prompt layers

Use small files and compose them explicitly:

```text
agents/
  prompts/                         # generic entry prompts
  instructions/
    review/                        # review behavior
    rework/                        # rework behavior
    development/                   # implementation behavior
    tracker/                       # Jira / ADO / generic work item formatting
    scm/                           # GitHub / ADO PR formatting
    platform/                      # reusable web/mobile/backend/database rules

target-repo/
  .dmtools/
    config.js                      # project composition
    prompts/                       # project role/context/focus
    instructions/                  # project architecture/platform rules
```

### Generic files may contain

- Agent role and task contract.
- Input/output contract.
- Provider-neutral wording: ticket/work item, SCM, PR, CI checks.
- Generic quality rules: correctness, security, maintainability, tests.
- Provider-specific rules only inside explicit provider folders:
  - `instructions/tracker/*`
  - `instructions/scm/*`

### Generic files must not contain

- Real project names, ticket keys, repo paths, or customer names.
- Target repo branch names, workflow names, labels, or pipeline details.
- Product-specific business rules.
- Technology rules that only one project needs.
- Links to private project documentation.

## Composition model

For CLI agents with `skipAIProcessing=true`, prefer direct CLI prompt surfaces:

```js
module.exports = {
    cliPrompts: {
        story_development: [
            './.dmtools/prompts/project_context.md',
            './.dmtools/prompts/development_focus.md',
            './agents/instructions/platform/backend_architecture.md'
        ],
        pr_review: [
            './.dmtools/prompts/reviewer_role.md',
            './.dmtools/prompts/review_focus.md',
            './agents/instructions/review/core.md',
            './agents/instructions/scm/github_pr_review_format.md'
        ]
    },

    cliPromptOverrides: {
        pr_review: './.dmtools/prompts/pr_review_prompt.md'
    },

    agentParamPatches: {
        story_development: {
            aiRole: 'Senior Software Engineer'
        }
    },

    additionalInstructions: {
        story_solution: [
            './.dmtools/instructions/product/domain_knowledge.md'
        ]
    }
};
```

Use:

| Field | Use |
|---|---|
| `cliPrompt` | Generic default entry prompt in agent JSON |
| `cliPrompts.<agent>` | Project/provider/platform modules appended to the CLI prompt |
| `cliPromptOverrides.<agent>` | Replace the default entry prompt for one project |
| `agentParamPatches.<agent>` | Patch `params.agentParams` without copying full JSON |
| `instructionOverrides.<agent>` | Replace `agentParams.instructions` |
| `additionalInstructions.<agent>` | Non-CLI/DMtools AI context, not the main CLI prompt channel |

## Path stability

Do not move production JSON config paths unless the workflow/Jira/ADO entrypoints
are being migrated in the same change.

Safe refactors:

- Split prompt markdown into smaller files.
- Add `cliPrompts` in target `.dmtools/config.js`.
- Move project rules from generic prompts to target repo prompt packs.
- Add provider/platform modules under `agents/instructions/*`.

Risky refactors:

- Moving `*.json` configs used by CI.
- Renaming workflow inputs or `config_file` values.
- Moving target repo custom JS actions.

## GraalJS constraints

Production agent JS runs in dmtools GraalJS, not Node.js.

Do not use Node-only APIs in runtime agent files:

- `fs`, `path`, `process`, `Buffer`, `child_process`, npm packages.
- Browser-only APIs such as `fetch`, `window`, `document`.
- Shelling out unless the agent already uses an approved dmtools tool for it.

Use GraalJS-safe patterns:

- `var` declarations and plain functions.
- Local `require('./module.js')` only for repository JS modules supported by the
  agent runner.
- JSON-safe data structures.
- Existing dmtools MCP/tool globals such as `jira_*`, `ado_*`, `github_*`,
  `file_read`, and project wrappers.
- Explicit error returns or throws consistent with nearby agent code.

Unit tests may run in Node.js and provide mocks, but runtime code must stay
GraalJS-compatible.

## Refactor checklist

1. Identify whether each rule is generic, provider-specific, platform-specific,
   or project-specific.
2. Keep generic rules in `agents/`.
3. Put provider-specific formatting in `instructions/tracker` or
   `instructions/scm`.
4. Put project rules in the target repo under `.dmtools/` or the existing
   project config/prompt folder.
5. Wire small prompt files through `cliPrompts`.
6. Keep JSON config paths stable unless explicitly migrating workflows.
7. Run JSON parse checks and existing JS unit tests.
8. Search for accidental project leakage before opening a PR.
