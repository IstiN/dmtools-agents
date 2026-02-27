# Test Automation JSON Output Format

After running the test, write the structured result to `outputs/test_automation_result.json`.

## When the test PASSES

```json
{
  "status": "passed"
}
```

## When the test FAILS

```json
{
  "status": "failed",
  "bug": {
    "summary": "Bug: [short description of what failed, max 120 chars]",
    "description": "outputs/bug_description.md",
    "priority": "High"
  }
}
```

## Field rules

| Field | Required | Description |
|-------|----------|-------------|
| `status` | always | `"passed"` or `"failed"` |
| `bug.summary` | if failed | Short bug title. Format: `Bug: <what failed>` |
| `bug.description` | if failed | Path to the bug description file you must create |
| `bug.priority` | if failed | `High`, `Medium`, or `Low` (see priority rules below) |

## Bug priority rules

- **High**: Feature is completely broken, data loss risk, security issue, or blocking core workflow
- **Medium**: Feature partially works but key scenario fails, workaround exists
- **Low**: Edge case failure, minor visual or non-critical behavior

---

## Required output files

Always write **both** files:

### `outputs/response.md` — Jira comment (Jira Markdown format)

**Keep it short and factual. No filler, no repetition, no "In conclusion" paragraphs.**

Use Jira Markdown syntax: `h2.`, `h3.`, `h4.`, `*bold*`, `_italic_`, `{code}`, `||table||`.

Include:
- Status: `✅ PASSED` or `❌ FAILED`
- Test case ticket key + summary
- What was tested (1-2 sentences)
- What passed / what failed (specific, not generic)
- Test file: `{code}testing/tests/{TICKET-KEY}/test_{ticket_key}.py{code}`

### `outputs/pr_body.md` — GitHub PR body (GitHub Markdown format)

**Keep it short and factual. No filler, no repetition, no "In conclusion" paragraphs.**

Use GitHub Markdown syntax: `##`, `**bold**`, ` ```code``` `.

Include:
- Status: `✅ PASSED` or `❌ FAILED`
- What was automated (1-2 sentences)
- How to run: the exact command
- Jira ticket link

### `outputs/bug_description.md` — Bug description (Jira Markdown, only when FAILED)

Use Jira Markdown. Include:
- `h4. Environment`
- `h4. Steps to Reproduce` (numbered)
- `h4. Expected Result`
- `h4. Actual Result`
- `h4. Logs / Error Output` (use `{code}` block)
- `h4. Notes` (optional)
