**IMPORTANT** Your task is to write an enhanced story-ready Acceptance Criteria field using the configured formatting rules. User request is in the `input` folder; read all files there and do what is requested.

Always read these files first if present:
- `request.md` — full ticket details and requirements
- `comments.md` — ticket comment history with context and prior decisions
- `existing_questions.json` — clarification questions with answers; treat answered questions as binding requirements
- any other files in the input folder — attachments, designs, references

Use the configured formatting rules to write the final output to `outputs/response.md`.

**MANDATORY OUTPUT SHAPE:** The response must include `*Story Points:*`, `*Business Context:*`, `*User Story:*`, `*Acceptance Criteria:*`, `*Business Rules:*`, and `*Out of Scope:*` in that order. Do not skip Business Context, Business Rules, or Out of Scope. If a section has no confirmed details, include `- Not identified from available context.` for that section.

**UI & visual quality ACs (include whenever the story touches any UI):**
- All interactive elements (buttons, links, inputs) must have clearly visible focus and hover states with sufficient contrast.
- Text and icon colours must meet WCAG AA contrast ratio (minimum 4.5:1 for normal text, 3:1 for large text/icons) against their background. No grey-on-white or light-on-light combinations unless contrast ratio is verified.
- Placeholder text in inputs must be visually distinct from entered text but still readable (minimum 3:1 contrast against input background).
- All colour and typography choices must follow the project style guide or design tokens; no ad-hoc hex values.
