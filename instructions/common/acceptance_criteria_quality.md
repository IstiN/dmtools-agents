# Acceptance Criteria Quality Rules

## Prohibited patterns

### ❌ Never write "follows standard X behavior"
Instead of writing "follows [Workflow X] behavior", "same as [Workflow X]",
"behaves as in [Workflow X]", or "no [story-specific] changes", you MUST first
search the codebase using codegraph_search or codegraph_explore for that
reference workflow, read its implementation, and describe the actual behavior
in detail: exact columns, validations, file names, transitions, and error
messages. A single-sentence reference to another workflow is never acceptable
as an AC — it is not testable and cannot be implemented or verified without
additional research.

This prohibition applies **even when the step is genuinely unchanged**.
"Unchanged" is a conclusion you reach only *after* verification, never a
shortcut that lets you skip it — an unverified claim of parity is exactly how
real, undetected differences slip through review. Concretely:
- Every sentence that asserts equivalence to another workflow/step MUST be
  immediately followed by the itemized proof: the actual columns, validations,
  transitions, or error messages you found, and the exact codegraph
  symbol/file you found them in (e.g. `[Verified via codegraph:
  WorkflowXStepHandler.java]`).
- If you could not verify — the reference workflow is not in the searched
  codebase, or you ran out of context — do NOT assert equivalence at all.
  Add an explicit blocker instead: `*⚠ BLOCKER:* behavior of [Workflow X] step
  [N] could not be verified against the codebase — AC cannot confirm parity.`
- A bare label such as "Copied as-is from {source}" is only acceptable once
  the itemized proof (or an explicit blocker) has already been given earlier
  in the same AC item; it may never *replace* the proof.

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

### ❌ Never mix inconsistent structures for the same kind of list
Pick one structure per repeating list (e.g. steps, requirements, criteria) and
use it for every item in that list — do not alternate between a table and
free-form bullets/headings for the same kind of content within one output,
and do not restate the same section twice under different headings.
When the source items share the same columns (id, description, version,
dependency, comment, reference), a single numbered table is the default
choice: one row per item, sub-details as a nested numbered list inside the
row's cell. Reserve free-form prose/headings for content that genuinely has
no tabular shape (e.g. Business Context, User Story). Restart numbering only
when starting a genuinely new list — never renumber or duplicate a list that
was already presented.

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

### ✅ Attribute individual AC items to their source
A page-level source list at the end is not sufficient on its own — it does
not tell the reviewer which specific paragraph produced a given AC item.
For any AC item built from a specific section of a source document (not the
overall ticket description), name that section inline, e.g. `(source:
[Confluence page name] § [section heading])`. This lets a reviewer jump
straight to the exact source passage to confirm or correct it, instead of
re-reading the whole document, and makes it obvious when two AC items were
derived from the same section (a signal of a duplicated or ambiguous source
that should be cleaned up upstream).
