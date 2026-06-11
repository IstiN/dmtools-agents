# Jira Question Description Format

When writing question descriptions for Jira tracker, use **Jira wiki markup**.

| Element | Jira wiki markup | Example |
|---------|------------------|---------|
| Bold | `*text*` | `*Background:*` |
| Italic | `_text_` | `_hint_` |
| Bullet list | `* item` | `* Option A: ...` |
| Numbered list | `# item` | `# Step one` |
| Inline code | `{{code}}` | `{{main.dart}}` |
| Link | `[title|url]` | `[TS-24|https://...]` |

**Rules:**
- Use `*text*` for bold — single asterisks, NOT `**` double asterisks.
- Use `* item` for bullets — asterisk + space, NOT `- item` or Markdown lists.
- Do NOT use Markdown headings (`#`, `##`, `###`).
- Do NOT use fenced code blocks (triple backticks). Use `{code}...{code}` if needed.
- Do NOT write literal XML tags like `<bold>` or `<bullet>`.

**Correct example:**

```text
*Background:* 1-2 sentences explaining why this matters.

*Question:* clear, specific question.

*Options:*
* Option A: description
* Option B: description
* Option C: description

*Recommended Decision:* always provide your best guess even if uncertain.
```
