# story development redirect

Routes a story to the repository-specific development agent based on the ticket context.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `repoAgentsDir` — directory with per-repository agent configs used by the redirect.
- `targetAgentName` — name of the agent configuration this redirect routes to.
