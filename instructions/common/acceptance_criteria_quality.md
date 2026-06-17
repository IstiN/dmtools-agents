# Acceptance Criteria Quality Rules

## Prohibited patterns

### ❌ Never write "follows standard X behavior"
If a step "follows standard behavior", you MUST:
1. Use codegraph/code search to find the reference implementation
2. Describe the actual behavior: columns, validations, file names, error messages
3. If code is unavailable, flag explicitly: "⚠️ Requires clarification from dev team"

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
