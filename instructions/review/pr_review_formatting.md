# PR Review Report Format

## Required Outputs

You MUST generate:
1. **outputs/response.md** - Jira-formatted review for ticket comment (Textile syntax)
2. **outputs/pr_review.json** - Structured data for GitHub PR review (see pr_review_json_output.md)
3. **outputs/pr_review_general.md** - General PR comment in GitHub markdown
4. **outputs/pr_review_comments/** - Directory with individual inline comment files

---

## outputs/response.md Format (JIRA WIKI MARKUP)

Structure your Jira review using **Jira Wiki Markup** (NOT Markdown) as follows:

```text
h1. Pull Request Review

h2. 📊 Summary
[Brief overview: PR scope, overall quality assessment, and recommendation (APPROVE/REQUEST CHANGES/BLOCK)]

----

h2. 🔒 Security Analysis
[List all security findings, or "✅ No security issues found"]

h3. 🚨 BLOCKING Security Issues
* *[Issue Title]*
** *Location*: {{file.js:123}}
** *Risk*: [High/Critical]
** *Description*: [What's wrong]
** *Recommendation*: [How to fix]

h3. ⚠️ Security Warnings
* [Same structure as blocking]

----

h2. 🏗️ Code Quality & OOP Review

h3. 🚨 BLOCKING Issues
* *[Issue Title]*
** *Location*: {{file.js:123}}
** *Principle Violated*: [e.g., Single Responsibility Principle]
** *Description*: [What's wrong]
** *Recommendation*: [How to fix]

h3. ⚠️ Important Issues
* [Same structure]

h3. 💡 Suggestions
* [Same structure but less critical]

----

h2. ✅ Task Alignment

h3. Requirements Coverage
* ✅ [Requirement from ticket] - Implemented
* ⚠️ [Requirement from ticket] - Partially implemented (explain)
* ❌ [Requirement from ticket] - Missing (explain)

h3. Out of Scope Changes
* [List any changes not mentioned in ticket requirements]

----

h2. 🧪 Testing Review

h3. Test Coverage
* ✅ [What's tested well]
* ⚠️ [What needs more tests]
* ❌ [What's missing tests]

h3. Test Quality Issues
* [List any test quality concerns]

----

h2. 📝 Additional Notes

h3. Performance Concerns
* [If any]

h3. Maintenance & Readability
* [Comments on code maintainability]

h3. Dependencies
* [Any new dependencies added, are they necessary?]

----

h2. 🎯 Final Recommendation

*[APPROVE / REQUEST CHANGES / BLOCK]*

*Blocking Issues Count*: [number]
*Important Issues Count*: [number]
*Suggestions Count*: [number]

*Next Steps*:
# [Action items for developer]
# [Action items for developer]

----

h2. 📋 Detailed Findings

[Optional: Additional detailed analysis for complex issues]
```

**IMPORTANT SYNTAX RULES**:
- Headings: `h1. Title`, `h2. Title`, `h3. Title`
- Lists: `* item` for bullet, `# item` for numbered
- Bold: `*text*`
- Italic: `_text_`
- Monospace/Code: `{{text}}`
- Code Block: `{code:javascript}...{code}`
- Panel: `{panel:title=Title|borderColor=#ccc}...{panel}`
- Horizontal Rule: `----`
- Links: `[Link Title|http://example.com]`
- DO NOT use Markdown (`#`, `##`, `-`, `**`, `` ` ``, ` ``` `)

---

## outputs/pr_review_general.md Format (GITHUB MARKDOWN)

This file allows standard GitHub Markdown:
```markdown
# General Review
## Summary
...
```

## outputs/pr_review_comments/comment-X.md Format (GITHUB MARKDOWN)

These files allow standard GitHub Markdown:
```markdown
**Suggestion:** Consider refactoring this...
```
