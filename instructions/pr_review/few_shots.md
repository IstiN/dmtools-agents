Example PR review outputs — keep concise:

### outputs/pr_review.json
```json
{
  "recommendation": "BLOCK",
  "summary": "SQL injection in UserService.js must be fixed before merge.",
  "generalComment": "outputs/pr_review_general.md",
  "inlineComments": [
    {"path":"src/auth/UserService.js","line":45,"comment":"outputs/pr_review_comments/comment1.md","severity":"BLOCKING"},
    {"path":"src/auth/LoginController.js","line":78,"comment":"outputs/pr_review_comments/comment2.md","severity":"IMPORTANT"},
    {"path":"src/utils/validation.js","line":23,"comment":"outputs/pr_review_comments/comment3.md","severity":"SUGGESTION"}
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

### outputs/pr_review_comments/comment1.md
```markdown
🚨 **BLOCKING: SQL Injection**

User input is interpolated directly into the query at `UserService.js:45`:

```javascript
const query = `SELECT * FROM users WHERE email = '${email}'`;
```

Use parameterized queries instead:

```javascript
const query = 'SELECT * FROM users WHERE email = ?';
await db.query(query, [email]);
```
```
