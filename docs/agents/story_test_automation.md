# story test automation

Bulk-automates all Test Cases linked to a Story in `Ready For Testing` on branch `test/{STORY_KEY}`, records per-case results (`passed`, `failed`, `skipped`, `irrelevant`) in `outputs/story_test_automation_result.json`, and opens one PR for the story.

## Parameters

- `removeLabel` — removes `sm_story_test_automation_triggered` upon completion.
- `testFilesGlob` — glob pattern selecting story test artifacts under `testing/`.
- `checkOpenPR` — guards against duplicate story test PRs.
- `customStatuses` — maps logical story/test statuses to project-specific tracker statuses.
- `autoStartReview` / `autoStartReviewConfigFile` — chains the story test review agent after PR creation.
