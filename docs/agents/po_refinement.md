# po refinement

Answers a Product Owner refinement question using the parent ticket context ([BA]/[SA]/[VD] sibling tickets), writes the answer to the Answer field, and closes the question.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `childQuestions` — fetches [Q] question sub-tickets of each matched context ticket and appends them to the context.
- `contexts` — context definitions matched by summary prefix (label, output file, description for the agent).
- `fields` — tracker fields to fetch for context tickets.
- `jql` — JQL override for selecting context tickets.
- `parentContextFetch` — enables and configures fetching the parent ticket context ([BA]/[SA]/[VD] sibling tickets).
