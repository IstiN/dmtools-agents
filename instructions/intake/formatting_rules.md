# Intake Agent Formatting Rules

## outputs/stories.json

- Must be a valid JSON array (validate before finishing)
- Each item must include:
  - `"summary"` — string, max 120 characters
  - `"description"` — string, relative file path (e.g. `"outputs/stories/story-1.md"`)
  - `"parent"` — real Jira key (e.g. `"PROJECT-5"`), temp ID (e.g. `"temp-1"`), or absent/null for a new Epic
  - `"tempId"` — optional string, unique within this array; assign to new Epics so Stories can reference them via `"parent"`
  - `"priority"` — one of: `Highest`, `High`, `Medium`, `Low`, `Lowest`
  - `"storyPoints"` — integer, Stories only (1–2 simple, 3–5 medium, 8–13 complex); max 5 SP — split if larger; omit for Epics
  - `"blockedBy"` — optional array of tempIds or real Jira keys this story cannot start until they are done. Creates "is blocked by" links and sets status to Blocked. Example: `["temp-1", "PROJECT-5"]`
  - `"integrates"` — optional array of tempIds or real Jira keys of parallel stories that will be combined with this one. Creates "Relates" links. Use when two parallel streams must eventually be merged. Example: `["temp-2"]`
- **Bug entries** — use when the intake describes a broken/malfunctioning existing feature (not a new feature):
  - `"type": "Bug"` — required, signals this is a bug ticket
  - No `"parent"` — bugs are top-level tickets
  - `"summary"`, `"description"`, `"priority"` — same as stories
  - No `"storyPoints"`, `"blockedBy"`, `"integrates"` — not applicable
  - Bug is automatically moved to *Ready For Development* after creation
  - Example: `{ "type": "Bug", "summary": "Video playback freezes on iOS Safari", "description": "outputs/stories/bug-1.md", "priority": "High" }`
- No trailing commas, no comments inside JSON

## outputs/comment.md

- Use Jira Markdown only: `h3.`, `*bold*`, `* bullet`, `[text|url]`
- No HTML tags
- Sections: intake summary, decomposition decisions, planned ticket list, assumptions/open questions

## outputs/stories/story-N.md and epic-N.md

- Start directly with content — no introductory header or preamble
- Use Jira Markdown
- Do NOT write Acceptance Criteria — that is handled by a separate agent
- No filler, no water — be specific

Each description must cover:

*h3. Goal*
One or two sentences: what this ticket delivers and why it matters.

*h3. Scope*
Bullet list of minimal requirements — concrete things that MUST be done to consider this story complete. Think: what would a developer need to know to start implementation? Include:
* Key functional requirements (what the system must do)
* Data or entities involved
* User-facing behaviour or API surface, if relevant
* Integration points or dependencies with other systems/tickets
* Known constraints (e.g. must reuse existing component X, must not break Y)

*h3. Out of scope*
Bullet list of what is explicitly NOT part of this ticket (to avoid scope creep). Omit section if nothing to exclude.

*h3. Notes*
Assumptions made, open questions, links to related tickets or designs. Omit section if nothing to add.
