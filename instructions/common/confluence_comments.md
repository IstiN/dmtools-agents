# Confluence output

Active only when the agent is configured to publish its output to Confluence (`contentOutput.target` is `confluence` or `both`). If `input/confluence_output_target.json` is not present, skip this instruction entirely.

## Output format

When `input/confluence_output_target.json` is present, your output is published to a Confluence page:

- Write `outputs/response.md` as **Markdown** — it is converted to Confluence storage format on publish. Do NOT use tracker-specific markup (no Jira `{code}` / `h2.` / ADF), even if other instructions ask for it; Markdown wins for this output.
- If `input/confluence_output_current.md` exists, it contains the page's current content — iterate on it instead of rewriting from scratch. The current content may be in legacy tracker markup from earlier runs — still write your output in Markdown.

## Inline comment anchors (`[[ic:...]]` placeholders)

`input/confluence_output_current.md` may contain placeholders like `[[ic:550e8400-e29b-41d4-a716-446655440000]]anchored text[[/ic]]`. Each one marks the text fragment an **inline comment is anchored to** on the published page. On publish, the Confluence Markdown sync converts these placeholders back into real page anchors; if you drop or mangle them, the comment loses its anchor and disappears from the page.

Rules:

- **Always preserve** every `[[ic:REF]]...[[/ic]]` placeholder, wrapped around the same text it currently marks.
- If you rephrase the anchored text, **move the placeholder** so it wraps the new equivalent fragment.
- On headings, place the placeholder **inside** the heading, after the `#` markers — `## [[ic:REF]]Purpose[[/ic]]`, never `[[ic:REF]]## Purpose[[/ic]]` (wrapping the `#` prefix breaks heading rendering).
- The same applies to list items and quotes: keep `-`, `1.`, `>` outside the placeholder.
- Remove a placeholder only when you intentionally remove the commented content itself.
- Never invent new `[[ic:...]]` refs — only the ones already present are valid.

## Reading comments

`input/confluence_output_comments.md` lists inline (annotation) comments left on the existing Confluence page for this ticket, and `input/confluence_output_current.md` contains the page's current content.

- Treat **unresolved** comments as review feedback: if a comment points out a mistake, asks a question, or requests a clarification, address it in the updated output.
- Already **resolved** comments need no action, but may provide useful context.

## Replying to comments

When your update directly answers an unresolved comment, add a reply entry to `outputs/confluence_replies.json`. The file must be a JSON array:

```json
[
  {
    "pageId": "12345678",
    "commentId": "98765432",
    "body": "Fixed — the section now covers this case."
  }
]
```

Rules:

- Only reply when the update genuinely addresses the comment.
- `pageId` and `commentId` must come from `input/confluence_output_comments.md`.
- Keep replies concise and professional.
- If no comment needs a reply, omit the file or write an empty array `[]`.
