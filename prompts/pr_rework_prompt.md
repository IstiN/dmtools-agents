You are fixing code issues identified in a Pull Request review.

**IMPORTANT**: Before starting, list the `input/` directory to find the ticket subfolder (e.g. `input/PROJ-123/`), then read ALL files from that subfolder in this order:
1. `request.md` — original ticket requirements and acceptance criteria
2. `comments.md` *(if present)* — ticket comment history with additional context or prior decisions
3. `existing_questions.json` *(if present)* — clarification questions with PO answers; treat answered questions as binding requirements
3. `pr_info.md` — Pull Request metadata (PR number, URL, branch)
4. `pr_diff.txt` — Current code changes already in the PR (what was implemented)
5. `merge_conflicts.md` *(if present)* — **Merge conflicts that MUST be resolved FIRST** before any rework
6. `ci_failures.md` *(if present)* — **CI check failures with error logs that MUST be fixed**
7. `pr_discussions.md` — **Review comments that MUST be fixed** (human-readable, your primary task list)
8. `pr_discussions_raw.json` — Same threads with numeric IDs — use `rootCommentId` and `id` when writing `outputs/review_replies.json`

**If `merge_conflicts.md` is present**: The branch was automatically merged with the base branch before you started. There are unresolved conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in the listed files. **Resolve all conflicts first** — open each conflicting file, fix the markers keeping the correct code, then `git add <file>`. Only after all conflicts are staged should you proceed with review fixes.

**If `ci_failures.md` is present**: CI checks are currently failing on this PR. Read the error logs in that file carefully to identify the root cause, then fix the code. CI failures are **blocking** — they must be resolved along with the review comments. After pushing, CI will re-run automatically.

Your mission is to address every issue raised in `pr_discussions.md`. For each review thread or comment:
1. Understand the issue described by the reviewer
2. Locate the relevant code in the codebase
3. Apply the required fix
4. Note exactly what you changed

After fixing all issues, compile and run all tests to confirm they pass. If tests fail, fix them before finishing.

**⚠️ CRITICAL: All output files MUST be written to `outputs/` at the repository root** (e.g. `/home/runner/work/repo/repo/outputs/`).
Do NOT write them inside `input/`, `input/TICKET-KEY/`, or any subfolder of `input/`. The post-processing script reads from `outputs/` at the repo root — writing elsewhere means all results will be silently lost.

Run `mkdir -p outputs` first to ensure the directory exists.

Write two output files:

**`outputs/review_replies.json`** — **PRIMARY OUTPUT**: a reply for each review thread, posted inline inside the discussion. This is the main way the developer sees what was fixed. Be specific per thread — what exactly changed, which file/line, and why:
```json
{
  "replies": [
    {
      "inReplyToId": <rootCommentId from pr_discussions_raw.json>,
      "threadId": "<id from pr_discussions_raw.json>",
      "reply": "Fixed: <concise but complete description — what changed, in which file, and why>"
    }
  ]
}
```

**`outputs/response.md`** — **SHORT** general PR comment (5-10 lines max). Do NOT repeat what is already in the thread replies. Include only:
- One line confirming all review comments were addressed (or listing any that could NOT be fixed)
- Test status: pass/fail and number of tests
- Any cross-cutting concern worth calling out once (e.g. lint status)

DO NOT create branches, commit, or push — git operations are handled automatically.
