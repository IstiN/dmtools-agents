# Test Automation JSON Output Format

Write structured result to `outputs/test_automation_result.json`.

```mermaid
flowchart TD
    subgraph STATUSES["Status"]
        S1["passed — test ran and succeeded"]
        S2["failed — test ran and found a bug"]
        S3["blocked_by_human — cannot run (missing credentials/data)"]
    end

    subgraph FIELDS["Fields by Status"]
        F1["passed: { status }"]
        F2["failed: { status, bug: { summary, description, priority } }"]
        F3["blocked: { status, blocked_reason, missing[]: { type, name, description, how_to_add } }"]
    end

    subgraph PRIORITY["Bug Priority"]
        P1["High — completely broken, data loss, security, blocking workflow"]
        P2["Medium — partially works, key scenario fails, workaround exists"]
        P3["Low — edge case, minor visual, non-critical"]
    end

    subgraph OUTPUTS["Required Output Files"]
        O1["test_automation_result.json — machine-readable status"]
        O2["tracker_comment.md — tracker-specific comment"]
        O3["pr_body.md — GitHub Markdown for PR"]
        O4["response.md — short backward-compatible summary"]
        O5["bug_description.md — ONLY when failed"]
    end

    STATUSES --> FIELDS
    FIELDS --> PRIORITY
    FIELDS --> OUTPUTS
```

## Examples

### Passed
```json
{ "status": "passed" }
```

### Failed
```json
{
  "status": "failed",
  "bug": {
    "summary": "Bug: [what failed, max 120 chars]",
    "description": "outputs/bug_description.md",
    "priority": "High"
  }
}
```

### Blocked by Human
```json
{
  "status": "blocked_by_human",
  "blocked_reason": "Missing TEST_USER_EMAIL secret — automated test user not configured.",
  "missing": [
    { "type": "secret", "name": "TEST_USER_EMAIL", "description": "Automated test user email", "how_to_add": "gh secret set TEST_USER_EMAIL --body value --repo OWNER/REPO" }
  ]
}
```

## Bug Description Template (when FAILED)

Use tracker-specific format:
- `h4. Environment`
- `h4. Steps to Reproduce` (numbered)
- `h4. Expected Result`
- `h4. Actual Result`
- `h4. Logs / Error Output` (`{code}` block)
- `h4. Notes` (optional)
