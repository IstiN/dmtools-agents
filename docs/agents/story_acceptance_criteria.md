# story acceptance criteria

Writes acceptance criteria for a story from its description, design context, and answered question sub-tickets.

By default the result replaces the ticket's Acceptance Criteria field and the story moves to Solution Architecture. When `contentOutput` targets Confluence, the criteria are instead published as a Confluence page, reviewer inline comments on that page are read before writing, and answers are posted back as comment replies.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `autoStartSolution` / `autoStartSolutionConfigFile` — after the acceptance criteria are written, automatically trigger the solution workflow for the ticket using the given agent config file.
- `contentOutput` — output routing block; see below.

### contentOutput

- `contentOutput.target` — `jira_field` (default, current behavior), `confluence`, or `both`.
- `contentOutput.field` — tracker field for the `jira_field`/`both` targets. Default in this agent's config: `Acceptance Criteria`.
- `contentOutput.operationType` — `replace` (default) or `append`.
- `contentOutput.space` / `contentOutput.parentPageId` — where the ticket's page lives (required for Confluence targets).
- `contentOutput.pageTitleSuffix` — appended to the page title.
- `contentOutput.includeInlineComments` — fetch the page's inline comments before the run and publish `outputs/confluence_replies.json` after it. Default: `true`.
- `contentOutput.updateTrackerField` — for `target: confluence`, also write the page link into the tracker field. Default: `true`.

**Markup for Confluence targets.** With `target: confluence` the tracker-specific CLI
prompts are selected by the `confluence` key of `cliPromptsByTracker` (see
`instructions/tracker/confluence_markup_transform.md`) instead of the configured default
tracker, so the agent authors Markdown that the Confluence sync can render. This selection
happens in `buildEncodedConfig.js` for encoded-config runs and in the dmtools CLI
(`CliCommandBuilder`) for direct `dmtools run` invocations. With `target: both` the tracker
markup is kept because the tracker field still receives the full content.
