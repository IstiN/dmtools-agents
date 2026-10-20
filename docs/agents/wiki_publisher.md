# wiki_publisher

Generic, tracker- and wiki-agnostic base agent that turns a work item's prepared context into one wiki page: it reads the input bundle (`input/<KEY>/`), writes the page as GitHub-flavored Markdown to `outputs/response.md`, and the post-action syncs it to the wiki (Confluence via the dmtools Markdown sync today) and posts the page link back to the originating ticket on Jira, Azure DevOps, or GitHub Issues.

Consuming repos specialize it through `"parent"` inheritance (merging project skill files onto `params.cliPrompts`) rather than forking the config; the base agent itself contains zero domain rules.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`; child configs override per key.

- `contentOutput` — publish routing: `target` (`wiki` — alias of `confluence`), `space`, `parentPageId`, `pageTitleSuffix` (page title becomes `<KEY> <Summary> — <pageTitleSuffix>`), `updateTrackerField` (default `false` here — the wiki target writes no tracker fields), `operationType`, `includeInlineComments`.
- `removeLabel` — SM idempotency label dropped once the agent runs (`sm_wiki_publisher_triggered`).
