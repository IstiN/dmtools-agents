# Test Automation Output Files

Write separate files for separate consumers. Do not reuse one format for all destinations.

## `outputs/tracker_comment.md` — tracker ticket comment

Purpose: posted to the Test Case ticket.

Use the tracker-specific markup format configured for the project (loaded via `cliPromptsByTracker`).
- For Jira trackers: use Jira wiki markup and follow `agents/instructions/tracker/jira_comment_format.md`.
- For Azure DevOps trackers: use GitHub-flavored Markdown and follow `agents/instructions/tracker/ado_comment_format.md`.

Required structure (render with the appropriate tracker syntax):

```text
### Test Automation Result

*Status:* ✅ PASSED / ❌ FAILED / 🚫 BLOCKED
*Test Case:* KEY-123 — summary
*Test Branch PR:* link to PR (omit if not available)

#### What was tested
- Short factual bullet

#### Result
- What passed or failed
- If failed, name the failed step and actual issue

#### Test file
<code block>
testing/tests/KEY-123/test_key_123.py
</code block>

#### Run command
<code block>
pytest testing/tests/KEY-123/test_key_123.py
</code block>
```

When the tracker is Jira, write this content to `outputs/jira_comment.md`.
When the tracker is Azure DevOps, write this content to `outputs/response.md` (or `outputs/tracker_comment.md`) using Markdown syntax.

## `outputs/pr_body.md` — GitHub Pull Request body

Purpose: used by `gh pr create --body-file`.

Use GitHub Markdown.

Required structure:

````markdown
## Test Automation Result

**Status:** ✅ PASSED / ❌ FAILED / 🚫 BLOCKED
**Test Case:** KEY-123 — summary

## What was automated
- Short factual bullet

## Result
- What passed or failed

## How to run
```bash
pytest testing/tests/KEY-123/test_key_123.py
```
````

## `outputs/response.md` — backward-compatible summary

If a platform still expects `outputs/response.md`, write a concise GitHub Markdown summary. The tracker-specific ticket comment must use the tracker markup file described above.

## `outputs/test_automation_result.json` — machine-readable result

Write the structured status JSON exactly as described in `agents/instructions/test_automation/test_automation_json_output.md`.
