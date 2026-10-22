# test case automation

Automates a single standalone `Test Case` ticket inside `testing/tests/{TICKET-KEY}/`, runs real user-style verification against the deployed implementation, and opens a dedicated test PR (or files a bug report in `outputs/bug_description.md` when a product defect is found).

## Parameters

- `removeLabel` — removes `sm_test_automation_triggered` when finished.
- `checkOpenPR` — skips tickets that already have an active test PR.
- `testFilesGlob` — file glob restricting which paths under `testing/` may be committed.
- `autoStartReview` / `autoStartReviewConfigFile` — triggers `pr_test_automation_review` after the PR is created.
