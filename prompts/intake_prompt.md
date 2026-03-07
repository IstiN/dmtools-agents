Your task is intake analysis. Read all files in the 'input' folder:
- `request.md` — this is a raw idea or informal input
- `comments.md` *(if present)* — ticket comment history with additional context or decisions
- `existing_epics.json` — understand what Epics already exist in the project
- `existing_stories.json` — understand what Stories already exist — avoid creating duplicates

**Before decomposing, study the current project structure:**
1. Read `existing_epics.json` and `existing_stories.json` fully.
2. For any existing story where the summary is ambiguous or closely related to the new request, fetch full details: `dmtools jira_get_ticket <KEY>`
3. Build a mental map of what pages/flows/features already exist and what entry points are already covered.
4. Only then proceed to identify gaps and create new tickets.

Analyse the request, break it into structured Jira tickets (Epics or Stories), then:
1. Write individual description files to outputs/stories/ (story-1.md, story-2.md, ...)
2. Write outputs/stories.json with the ticket plan
3. Write outputs/comment.md with your intake analysis summary

**CRITICAL** 
1. If technical prerequisets are required, like deployment workflows. Create for that separate epics, stories.
2. Check yourself: user stories must not be big - max 5SPs.
3. Stories must not duplicate content of each other.
4. No water in descriptions.
5. MVP thinking, all time.
Follow all instructions from the input folder exactly.
