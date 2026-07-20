Each description file (`outputs/stories/epic-N.md`, `story-N.md`, `bug-N.md`, referenced from `outputs/stories.json` as `description`) must follow this template. If a tracker-specific template is provided in the instructions, use that instead.

The block below is a **structural template / example only**. The tags such as `<heading3>` and `<bullet>` are placeholders that show the required shape of the document.

**CRITICAL: Never write the final description using these literal metatags.** Use the tracker-specific transformation table (for example `agents/instructions/tracker/jira_markup_transform.md` when the tracker is Jira) to convert every placeholder into the correct tracker markup.

Structure:
```
<heading3>Goal</heading3>
what & why

<heading3>Scope</heading3>
minimal requirements: functional, data, behaviour, integrations, constraints

<heading3>Out of scope</heading3>
explicitly NOT included

<heading3>Notes</heading3>
assumptions, questions, links
```

Rules:
- Start directly with content — no header/title line, do NOT repeat the summary.
- Do NOT include Acceptance Criteria.
- Avoid filler; be specific.
- Replace every placeholder tag with the equivalent markup defined in the tracker-specific transformation table.
- Do NOT leave literal XML-style tags such as `<heading3>` or `<bullet>` in the final description.

### ❌ Common mistake — do not do this

Writing raw Markdown (e.g. `### Goal`, `**Scope**`, `- item`) straight into a Jira description. Jira wiki markup interprets `#`/`##`/`###` as numbered-list markers, not headings — this silently corrupts the rendered ticket (nested empty numbered lists, mangled bullets). Always run content through the tracker transform table first — the same rule and the same transform table used by the `story_questions` agent.
