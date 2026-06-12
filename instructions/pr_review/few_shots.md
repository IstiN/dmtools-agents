Example PR review outputs — keep concise:

### outputs/pr_review.json
```json
{
  "recommendation": "BLOCK",
  "summary": "SQL injection in UserService.js must be fixed before merge.",
  "generalComment": "outputs/pr_review_general.md",
  "inlineComments": [
    {"path":"src/auth/UserService.js","line":45,"body":"🚨 BLOCKING: SQL Injection — Use parameterized queries.","severity":"BLOCKING"},
    {"path":"src/auth/LoginController.js","line":78,"body":"⚠️ IMPORTANT: Weak Password Validation — Require 8+ chars with mixed case, numbers, symbols.","severity":"IMPORTANT"},
    {"path":"src/utils/validation.js","line":23,"body":"💡 SUGGESTION: DRY — Email validation duplicated in 3 files. Extract to shared utility.","severity":"SUGGESTION"}
  ],
  "issueCounts": {"blocking":1,"important":1,"suggestions":1}
}
```

### outputs/pr_review_general.md
```markdown
## Automated Code Review — BLOCK

**Summary**: SQL injection blocks merge. One important issue (weak password validation) and one suggestion (extract duplicated validation).

**Next Steps**:
1. Fix SQL injection in UserService.js — use parameterized queries
2. Strengthen password validation (8+ chars, mixed case, numbers, symbols)
3. Extract shared email validation utility
```

### outputs/response.md

```markdown
h2. PR Review

*Status*: REQUEST_CHANGES (1 blocking, 1 important, 1 suggestion)

*Blocking*:
* SQL injection in {{UserService.js:45}}

*Next Steps*:
# Fix security issue
# See inline PR comments for details
```
