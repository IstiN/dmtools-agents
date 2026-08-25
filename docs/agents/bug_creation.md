# bug creation

Turns a ready QA finding into a well-formed bug ticket: drafts summary, description, severity and steps to reproduce, creates the bug and links it to the source ticket.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `openBugsJql` — JQL selecting the open bugs to include.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
