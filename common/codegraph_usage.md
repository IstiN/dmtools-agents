# CodeGraph Usage Guide

CodeGraph builds a semantic knowledge graph of your codebase, enabling fast symbol search, call-graph traversal, and AI-context generation. It runs as a CLI tool backed by a local `.codegraph/` index.

---

## Installation

```bash
# Via setup script (recommended in CI)
bash agents/setup/install.sh codegraph

# Manual
npm install -g @colbymchenry/codegraph
```

---

## Initialisation

Run once per repository to build the index (interactive mode skips confirmation prompts):

```bash
codegraph init -i
```

The index is stored in `.codegraph/` at the project root. Add it to `.gitignore` if you don't want to commit it.

---

## Core Commands

### `codegraph status`
Show index statistics and file counts.
```bash
codegraph status
```

### `codegraph sync`
Incrementally update the index after file changes (faster than full `init`).
```bash
codegraph sync
```

---

## Searching Code

### `codegraph query <name>`
Find a symbol (class, method, function, field) by name. Returns ranked matches with file/line.
```bash
codegraph query "JavaScriptExecutor"
codegraph query "executeJavaScript"
```

### `codegraph files`
List all indexed files.
```bash
codegraph files
```

---

## Understanding Call Flow

### `codegraph callees <Symbol.method>`
Find all symbols that the given method calls (one hop down).
```bash
codegraph callees "JavaScriptExecutor.execute"
codegraph callees "JobJavaScriptBridge.executeJavaScript"
```

### `codegraph callers <Symbol.method>`
Find all callers of a given symbol (one hop up).
```bash
codegraph callers "JobJavaScriptBridge.exposeMCPToolsUsingGenerated"
```

### `codegraph impact <Symbol.method>`
Analyse what code would be affected by changing a symbol.
```bash
codegraph impact "MCPToolExecutor.execute"
```

---

## AI Context Generation

### `codegraph context <task description>`
Builds a full Markdown context block for a given task — combines symbol search, source bodies, callers/callees, and related files in one call. Ideal for feeding into an AI prompt.

```bash
codegraph context "how does the JavaScript runner expose MCP tools to GraalJS"
codegraph context "trace TestCasesGenerator flow from job config to AI call"
```

The output is Markdown with:
- **Entry Points** — top-matching symbols
- **Related Symbols** — adjacent code
- **Code** — inline source of each symbol

---

## Single Symbol Inspection

### `codegraph node <Symbol>`
Retrieve source and signature for a single symbol without any traversal.
```bash
codegraph node "JobJavaScriptBridge"
codegraph node "JavaScriptExecutor.mcpWithKB"
```

---

## Find Affected Tests

```bash
# After editing source files, find which test files are affected
codegraph affected dmtools-core/src/main/java/com/github/istin/dmtools/job/JavaScriptExecutor.java
```

---

## MCP Server Mode (for AI assistants)

CodeGraph can run as an MCP server so AI tools (Claude, Cursor, Copilot) call it directly:

```bash
codegraph serve
```

Install into your agent of choice:
```bash
codegraph install          # interactive picker
codegraph install --claude # Claude Code only
codegraph install --cursor # Cursor only
```

---

## Typical Workflow in CI / AI Teammate

```yaml
# In ai-teammate.yml (simplified)
- name: Export cache keys
  run: bash agents/setup/cache.sh keys dmtools:v1.7.196 codegraph

- name: Cache CodeGraph
  uses: actions/cache@v4
  with:
    path: ${{ env.CODEGRAPH_CACHE_PATH }}
    key: ${{ env.CODEGRAPH_CACHE_KEY }}

- name: Install tools
  run: bash agents/setup/install.sh dmtools:v1.7.196 codegraph

# After checkout, init or sync the index:
- name: Init CodeGraph index
  run: codegraph init -i
```

Then in a JS agent you can shell out to codegraph:
```javascript
function action(params) {
    const result = cli_execute_command("codegraph context 'how does X work'");
    return { context: result };
}
```

---

## File Reference

| Path | Purpose |
|------|---------|
| `.codegraph/` | Local index (do not commit) |
| `agents/setup/codegraph.sh` | CI installer script |
| `agents/setup/cache.sh` | Cache key/path definitions |
| `agents/setup/install.sh` | Unified tool installer |
