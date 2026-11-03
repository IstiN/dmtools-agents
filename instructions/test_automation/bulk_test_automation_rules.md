# Bulk Test Automation Shared Rules

## Pre-flight merge conflict resolution

If `merge_conflicts.md` exists in the ticket input folder, the test branch could not be cleanly synced with the remote default branch (e.g., `origin/$(git rev-parse --abbrev-ref origin/HEAD | cut -d/ -f2)`):
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
      "failureSummary": "One-line failure summary when status is failed.",
      "errorClass": "element-not-found|assertion|timeout|navigation|crash|unknown",
      "envFingerprint": "store/config revision + data seed actually used",
      "retryStatus": "green|red",
      "differential": "green|red|unavailable",
      "acVerdict": "violated|intact",
      "role": "own oracle|regression guard",
      "verifies": "BUG-123"
    }
  ],
  "blockedReason": "Explanation when overall is blocked_by_human."
}
```

- `results` must list every linked Test Case from `linked_test_cases.json`.
- `failedDescriptionFile` and `failureSummary` are required for every `failed` entry.
- `testPath` is required for every `passed` entry and omitted for `skipped` or `irrelevant`.
- **Triage metadata (gh-1329)** — on bugs, the pipeline attributes failures before bouncing:
  - `errorClass` is REQUIRED on every `failed` entry — classify from the failure evidence you already have (`element-not-found`, `assertion`, `timeout`, `navigation`, `crash`, or `unknown` when genuinely unclassifiable).
  - `envFingerprint` — when you can identify the environment the run used (store/config revision, data seed), record it; it is the baseline the triage compares against the last green run.
  - `retryStatus` — you already re-run a failed test once to confirm it: record `green` when that re-run passed, `red` when it failed again.
  - `role` / `verifies` — copy each Test Case's role from its description: `own oracle` (the TC says `Verifies: <BUG-KEY>` naming this bug) or `regression guard`; when the TC names a different bug in `Verifies:`, put that key in `verifies`.
  - `differential` — when a rerun of the same script on the last-green build is available to you, record its outcome; `unavailable` when no last-green build exists. Only the pipeline turns this into a bug bounce — never bounce a bug from the automation leg yourself.
  - `acVerdict` — only after a re-check of a failed own-oracle TC against the ticket's acceptance criteria: `violated` (the product genuinely violates the AC) or `intact` (the TC misencodes the requirement).
- Also write `outputs/tracker_comment.md` summarizing the run and `outputs/failed_description_{TC_KEY}.md` for each failed Test Case.
