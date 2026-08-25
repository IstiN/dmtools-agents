# solution description

Enhances the solution design description of a ticket with architecture detail and posts an assessment of the result.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `childQuestions` — fetches [Q] question sub-tickets of each matched context ticket and appends them to the context.
- `contexts` — context definitions matched by summary prefix (label, output file, description for the agent).
- `fields` — tracker fields to fetch for context tickets.
- `jql` — JQL override for selecting context tickets.
- `parentContextFetch` — enables fetching the parent ticket context so the solution description can reference BA/SA/VD decisions.
