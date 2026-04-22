Write `outputs/response.md` in **Jira wiki markup** format.

⚠️ CRITICAL: In Jira wiki markup, `#` means a **numbered list item** — NOT a heading.
Writing `### Summary` will render in Jira as a deeply nested numbered list (1. > a. > i. Summary), which is completely wrong.

## FORBIDDEN — Never use these Markdown constructs

| ❌ DO NOT USE (Markdown)    | ✅ USE INSTEAD (Jira wiki markup) |
|------------------------------|-----------------------------------|
| `# Heading`                  | `h1. Heading`                     |
| `## Heading`                 | `h2. Heading`                     |
| `### Heading`                | `h3. Heading`                     |
| `#### Heading`               | `h4. Heading`                     |
| `**bold**`                   | `*bold*`                          |
| `---` (horizontal rule)      | `----` (four dashes in Jira)      |
| `\| col \| col \|` (table)   | `\|\|col\|\|\|col\|\|` (Jira)     |
| `\|---\|---\|` (table sep)   | *(no separator row in Jira)*      |
| `` ```mermaid ``` ``         | `{code:mermaid}...{code}`         |
| `` ```language ``` ``        | `{code:language}...{code}`        |

## Required structure for `outputs/response.md`

```
h2. Root Cause Analysis

h3. Summary
One paragraph describing the symptom: what the user/system experiences and under what conditions.

h3. Root Cause
Exact code-level finding: file path, function/component name, what is wrong and why.

h4. Sub-finding title (use h4 for sub-sections, never ###)
Details...

h3. Affected Code Path
Step-by-step trace from user action to failure point.

||Step||File||Component / Function / Logic||
|1|src/...|...|
|2|src/...|...|

h3. Impact

||Dimension||Detail||
|Scope|...|
|Severity|Critical / High / Medium / Low|
|Environment|...|
|Data loss / security|None / ...|

h3. Recommended Fix

h4. Option A — Short title
Description...

h4. Option B — Short title
Description...

h3. Files Involved

||File||Role||
|path/to/file.ext|Description of role|

h3. Open Questions
Any unknowns that need clarification before a developer can implement the fix.
Leave this section empty (or omit) if there are none.
```

## Additional Jira wiki markup rules

* Bullets: `* item` (not `- item`)
* Inline code: `{{monospace text}}`
* Preformatted block: `{noformat}...{noformat}`
* Mermaid diagram: `{code:mermaid}...{code}` — place the mermaid code directly inside, no backtick fences
* Bold: `*text*` (not `**text**`)
* Italic: `_text_`
* Horizontal rule: `----` (four dashes)
