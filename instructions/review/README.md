# PR Review Agent Documentation

## Overview

The PR review agent performs automated code review of GitHub Pull Requests, focusing on security vulnerabilities, code quality, OOP principles, and task alignment.

## Output Structure

The agent generates **two different output formats**:

### 1. GitHub PR Comments (GitHub Markdown)
- **outputs/pr_review.json** - Structured data with review metadata
- **outputs/pr_review_general.md** - Overall PR review comment
- **outputs/pr_review_comments/** - Directory with individual inline code comments
  - `comment-1.md`, `comment-2.md`, etc.

### 2. Jira Ticket Comment (Jira Markup)
- **outputs/response.md** - Comprehensive review in Jira format

## Workflow

```
┌─────────────────────────────────────────────────────────┐
│ 1. preparePRForReview.js (preCliJSAction)              │
│    - Finds PR for ticket using gh CLI                   │
│    - Fetches PR metadata, diff, files                   │
│    - Writes to input/<ticket>/ folder                   │
│    - Checks out PR branch for inspection                │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Cursor Agent (cliCommands)                           │
│    - Reads PR context from input/ folder                │
│    - Performs code review analysis                      │
│    - Generates JSON + markdown outputs                  │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ 3. postPRReviewComments.js (postJSAction)              │
│    - Parses outputs/pr_review.json                      │
│    - Posts general comment to PR via github_add_pr_comment │
│    - Posts inline comments via github_add_inline_comment  │
│    - Posts Jira review to ticket                        │
│    - Updates ticket status based on recommendation      │
└─────────────────────────────────────────────────────────┘
```

## pr_review.json Schema

```json
{
  "recommendation": "APPROVE|REQUEST_CHANGES|BLOCK",
  "summary": "Brief overall assessment",
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

## Review Severity Levels

- **🚨 BLOCKING** - Critical issues that prevent merge (security vulnerabilities, major bugs, scope violations)
- **⚠️ IMPORTANT** - Significant issues that should be addressed (code quality, OOP violations, missing tests)
- **💡 SUGGESTION** - Improvements and optimizations (code style, performance, maintainability)

## DMTools GitHub MCP Tools Used

- **github_add_pr_comment** - Posts general review comment to PR discussion
- **github_add_inline_comment** - Creates inline code review comments on specific lines
  - Parameters: owner, repo, prNumber, filePath, line, startLine (optional), side (RIGHT/LEFT), comment

## Review Focus Areas

1. **🔒 Security** (HIGHEST PRIORITY)
   - OWASP Top 10 vulnerabilities
   - SQL injection, XSS, CSRF, command injection
   - Authentication/authorization bypass
   - Sensitive data exposure

2. **🏗️ Code Quality & OOP**
   - SOLID principles adherence
   - Design patterns usage
   - Code duplication and DRY violations
   - Proper abstraction and encapsulation

3. **✅ Task Alignment**
   - Implementation matches ticket requirements
   - All acceptance criteria met
   - No out-of-scope changes

4. **🧪 Testing**
   - Test coverage adequacy
   - Edge cases handling
   - Test quality and maintainability

## Markdown Format Differences

| Aspect | GitHub Markdown | Jira Markup |
|--------|----------------|-------------|
| Headings | `## Title` | `h2. Title` |
| Code blocks | ` ```language ``` ` | `{code:language}{code}` |
| Bold | `**text**` | `*text*` |
| Lists | `- item` | `* item` |
| Panels | Not available | `{panel:title=Title}{panel}` |
| Inline code | `` `code` `` | `{{code}}` |

## Example Usage

### Running the Agent
```bash
dmtools run agents/pr_review.json
```

### With Custom Ticket
```json
{
  "name": "Teammate",
  "params": {
    "inputJql": "key = PROJ-123",
    "initiator": "accountId"
  }
}
```

### WIP Label Protection
Add `pr_review_wip` label to a ticket to prevent automated review while manually reviewing.

## Files

- **pr_review_instructions.md** - Main task instructions
- **pr_review_formatting.md** - Output format rules
- **pr_review_json_output.md** - JSON structure specification
- **pr_review_few_shots.md** - Examples of correct outputs
- **pr_review.json** - Agent configuration
- **preparePRForReview.js** - Pre-action script
- **postPRReviewComments.js** - Post-action script
