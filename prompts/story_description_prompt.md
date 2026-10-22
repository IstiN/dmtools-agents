Your task is to write a story description. Write your output to `outputs/response.md`. Read all files in the 'input' folder.

Always read these files first if present:
- `request.md` — full ticket details and requirements
- `comments.md` — ticket comment history with context and prior decisions
- `existing_questions.json` — clarification Q&A. For each question entry (`key`, `summary`, `description`, `status`, `priority`, `answer`):
  - Check the `answer` field first for the user's decision, and also read `description` for background, options, or an explicit recorded **Decision**.
  - When a question has a confirmed answer (non-empty `answer` or an explicit final `Decision:` in `description`), the chosen option specifies exact behavior (numbers, limits, wording). **Use those exact values in every AC that relates to that question**, and NEVER fall back to original/default values that the decision overrides.
  - When an AC is directly based on a confirmed question decision, add a reference: `(see [TICKET-KEY])` at the end of the AC line, where TICKET-KEY is the key from `existing_questions.json`.
  - **CRITICAL: If `answer` is `null` or empty and `description` has no explicit final decision, NEVER invent, guess, or default to an option (such as "Option A").** Treat the question as unanswered (`answer unavailable`), do NOT attribute a decision to `(see [TICKET-KEY])`, and either leave the undecided behavior out or explicitly note that the question is still open / answer unavailable.
- any other files in the input folder — attachments, designs, references

**CRITICAL: Read ALL files in the input folder, including images.**
List the input folder with `ls -la input/*/` and read every file found:
- Text/markdown files: read with `cat`
- Image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`): **view them using the Read tool** — they may contain UI mockups, designs, or screenshots with critical context. Describe what you see and incorporate it into the output.

**IMPORTANT** Before writing, investigate the target codebase and dependencies to understand the current implementation, existing patterns, and any relevant code that relates to the story. Use CLI (`find`, `ls`, `cat`) to explore. Do not make assumptions that can be verified from the code.

**IMPORTANT** Strictly follow the formatting rules provided in instructions or in `request.md`. Use tracker-specific markup only when that provider format is explicitly specified. Only use free-form text if no formatting rules are specified anywhere.
