User request is in the 'input' folder. Read all files there.

**IMPORTANT**: Read in order:
1. `request.md` *(if present)* — full ticket details
2. `comments.md` *(if present)* — ticket comment history; recent comments contain previous test run results and review feedback
3. `linked_bugs.md` *(if present)* — **CRITICAL**: linked bugs that block or relate to this test case.
   - Read the **Solution** field and **AI Fix Comments** carefully — they describe HOW the bug was fixed.
   - If the fix introduced **timing or async behavior** (e.g., a heartbeat probe with an interval, retry delay, polling timeout) — the test **MUST** wait long enough to observe the effect. Do NOT assert immediately after triggering the action.
   - Example: if the bug was fixed by a heartbeat probe that runs every 5 seconds, the test must wait at least 5–10 seconds after simulating the failure condition before asserting the error appears.
4. `ticket.md` — the Test Case ticket (objective, steps, expected result)
5. `pr_info.md` — PR metadata
6. `pr_diff.txt` — current test code
7. `merge_conflicts.md` *(if present)* — **Resolve all merge conflicts FIRST** before touching anything else
8. `pr_discussions.md` — review comments that must be addressed
9. `pr_discussions_raw.json` — structured thread data with IDs for replies

**If `merge_conflicts.md` is present**: Resolve every `<<<<<<<` / `=======` / `>>>>>>>` conflict marker in the listed files, then `git add <file>` for each. Do NOT `git commit` or `git merge --abort`.

The feature code is **already in main branch**. Your job is to:
1. Fix all issues raised in the PR review comments (address every thread)
2. Re-run the test and capture the new result
3. Write output files

**You may ONLY write code inside the `testing/` folder.**

## Output files

**⚠️ CRITICAL: All output files MUST be written to `outputs/` at the repository root** (e.g. `/home/runner/work/repo/repo/outputs/`).
Do NOT write them inside `input/`, `input/TICKET-KEY/`, or any subfolder of `input/`. The post-processing script reads from `outputs/` at the repo root — writing elsewhere means all results will be silently lost.

Run `mkdir -p outputs` first to ensure the directory exists.

- `outputs/response.md` — rework summary in **Jira Markdown** (short, factual): what was fixed + new test result
- `outputs/pr_body.md` — same content in **GitHub Markdown** (always required — posted as GitHub PR comment; use standard MD: `##`, `**bold**`, backticks — NOT Jira syntax like `h3.`, `*bold*`, `{code}`)
- `outputs/test_automation_result.json` — **MANDATORY — always write this file**, even if the test failed or errored. Use exactly this format:
  ```json
  { "status": "passed", "passed": 1, "failed": 0, "skipped": 0, "summary": "1 passed, 0 failed" }
  ```
  or for failure:
  ```json
  { "status": "failed", "passed": 0, "failed": 1, "skipped": 0, "summary": "0 passed, 1 failed", "error": "AssertionError: <exact error message>" }
  ```
  The `"status"` field **must** be exactly `"passed"` or `"failed"` (lowercase). Missing or wrong field name causes the pipeline to break.
- `outputs/review_replies.json` — replies per thread: `{ "replies": [{ "inReplyToId": 123, "threadId": "PRRT_...", "reply": "Fixed: ..." }] }`
- `outputs/bug_description.md` — updated bug description in Jira Markdown (only if test still FAILED)
