# Enhanced Story Template Guidelines

Follow `agents/instructions/common/markup_placeholder_rules.md` to transform every template placeholder tag into the target tracker markup.

```mermaid
flowchart TD
    subgraph SECTIONS["Required Sections (in order)"]
        S1["<bold>Story Points:</bold> [1-13]"]
        S2["<bold>Business Context:</bold><br/>Why needed, problem solved, value provided"]
        S3["<bold>User Story:</bold><br/>As a [type] I want [action] So that [value]"]
        S4["<bold>Acceptance Criteria:</bold><br/>AC 1 - [Category]<br/><bullet> [testable req 1]<br/><bullet> [testable req 2]"]
        S5["<bold>Business Rules:</bold><br/><bullet> [constraints, policies, validations]"]
        S6["<bold>Out of Scope:</bold><br/><bullet> [explicitly not included]<br/><bullet> [future enhancements]"]
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

**IMPORTANT**: Read `input/existing_questions.json` for answered questions as context. Use `dmtools` CLI commands for full ticket details.

**IMPORTANT**: Check child tickets and parent story for better context using the appropriate `dmtools` search command.
