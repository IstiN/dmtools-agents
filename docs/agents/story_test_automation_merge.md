# story test automation merge

Merges an approved Story bulk test automation PR (`test/{STORY_KEY}`) and advances the Story and its passing Test Cases to Done.

## Parameters

- `removeLabel` — removes `sm_story_test_merge_triggered` after the run.
- `onlyAttemptMerge` — when enabled, only merges the PR and skips story/test ticket transitions.
- `storyTestMerge` — configuration block controlling bulk story test PR merge checks.
