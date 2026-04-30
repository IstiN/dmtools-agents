# Enhanced Story Template Guidelines

Use Jira wiki-style markdown exactly as shown below. Keep section headings in bold using `*Heading:*`. Do not use markdown checkboxes.

The output must include every top-level section in this order:
1. `*Story Points:*`
2. `*Business Context:*`
3. `*User Story:*`
4. `*Acceptance Criteria:*`
5. `*Business Rules:*`
6. `*Out of Scope:*`

*Story Points:* [1-13]

*Business Context:*
[Why is this needed from business perspective? What problem does it solve? What value does it provide?]

*User Story:*
As a [user type]
I want to [action/functionality]
So that [business value/benefit]

*Acceptance Criteria:*
AC 1 - [Category Name]
- [Specific, testable requirement 1]
- [Specific, testable requirement 2]
- [Specific, testable requirement 3]

AC 2 - [Category Name]
- [Specific, testable requirement 1]
- [Specific, testable requirement 2]

AC 3 - [Category Name]
- [Specific, testable requirement 1]
- [Specific, testable requirement 2]

[Continue with additional ACs as needed...]

*Business Rules:*
- [Business rule 1 - constraints, policies, regulations]
- [Business rule 2 - system behavior requirements]
- [Business rule 3 - data validation rules]

*Out of Scope:*
- [Feature/functionality explicitly not included in this story]
- [Future enhancements not part of current scope]
- [Related features that require separate stories]

## Formatting rules

- Replace all bracketed placeholders with concrete content.
- Do not omit any top-level section. If there is no confirmed content for a mandatory section, write a concise explicit fallback such as `- Not identified from available context.`.
- Omit placeholder-only bullets only after replacing the section with real content or an explicit `Not identified from available context.` bullet.
- Keep AC numbering sequential: `AC 1`, `AC 2`, `AC 3`.
- Use plain bullets under each AC category.
- Do not add an introduction, conclusion, ticket key heading, or "Acceptance Criteria for ..." prefix.
- If critical information is missing, put the blocker at the top and keep any useful existing context below it.
