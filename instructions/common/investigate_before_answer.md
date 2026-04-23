# Investigate Before Answering

**If you are not fully confident about what has already been implemented or how the system currently works — you MUST investigate before answering.**

Do not guess or reason from the ticket text alone. Check the actual artefacts.

---

## What to Investigate

### 🔧 Code / Backend
Search source files for relevant classes, methods, or keywords:
```bash
find . -type f -name "*.java" | xargs grep -l "KeywordFromTicket" 2>/dev/null
cat path/to/RelevantClass.java
```

### 🌐 API surface
Check what REST endpoints, MCP tools, or CLI commands are already exposed:
```bash
# MCP / CLI tools (Java projects with @MCPTool pattern)
grep -rn "@MCPTool\|@MCPParam" . --include="*.java" -l
grep -A 10 "@MCPTool" path/to/SomeTool.java

# REST API routes (Spring / Express / FastAPI / etc.)
grep -rn "@GetMapping\|@PostMapping\|@RequestMapping\|router\." . --include="*.java" -l
grep -rn "path\|route\|endpoint" . --include="*.ts" -l

# OpenAPI / Swagger spec
find . -name "openapi*.yml" -o -name "swagger*.json" | head -5
```

### 💻 CLI commands
Check what commands and flags are already available to end users:
```bash
# Run the CLI help to see current commands
dmtools --help 2>/dev/null || ./cli --help 2>/dev/null

# Find command definitions in code
grep -rn "command\|CommandLine\|@Command\|subcommand" . --include="*.java" -l
```

### 🖥️ UI / UX
Check existing screens, components, and user flows if a UI is present:
```bash
# React/Vue/Angular components
find . -type f \( -name "*.tsx" -o -name "*.vue" -o -name "*.component.ts" \) | head -20
grep -rn "route\|<Route\|RouterModule" . --include="*.tsx" --include="*.ts" -l

# Design tokens / style guides
find . -name "*.stories.*" -o -name "*.figma*" | head -10
```

### 🧪 Tests (behaviour contracts)
Read existing tests to understand expected behaviour:
```bash
find . -name "*Test.java" -o -name "*.spec.ts" -o -name "*.test.js" | xargs grep -l "RelevantClass" 2>/dev/null
```

---

## Rule

Only **after** checking what currently exists — form your answer, acceptance criteria, or decision.

An answer that contradicts or ignores the existing implementation creates confusion for the team.
Always ground your response in **what actually exists today**.
