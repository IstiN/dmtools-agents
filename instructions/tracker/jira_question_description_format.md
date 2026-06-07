# Jira Question Description Format

When writing question descriptions for Jira tracker, follow these formatting rules:

```mermaid
flowchart TD
    subgraph SYNTAX["Jira Markdown Syntax"]
        S1["*bold* — single asterisks for bold text"]
        S2["- item — dashes for bullet lists"]
        S3["Do NOT use ** double asterisks"]
        S4["Do NOT use # Markdown headers"]
    end

    subgraph TEMPLATE["Required Question Structure"]
        T1["*Background:* 1-2 sentences explaining why this matters"]
        T2["*Question:* clear, specific question"]
        T3["*Options:* 2-3 bullets (omit if only one valid path)"]
        T4["*Recommended Decision:* always provide your best guess even if uncertain"]
    end

    SYNTAX --> TEMPLATE
```
