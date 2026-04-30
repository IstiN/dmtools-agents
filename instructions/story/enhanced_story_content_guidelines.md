# Enhanced Story Content Guidelines

Use these guidelines to decide what content belongs in the enhanced story output. Keep wording specific and useful; avoid generic filler.

## No water words in description

- Do not use vague phrases such as "user-friendly", "seamless", "robust", "intuitive", "enhanced", or "improved" unless the output immediately explains the measurable behavior.
- Prefer concrete business facts, user actions, system behavior, data rules, and acceptance conditions.
- Do not restate the ticket title in different words just to fill a section.

## Story Points Guidelines

- `1-3 SP`: Simple feature, single component.
- `5-8 SP`: Medium complexity, multiple components.
- `8-13 SP`: Complex feature, cross-system integration.
- If the story appears larger than `13 SP`, state that it should be split into multiple stories and explain the split candidates.

## Acceptance Criteria Best Practices

- Acceptance Criteria are critical and must be testable.
- Group related requirements under AC categories.
- Use bullets for testable requirements.
- Do not use checkboxes (`[ ]`).
- Write in present tense: "The system does...", not "The system will...".
- Each AC category should be independently testable.
- Link ACs to specific subtasks or question tickets for traceability when the requirement comes from child-ticket context, for example `(see DMC-123)`.
- Treat answered questions from `existing_questions.json` as binding requirements. Do not fall back to original/default values if an answer overrides them.

## Business Context Examples

- "Users need secure authentication to protect sensitive data."
- "Manual process causes delays and errors, automation is needed."
- "Integration is required to synchronize data between systems."

## Out of Scope Examples

- Advanced features planned for future releases.
- Non-functional requirements handled separately.
- External system integrations not part of the current sprint.

