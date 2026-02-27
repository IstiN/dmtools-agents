# PR Review JSON Output Format

In addition to outputs/response.md (Jira-formatted review), you MUST generate:

## outputs/pr_review.json

```json
{
  "recommendation": "APPROVE|REQUEST_CHANGES|BLOCK",
  "summary": "Brief overall assessment in one paragraph",
  "prNumber": null,
  "prUrl": null,
  "generalComment": "outputs/pr_review_general.md",
  "inlineComments": [
    {
      "file": "path/to/file.js",
      "line": 42,
      "startLine": 40,
      "side": "RIGHT",
      "comment": "outputs/pr_review_comments/comment-1.md",
      "severity": "BLOCKING|IMPORTANT|SUGGESTION"
    }
  ],
  "issueCounts": {
    "blocking": 2,
    "important": 5,
    "suggestions": 3
  }
}
```

### Field Descriptions:

- **recommendation**: Final decision - APPROVE, REQUEST_CHANGES, or BLOCK
- **summary**: One paragraph overall assessment (plain text)
- **prNumber**: Leave null (will be filled by JS action)
- **prUrl**: Leave null (will be filled by JS action)
- **generalComment**: Path to markdown file with overall PR review comment (GitHub markdown)
- **inlineComments**: Array of inline code review comments
  - **file**: Relative path to file from repo root
  - **line**: Line number to comment on
  - **startLine**: (Optional) Start line for multi-line comment range
  - **side**: "RIGHT" for new code (default), "LEFT" for old code
  - **comment**: Path to markdown file with comment text (GitHub markdown)
  - **severity**: BLOCKING, IMPORTANT, or SUGGESTION
- **issueCounts**: Counts of each issue severity

## outputs/pr_review_general.md

Overall PR review comment in **GitHub Markdown** format (NOT Jira markup).

Example:
```markdown
## 🤖 Automated Code Review

### 📊 Summary
This PR implements [brief summary]. Overall code quality is [assessment].

**Recommendation**: ✅ APPROVE / ⚠️ REQUEST CHANGES / 🚨 BLOCKED

**Issues Found**:
- 🚨 Blocking: 2
- ⚠️ Important: 5
- 💡 Suggestions: 3

See inline comments for details.

### 🔒 Security
[Summary of security findings]

### 🏗️ Code Quality
[Summary of code quality findings]

### ✅ Task Alignment
[Summary of requirements coverage]
```

## outputs/pr_review_comments/

Directory containing individual inline comment markdown files.

**Naming**: `comment-1.md`, `comment-2.md`, etc.

**Format**: GitHub Markdown (NOT Jira markup)

Example `outputs/pr_review_comments/comment-1.md`:
```markdown
🚨 **BLOCKING: SQL Injection Vulnerability**

This code is vulnerable to SQL injection because user input is directly concatenated into the query string.

**Risk**: Critical - allows attackers to execute arbitrary SQL commands

**Recommendation**:
Use parameterized queries instead:
\`\`\`javascript
const query = 'SELECT * FROM users WHERE id = ?';
db.query(query, [userId]);
\`\`\`
```

## Important Notes:

1. **Two different formats**:
   - `outputs/response.md` - **Jira Wiki Markup** (for Jira ticket comment)
   - `outputs/pr_review_general.md` + inline comments - **GitHub Markdown** (for PR comments)

2. **Inline comments guidelines**:
   - **MANDATORY**: Any issue specific to a line of code MUST be included in `inlineComments` array
   - `issueCounts` MUST match the actual number of issues found
   - Focus on specific code issues at exact locations
   - Each comment should be self-contained
   - Include code snippets when showing fixes
   - Use severity emojis: 🚨 BLOCKING, ⚠️ IMPORTANT, 💡 SUGGESTION

3. **General comment guidelines**:
   - High-level overview of the review
   - Summary of all findings
   - Overall recommendation
   - **If an issue is general and not tied to specific lines, include it here**
   - Should reference that details are in inline comments

4. **File locations in JSON**:
   - Use relative paths from outputs/ directory
   - Comment files numbered sequentially: comment-1.md, comment-2.md, etc.
