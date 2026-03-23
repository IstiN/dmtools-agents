Your task is to generate question subtasks for the story. Read all files in the 'input' folder.

Always read these files first if present:
- `request.md` — full ticket details, requirements, and all agent instructions including formatting rules and role context
- `comments.md` — ticket comment history with context and prior decisions

**CRITICAL: Follow ALL instructions found in `request.md` strictly.** The request.md contains the full agent configuration including formatting rules, role, and known info.

**CRITICAL: Description files MUST be written in Jira wiki markup format — NOT Markdown.**
- Use `h2.`, `h3.` for headings (NOT `##`)
- Use `*bold*` (NOT `**bold**`)
- Use `_italic_` (NOT `_italic_` with underscores in Markdown sense)
- Use `* item` for bullet lists (NOT `-`)
- Use `||col1||col2||` for table headers, `|val1|val2|` for rows
- Do NOT use triple backticks — use `{code}...{code}` or `{noformat}...{noformat}`

In addition to functional questions, always check:

*Navigation & discoverability:* How will a user reach this feature? Is there a clear path from the app entry point (homepage / nav menu) to this screen or action? If the route is not obvious or not yet covered by another story, raise a question about it.

*UI styles & visual accessibility:* Does the story involve any UI elements? If so, raise a question to confirm that the design avoids low-contrast combinations (e.g. grey text on white background). Ask for a specific colour palette or reference to design tokens / style guide. Include a suggestion: prefer contrast ratios that meet WCAG AA (4.5:1 for normal text).

Write individual description files to outputs/questions/ and the question plan to outputs/questions.json according to instructions.
