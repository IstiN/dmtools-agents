Your task is intake analysis. Read all files in the 'input' folder:
- `request.md` — this is a raw idea or informal input
- `comments.md` *(if present)* — ticket comment history with additional context or decisions
- `existing_epics.json` — understand what Epics already exist in the project
- `existing_stories.json` — understand what Stories already exist — avoid creating duplicates

**Check for attachments in input folder:**
List ALL files in `input/` to find any non-standard files (images, PDFs, ZIPs, mockups, specs, etc.):
- If a `.zip` file is present, unzip it: `unzip input/file.zip -d input/` — then study all extracted files
- If any files are relevant to specific tickets (designs, screenshots, specs, mockups, PDFs), copy them to `outputs/attachments/`:
  `cp input/design.png outputs/attachments/design.png`
- Mark those files for attachment in `stories.json` using the `attachments` field on the relevant ticket(s)

**Before decomposing, study the current project structure:**
1. Read `existing_epics.json` and `existing_stories.json` fully.
2. For any existing story where the summary is ambiguous or closely related to the new request, fetch full details: `dmtools jira_get_ticket <KEY>`
3. Build a mental map of what pages/flows/features already exist and what entry points are already covered.
4. Only then proceed to identify gaps and create new tickets.

Analyse the request, break it into structured Jira tickets (Epics or Stories), then:
1. Write individual description files to outputs/stories/ (story-1.md, story-2.md, ...)
2. Write outputs/stories.json with the ticket plan
3. Write outputs/comment.md with your intake analysis summary

**Attachments in stories.json** — if a ticket should have files attached, add an `attachments` array with paths to files copied into `outputs/attachments/`:
```json
{
  "summary": "...",
  "description": "outputs/stories/story-1.md",
  "attachments": ["outputs/attachments/design.png", "outputs/attachments/spec.pdf"]
}
```

**CRITICAL** 
1. If technical prerequisets are required, like deployment workflows. Create for that separate epics, stories.
2. Check yourself: user stories must not be big - max 5SPs.
3. Stories must not duplicate content of each other.
4. No water in descriptions.
5. MVP thinking, all time.
Follow all instructions from the input folder exactly.
