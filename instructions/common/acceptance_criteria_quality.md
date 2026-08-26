# Acceptance Criteria Quality Rules

These rules define baseline quality expectations for any acceptance criteria
output. Project-specific workflow rules (e.g. how to reference existing
workflows, enumerate copied steps, or handle upstream workflow fields) belong
in the consuming repository's `.dmtools/instructions/` and are injected via
`cliPrompts` in `.dmtools/config.js`.

## Prohibited patterns

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
