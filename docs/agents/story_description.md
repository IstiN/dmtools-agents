# story description

Writes a full story description from the ticket context and its answered question sub-tickets.

By default the result replaces the ticket's Description field and the story is assigned back to the initiator for review. When `contentOutput` targets Confluence, the description is instead published as a Confluence page, reviewer inline comments on that page are read before writing, and answers are posted back as comment replies.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `contentOutput` — output routing block; see below.

### contentOutput

- `contentOutput.target` — `jira_field` (default, current behavior), `confluence`, or `both`.
- `contentOutput.field` — tracker field for the `jira_field`/`both` targets. Default in this agent's config: `Description`.
- `contentOutput.operationType` — `replace` (default) or `append`.
- `contentOutput.space` / `contentOutput.parentPageId` — where the ticket's page lives (required for Confluence targets).
- `contentOutput.pageTitleSuffix` — appended to the page title.
- `contentOutput.includeInlineComments` — fetch the page's inline comments before the run and publish `outputs/confluence_replies.json` after it. Default: `true`.
- `contentOutput.updateTrackerField` — for `target: confluence`, also write the page link into the tracker field. Default: `true`.
- `contentOutput.assignForReview` — assign the ticket back to the initiator and move it to the review status after writing. Default: `true`.
