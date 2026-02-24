Your task is intake analysis. Read all files in the 'input' folder:
- The ticket description is in request.md — this is a raw idea or informal input
- Read existing_epics.json to understand what Epics already exist in the JD project
- Read existing_stories.json to understand what Stories already exist — avoid creating duplicates
- If you need full details of any existing story, run: dmtools jira_get_ticket JD-X

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
