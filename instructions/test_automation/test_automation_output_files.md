# Test Automation Output Files

Write separate files for separate consumers. Do not reuse one format for all destinations.

## `outputs/jira_comment.md` — Jira ticket comment

Purpose: posted to the Test Case ticket.

Use Jira wiki markup only. Follow `agents/instructions/tracker/jira_comment_format.md`.

Required structure:

```text
h3. Test Automation Result

*Status:* ✅ PASSED / ❌ FAILED / 🚫 BLOCKED
*Test Case:* KEY-123 — summary
*Test Branch PR:* [PR title|https://github.com/org/repo/pull/123] (omit if not available)

h4. What was tested
* Short factual bullet

h4. Result
* What passed or failed
* If failed, name the failed step and actual issue

h4. Test file
{code}
testing/tests/KEY-123/test_key_123.py
{code}

h4. Run command
{code:bash}
pytest testing/tests/KEY-123/test_key_123.py
{code}
```

Jira-specific rules:
- Use `h3.` / `h4.` headings, not `##`.
- Use `* item` bullets, not `- item`.
- Use `{code}` blocks for file paths, commands, logs, and snippets.
- Use `{{inline code}}` only for short identifiers.
- Do not use triple backticks, Markdown tables, or Markdown links.

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

If a platform still expects `outputs/response.md`, write a concise GitHub Markdown summary. Jira posting must use `outputs/jira_comment.md`.

## `outputs/test_automation_result.json` — machine-readable result

Write the structured status JSON exactly as described in `agents/instructions/test_automation/test_automation_json_output.md`.
