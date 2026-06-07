# Jira Question Description Format

When writing question descriptions for Jira tracker, render the generic formatting tags as Jira Markdown:

| Generic tag | Jira Markdown |
|-------------|---------------|
| `<bold>X</bold>` | `*X*` |
| `<bullet>` | `-` |

Additional formatting rules:
- `*bold*` — single asterisks for bold text
- `- item` — dashes for bullet lists
- Do NOT use `**` double asterisks
- Do NOT use `#` Markdown headers

```mermaid
flowchart TD
    subgraph SYNTAX["Jira Markdown Syntax"]
        S1["<bold>X</bold> → *X*"]
        S2["<bullet> → - item"]
        S3["Do NOT use ** double asterisks"]
        S4["Do NOT use # Markdown headers"]
    end

    subgraph EXAMPLE["Rendered Example"]
        T1["*Background:* 1-2 sentences explaining why this matters"]
        T2["*Question:* clear, specific question"]
        T3["*Options:* 2-3 bullets (omit if only one valid path)"]
        T4["*Recommended Decision:* always provide your best guess even if uncertain"]
    end

    SYNTAX --> EXAMPLE
```
