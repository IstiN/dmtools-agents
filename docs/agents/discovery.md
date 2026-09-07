# discovery

Runs continuous product discovery for a ticket and publishes the result as a Confluence page tree; on later runs it iterates on the existing pages and answers reviewer inline comments.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `feedbackLoop` — closes the loop after the post action: when `feedbackLoop.postAction.enabled` is `true`, reviewer answers posted after publication are re-read and the page tree is refined, at most `feedbackLoop.postAction.maxAttempts` times per ticket.
