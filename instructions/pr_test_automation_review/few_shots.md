Example PR test automation review outputs — keep everything concise:

### outputs/pr_review.json
```json
{
  "recommendation": "BLOCK",
  "summary": "Test uses hardcoded selectors and sleeps instead of explicit waits. Architecture violates layered design (test calls framework directly).",
  "prNumber": null,
  "prUrl": null,
  "generalComment": "outputs/pr_review_general.md",
  "resolvedThreadIds": [],
  "inlineComments": [
    {
      "path": "testing/tests/TEST-123/test_login.py",
      "line": 34,
      "startLine": 32,
      "side": "RIGHT",
      "body": "🚨 **BLOCKING: Hardcoded selector** — Use Page Object method `login_page.username_field` instead of raw `page.locator('#user')`.",
      "severity": "BLOCKING"
    },
    {
      "path": "testing/tests/TEST-123/test_login.py",
      "line": 45,
      "side": "RIGHT",
      "body": "🚨 **BLOCKING: time.sleep(5)** — Replace with Playwright's `expect(...).to_be_visible(timeout=5000)`. Tests must be deterministic.",
      "severity": "BLOCKING"
    },
    {
      "path": "testing/tests/TEST-123/test_login.py",
      "line": 12,
      "side": "RIGHT",
      "body": "⚠️ **IMPORTANT: Missing config.yaml** — Each test folder must include `config.yaml` with framework, platform, and dependencies.",
      "severity": "IMPORTANT"
    },
    {
      "path": "testing/components/pages/login_page.py",
      "line": 8,
      "side": "RIGHT",
      "body": "💡 **SUGGESTION: Add type hints** — Constructor parameters lack types. Add `driver: IWebDriver` and return types for public methods.",
      "severity": "SUGGESTION"
    }
  ],
  "issueCounts": { "blocking": 2, "important": 1, "suggestions": 1 }
}
```

### outputs/pr_review_general.md
```markdown
## Automated Test PR Review — BLOCK

**Summary**: Test contains hardcoded selectors and `time.sleep()`, violating architecture and determinism rules. Missing `config.yaml`.

**Next Steps**:
1. Extract selectors into `LoginPage` Page Object
2. Replace `time.sleep()` with explicit waits
3. Add `config.yaml` with framework/platform/dependencies
```

### outputs/response.md (tracker-agnostic, concise)
```markdown
### Summary
BLOCK — Test uses hardcoded selectors and sleeps; missing config.yaml.

### Key Issues
- 🚨 **BLOCKING**: Hardcoded selector (test_login.py:34) — use Page Object
- 🚨 **BLOCKING**: `time.sleep(5)` (test_login.py:45) — use explicit wait
- ⚠️ **IMPORTANT**: Missing `config.yaml` (test folder root)
- 💡 **SUGGESTION**: Add type hints to LoginPage constructor

### Next Steps
1. Extract selectors into Page Object
2. Replace sleeps with explicit waits
3. Add config.yaml
```
