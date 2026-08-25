# Confluence inline comments

Active only when the agent is configured to publish its output to Confluence (`contentOutput.target` is `confluence` or `both`). If `input/confluence_output_comments.md` is not present, skip this instruction entirely.

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
