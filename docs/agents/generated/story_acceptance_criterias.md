# Story Acceptance Criterias

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

_Human doc: [`agents/docs/agents/story_acceptance_criterias.md`](agents/docs/agents/story_acceptance_criterias.md)_

## Attributes

| Attribute | Value |
|---|---|
| Job | `Teammate` |
| Config | `story_acceptance_criterias.json` |
| ContextId | `—` |
| outputType | `none` |
| skipAIProcessing | `true` |

## Prompt snapshot

Full prompt / instruction set: [`agents/snapshots/story_acceptance_criterias.md`](agents/snapshots/story_acceptance_criterias.md)

## Actions

### preJSAction: `requireTicket.js`

_Require Ticket Pre-Action_

- Source: `agents/js/requireTicket.js`
- Parameters (customParams):
  - `adoTextFormat`
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `configPath`
  - `customStatuses`
  - `featureBranchEnabled`
  - `prSearchFnPath`
  - `scmProvider`
  - `stageFallback`
  - `targetRepository`
  - `trackerProvider`

### preCliJSAction: `preCliContentOutputSetup.js`

_Pre-CLI Content Output Setup — shared pre-action for content-generating_

- Source: `agents/js/preCliContentOutputSetup.js`
- Parameters (customParams):
  - `adoTextFormat`
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `childQuestions`
  - `configPath`
  - `contentOutput`
  - `contexts`
  - `customStatuses`
  - `featureBranchEnabled`
  - `fields`
  - `jql`
  - `parentContextFetch`
  - `prSearchFnPath`
  - `scmProvider`
  - `stageFallback`
  - `targetRepository`
  - `trackerProvider`


### postJSAction: `writeContentOutput.js`

_Write Content Output — unified post-action for content-generating agents_

- Source: `agents/js/writeContentOutput.js`
- Side effects:
  - post ticket comment (via tracker)
- Parameters (customParams):
  - `adoTextFormat`
  - `branchCreateFnPath`
  - `branchNamingFnPath`
  - `configPath`
  - `contentOutput`
  - `customStatuses`
  - `featureBranchEnabled`
  - `prSearchFnPath`
  - `scmProvider`
  - `stageFallback`
  - `targetRepository`
  - `trackerProvider`


## LLM step

- outputType: `none`
- Prompt snapshot: `agents/snapshots/story_acceptance_criterias.md`

## Custom params

- `contentOutput`:

  ```json
  {
    "target": "jira_field",
    "field": "Acceptance Criteria",
    "operationType": "replace",
    "thenAction": "assignForSolutionArchitecture.js",
    "assignForReview": false
  }
  ```
- `adoTextFormat` _(used by JS action)_
- `branchCreateFnPath` _(used by JS action)_
- `branchNamingFnPath` _(used by JS action)_
- `configPath` _(used by JS action)_
- `customStatuses` _(used by JS action)_
- `featureBranchEnabled` _(used by JS action)_
- `prSearchFnPath` _(used by JS action)_
- `scmProvider` _(used by JS action)_
- `stageFallback` _(used by JS action)_
- `targetRepository` _(used by JS action)_
- `trackerProvider` _(used by JS action)_
- `childQuestions` _(used by JS action)_
- `contexts` _(used by JS action)_
- `fields` _(used by JS action)_
- `jql` _(used by JS action)_
- `parentContextFetch` _(used by JS action)_

---
_Generated by js/agentDocGenerator.js_