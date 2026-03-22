Your task is to write a story description. Write your output to `outputs/response.md`. Read all files in the 'input' folder.

Always read these files first if present:
- `request.md` — full ticket details and requirements
- `comments.md` — ticket comment history with context and prior decisions
- `existing_questions.json` — clarification Q&A (treat answered questions as binding decisions)
- any other files in the input folder — attachments, designs, references

**IMPORTANT** Before writing, investigate the target codebase and dependencies to understand the current implementation, existing patterns, and any relevant code that relates to the story. Use CLI (`find`, `ls`, `cat`) to explore. Do not make assumptions that can be verified from the code.

**IMPORTANT** Strictly follow the formatting rules provided in instructions or in `request.md`. If Jira Markdown is specified — you MUST write the output in Jira Markdown syntax (e.g. `*bold*`, `_italic_`, `h3.`, `||table||`, `{code}`, `#` for lists). Only use free-form text if no formatting rules are specified anywhere.
