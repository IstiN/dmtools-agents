# bug test automation

Automates and executes all linked Test Case tickets for a Bug in `Ready For Testing` on a single `test/{BUG_KEY}` branch, verifying the regression scenario and opening a bulk test PR.

## Parameters

- `removeLabel` — clears `sm_bug_test_automation_triggered` after the run.
- `testFilesGlob` — glob pattern limiting which files under `testing/` are staged for the bug test PR.
- `checkOpenPR` — skips the run if an open test PR already exists for the bug.
- `customStatuses` — overrides default tracker status names for bug/test transitions.
- `autoStartReview` / `autoStartReviewConfigFile` — dispatches the bug test PR review config once the PR is opened.
