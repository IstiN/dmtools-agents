# pr bug test automation review

Reviews the bulk test automation PR for a Bug (`test/{BUG_KEY}`), checking that every linked Test Case reproduces the bug and respects the layered `testing/` architecture, then posts inline diff comments and a review verdict.

## Parameters

- `removeLabel` — clears `sm_bug_test_review_triggered` after posting the review.
- `checkOpenPR` — requires an open bug test PR.
- `autoStartMerge` / `autoStartMergeConfigFile` — dispatches `bug_test_automation_merge` on `APPROVE`.
- `autoStartRework` / `autoStartReworkConfigFile` — dispatches `bug_test_automation_rework` on `REQUEST_CHANGES`.
- `maxAutoReworkRounds` — maximum auto-started rework rounds (`rework-round-N` on the ticket, default `3`) before the ticket is labeled `needs-human` and no further rework is chained.

- `responseTarget`: `"scm"` — `outputs/response.md` becomes the PR body/comment, so the output-format prompt is GitHub-Flavored Markdown even on Jira (conditions `isResponseToScm.js` / `isResponseToTracker.js`).
