You are fixing code issues identified in a Pull Request review.

**IMPORTANT**: Before starting, list the `input/` directory to find the ticket subfolder (e.g. `input/PROJ-123/`), then read ALL files from that subfolder in this order:
1. `request.md` — original ticket requirements and acceptance criteria
2. `comments.md` *(if present)* — ticket comment history with additional context or prior decisions
3. `existing_questions.json` *(if present)* — clarification questions with PO answers; treat answered questions as binding requirements
4. `parent_context_ba.md` *(if present)* — **Business Analysis**: acceptance criteria, business rules, and user flows from the parent Epic. Use to understand what must be implemented and verify the rework addresses all ACs.
5. `parent_context_sa.md` *(if present)* — **Solution Architecture**: technical design, API contracts, and architectural decisions from the parent Epic. Follow this design when applying fixes.
6. `parent_context_vd.md` *(if present)* — **Visual Design**: UI mockups, component specs, and design notes from the parent Epic. Align the rework with the expected look and feel.
7. `pr_info.md` — Pull Request metadata (PR number, URL, branch)
8. `pr_diff.txt` — Current code changes already in the PR (what was implemented)
9. `merge_conflicts.md` *(if present)* — **Merge conflicts that MUST be resolved FIRST** before any rework
10. `ci_failures.md` *(if present)* — **CI check failures with error logs that MUST be fixed**
11. `pr_discussions.md` — **ALL open (unresolved) review threads that MUST be fixed** — this file contains ONLY threads that are still open on GitHub. Already-resolved threads are excluded. **Every single thread in this file requires a code fix AND a reply entry in `review_replies.json` — no exceptions.**
12. `pr_discussions_raw.json` — Same threads with numeric IDs — use `rootCommentId` as `inReplyToId` and `id` as `threadId` when writing `outputs/review_replies.json`. **The number of reply entries MUST equal the number of threads in `pr_discussions.md`.**

**If `merge_conflicts.md` is present**: The branch was automatically merged with the base branch before you started. There are unresolved conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in the listed files. **Resolve all conflicts first** — open each conflicting file, fix the markers keeping the correct code, then `git add <file>`. Only after all conflicts are staged should you proceed with review fixes.

**If `ci_failures.md` is present**: CI checks are currently failing on this PR. Read the error logs in that file carefully to identify the root cause, then fix the code. CI failures are **blocking** — they must be resolved along with the review comments. After pushing, CI will re-run automatically.

Your mission is to address every issue raised in `pr_discussions.md`. This includes:

1. **Human review threads** — inline code review comments with `rootCommentId` and `threadId`. These MUST be fixed and replied to in `review_replies.json`.
2. **🤖 Maestro Test Results** — comments titled "🤖 Maestro Test Results" containing test automation results with a11y structural warnings. These have `rootCommentId: null` because they are PR comments (not review threads), but they contain **real, actionable bugs** that MUST be fixed. See the Maestro analysis section below.

**Ignore only**: bot ticket-link comments (e.g. "MAPC-XXXX ...link..."), previous rework summary comments, and automated code review APPROVE comments — these are informational and require no action.

### 🛑 STALE AUTOMATION LOOP — DO NOT REPEAT YOURSELF

If the only "blocker" is the reviewer asking for fresh post-fix automation, and you have ALREADY explained in a previous rework cycle that the code addresses the failure:

- Do NOT re-write code that's already correct.
- Do NOT post another "Rework Complete" comment with the same explanation — this triggers another review cycle.
- Write a short `outputs/response.md` saying *"No new actionable items — fix already in place on commit `<sha>`. Awaiting fresh automation run."* and an empty `outputs/review_replies.json`.

The reviewer's job is to APPROVE based on code analysis (review is cheaper than re-running automation). If you keep posting "Rework Complete" you keep retriggering the reviewer.

If `pr_discussions.md` contains NO actionable items (no human review threads AND no Maestro failures/warnings), then there is **nothing to fix** — write a short `outputs/response.md` stating "No open review comments to address" and an empty `outputs/review_replies.json` (`{ "replies": [] }`), then exit. **Do NOT post multiple acknowledgment comments.**

### Fixing human review threads
For each thread:
1. Understand the issue described by the reviewer
2. Locate the relevant code in the codebase
3. Apply the required fix
4. **Search the entire codebase for the same pattern** and fix ALL similar occurrences — not just the exact line the reviewer flagged. For example, if the reviewer flags a missing `accessibilityLabel`, search all similar components for the same omission and fix them too. This prevents the reviewer from raising the same issue again in the next cycle.
5. Write a reply entry in `outputs/review_replies.json` — mention all files you fixed (both the flagged one and the similar ones found by search)

**Every human review thread in `pr_discussions.md` must have exactly one matching entry in `review_replies.json`. Do not skip any thread.**

### 🧪 Fixing Test Automation Results (CRITICAL)

When `pr_discussions.md` contains test automation results (e.g., **🤖 Maestro Test Results**), you MUST analyze them in detail:

1. **Failed tests (❌)** — these indicate real bugs found by running automation on the actual build from this PR branch. The failure reason tells you exactly what's wrong.

2. **Structural warnings (⚠️)** — these are based on the **actual runtime state** captured at execution time. They are NOT static analysis guesses — they reflect what the accessibility tree or UI actually looks like. If a warning says "value is empty" or "content not exposed to tree", the fix in the code is **not working at runtime**.

3. **Never trust your own previous rework as evidence.** If you fixed something in a prior rework cycle but automation STILL reports the same issue — your fix did not work. Re-analyze the root cause from scratch. Only **reviewer comments** and **automation runtime data** are sources of truth.

4. **After fixing automation issues**: include a summary in `outputs/response.md` listing what warnings you addressed and how. Since automation comments have no `rootCommentId`, do NOT create a `review_replies.json` entry for them — just fix the code and document in `response.md`.

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
