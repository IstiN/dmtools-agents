# Copilot Instructions — dmtools-agents

## Architecture

This is a **generic agents repository** (typically used as a git submodule at `agents/` inside product repos). It orchestrates AI-driven Agile delivery via [dmtools](https://github.com/nicku/dmtools) — a Java tool that provides a GraalJS runtime for agent scripts.

### Execution model

1. **SM Agent** (`sm.json` → `js/smAgent.js`) runs on a cron schedule, queries Jira via JQL rules, and dispatches specialized agents by triggering GitHub Actions workflows.
2. **Agent configs** (root `*.json` files) define individual agent jobs. Three job types exist:
   - `Teammate` — CLI-based agent (prepares context → runs AI CLI → post-processes result)
   - `JSRunner` — pure GraalJS logic executed inside dmtools (no AI CLI)
   - `TestCasesGenerator` — dmtools-native job for test case generation
3. **Project config** lives in the target repo at `.dmtools/config.js`, never here. This repo stays project-agnostic.

### Key layers

| Layer | Location | Purpose |
|-------|----------|---------|
| SM rules | `sm.json`, `sm_merge.json` | JQL-based ticket routing |
| Agent configs | root `*.json` | Job definitions (type, params, actions) |
| JS runtime scripts | `js/` | Pre/post actions, orchestration logic |
| Shared helpers | `js/common/` | SCM abstraction, Jira helpers, PR logic |
| Config system | `js/configLoader.js` + `js/config.js` | Discovery, merging, defaults |
| Prompts | `prompts/` | Markdown entry prompts for CLI agents |
| Instructions | `instructions/` | Reusable instruction packs (review, dev, rework, platform, tracker, scm) |
| Setup scripts | `setup/` | Shell scripts for CI environment setup |

## GraalJS Constraints

All `js/` runtime code executes in **dmtools GraalJS**, not Node.js.

- Use `var` declarations and plain functions (no `let`/`const`, no arrow functions, no async/await, no template literals).
- No Node.js APIs: no `fs`, `path`, `process`, `Buffer`, `child_process`, no npm packages.
- No browser APIs: no `fetch`, `window`, `document`.
- Use dmtools globals: `jira_*`, `github_*`, `ado_*`, `file_read`, `file_write`, `cli_execute_command`.
- Local `require('./module.js')` works only for files within this repo.
- Keep data structures JSON-safe.

## Running Tests

Tests run **standalone** inside dmtools GraalJS via the custom test runner. The repo is independent — no parent repo or submodule mount needed.

```bash
# Run from the dmtools-agents repo root
cd dmtools-agents

# All tests
dmtools run js/unit-tests/run_all.json

# Single test suite
dmtools run js/unit-tests/run_smAgent.json
dmtools run js/unit-tests/run_configLoader.json
```

Each `run_*.json` specifies which test files to load. Tests use `loadModule()` with mock injection — see `js/unit-tests/testRunner.js` for the framework API (`test()`, `suite()`, `assert.*`, `loadModule()`, `makeRequire()`).

### Writing tests for new logic

**All new JS logic must be covered by unit tests before committing.**

- Create or extend a `js/unit-tests/test_<module>.js` file.
- Add it to the corresponding `run_<module>.json` (or create a new one) and include it in `run_all.json`.
- Use `loadModule('js/your-module.js', makeRequire({...}), { globalMock: fn })` to isolate the module.
- Mock all dmtools globals (`file_read`, `file_write`, `cli_execute_command`, `jira_*`, `github_*`, etc.) — never let tests call real services.
- Block config file discovery in mocks: return `null` for any path containing `.dmtools/config` to prevent loading a parent repo's real config.
- Project-specific test suites (loading files from `.dmtools/`) must guard with a file-existence check so they skip gracefully in standalone context.

Example mock pattern:
```js
var fileReadMock = function(opts) {
    var p = opts && (opts.path || opts);
    if (fileMap[p] !== undefined) return fileMap[p];
    if (p && p.indexOf('.dmtools/config') !== -1) return null; // block real config
    try { return file_read(opts); } catch (e) { return null; }
};
```

## Conventions

### No project-specific content
This repo must not contain customer names, ticket keys, repo paths, branch names, or technology rules that belong to a single project. Project context goes in the target repo's `.dmtools/config.js`.

### Agent config structure
- `metadata.contextId` identifies the workflow (used for config composition lookups).
- `preJSAction` / `preCliJSAction` / `postJSAction` — GraalJS hooks that run before/after the CLI agent.
- `cliPrompt` — path to the main prompt markdown.
- `cliPrompts` — additional prompt files appended to the CLI agent input.
- `cliCommands` — shell scripts invoked by dmtools to run the AI CLI.

### Label-based idempotency
SM rules use `skipIfLabel` / `addLabel` to prevent re-processing tickets. When adding new rules, always include an idempotency label.

### SCM abstraction
Use `js/common/scm.js` (via `configLoader.createScm(config)`) instead of calling `github_*` or `ado_*` globals directly. This keeps agents portable between GitHub and Azure DevOps.

### Config composition
Project repos customize agent behavior through `.dmtools/config.js` fields:
- `cliPrompts.<contextId>` — append prompt files
- `cliPromptOverrides.<contextId>` — replace the entry prompt
- `additionalInstructions.<contextId>` — append to agentParams.instructions
- `instructionOverrides.<contextId>` — replace agentParams.instructions
- `agentParamPatches.<contextId>` — patch agentParams fields

### Output JSON discipline
When agents produce JSON output files, keep them compact (status, IDs, paths, short summaries). Put large text in separate `.md` files and reference them by path.

### Path stability
Do not rename or move root `*.json` config files — CI workflows and Jira automations reference them by path. Safe refactors: splitting prompt markdown, adding instruction files, adding `cliPrompts` composition in target repos.
