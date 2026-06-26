# Story-level Test Automation Guidelines

You are automating a Story that has reached **Ready For Testing**. The Story already has linked Test Case tickets. Your job is to process **all linked Test Cases in one bulk run**.

## Workflow

1. Read the Story ticket and all linked Test Cases from `input/{STORY_KEY}/linked_test_cases.md`.
2. If `input/{STORY_KEY}/merge_conflicts.md` is present, the test branch could not be cleanly synced with `origin/main`. Resolve every `<<<<<<<` / `=======` / `>>>>>>>` conflict marker in the listed files, using `input/{STORY_KEY}/pr_diff.txt` for context. Stage each resolved file with `git add <file>`. Do NOT `git commit` or `git merge --abort`.
3. For each linked Test Case:
   - Check if an automated test already exists under `testing/tests/{TC_KEY}/`.
   - If it exists, run it.
   - If it is missing, write a new automated test for it.
4. Produce a single result JSON: `outputs/story_test_automation_result.json`.
5. For every failed Test Case, produce `outputs/failed_description_{TC_KEY}.md`.
6. If environment/credentials are missing, produce `outputs/blocked.json` instead of running tests.

## Failure classification

- A **product failure** — the test ran and found a real bug in the product — must be recorded as `failed`. The Story and the failing Test Case follow the normal review flow.
- An **access / credential / permission / infrastructure failure** — the test account cannot reach a required service, repository, secret, or token — is **NOT a product failure**. Mark that Test Case as `skipped`, explain the blocker in `failureSummary`, and keep the overall result as `passed` if all other Test Cases passed. Do **not** mark it `failed`.
- If **every** linked Test Case is blocked by missing setup, set `overall` to `blocked_by_human` and produce `outputs/blocked.json`.

## Scope rules

- You may ONLY write code inside the `testing/` folder.
- Each Test Case must have its own folder under `testing/tests/{TC_KEY}/`.
- Reuse components from `testing/components/`, `testing/frameworks/`, and `testing/core/`.
- Do NOT put raw Flutter/widget locators or `WidgetTester` code directly in the ticket test file.
- Every `testing/tests/{TC_KEY}/` folder must contain:
  - `README.md` describing what is being tested.
  - `config.yaml` with test metadata.

## Output files

| File | Purpose |
|------|---------|
| `outputs/story_test_automation_result.json` | Per-TC results and overall status. |
| `outputs/tracker_comment.md` | Human-readable summary for the Story ticket comment. |
| `outputs/failed_description_{TC_KEY}.md` | Full failure report for a failed Test Case. |
| `outputs/blocked.json` | Required when automation cannot run due to missing setup. |

## Result statuses

- `passed` — test ran successfully.
- `failed` — test ran and failed; a failed description file must be written.
- `skipped` — test cannot be automated (requires human-only verification); explain why.
- `blocked_by_human` — the whole Story is blocked by missing credentials/data.
