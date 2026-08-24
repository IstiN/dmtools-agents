# Inline comments on existing discovery pages

When `input/discovery_inline_comments.md` is present, it contains inline (annotation) comments left on the existing discovery Confluence pages for this ticket.

## How to use them

- Read the file before editing any discovery content.
- Treat **unresolved** comments as review feedback. If a comment points out a mistake, asks a question, or requests a clarification, update the relevant discovery page so the concern is addressed.
- If a comment is already **resolved**, you do not need to act on it again, but you may reference it if useful.

## Replying to comments

If you make a change that directly answers an unresolved comment, add a reply entry to `outputs/discovery_replies.json`. The file must contain a JSON array with objects in this exact shape:

```json
[
  {
    "pageId": "12345678",
    "commentId": "98765432",
    "body": "Fixed — the assumption is now documented in the AS IS section."
  }
]
```

Rules:

- Only reply when your update genuinely addresses the comment.
- `pageId` and `commentId` must come from `input/discovery_inline_comments.md`.
- Keep replies concise and professional.
- If you do not reply to any comment, you may omit the file or write an empty array `[]`.
