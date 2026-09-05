## PR Rework — Output Rules

Rework posts **only** to the Pull Request. All output must be Markdown.

### Required files

1. `outputs/response.md`
   - Markdown fix summary for the top-level PR comment.
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
      "threadId": "<copied verbatim from pr_discussions_raw.json>",
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
- `threadId` is required to resolve/close the conversation; `inReplyToId` is required to post the reply in the correct thread.
- ⚠️ **Copy `threadId` verbatim, character-for-character, from `pr_discussions_raw.json`.** Its format depends on which SCM the PR lives on (a GitHub GraphQL node ID, a GitLab discussion hash, an ADO thread number, etc.) and is opaque — never invent, prefix, reformat, or pattern-match it against an example. The value above is a placeholder showing *where* the field goes, not what it should look like.
- Do **not** put the reply body inline in the JSON; use the `reply` field only as a file path reference.
- ⚠️ **Common mistake**: `pr_discussions_raw.json` uses the field names `rootCommentId` and `body`. When writing `review_replies.json`, you MUST rename these to `inReplyToId` and `reply` respectively — do NOT copy the input field names as-is into the output JSON, or the reply will silently post as an untargeted top-level comment instead of a threaded reply.
