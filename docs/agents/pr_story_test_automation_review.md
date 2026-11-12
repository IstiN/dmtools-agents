# pr story test automation review

Reviews a Story bulk test automation PR (`test/{STORY_KEY}`) against the Story's Acceptance Criteria and linked Test Cases, posting diff-anchored review threads (`outputs/pr_review.json`) and an approval or rework verdict.

## Parameters

- `removeLabel` — removes `sm_story_test_review_triggered` once the review completes.
- `checkOpenPR` — verifies an open story test PR exists.
- `autoStartMerge` / `autoStartMergeConfigFile` — triggers `story_test_automation_merge` when approved.
- `autoStartRework` / `autoStartReworkConfigFile` — triggers `story_test_automation_rework` when changes are requested.
- `maxAutoReworkRounds` — maximum auto-started rework rounds (`rework-round-N` on the ticket, default `3`) before the ticket is labeled `needs-human` and no further rework is chained.

- `responseTarget`: `"scm"` — `outputs/response.md` becomes the PR body/comment, so the output-format prompt is GitHub-Flavored Markdown even on Jira (conditions `isResponseToScm.js` / `isResponseToTracker.js`).
