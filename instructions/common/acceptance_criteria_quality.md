# Acceptance Criteria Quality Rules

## Prohibited patterns

### ❌ Never write "follows standard X behavior"
Instead of writing "follows [Workflow X] behavior" or "same as [Workflow X]",
you MUST first search the codebase using codegraph_search or codegraph_explore
for that reference workflow, read its implementation, and describe the actual
behavior in detail: exact columns, validations, file names, transitions, and
error messages. A single-sentence reference to another workflow is never
acceptable as an AC — it is not testable and cannot be implemented or verified
without additional research.

### ❌ Never include generic UI/accessibility AC
WCAG AA, contrast ratios, focus states, style guide compliance —
these belong to a global Definition of Done or QA checklist.
Do NOT add them to individual story ACs unless the story is
explicitly about a UI component or design system.

### ❌ Never duplicate Business Rules in AC body
If a rule is stated in the Business Rules section,
do not restate it in the AC text.

## Required patterns

### ✅ "Follows X workflow" → enumerate it
When an AC references another workflow:
- Find it in the codebase via codegraph
- List the actual columns, validations, file names, transitions
- Only omit details that are genuinely identical AND already
  documented elsewhere in the same story

### ✅ Always cover the "missing input" case
For any field pre-filled from an upstream source:
- Describe what happens when the upstream value is absent
- Is the field then required? Optional? Blocked?

### ✅ Error messages must be verbatim
Use exact UI text: Header, Message, and variable placeholders.
Do not paraphrase.
