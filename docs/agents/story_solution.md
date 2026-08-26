# story solution

Designs the technical solution for a story: reads the story context, the answered questions, and the BA/SA/VD parent context, then produces the solution write-up and architecture diagrams.

By default the result is written to the ticket's Solution and Diagrams fields and the story moves to Ready For Development. When `contentOutput` targets Confluence, the solution is instead published as a Confluence page (with the diagram as a Mermaid section), reviewer inline comments on that page are read before writing, and answers are posted back as comment replies.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `solutionField` — tracker field that receives the solution text. Default: `Solution`.
- `diagramField` — tracker field that receives the diagram. Set to an empty string to prepend the diagram to the solution as a code block instead. Default: `Diagrams`.
- `outputType` — `replace` (default) overwrites the solution field; `append` keeps the existing field content and appends the new solution after a separator.
- `requireDiagram` — when `true`, the run fails if the agent did not produce `outputs/diagram.md`. Default: `false`.
- `checkOpenPR` — when `true`, skip tickets that already have an open solution PR. Default: `false`.
- `autoStartDevelopment` / `autoStartDevelopmentConfigFile` — after a successful solution, automatically trigger the development workflow for the ticket using the given agent config file.
- `contentOutput` — output routing block; see below.

### contentOutput

- `contentOutput.target` — `jira_field` (default, current behavior), `confluence`, or `both`.
- `contentOutput.space` / `contentOutput.parentPageId` — where the ticket's solution page lives (required for Confluence targets).
- `contentOutput.pageTitleSuffix` — appended to the page title, e.g. `Solution Design`.
- `contentOutput.includeInlineComments` — fetch the page's inline comments into the input folder before the run and publish `outputs/confluence_replies.json` after it. Default: `true`.
- `contentOutput.updateTrackerField` — for `target: confluence`, also write the page link into the solution field. Default: `true`.

> **Downstream consumers:** other agents in the pipeline (for example the
> affected-repos / task-splitting flows that parse the Solution field) read the
> tracker field, not Confluence. When such a consumer exists, use
> `target: 'both'` — the field keeps the full machine-readable content and the
> Confluence page becomes the human-facing mirror. `target: 'confluence'`
> alone would leave only a link in the field and break those agents.
