> Role: Senior QA Automation Engineer
> Task: Bulk automate/run all Test Cases linked to a Bug that is Ready For Testing.

## Context files you must read

- `input/{BUG_KEY}/ticket.md` — Bug details, description, reproduction steps.
- `input/{BUG_KEY}/linked_test_cases.md` — all linked Test Cases.
- `input/{BUG_KEY}/linked_test_cases.json` — machine-readable list.
- `input/{BUG_KEY}/merge_conflicts.md` *(if present)* — unresolved merge conflicts from syncing the test branch with `origin/main`.
- `input/{BUG_KEY}/pr_diff.txt` *(if present)* — diff context for resolving conflicts.
- `testing/` — existing tests and reusable helpers.

## Task steps

1. **If `input/{BUG_KEY}/merge_conflicts.md` exists**, resolve all `<<<<<<<` / `=======` / `>>>>>>>` conflict markers in the listed files first, using `input/{BUG_KEY}/pr_diff.txt` for context. Stage each resolved file with `git add <file>`. Do NOT `git commit` or `git merge --abort`. Only proceed to test automation after the working directory is clean of conflicts.
2. Run `codegraph context "{BUG_KEY} test automation existing tests and reusable helpers"` before grepping.
2. For each linked Test Case `{TC_KEY}`:
   - Check `testing/tests/{TC_KEY}/`.
   - If it exists, run it.
   - If missing, write a new automated test that reproduces the bug and verifies the fix.
3. Re-run failed tests once to confirm real failure.
4. Write `outputs/story_test_automation_result.json` with the shared schema.
5. Write `outputs/tracker_comment.md` summarizing the bulk run.
6. For each failed Test Case, write `outputs/failed_description_{TC_KEY}.md`.

## Rules

- One Bug = one branch `test/{BUG_KEY}` and one PR.
- All test code lives under `testing/`.
- Do NOT modify feature code.
- Each new `testing/tests/{TC_KEY}/` folder must contain `README.md` and `config.yaml`.
- Focus tests on the bug regression scenario.
