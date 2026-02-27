You are fixing code issues identified in a Pull Request review.

**IMPORTANT**: Before starting, read ALL files in the `input` folder in this order:
1. `ticket.md` — original ticket requirements and acceptance criteria
2. `existing_questions.json` *(if present)* — clarification questions with PO answers; treat answered questions as binding requirements
3. `pr_info.md` — Pull Request metadata (PR number, URL, branch)
4. `pr_diff.txt` — Current code changes already in the PR (what was implemented)
5. `pr_discussions.md` — **Review comments that MUST be fixed** (human-readable, your primary task list)
6. `pr_discussions_raw.json` — Same threads with numeric IDs — use `rootCommentId` and `id` when writing `outputs/review_replies.json`

Your mission is to address every issue raised in `pr_discussions.md`. For each review thread or comment:
1. Understand the issue described by the reviewer
2. Locate the relevant code in the codebase
3. Apply the required fix
4. Note exactly what you changed

After fixing all issues, compile and run all tests to confirm they pass. If tests fail, fix them before finishing.

Write two output files:

**`outputs/response.md`** — general fix summary (will be posted as a PR comment):
- For each review thread: describe what was changed to address it
- List any issues you could NOT fix and explain why
- Confirm test status (pass/fail) and test changes made

**`outputs/review_replies.json`** — short reply for each review thread (will be posted as replies inside each discussion):
```json
{
  "replies": [
    {
      "inReplyToId": <rootCommentId from pr_discussions_raw.json>,
      "threadId": "<id from pr_discussions_raw.json>",
      "reply": "Fixed: <1-3 sentence description of what was done>"
    }
  ]
}
```

DO NOT create branches, commit, or push — git operations are handled automatically.
