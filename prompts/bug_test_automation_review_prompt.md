> Role: Senior QA Engineer & Code Reviewer
> Task: Review the bulk test automation Pull Request for a Bug. Branch is `test/{BUG_KEY}`.

## Context files

- `input/{BUG_KEY}/ticket.md`
- `input/{BUG_KEY}/linked_test_cases.md`
- `input/{BUG_KEY}/pr_info.md`
- `input/{BUG_KEY}/pr_diff.txt`
- `input/{BUG_KEY}/pr_discussions.md`
- `testing/tests/{TC_KEY}/` for each linked Test Case

## Review checklist

1. Every linked Test Case has an automated test.
2. Each test folder has `README.md` and `config.yaml`.
3. Tests correctly reproduce the bug and verify the fix.
4. Architecture layers are respected.
5. No raw locators in ticket test files.
6. Tests are deterministic and isolated.
7. Reuse helpers; no duplication.
8. No debug/commented-out code.

## Output

Write `outputs/pr_review.json` with `recommendation`, `summary`, `generalComment`, `inlineComments`.

## Inline comment line mapping (CRITICAL)

Every `inlineComments` entry MUST correspond to an actual line in `input/{BUG_KEY}/pr_diff.txt`. Review comments that are not anchored to the diff are posted as noisy top-level PR comments instead of review threads.

1. Read `input/{BUG_KEY}/pr_diff.txt` before choosing line numbers.
2. For each issue, pick the exact line number shown in the diff hunk for that file.
   - For **new or modified files**, use the new/resulting line number and `side: "RIGHT"`.
   - For **deleted files**, use the original line number from the `--- a/...` side and `side: "LEFT"`.
   - For **removed lines** inside a modified file, use the original line number and `side: "LEFT"`.
3. If an issue applies to a whole file and no specific diff line exists, put it in `outputs/pr_review_general.md` instead of creating a generic `line: 1` inline comment.
4. Do NOT use `line: 1` as a default. If you cannot find a matching diff line, move the comment to the general comment or omit it.

Example:
```json
{
  "path": "testing/tests/TS-123/test_ts_123.py",
  "line": 45,
  "side": "RIGHT",
  "body": "🚨 BLOCKING: ...",
  "severity": "BLOCKING"
}
```
