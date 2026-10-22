# Agent Snapshot: `story_description`

- **Context ID**: `story_description`

## Base cliPrompts

### [1] Role / Plain Text

Experienced Business Analyst

---

### [2] `./agents/instructions/common/agent_task_preamble.md`

You are an agent triggered to perform a specific task. All required context — ticket description, PR diff, CI status, and related materials — has already been prepared in the `input/` folder. Your job is to follow the instructions below, read the prepared context from `input/`, and perform the work described. Do not ask for identifiers; the context is already available locally.


---

### [3] `./agents/instructions/story_description/workflow.md`

You must write response to the request to outputs/response.md according to formatting rules
Don't write Enhanced Story Description of TICKET-XXX, just start from the content.
Content from the response.md file will replace description fully from the ticket, don't include any intro, current ticket reference.
if you did not understand the task, or you can't finish it with right quality or you can't read something and understand **IMPORTANT** you must mention that in updated description keeping initial content. You must not delete important content then from description. For example: [initial content] Opened issues... Help is needed...
**IMPORTANT** You must keep exact syntax and references to attachments if there are any in description of the ticket. Especially if we need it in future. If you remove reference from description we lose attachments. For instance, if initial description has !image-20250923-195553.png|width=763,alt="image-20250923-195553.png"!, it must be presented in new description as well.
**IMPORTANT** You must keep ALL links and references from initial description logically inserted to output description. Otherwise you lose it. You can add section like: References [Link]
**IMPORTANT** if current description looks fully correct look any mentions of tagging account like [~accountid:712020:39ae9870-8a56-44be-945e-a8ad26273932], which means user asked extra improvements. That can be in comments or in the texts.
**IMPORTANT** Read 'input/existing_questions.json' to see existing question subtasks for this story (fields: key, summary, description, status, priority). Use these questions and their answers as context when writing the description.


---

### [4] `./agents/instructions/common/media_handling.md`

Images and attachments are pre-downloaded to the input folder. Read them directly — no extra API call is needed.

To download a Figma design image use the terminal command:
dmtools figma_download_image_of_file <<EOF
{
  "href": "https://www.figma.com/design/asdsadasdasdasd/Business-App?m=auto&node-id=NODEID&t=ASdasdsadas-1"
}
EOF


---

### [5] `./agents/prompts/story_description_prompt.md`

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


---

### [6] `./agents/instructions/common/confluence_comments.md`

# Confluence output

Active only when the agent is configured to publish its output to Confluence (`contentOutput.target` is `confluence` or `both`). If `input/confluence_output_target.json` is not present, skip this instruction entirely.

## Output format

When `input/confluence_output_target.json` is present, your output is published to a Confluence page:

- Write `outputs/response.md` as **Markdown** — it is converted to Confluence storage format on publish. Do NOT use tracker-specific markup (no Jira `{code}` / `h2.` / ADF), even if other instructions ask for it; Markdown wins for this output.
- If `input/confluence_output_current.md` exists, it contains the page's current content — iterate on it instead of rewriting from scratch. The current content may be in legacy tracker markup from earlier runs — still write your output in Markdown.
- The current content may end with `## Diagram` and/or `## Affected Repositories` sections — these are managed by the publish step and refreshed automatically. Do NOT copy them into your output; any copies are stripped to avoid duplicates.

## Inline comment anchors (`[[ic:...]]` placeholders)

`input/confluence_output_current.md` may contain placeholders like `[[ic:550e8400-e29b-41d4-a716-446655440000]]anchored text[[/ic]]`. Each one marks the text fragment an **inline comment is anchored to** on the published page. On publish, the Confluence Markdown sync converts these placeholders back into real page anchors; if you drop or mangle them, the comment loses its anchor and disappears from the page.

Rules:

- **Always preserve** every `[[ic:REF]]...[[/ic]]` placeholder, wrapped around the same text it currently marks.
- If you rephrase the anchored text, **move the placeholder** so it wraps the new equivalent fragment.
- On headings, place the placeholder **inside** the heading, after the `#` markers — `## [[ic:REF]]Purpose[[/ic]]`, never `[[ic:REF]]## Purpose[[/ic]]` (wrapping the `#` prefix breaks heading rendering).
- The same applies to list items and quotes: keep `-`, `1.`, `>` outside the placeholder.
- Remove a placeholder only when you intentionally remove the commented content itself.
- Never invent new `[[ic:...]]` refs — only the ones already present are valid.

## Reading comments

`input/confluence_output_comments.md` lists inline (annotation) comments left on the existing Confluence page for this ticket, and `input/confluence_output_current.md` contains the page's current content.

- Treat **unresolved** comments as review feedback: if a comment points out a mistake, asks a question, or requests a clarification, address it in the updated output.
- Already **resolved** comments need no action, but may provide useful context.

## Replying to comments

When your update directly answers an unresolved comment, add a reply entry to `outputs/confluence_replies.json`. The file must be a JSON array:

```json
[
  {
    "pageId": "12345678",
    "commentId": "98765432",
    "body": "Fixed — the section now covers this case."
  }
]
```

Rules:

- Only reply when the update genuinely addresses the comment.
- `pageId` and `commentId` must come from `input/confluence_output_comments.md`.
- Keep replies concise and professional.
- If no comment needs a reply, omit the file or write an empty array `[]`.


---

### [7] `./agents/prompts/bash_tools.md`

```mermaid
flowchart TD
    subgraph USE["Use dmtools skill"]
        U1["Jira, Figma, Confluence, Teams, etc."]
        U2["Credentials preconfigured via environment variables"]
    end

    subgraph SHELLSTATE["⚠️ Persistent-shell pitfalls (sandbox-observed)"]
        P1["Never end commands with exit — it kills the shell session, making read_bash fail with Invalid shell ID"]
        P2["Capture the exit code via $? right after the command, before running anything else — a late $? reads the wrong command's code"]
        P3["Avoid $PIPESTATUS — it produced wrong exit codes in the sandbox; redirect output to a file and check $? instead"]
    end

    subgraph CWD["Working directory discipline (persistent shell!)"]
        C1["Your Bash shell is ONE persistent session for the whole task — a cd in one command carries over to every later command, including Write/Edit"]
        C2["cd dependencies/&lt;repo&gt; to explore a dependency's source? You are now inside it for every subsequent command until you cd out"]
        C3["Forgetting to cd back before writing outputs/* silently writes to dependencies/&lt;repo&gt;/outputs/* instead of the job's own outputs/ — the write itself succeeds, so nothing looks wrong, but the file is lost"]
        C4["Before ANY Write/Edit to outputs/ (response.md, pr_review.json, pr_review_comments/*.md, etc.): run pwd first and confirm you are at the job root, not inside dependencies/"]
        C5["If unsure or already deep in a dependency checkout: cd to the ABSOLUTE job root path shown in the very first tool result of this session before writing outputs/*"]
        C6["Do NOT defensively re-cd into a directory you are already in — running cd dependencies/&lt;repo&gt; a second time while already inside it fails with No such file or directory (it looks for a nested dependencies/&lt;repo&gt;/dependencies/&lt;repo&gt;). Run pwd first if unsure; only cd once per direction change"]
        C7["For one-off commands inside a dependency checkout, prefer git -C dependencies/&lt;repo&gt; &lt;command&gt; over cd dependencies/&lt;repo&gt; then command — the -C form targets that directory without depending on or changing the shell cwd, so there is no cd bookkeeping to get wrong"]
        C8["Git global flags like --no-pager go BEFORE the subcommand: git --no-pager diff ... is correct, git diff ... --no-pager errors out (git treats the trailing flag as a positional argument)"]
    end

    subgraph BGJOBS["⚠️ Long-running commands — background execution, never foreground-poll"]
        B1["Any command that can run longer than ~2 minutes (full test suite, coverage run, build, dependency install, dev server or watch mode) MUST be started with bash background: true — you get a job id immediately and the completion notice arrives as a message"]
        B2["❌ NEVER wait for a long job with foreground sleep-polling: repeated sleep-then-check loops like sleep 540 → ls coverage. A foreground sleep pins the tool-call open — owner steering and cancel cannot reach you until it ends — and burns wall-clock plus a runner slot"]
        B3["While a background job runs, keep working on other steps — check progress between steps with bash_job status / bash_job output &lt;job-id&gt; — never park the turn in a watch loop"]
        B4["A harness hint like background candidate: bash background: true, job board /tasks, --wait-for-jobs is an ORDER, not a suggestion — obey it and start the command in the background; working around it with foreground sleeps is a violation"]
        B5["Verification order: finalize ALL code edits BEFORE launching a long verification run (full suite, coverage) — verification must run against a frozen tree, otherwise the run is wasted"]
        B6["Files changed while a verification run is in flight? Do NOT kill it mid-flight — let it finish, treat the result as stale, then deliberately start a fresh run against the updated tree"]
        B7["B6 covers a job still making progress — do NOT kill it mid-flight; a job with NO progress for ~10 min (or 2× its expected duration) is HUNG — dispose of it and MOVE ON: bash_job stop &lt;job-id&gt;, note the disposal in the deliverable (job id, command, last output tail), finish the remaining steps and write outputs/response.md reporting the unverified part. NEVER let a hung child hold the deliverable hostage: validation CI on the pull request is the safety net"]
        B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7
    end

    USE --> SHELLSTATE
    SHELLSTATE --> CWD
    CWD --> BGJOBS
```


---

## cliPromptsByTracker

### Tracker: `jira`

#### [1] `./agents/instructions/tracker/jira_comment_format.md`

# Jira tracker comment

Use Jira wiki markup in `outputs/response.md`.

- Headings: `h1.`, `h2.`, `h3.`
- Bullets: `* item`
- Numbered lists: `# item`
- Bold: `*text*`
- Inline code: `{{code}}`
- Code block: `{code}...{code}`
- Link: `[title|url]`

Do not use Markdown headings, fenced code blocks, or backtick inline code.

**IMPORTANT** When answering a clarification question about a user story, get the parent story for full context using: `dmtools jira_get_ticket PARENT-KEY` (the parent key is visible in the ticket's parent field).



---

### Tracker: `ado`

#### [1] `./agents/instructions/tracker/ado_markup_transform.md`

# ADO Markup Reference

When the target tracker is Azure DevOps, replace every generic placeholder tag from the template with the GitHub-flavored Markdown shown below. Do not write literal XML-style tags in the final output.

| Generic placeholder | Markdown | Example |
|---------------------|----------|---------|
| `<bold>X</bold>` | `**X**` | `**Background:**` |
| `<italic>X</italic>` | `*X*` | `*hint*` |
| `<strike>X</strike>` | `~~X~~` | `~~deprecated~~` |
| `<underline>X</underline>` | `<u>X</u>` | `<u>important</u>` |
| `<code>X</code>` | `` `X` `` | `` `main.dart` `` |
| `<codeblock>X</codeblock>` | ` ```\nX\n``` ` | ` ```\nvoid main() {}\n``` ` |
| `<codeblock:lang>X</codeblock:lang>` | ` ```lang\nX\n``` ` | ` ```dart\nvoid main() {}\n``` ` |
| `<bullet> text` | `- text` | `- Option A` |
| `<numbered> text` | `1. text` | `1. Step one` |
| `<heading1>X</heading1>` | `# X` | `# Title` |
| `<heading2>X</heading2>` | `## X` | `## Section` |
| `<heading3>X</heading3>` | `### X` | `### Subsection` |
| `<link>text\|url</link>` | `[text](url)` | `[TS-24](https://dev.azure.com/.../12345)` |
| `<image>url</image>` | `![image](url)` | `![diagram](https://.../diagram.png)` |
| `<quote>X</quote>` | `> X` | `> cited text` |
| `<panel>X</panel>` | `> X` | `> note` |
| `<color color="red">X</color>` | `<span style="color:red">X</span>` | `<span style="color:red">alert</span>` |
| `<hr>` | `---` | `---` |

## Rules

- Replace every placeholder tag with the Markdown shown above.
- Do NOT use Jira wiki markup in ADO output: no `*bold*`, no `* item` bullets, no `h2.` headings, no `{code}...{code}` blocks.
- Use `- item` for bullets and `1. item` for numbered lists.
- For Mermaid diagrams in ADO fields that support them, wrap the diagram in ` ```mermaid\n...\n``` `.


---

### Tracker: `confluence`

#### [1] `./agents/instructions/tracker/confluence_markup_transform.md`

# Confluence Markup Reference

When the generated content is published to Confluence (contentOutput target `confluence`), the body is synced as **Markdown** and converted to Confluence storage format automatically. Replace every generic placeholder tag from the template with the GitHub-flavored Markdown shown below. Do not write literal XML-style tags in the final output.

| Generic placeholder | Markdown | Example |
|---------------------|----------|---------|
| `<bold>X</bold>` | `**X**` | `**Background:**` |
| `<italic>X</italic>` | `*X*` | `*hint*` |
| `<strike>X</strike>` | `~~X~~` | `~~deprecated~~` |
| `<underline>X</underline>` | `<u>X</u>` | `<u>important</u>` |
| `<code>X</code>` | `` `X` `` | `` `main.dart` `` |
| `<codeblock>X</codeblock>` | ` ```\nX\n``` ` | ` ```\nvoid main() {}\n``` ` |
| `<codeblock:lang>X</codeblock:lang>` | ` ```lang\nX\n``` ` | ` ```dart\nvoid main() {}\n``` ` |
| `<bullet> text` | `- text` | `- Option A` |
| `<numbered> text` | `1. text` | `1. Step one` |
| `<heading1>X</heading1>` | `# X` | `# Title` |
| `<heading2>X</heading2>` | `## X` | `## Section` |
| `<heading3>X</heading3>` | `### X` | `### Subsection` |
| `<link>text\|url</link>` | `[text](url)` | `[TS-24](https://tracker.example.com/browse/TS-24)` |
| `<image>url</image>` | `![image](url)` | `![diagram](https://.../diagram.png)` |
| `<quote>X</quote>` | `> X` | `> cited text` |
| `<panel>X</panel>` | `> X` | `> note` |
| `<color color="red">X</color>` | `<span style="color:red">X</span>` | `<span style="color:red">alert</span>` |
| `<hr>` | `---` | `---` |

## Rules

- Replace every placeholder tag with the Markdown shown above.
- Do NOT use tracker-specific wiki markup in Confluence output: no `h2.` headings, no `{code}...{code}` blocks, no `{{monospace}}`, no `[text|url]` links.
- Use `- item` for bullets and `1. item` for numbered lists.
- For Mermaid diagrams, wrap the diagram in a fenced code block with the `mermaid` language tag: ` ```mermaid\n...\n``` `.


---
