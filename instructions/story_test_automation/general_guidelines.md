# Story-level Test Automation Guidelines

You are automating a Story that has reached **Ready For Testing**. The Story already has linked Test Case tickets. Your job is to process **all linked Test Cases in one bulk run**.

## Workflow

1. Read the Story ticket and all linked Test Cases from `input/{STORY_KEY}/linked_test_cases.md`.
2. For each linked Test Case:
   - Check if an automated test already exists under `testing/tests/{TC_KEY}/`.
   - If it exists, run it.
   - If it is missing, write a new automated test for it.
3. Produce a single result JSON: `outputs/story_test_automation_result.json`.
4. For every failed Test Case, produce `outputs/failed_description_{TC_KEY}.md`.
5. If environment/credentials are missing, produce `outputs/blocked.json` instead of running tests.

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
