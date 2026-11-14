Each description file (`outputs/stories/epic-N.md`, `story-N.md`, `bug-N.md`, referenced from `outputs/stories.json` as `description`) must follow this template. If a tracker-specific template is provided in the instructions, use that instead.

The block below is a **structural template / example only**. The tags such as `<heading3>` and `<bullet>` are placeholders that show the required shape of the document.

**CRITICAL: Never write the final description using these literal metatags.** Use the tracker-specific markup transformation table included in this prompt to convert every placeholder into the correct tracker markup.

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

Writing raw Markdown (e.g. `### Goal`, `**Scope**`, `- item`) or literal placeholder tags straight into a description without applying the configured tracker transformation rules. Trackers that use non-Markdown dialects (or specialized syntax) can misinterpret raw Markdown headings and bullets, silently corrupting the rendered ticket (nested empty numbered lists, mangled bullets). Always run content through the tracker transform table first — the same rule and the same transform table used by the `story_questions` agent.
