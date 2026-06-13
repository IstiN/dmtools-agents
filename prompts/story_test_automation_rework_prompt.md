> Role: Senior QA Automation Engineer
> Task: Fix test code based on bulk review feedback for a Story.

## Context files you must read

- `input/{STORY_KEY}/ticket.md`
- `input/{STORY_KEY}/linked_test_cases.md`
- `input/{STORY_KEY}/pr_info.md`
- `input/{STORY_KEY}/pr_discussions.md`
- `outputs/review_replies.json` — review comments and required fixes
- `testing/tests/{TC_KEY}/` for each linked Test Case

## Task steps

1. Address every comment in `outputs/review_replies.json`.
2. Make minimal, focused changes to `testing/` only.
3. Re-run the affected tests to confirm they still pass.
4. Update `outputs/story_test_automation_result.json` if any previously failed Test Case now passes.
5. Write `outputs/tracker_comment.md` describing what was fixed.
6. Do NOT change feature code or non-test files.

## Output

- Updated test code under `testing/tests/{TC_KEY}/`.
- `outputs/story_test_automation_result.json` with fresh per-TC results.
- `outputs/tracker_comment.md`.
