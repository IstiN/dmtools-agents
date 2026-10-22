# retry merge

Retries merging an approved feature or bug-fix pull request that was blocked by a transient conflict or CI check, syncing the branch and completing the ticket transition on success.

## Parameters

- `removeLabel` — clears `sm_retry_merge_triggered` after the retry finishes.
- `checkOpenPR` — confirms the PR is still open before attempting the merge.
- `testCaseMerge` — merge options shared with test-case PR merge handlers.
- `autoStartRework` / `autoStartReworkConfigFile` — routes the PR to rework if merge conflicts or checks fail.
