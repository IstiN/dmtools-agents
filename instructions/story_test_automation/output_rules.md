# Story Test Automation Output Rules

## Mandatory JSON output

Write `outputs/story_test_automation_result.json` with exactly this schema in a single `Write` call. Do NOT use `Edit` on this file — if you need to correct it, rewrite the entire file. The post-action parses this file with a strict JSON parser; any `Edit`-induced formatting corruption will cause the whole run to fail.

```json
{
  "storyKey": "TS-123",
  "overall": "passed|failed|blocked_by_human",
  "summary": "Short human-readable summary of what was done.",
  "results": [
    {
      "testCaseKey": "TS-124",
      "status": "passed|failed|skipped|irrelevant",
      "testPath": "testing/tests/TS-124/...",
      "failedDescriptionFile": "outputs/failed_description_TS-124.md",
      "failureSummary": "One-line failure summary when status is failed."
    }
  ],
  "blockedReason": "Explanation when overall is blocked_by_human."
}
```

### Field rules

- `overall`:
  - `passed` — no `failed` results (combination of `passed`, `skipped`, and/or `irrelevant` is OK).
  - `failed` — at least one result is `failed` and none are blocked.
  - `blocked_by_human` — automation could not run due to missing credentials/data.
- `results` must contain every linked Test Case found in the input context.
- `failedDescriptionFile` is required for every `failed` result. It must point to a file under `outputs/`.
- `failureSummary` is required for every `failed` result.
- `testPath` is required for every `passed` result; it should be omitted for `skipped` and `irrelevant`.
- `irrelevant` — use when the Test Case is legacy, obsolete, or no longer applies to the current product (e.g., a test for a removed workflow job or an external page whose contract changed). The post-action will move it to `Irrelevant` and delete its test code.

## Mandatory tracker comment

Write `outputs/tracker_comment.md` in Jira wiki format. It should include:

- Story key and summary.
- Counts of passed / failed / skipped Test Cases.
- List of failed Test Cases with links to their failed description files (will be attached by the post-action).
- Any blockers or missing setup.

## Failed description files

For each failed Test Case, write `outputs/failed_description_{TC_KEY}.md` containing:

1. Test Case key and summary.
2. Steps to reproduce.
3. Expected vs actual result.
4. Stack trace / logs / screenshots if available.
5. Environment details.

Use Jira wiki markup (headings, code blocks, lists) so the file is readable when attached to the Test Case ticket.
