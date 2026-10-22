# Test Review Inline Comment Line Mapping

Every `inlineComments` entry in `outputs/pr_review.json` MUST correspond to an actual line in `pr_diff.txt`. Review comments not anchored to the diff are posted as top-level PR comments instead of review threads.

1. Read `pr_diff.txt` before choosing line numbers.
2. Pick the exact line number shown in the diff hunk for that file:
   - **New or modified files**: use the new/resulting line number and `side: "RIGHT"`.
   - **Deleted files**: use the original line number from `--- a/...` and `side: "LEFT"`.
   - **Removed lines** inside a modified file: use the original line number and `side: "LEFT"`.
3. If an issue applies to a whole file and no specific diff line exists, put it in `outputs/pr_review_general.md` instead of using `line: 1`.
4. Do NOT use `line: 1` as a default. Prefer fewer, high-quality inline comments over generic file-level comments.

Example inline comment:
```json
{
  "path": "testing/tests/TS-123/test_ts_123.py",
  "line": 45,
  "side": "RIGHT",
  "body": "🚨 BLOCKING: ...",
  "severity": "BLOCKING"
}
```
