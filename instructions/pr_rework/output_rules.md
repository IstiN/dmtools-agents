## PR Rework — Output Rules

Rework posts **only** to the Pull Request. All output must be Markdown.

### Required files

1. `outputs/response.md`
   - GitHub Markdown fix summary for the top-level PR comment.
   - Use `#`/`##` headings, ` ``` ` code fences, `-` bullets.
   - Required sections: `## Issues/Notes`, `## Approach`, `## Files Modified`, `## Test Coverage`.

2. `outputs/review_replies.json`
   - **Mandatory** when the PR has open review threads.
   - If there are no open threads, write `{ "replies": [] }`.
   - Format:

```json
{
  "replies": [
    {
      "inReplyToId": 1234567890,
      "threadId": "PRRT_<graphQL_id>",
      "reply": "outputs/review_replies/thread_1.md"
    }
  ]
}
```

3. `outputs/review_replies/*.md`
   - One Markdown file per open PR review thread.
   - The file path is referenced from `outputs/review_replies.json` via the `reply` field.
   - Keep each reply concise and factual; reference the fix location when possible.

Rules for review replies:
- Read `input/<TICKET>/pr_discussions_raw.json` to obtain each open thread's `threadId` and `rootCommentId` (`inReplyToId`).
- Create one reply entry and one `.md` file for **every** open review thread — do not skip any unresolved conversation.
- `threadId` is required for GitHub to resolve/close the conversation; `inReplyToId` is required to post the reply in the correct thread.
- Do **not** put the reply body inline in the JSON; use the `reply` field only as a file path reference.
