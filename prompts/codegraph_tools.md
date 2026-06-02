# CodeGraph — code intelligence tools

CodeGraph builds a semantic knowledge graph of the codebase and makes it available as CLI commands. The index is pre-built during CI setup, so all commands work immediately without any initialization step.

## Required first action

If this task includes development, rework, code review, test automation, or any source-code investigation, run CodeGraph before any other code-navigation command:

```bash
codegraph context "<ticket key> <agent role> <short task summary>"
```

Do this even when the prompt already includes a PR diff, file path, failing test, or review comment. PR diffs are not enough context; CodeGraph provides surrounding symbols and call paths that plain file reads miss.

## Completion check

Before you finish a source-code agent run, verify that the conversation contains an actual executed `codegraph ...` command, not only this instruction text or example commands. If no CodeGraph command has been executed yet, run a targeted command before writing the final result:

```bash
codegraph context "<ticket key> <changed file or tested flow> <decision you are validating>"
```

Do not approve, request changes, report a passed test, report a failed test, or publish implementation results until this check is satisfied.

## When to use CodeGraph vs other tools

| Situation | Use |
|-----------|-----|
| Understand how a feature/flow works end-to-end | `codegraph context "<task description>"` |
| Find where a class/function/method is defined | `codegraph query "<name>"` |
| Trace what a method calls (downstream) | `codegraph callees "<Class.method>"` |
| Find who calls a method (upstream) | `codegraph callers "<Class.method>"` |
| Check what breaks if you change something | `codegraph impact "<Class.method>"` |
| Read a single symbol's source | `codegraph node "<ClassName>"` |
| Browse project file structure | `codegraph files` |

## Mandatory usage rule

For any task that requires understanding, modifying, or reviewing source code, your first code-navigation command MUST be a CodeGraph command before using `grep`, `find`, `cat`, `sed`, or opening files directly.

Use `codegraph context "<task description>"` by default. Use `codegraph query "<symbol>"` only when you already know the symbol name.

After editing code, run `codegraph sync` before any further CodeGraph query.

Only skip CodeGraph when the task does not involve source-code navigation at all (for example, a pure Jira/status update). Source-code agents such as development, rework, review, and test automation must still run at least one CodeGraph command even when the requested fix names an exact file, line, failing test, or review comment. In that case use a short targeted command such as `codegraph context "<ticket key> <file or failing test> <issue summary>"`.

**Prefer CodeGraph over `grep` or `cat` for code understanding** — it uses the pre-built semantic index and returns only relevant, structured results.

## Key commands

### Explore a task or feature
```bash
codegraph context "how does the JavaScript runner expose MCP tools"
codegraph context "trace the test case generation flow from JQL to Jira ticket creation"
```
Returns: entry-point symbols, related symbols, inline source bodies.

### Find a symbol
```bash
codegraph query "JavaScriptExecutor"
codegraph query "executeJavaScript"
```

### Walk call graph
```bash
codegraph callees "JobJavaScriptBridge.executeJavaScript"   # what it calls
codegraph callers "exposeMCPToolsUsingGenerated"            # who calls it
codegraph impact  "MCPToolExecutor.execute"                 # what changes affect
```

### Read a symbol
```bash
codegraph node "JavaScriptExecutor"
codegraph node "JobJavaScriptBridge.initializeJavaScriptContext"
```

### Check affected tests before a change
```bash
codegraph affected src/main/java/com/example/MyService.java
```

## Sync the index after making code changes

If you edit source files during your session, sync the index before querying:
```bash
codegraph sync
```

## Tips
- Symbol format: `ClassName` or `ClassName.methodName`
- `codegraph context` is the most powerful single command — start there for any "how does X work" question
- Results are Markdown-formatted and safe to include directly in your reasoning
- The index covers all Java, JavaScript, TypeScript, and Python files in the project
