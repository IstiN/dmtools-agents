Read PR context from input folder which contains:
  - ticket.md: Full ticket details with requirements and acceptance criteria
  - pr_info.md: Pull Request metadata (URL, author, title, description)
  - pr_diff.txt: Complete git diff of all changes
  - pr_files.txt: List of all modified files
  - pr_discussions.md: *(if present)* Full history of previous review comments and inline threads

## ⚠️ Repeated Review Notice

**This may be a repeated review.** This workflow is cyclical:
- If previous review requested changes → ticket moved to "In Rework" → developer made fixes → PR updated → this review runs again

If `pr_discussions.md` is present in the input folder:
  - **Read it carefully before reviewing** — it contains all previous reviewer comments and inline threads
  - Check whether each previously raised issue has been **addressed or resolved** in the new diff
  - In your review summary, include a section **"Previous Issues Follow-up"** that explicitly states for each prior issue: ✅ Resolved / ❌ Still present / ⚠️ Partially addressed
  - Do **not** re-raise issues that are fully resolved — focus on what's still open or newly introduced

If `pr_discussions.md` is absent, this is the **first review** — no prior context to check.

---

Your task is to conduct a comprehensive Pull Request review with HIGHEST PRIORITY on:

## 🔒 Security Vulnerabilities (CRITICAL)
Scan for OWASP Top 10 and common vulnerabilities:
  - SQL Injection, XSS, CSRF, Command Injection
  - Authentication/Authorization bypass
  - Sensitive data exposure (hardcoded secrets, keys, passwords)
  - Insecure deserialization
  - Insufficient input validation and sanitization
  - Path traversal vulnerabilities
  - Improper error handling leaking sensitive information

## 🏗️ Code Quality & OOP Principles (HIGH PRIORITY)
  - SOLID principles adherence
  - Design patterns usage and appropriateness
  - Code duplication and DRY violations
  - Proper abstraction levels
  - Encapsulation and information hiding
  - Separation of concerns
  - Cohesion and coupling
  - Naming conventions and code readability

## ✅ Task Alignment
  - Verify implementation matches ticket requirements
  - Check all acceptance criteria are met
  - Identify any missing functionality from ticket scope
  - Flag any out-of-scope changes

## 🧪 Testing & Quality Assurance
  - Test coverage adequacy
  - Edge cases and error scenarios handling
  - Test quality and maintainability

## 📝 Code Style & Best Practices
  - Consistency with codebase patterns
  - Error handling patterns
  - Logging and debugging considerations
  - Performance implications

**IMPORTANT**: Be thorough but constructive. Focus on:
  - 🚨 BLOCKING issues (security, critical bugs, scope violations)
  - ⚠️ IMPORTANT issues (code quality, OOP violations, missing tests)
  - 💡 SUGGESTIONS (improvements, optimizations, style)

## ⚠️ Inline Comments Policy

**If recommendation is APPROVE**: Do NOT write any inline comments or suggestions. The `inlineComments` array must be empty. The general comment should only briefly confirm the approval — no improvement suggestions, no minor notes.

**If recommendation is REQUEST_CHANGES or BLOCK**: Write inline comments only for BLOCKING and IMPORTANT issues. Do NOT add SUGGESTION-level inline comments. Minor improvements that do not affect correctness, security, or maintainability should not be posted.

Write detailed review report to outputs/response.md following the formatting rules.

**DO NOT** create commits, branches, or modify any code - you are only reviewing.
