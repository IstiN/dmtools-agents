Each question `.md` file (referenced from `questions.json` as `description`) must follow this template. If a tracker-specific template is provided in the instructions, use that instead.

The block below is a **structural template / example only**. The tags such as `<bold>` and `<bullet>` are placeholders that show the required shape of the document.

**CRITICAL: Never write the final question description using these literal metatags.** Use the tracker-specific markup transformation table included in this prompt to convert every placeholder into the correct tracker markup.

Structure:
```
<bold>Background</bold>:
<bullet> <bold>Spec</bold>: [1 short sentence quoting or summarizing the exact requirement/AC/comment, with link if available]
<bullet> <bold>Codebase / Gap</bold>: [1 short sentence stating what the code currently does or where the conflict/gap is, keeping class/constant names concise in parentheses]

<bold>Question</bold>: [Single clear, business-first question stating what decision is needed for user/system behavior — understandable on first read]

<bold>Options</bold>:
<bullet> Option A: [Brief description of behavior and impact]
<bullet> Option B: [Brief description of behavior and impact — include ONLY when a genuine trade-off exists]

<bold>Recommended Decision</bold>: [Write your proposed answer here, grounded in existing codebase conventions and updated AC/mockups]
```

Rules:
- Do NOT repeat the summary in the description — start directly with `<bold>Background</bold>`.
- **Scannable `<bold>Background</bold>` (no "wall of text")**: use 2–3 short bullets (`Spec:` / `Codebase / Gap:`) instead of a long narrative paragraph. Put code identifiers (class, method, constant, file) concisely in parentheses rather than writing code-heavy prose.
- **Business-first `<bold>Question</bold>` & one topic per question**: phrase the question in terms of user or system behavior so a Business Analyst or Product Owner understands the decision on the first read. Strictly **one decision topic per question subtask** — never bundle unrelated decisions (e.g., workflow step existence + ID naming format) into one question.
- **Grounded `<bold>Options</bold>` (no artificial choices)**:
  - Present multiple options (`Option A` / `Option B`, max 2–3) **only** when there is a genuine product or technical trade-off.
  - When the existing codebase already handles all comparable fields or flows with a single uniform convention (e.g., audit/history logging format, standard field validation limits), do **not** invent artificial alternatives just to fill Option B/C. Cite the existing codebase pattern and present a single confirmation option (or omit `<bold>Options</bold>` and state the confirmation directly in `<bold>Recommended Decision</bold>`).
- **Self-contained citations (never bare numeric IDs)**:
  - Never cite a bare inline comment ID (e.g., `inline comment 7065501717`) or an unquoted section/AC number by itself — a reviewer cannot locate a comment by numeric ID alone.
  - Always include the **short quoted text** of the inline comment, open question, or Acceptance Criterion (plus a direct link when available in the input context).
- **Evidence weighting in `<bold>Recommended Decision</bold>`**:
  - `<bold>Recommended Decision</bold>` is required — always provide a concrete recommendation.
  - Updated Acceptance Criteria and current UI mockups carry higher weight than older notes in `Assumptions` or `Open Questions` sections. When a stale note conflicts with updated AC or mockups, flag the discrepancy so the spec can be cleaned up, but base your `<bold>Recommended Decision</bold>` on the updated AC and mockups.
- Replace every placeholder tag with the equivalent markup defined in the tracker-specific transformation table.
- Do NOT leave literal XML-style tags such as `<bold>` or `<bullet>` in the final question description.
