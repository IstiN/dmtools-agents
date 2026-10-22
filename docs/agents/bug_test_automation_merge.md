# bug test automation merge

Merges an approved Bug test automation PR (`test/{BUG_KEY}`) and transitions the Bug and its linked Test Case tickets to their post-merge statuses.

## Parameters

- `removeLabel` — clears `sm_bug_test_merge_triggered` after the merge attempt.
- `onlyAttemptMerge` — attempts the PR merge without performing downstream ticket status transitions.
- `storyTestMerge` — merge policy overrides for bulk test automation PRs.
