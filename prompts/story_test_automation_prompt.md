> Role: Senior QA Automation Engineer
> Task: Bulk automate/run all Test Cases linked to a Story that is Ready For Testing.

## Context files you must read

- `input/{STORY_KEY}/ticket.md` — Story details, acceptance criteria, solution.
- `input/{STORY_KEY}/linked_test_cases.md` — all linked Test Cases with key, summary, description, priority, and existing status.
- `input/{STORY_KEY}/linked_test_cases.json` — machine-readable version of the above.
- `input/{STORY_KEY}/merge_conflicts.md` *(if present)* — unresolved merge conflicts from syncing the test branch with `origin/main`.
- `input/{STORY_KEY}/pr_diff.txt` *(if present)* — diff context for resolving conflicts.
- `testing/` — existing reusable components, frameworks, core helpers, and previously automated tests.

## Task steps

1. **If `input/{STORY_KEY}/merge_conflicts.md` exists**, resolve all `<<<<<<<` / `=======` / `>>>>>>>` conflict markers in the listed files first, using `input/{STORY_KEY}/pr_diff.txt` for context. Stage each resolved file with `git add <file>`. Do NOT `git commit` or `git merge --abort`. Only proceed to test automation after the working directory is clean of conflicts.
2. Run `codegraph context "{STORY_KEY} test automation existing tests and reusable helpers"` before grepping files.
2. For each linked Test Case `{TC_KEY}`:
   - Check `testing/tests/{TC_KEY}/`.
   - If the Test Case is **legacy, obsolete, or no longer applicable** (e.g., the product behavior or external contract it verified has been removed/changed), record `status: "irrelevant"` and do NOT write or keep test code for it.
   - If it exists, run the test and record the result.
   - If it is missing, write a new automated test following the architecture rules.
3. After running/writing, re-run any failed test at least once to confirm it is a real failure (not a flaky environment issue).
4. Write `outputs/story_test_automation_result.json` with the exact schema from the output rules.
5. Write `outputs/tracker_comment.md` summarizing the bulk run.
6. For each failed Test Case, write `outputs/failed_description_{TC_KEY}.md`.

## Important rules

- One Story = one branch `test/{STORY_KEY}` and one PR.
- All test code lives under `testing/`.
- Do NOT modify feature code.
- Reuse existing helpers; do not duplicate infrastructure.
- If credentials or test data are missing, stop and write `outputs/blocked.json`.
- Each new `testing/tests/{TC_KEY}/` folder must contain `README.md` and `config.yaml`.
