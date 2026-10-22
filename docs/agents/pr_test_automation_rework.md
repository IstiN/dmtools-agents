# pr test automation rework

Applies PR review feedback and CI fixes for a single-Test-Case automation pull request (`In Rework`), updating `outputs/test_automation_result.json` and pushing changes to the test branch.

## Parameters

- `removeLabel` — clears `sm_test_rework_triggered` after pushing rework commits.
- `checkOpenPR` — requires an open test PR before running rework.
- `autoStartReview` / `autoStartReviewConfigFile` — re-runs the test PR review workflow after rework is pushed.
