User request is in the 'input' folder. Read all files there.

**IMPORTANT**: Read in order:
1. `request.md` *(if present)* — full ticket details
2. `comments.md` *(if present)* — ticket comment history; recent comments contain previous test run results
3. `ticket.md` — the Test Case ticket (objective, steps, expected result)
4. `pr_info.md` — PR metadata and current test result (PASSED or FAILED)
3. `pr_diff.txt` — all code changes in this PR
4. `pr_discussions.md` — previous review comments (if any)
5. `pr_discussions_raw.json` *(if present)* — previous thread IDs; populate `resolvedThreadIds` in `pr_review.json` with `threadId` values for any prior thread that is **fully fixed** in this diff

Your task is to review the test automation PR — not the feature code. Focus on whether the test correctly implements the Test Case and follows the testing architecture.

## ⚠️ MANDATORY OUTPUT FILES — automation will silently fail without these

You MUST write all three files below. Do NOT just write the review as plain text — the post-processing pipeline reads these files directly.

### 1. `outputs/pr_review.json` — REQUIRED (exact format in `pr_review_json_output.md`)
This is the machine-readable result consumed by the post-action. If it is missing the entire review outcome is lost — the ticket will not be merged, no status will change, and no comments will be posted.

**⚠️ CRITICAL — `recommendation` field**: Use EXACTLY `"APPROVE"`, `"REQUEST_CHANGES"`, or `"BLOCK"`. Never `"APPROVED"` (with extra D). Never use `"verdict"` as the field name.

### 2. `outputs/pr_review_general.md` — REQUIRED
GitHub-formatted general PR comment (referenced in `pr_review.json` → `generalComment`).

### 3. `outputs/response.md` — REQUIRED
Jira-formatted review summary posted as a ticket comment.
