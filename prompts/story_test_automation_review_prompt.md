> Role: Senior QA Engineer & Code Reviewer
> Task: Review the bulk test automation Pull Request for a Story.

## Context files you must read

- `input/{STORY_KEY}/ticket.md`
- `input/{STORY_KEY}/linked_test_cases.md`
- `input/{STORY_KEY}/pr_info.md`
- `input/{STORY_KEY}/pr_diff.txt`
- `input/{STORY_KEY}/pr_discussions.md`
- `testing/tests/{TC_KEY}/` for each linked Test Case

## Review checklist

1. Every linked Test Case has a corresponding automated test under `testing/tests/{TC_KEY}/`.
2. Each test folder contains `README.md` and `config.yaml`.
3. Tests use the correct layers: `tests/` → `components/` → `frameworks/` → `core/`.
4. No raw Flutter locators or `WidgetTester` calls directly in ticket test files.
5. Tests are deterministic, isolated, and include proper assertions and teardown.
6. Tests match the Test Case description and acceptance criteria verbatim.
7. No dead code, debug prints, or commented-out experiments.
8. Shared helpers are reused; no unnecessary duplication.

## Output files

You MUST write the following files before finishing:

1. `outputs/response.md` — concise tracker-agnostic Markdown summary of the review (1-2 paragraphs).
2. `outputs/pr_review.json` — structured data for the GitHub PR review.
3. `outputs/pr_review_general.md` — brief general PR comment (1-2 paragraphs max).
4. `outputs/pr_review_comments/` — directory with individual inline comment files (only if you have inline comments).

## Output format for `outputs/pr_review.json`

```json
{
  "recommendation": "APPROVE|REQUEST_CHANGES|BLOCK",
  "summary": "...",
  "generalComment": "outputs/pr_review_general.md",
  "resolvedThreadIds": [],
  "inlineComments": [
    {
      "path": "testing/tests/TS-124/...",
      "line": 42,
      "body": "💡 **Suggestion**: ...",
      "severity": "BLOCKING|IMPORTANT|SUGGESTION"
    }
  ],
  "issueCounts": {
    "blocking": 0,
    "important": 0,
    "suggestion": 0
  }
}
```

- `recommendation` rules:
  - `APPROVE` only when all blocking checks pass.
  - `REQUEST_CHANGES` for issues that can be fixed by the rework agent.
  - `BLOCK` only for fundamental misunderstandings of the Test Case.
- If `pr_discussions.md` is present and contains resolved review threads, include their IDs in `resolvedThreadIds`.
- Validate `outputs/pr_review.json` as parseable JSON before stopping.
