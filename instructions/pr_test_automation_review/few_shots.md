Example PR test automation review outputs — keep concise:

### outputs/pr_review.json
```json
{
  "recommendation": "BLOCK",
  "summary": "Test uses hardcoded selectors and sleeps instead of explicit waits. Architecture violates layered design.",
  "generalComment": "outputs/pr_review_general.md",
  "inlineComments": [
    {"path":"testing/tests/TEST-123/test_login.py","line":34,"comment":"outputs/pr_review_comments/comment1.md","severity":"BLOCKING"},
    {"path":"testing/tests/TEST-123/test_login.py","line":45,"comment":"outputs/pr_review_comments/comment2.md","severity":"BLOCKING"},
    {"path":"testing/tests/TEST-123/test_login.py","line":12,"comment":"outputs/pr_review_comments/comment3.md","severity":"IMPORTANT"},
    {"path":"testing/components/pages/login_page.py","line":8,"comment":"outputs/pr_review_comments/comment4.md","severity":"SUGGESTION"},
    {"path":"testing/tests/TEST-123/test_login.py","line":20,"comment":"outputs/pr_review_comments/comment5.md","severity":"NIT"}
  ],
  "issueCounts": {"blocking":2,"important":1,"suggestions":1,"nits":1}
}
```

Each `comment` field references a file under `outputs/pr_review_comments/`
holding the finding text (the base output contract). Example
`outputs/pr_review_comments/comment1.md`:

```markdown
🚨 **BLOCKING: Hardcoded selector**

Use the Page Object method `login_page.username_field` instead of the raw
`page.locator('#user')`.
```

**Severity boundary (4 tiers)**: a 🪶 NIT changes nothing behavioral and
nothing documented (style, naming, formatting); a 💡 SUGGESTION changes clarity of
the documented/behavioral surface. Behavior or contract breakage is ⚠️/🚨.

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
