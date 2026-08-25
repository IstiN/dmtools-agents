# pr knowledge update

Distills the outcome of a merged PR into the self-curated review-knowledge base and pushes the update.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `diffText` — precomputed diff text override (instead of fetching the PR diff).
- `discussionsMarkdown` — precomputed review-discussions markdown override.
- `knowledgeDir` — directory of the review-knowledge base being updated.
- `prNumber` — PR/MR number whose outcome is distilled into the knowledge base.
- `prTitle` — title of the PR being distilled.
- `prUrl` — URL of the PR being distilled.
- `ticket` — ticket key override for the knowledge update.
