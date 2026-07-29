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

See `description_template.md` for the required generic structure and the mandatory tracker-markup transform step.
