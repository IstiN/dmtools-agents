Your task is to write a story description. Write your output to `outputs/response.md`. Read all files in the 'input' folder.

Always read these files first if present:
- `request.md` — full ticket details and requirements
- `comments.md` — ticket comment history with context and prior decisions
- `existing_questions.json` — clarification Q&A. For each question entry:
  - Read the full `description` field — it contains background, options, and the **Decision** (e.g. "Decision: Option A")
  - The chosen option specifies exact behavior (numbers, limits, wording). **Use those exact values in every AC that relates to that question.**
  - When an AC is directly based on a question decision, add a reference: `(see [TICKET-KEY])` at the end of the AC line, where TICKET-KEY is the key from `existing_questions.json`.
  - NEVER fall back to the original/default values described in the background if the decision explicitly overrides them.
- any other files in the input folder — attachments, designs, references

**CRITICAL: Read ALL files in the input folder, including images.**
List the input folder with `ls -la input/*/` and read every file found:
- Text/markdown files: read with `cat`
- Image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`): **view them using the Read tool** — they may contain UI mockups, designs, or screenshots with critical context. Describe what you see and incorporate it into the output.

**IMPORTANT** Before writing, investigate the target codebase and dependencies to understand the current implementation, existing patterns, and any relevant code that relates to the story. Use CLI (`find`, `ls`, `cat`) to explore. Do not make assumptions that can be verified from the code.

**IMPORTANT** Strictly follow the formatting rules provided in instructions or in `request.md`. Use tracker-specific markup only when that provider format is explicitly specified. Only use free-form text if no formatting rules are specified anywhere.
