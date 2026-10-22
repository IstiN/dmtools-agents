# story test automation rework

Resolves open PR review threads (`outputs/review_replies.json`) and fixes test code on a bulk Story test automation branch (`test/{STORY_KEY}`), re-running affected Test Cases and updating `outputs/story_test_automation_result.json`.

## Parameters

- `removeLabel` — clears `sm_story_test_rework_triggered` after rework finishes.
- `checkOpenPR` — verifies an open story test PR exists before starting.
- `testFilesGlob` — restricts reworked commits to matching paths under `testing/`.
- `autoStartReview` / `autoStartReviewConfigFile` — re-triggers `pr_story_test_automation_review` once fixes land.
