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

### ❌ Never flatten tables to plain text
When source material contains a table (columns, file formats, mapping rules,
validation logic) it must remain a table in the output.
Use Jira wiki markup table syntax as defined in `jira_wiki_markup.md`:
`||Header 1||Header 2||` for header rows, `|value 1|value 2|` for data rows.
Never convert a table to a bullet list or prose.

### ❌ Never silently skip unavailable artifacts
If a linked artifact is unavailable (Figma file requires login, Confluence page
is restricted, attachment is missing), do NOT silently omit it.
Instead, add an explicit blocker entry:
`*⚠ BLOCKER:* [artifact name] is not accessible — AC for [scope] cannot be
finalized without this material.`

### ❌ Never use partial detail for copied workflow steps
Either describe a workflow step fully (all columns, validations, transitions)
or mark it explicitly as `[Copied as-is from {reference}]`.
Partial detail — describing some sub-steps but skipping others — is
indistinguishable from missing requirements and leads to implementation gaps.

## Required patterns

### ✅ Separate new behavior from existing behavior
Every AC output must clearly distinguish:
- *Existing behavior* — what the system already does today (validated against code)
- *New behavior* — what changes with this story
- *Copied as-is* — steps that are identical to an existing workflow (name the source)
- *Changed behavior* — existing steps that are modified (show before → after)

Do not mix old and new in the same AC item.

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

### ✅ Include a Source References section
Every AC output must end with a *Source References* section listing:
- The Jira ticket(s) and Confluence page(s) used as source
- Any Figma or design files referenced
- Any specification documents or attachments read
If a source was attempted but inaccessible, list it with an ⚠ marker.
