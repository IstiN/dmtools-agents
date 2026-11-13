<!-- ⚠️ DEPRECATED v1 shim — frozen content, REMOVED in the next major release. -->
<!-- Live version(s): instructions/pr_review/base/output_rules.md — update your .dmtools/config.js (cliPrompts / cliPromptOverrides)
<!-- or .dmtools/runners/*.json to pin the new path. Content below is kept verbatim so configs
<!-- pinning this old path keep working during the deprecation window.

```mermaid
flowchart TD
    O1["Write outputs/response.md — concise tracker-agnostic Markdown summary"]
    O2["Write outputs/pr_review.json — structured data for GitHub PR review"]
    O3["Write outputs/pr_review_general.md — brief general PR comment (1-2 paragraphs max)"]
    O4["Write outputs/pr_review_comments/ — directory with individual inline comment files"]
    O5["If pr_discussions.md present → include resolvedThreadIds in pr_review.json"]
    O6["Tracker-specific formatting is injected via cliPromptsByTracker — do NOT hardcode Jira/ADO markup in response.md"]
    O1 --> O2 --> O3 --> O4 --> O5 --> O6
```
