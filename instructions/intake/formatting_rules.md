# Intake output formatting rules

## `outputs/stories.json`

- Must be a valid JSON array with no trailing commas.
- Each item may represent an Epic, Story, or Bug.

| Field | Type | Notes |
|-------|------|-------|
| `type` | string | `Epic`, `Story`, or `Bug` |
| `summary` | string | Max 120 characters, concise, actionable, imperative |
| `description` | string | Relative path, e.g. `outputs/stories/story-1.md` |
| `parent` | string \| null | Real tracker key, `tempId`, or `null` for Epic |
| `tempId` | string | Optional, unique identifier for new Epics referenced by Stories |
| `priority` | string | `Highest`, `High`, `Medium`, `Low`, `Lowest` |
| `storyPoints` | integer | Stories only, max 5 |
| `blockedBy` | array | Of `tempId` or real keys; sets `Blocked` status |
| `integrates` | array | Of `tempId` or real keys; parallel merge, do NOT add to `blockedBy` |
| `attachments` | array | Relative paths to files copied under `outputs/attachments/` |

### Bug-specific rules

- `type` must be `Bug`.
- Do NOT include `parent`, `storyPoints`, `blockedBy`, or `integrates`.
- Write the bug description to `outputs/stories/bug-N.md`.

## `outputs/comment.md`

- Tracker-agnostic Markdown summary. Tracker-specific formatting is applied by `cliPromptsByTracker` (Jira wiki vs ADO Markdown).
- Include sections: summary, decomposition decisions, planned tickets, assumptions.

## Description files: `outputs/stories/story-N.md`, `epic-N.md`, `bug-N.md`

- Start directly with content — no header line.
- Do NOT include Acceptance Criteria.
- Avoid filler; be specific.

### ⚠️ MANDATORY: tracker-specific markup transform

The structure below is a **generic placeholder template only** — the tags such as `<heading3>` and `<bullet>` are NOT literal output. Never write these literal tags (or raw Markdown like `### Goal`, `**bold**`, `- item`) directly into a description file.

Before writing the final `.md` file, transform every placeholder using the tracker-specific transformation table supplied for this run (e.g. `agents/instructions/tracker/jira_markup_transform.md` when the tracker is Jira, `agents/instructions/tracker/ado_markup_transform.md` when the tracker is ADO). This is the exact same rule and the exact same transform table used by the `story_questions` agent — apply it consistently here.

### Description structure (generic placeholders — transform before writing)

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

### ❌ Common mistake — do not do this

Writing raw Markdown (e.g. `### Goal`, `**Scope**`, `- item`) straight into a Jira description. Jira wiki markup interprets `#`/`##`/`###` as numbered-list markers, not headings — this silently corrupts the rendered ticket (nested empty numbered lists, mangled bullets). Always run content through the tracker transform table first.
