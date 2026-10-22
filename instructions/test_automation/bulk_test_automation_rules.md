# Bulk Test Automation Shared Rules

## Pre-flight merge conflict resolution

If `merge_conflicts.md` exists in the ticket input folder, the test branch could not be cleanly synced with `origin/main`:
1. Resolve every `<<<<<<<` / `=======` / `>>>>>>>` conflict marker in the listed files, using `pr_diff.txt` for context.
2. Stage each resolved file with `git add <file>`.
3. Do NOT `git commit` or `git merge --abort`. Only proceed to test automation after the working directory is clean of conflicts.

## Failure classification

- **Product failure**: the test ran and found a real defect or regression in the product → record status as `failed` and write `outputs/failed_description_{TC_KEY}.md`.
- **Access / credential / permission / infrastructure failure**: the test account cannot reach a required service, repository, secret, or token → mark that Test Case as `skipped`, explain the blocker in `failureSummary`, and keep `overall` as `passed` if all other Test Cases passed. Do **not** mark it `failed`.
- **All Test Cases blocked by missing setup**: set `overall` to `blocked_by_human` and produce `outputs/blocked.json`.

## Shared `outputs/story_test_automation_result.json` contract

Write `outputs/story_test_automation_result.json` in a single `Write` call (do NOT use `Edit` on this file; rewrite it completely if corrections are needed):

```json
{
  "storyKey": "TS-123",
  "overall": "passed|failed|blocked_by_human",
  "summary": "Short human-readable summary of what was done.",
  "results": [
    {
      "testCaseKey": "TS-124",
      "status": "passed|failed|skipped|irrelevant",
      "testPath": "testing/tests/TS-124/...",
      "failedDescriptionFile": "outputs/failed_description_TS-124.md",
      "failureSummary": "One-line failure summary when status is failed."
    }
  ],
  "blockedReason": "Explanation when overall is blocked_by_human."
}
```

- `results` must list every linked Test Case from `linked_test_cases.json`.
- `failedDescriptionFile` and `failureSummary` are required for every `failed` entry.
- `testPath` is required for every `passed` entry and omitted for `skipped` or `irrelevant`.
- Also write `outputs/tracker_comment.md` summarizing the run and `outputs/failed_description_{TC_KEY}.md` for each failed Test Case.
