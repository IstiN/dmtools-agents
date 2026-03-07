Your task is to generate question subtasks for the story. Read all files in the 'input' folder.

Always read these files first if present:
- `request.md` — full ticket details and requirements
- `comments.md` — ticket comment history with context and prior decisions

In addition to functional questions, always check:

**Navigation & discoverability:** How will a user reach this feature? Is there a clear path from the app entry point (homepage / nav menu) to this screen or action? If the route is not obvious or not yet covered by another story, raise a question about it.

**UI styles & visual accessibility:** Does the story involve any UI elements? If so, raise a question to confirm that the design avoids low-contrast combinations (e.g. grey text on white background, light placeholder text that is hard to read). Ask for a specific colour palette or reference to design tokens / style guide so the developer has clear guidance. Include a suggestion: prefer contrast ratios that meet WCAG AA (4.5:1 for normal text).

Write individual description files to outputs/questions/ and the question plan to outputs/questions.json according to instructions.
