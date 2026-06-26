# Bug-level Test Automation Guidelines

You are automating tests for a Bug that has reached **Ready For Testing**. The Bug already has linked Test Case tickets. Process **all linked Test Cases in one bulk run**.

## Workflow

1. Read the Bug ticket and all linked Test Cases from `input/{BUG_KEY}/linked_test_cases.md`.
2. If `input/{BUG_KEY}/merge_conflicts.md` is present, the test branch could not be cleanly synced with `origin/main`. Resolve every `<<<<<<<` / `=======` / `>>>>>>>` conflict marker in the listed files, using `input/{BUG_KEY}/pr_diff.txt` for context. Stage each resolved file with `git add <file>`. Do NOT `git commit` or `git merge --abort`.
3. For each linked Test Case:
   - Check if an automated test already exists under `testing/tests/{TC_KEY}/`.
   - If it exists, run it.
   - If it is missing, write a new automated test for it.
4. Produce `outputs/story_test_automation_result.json` (shared schema).
5. For every failed Test Case, produce `outputs/failed_description_{TC_KEY}.md`.
6. If environment/credentials are missing, produce `outputs/blocked.json`.

## Failure classification

- A **product failure** — the bug is not fixed or the automated test reveals a regression — must be recorded as `failed`. The Test Case goes to `Failed` and the Bug must go back to `Ready For Development` / `To Do`.
- An **access / credential / permission / infrastructure failure** — the test account cannot reach a required service, repository, secret, or token — is **NOT a product failure**. Mark that Test Case as `skipped`, explain the blocker in `failureSummary`, and keep the overall result as `passed` if all other Test Cases passed. Do **not** mark it `failed` and do **not** send the Bug to rework.
- If **every** linked Test Case is blocked by missing setup, set `overall` to `blocked_by_human` and produce `outputs/blocked.json`.

## Focus for Bug tests

- Tests must reproduce the original bug scenario and verify the fix.
- Include regression checks: ensure the bug does not reappear.
- Use the same layer architecture as Story tests.

## Output files

| File | Purpose |
|------|---------|
| `outputs/story_test_automation_result.json` | Per-TC results and overall status. |
| `outputs/tracker_comment.md` | Summary for the Bug ticket comment. |
| `outputs/failed_description_{TC_KEY}.md` | Full failure report for a failed Test Case. |
| `outputs/blocked.json` | Required when automation cannot run. |
