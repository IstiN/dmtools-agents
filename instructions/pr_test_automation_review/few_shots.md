Example PR test automation review outputs — keep concise:

### outputs/pr_review.json
```json
{
  "recommendation": "BLOCK",
  "summary": "Test uses hardcoded selectors and sleeps instead of explicit waits. Architecture violates layered design.",
  "generalComment": "outputs/pr_review_general.md",
  "inlineComments": [
    {"path":"testing/tests/TEST-123/test_login.py","line":34,"body":"🚨 BLOCKING: Hardcoded selector — Use Page Object method login_page.username_field instead of raw page.locator('#user').","severity":"BLOCKING"},
    {"path":"testing/tests/TEST-123/test_login.py","line":45,"body":"🚨 BLOCKING: time.sleep(5) — Replace with Playwright's expect(...).to_be_visible(timeout=5000).","severity":"BLOCKING"},
    {"path":"testing/tests/TEST-123/test_login.py","line":12,"body":"⚠️ IMPORTANT: Missing config.yaml — Each test folder must include config.yaml with framework, platform, and dependencies.","severity":"IMPORTANT"},
    {"path":"testing/components/pages/login_page.py","line":8,"body":"💡 SUGGESTION: Add type hints — Constructor parameters lack types. Add driver: IWebDriver and return types.","severity":"SUGGESTION"}
  ],
  "issueCounts": {"blocking":2,"important":1,"suggestions":1}
}
```

### outputs/pr_review.json (APPROVE example)
```json
{
  "recommendation": "APPROVE",
  "summary": "Test correctly exercises the ticket's acceptance criteria with self-sufficient data and proper architecture.",
  "generalComment": "outputs/pr_review_general.md",
  "inlineComments": [],
  "issueCounts": {"blocking":0,"important":0,"suggestions":0}
}
```

### outputs/pr_review_general.md
```markdown
## Automated Test PR Review — BLOCK

**Summary**: Test contains hardcoded selectors and time.sleep(), violating architecture and determinism rules. Missing config.yaml.

**Next Steps**:
1. Extract selectors into LoginPage Page Object
2. Replace time.sleep() with explicit waits
3. Add config.yaml with framework/platform/dependencies
```
