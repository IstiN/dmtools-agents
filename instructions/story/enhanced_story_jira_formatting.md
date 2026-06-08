# Enhanced Story Template Guidelines

Use Jira wiki-style markdown. Section headings in bold: `*Heading:*`. No markdown checkboxes.

```mermaid
flowchart TD
    subgraph SECTIONS["Required Sections (in order)"]
        S1["*Story Points:* [1-13]"]
        S2["*Business Context:*<br/>Why needed, problem solved, value provided"]
        S3["*User Story:*<br/>As a [type] I want [action] So that [value]"]
        S4["*Acceptance Criteria:*<br/>AC 1 - [Category]<br/>- [testable req 1]<br/>- [testable req 2]"]
        S5["*Business Rules:*<br/>- [constraints, policies, validations]"]
        S6["*Out of Scope:*<br/>- [explicitly not included]<br/>- [future enhancements]"]
    end

    subgraph RULES["Formatting Rules"]
        R1["Replace all [placeholders] with concrete content"]
        R2["Never omit a top-level section — use 'Not identified' if empty"]
        R3["AC numbering: AC 1, AC 2, AC 3 (NOT AC-1 — Jira Smart Link conflict)"]
        R4["Plain bullets under each AC category"]
        R5["No intro, conclusion, ticket key heading, or 'Acceptance Criteria for...' prefix"]
    end

    SECTIONS --> RULES
```

**IMPORTANT**: Read `input/existing_questions.json` for answered questions as context. Run `dmtools jira_get_ticket KEY` for full details.

**IMPORTANT**: Check child tickets and parent story via `dmtools jira_search_by_jql` for better context.
