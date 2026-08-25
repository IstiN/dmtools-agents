# bug creation

Turns a ready QA finding into a well-formed bug ticket: drafts summary, description, severity and steps, then creates the bug and links it to the source ticket.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `checkOpenPR` — check open pr.
- `openBugsJql` — open bugs jql.
- `removeLabel` — remove label.
