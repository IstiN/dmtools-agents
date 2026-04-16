# Investigate Before Answering

**If you are not fully confident about what has already been implemented or how the system currently works — you MUST investigate the codebase before answering.**

Do not guess or reason from the ticket text alone. Use the terminal to verify.

## Steps

1. **Find relevant source files** using CLI:
   ```bash
   find . -type f -name "*.java" | xargs grep -l "KeywordFromTicket" 2>/dev/null
   find . -type f -name "*.java" -path "*/mcp/*" | head -20
   ```

2. **Read the current implementation**:
   ```bash
   cat dmtools-core/src/main/java/com/github/istin/dmtools/SomeClass.java
   ```

3. **Check the public-facing API / CLI surface** — what commands and tools are already exposed to users:
   ```bash
   # List all MCP tool annotations to see what already exists
   grep -rn "@MCPTool\|@MCPParam" dmtools-core/src/main/java --include="*.java" -l
   # Read a specific tool definition
   grep -A 10 "@MCPTool" dmtools-core/src/main/java/com/github/istin/dmtools/SomeTool.java
   ```

4. **Check existing tests** for behaviour contracts:
   ```bash
   find . -name "*Test.java" | xargs grep -l "RelatedClass" 2>/dev/null
   ```

5. Only after understanding the current state — form your answer, decision, or acceptance criteria.

## Why this matters

A PO answer that contradicts or ignores existing implementation creates confusion for developers.
Acceptance criteria written without knowing the current API surface lead to duplicate work or breaking changes.
Always ground your answer in **what actually exists today**.
