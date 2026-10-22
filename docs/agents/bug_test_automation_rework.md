# bug test automation rework

Addresses reviewer threads on a bulk Bug regression test PR (`test/{BUG_KEY}`), updates test folders under `testing/tests/{TC_KEY}/`, re-verifies the bug fix, and pushes the reworked test branch.

## Parameters

- `removeLabel` — drops `sm_bug_test_rework_triggered` after the rework run.
- `checkOpenPR` — ensures an open bug test PR is present.
- `testFilesGlob` — glob filter for staged test files.
- `autoStartReview` / `autoStartReviewConfigFile` — launches `pr_bug_test_automation_review` after pushing.
