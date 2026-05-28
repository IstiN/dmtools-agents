Your task is to generate question subtasks for the story. Read all files in the 'input' folder.

Always read these files first if present:
- `request.md` — full ticket details, requirements, and all agent instructions including formatting rules and role context
- `comments.md` — ticket comment history with context and prior decisions

**CRITICAL: Follow ALL instructions found in `request.md` strictly.** The request.md contains the full agent configuration including formatting rules, role, and known info.

**CRITICAL: Read ALL files in the input folder, including images.**
List the input folder with `ls -la input/` and then the ticket subfolder (e.g. `ls -la input/TICKET-*/`) and read every file found:
- Text/markdown files: read with `cat`
- Image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`): **view them using the Read tool** — they may contain UI mockups, designs, or screenshots that are essential context. If an image shows a design or UI, describe what you see and use it to avoid asking questions that are already answered by the design.

**CRITICAL: Description files must follow the tracker-specific formatting rules provided in `request.md`, formatting instructions, or provider modules.**

**CRITICAL: Description files must NEVER contain a title line.**
The `summary` field in `questions.json` becomes the generated subtask title automatically. Writing a title inside the description file creates a duplicate heading in the tracker.

If a question template you are following shows a `Title:` field — that value goes into the `summary` field of `questions.json`, NOT into the description `.md` file. The `.md` file starts directly with the body content.

✅ CORRECT description file — starts directly with content:
```
h2. Background

The story lists three candidate solutions for making customer number generation collision-free,
but no preferred approach has been chosen yet.

h2. Question

Which of the three proposed solutions should be implemented?
```

❌ WRONG — do NOT add a title line at the top:
```
Title: [Q] Confirm uniqueness strategy for customer number generation

h2. Background
...
```

In addition to functional questions, always check:

*Navigation & discoverability:* How will a user reach this feature? Is there a clear path from the app entry point (homepage / nav menu) to this screen or action? If the route is not obvious or not yet covered by another story, raise a question about it.

*UI styles & visual accessibility:* Does the story involve any UI elements? If so, raise a question to confirm that the design avoids low-contrast combinations (e.g. grey text on white background). Ask for a specific colour palette or reference to design tokens / style guide. Include a suggestion: prefer contrast ratios that meet WCAG AA (4.5:1 for normal text). **Skip this question if an image/design already shows the colour palette clearly.**

Write individual description files to outputs/questions/ and the question plan to outputs/questions.json according to instructions.

**CRITICAL: `outputs/questions.json` must be a plain JSON array.** The root element MUST be `[` … `]`. Never wrap it in an object.

✅ CORRECT format:
```json
[
  {
    "summary": "Confirm query strategy for bulk data retrieval",
    "priority": "Major",
    "description": "outputs/questions/question-1.md"
  },
  {
    "summary": "Clarify sharing model for the new custom object",
    "priority": "Minor",
    "description": "outputs/questions/question-2.md"
  }
]
```

❌ WRONG — do NOT wrap in an object:
```json
{
  "questions": [
    { "summary": "...", "priority": "...", "description": "..." }
  ]
}
```

If there are no questions to raise, write an empty array `[]` — not `{"questions": []}`.
