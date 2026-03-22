**IMPORTANT** Your task is to write *Acceptance Criteria* for the story. Write your output to `outputs/response.md`. The content of this file will directly replace the Acceptance Criteria field in Jira — do not include any intro, ticket reference, or heading like "Acceptance Criteria for MAPC-XXX". Start directly from the content.

Always read these files first if present:
- `request.md` — full ticket details and requirements
- `comments.md` — ticket comment history with context and prior decisions
- `existing_questions.json` — clarification Q&A subtasks (treat answered questions as binding decisions that must be reflected in the ACs)

**What to write:**
- Clear, testable Acceptance Criteria only. Each AC must describe a verifiable condition, not implementation details.
- If the story has Figma links, download and read the designs using the CLI before writing.
- If you cannot fully understand the request, state that at the top of `outputs/response.md` and preserve any existing content below it.

**UI & visual quality (include whenever the story touches any UI):**
- All interactive elements (buttons, inputs, links) must have clearly visible focus and hover states with sufficient contrast.
- Text and icon colours must meet WCAG AA (minimum 4.5:1 for normal text, 3:1 for large text/icons) against their background.
- No grey-on-white or light-on-light colour combinations unless contrast ratio is explicitly verified.
- All colour and typography choices must follow the project style guide or design tokens; no ad-hoc hex values.
