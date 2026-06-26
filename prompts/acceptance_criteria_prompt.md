**IMPORTANT** Your task is to write an enhanced story-ready Acceptance Criteria field using the configured formatting rules. User request is in the `input` folder; read all files there and do what is requested.

**You MUST follow the Acceptance Criteria Quality Rules defined in `acceptance_criteria_quality.md` throughout this entire task. These rules take priority over any default patterns.**

Always read these files first if present:
- `request.md` — full ticket details and requirements
- `comments.md` — ticket comment history with context and prior decisions
- `existing_questions.json` — clarification questions with answers; treat answered questions as binding requirements
- any other files in the input folder — attachments, designs, references

Use the configured formatting rules to write the final output to `outputs/response.md`.

**MANDATORY OUTPUT SHAPE:** The response must contain the following sections in this order. Do not skip any section. If a section has no confirmed details, include `<bullet> Not identified from available context.`

<bullet> *Story Points:*
<bullet> *Business Context:*
<bullet> *User Story:*
<bullet> *Design / Mockups:* — link to Figma or attach mockup images. If design is required but unavailable, add `*⚠ BLOCKER:*` with a description of what is missing.
<bullet> *Acceptance Criteria:* — numbered list. Each AC must be self-contained: include the rule, the trigger, and the expected outcome in the AC text itself. Do not assume the reader will search Confluence or the spec.
<bullet> *Existing vs New Behavior:* — table with columns `||Behavior||Existing||New / Changed||`. List every behavior touched by this story. Mark unchanged copied behaviors as `Copied as-is from {source}`.
<bullet> *Business Rules:*
<bullet> *Out of Scope:*
<bullet> *Source References:* — list every source read: Jira tickets, Confluence pages, Figma links, attachments. Mark any source that was inaccessible with ⚠.
