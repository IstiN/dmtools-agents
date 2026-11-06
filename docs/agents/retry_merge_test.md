# retry merge test

Retries merging an approved single-Test-Case automation pull request (`retryMergeTestPR.js`), re-attempting the merge and updating the Test Case ticket status.

## Parameters

- `removeLabel` — removes `sm_retry_merge_test_triggered` once the retry completes.
- `checkOpenPR` — skips tickets without an open test-case PR.
- `testCaseMerge` — test-case PR merge configuration overrides.
- `autoStartRework` / `autoStartReworkConfigFile` — triggers `pr_test_automation_rework` when the test PR cannot be merged cleanly.
- `maxAutoReworkRounds` — maximum auto-started rework rounds (`rework-round-N` on the ticket, default `3`) before the ticket is labeled `needs-human` and no further rework is chained.
