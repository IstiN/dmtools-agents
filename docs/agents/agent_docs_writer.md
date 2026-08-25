# agent docs writer

Rewrites the human-readable agent docs (`docs/agents/<name>.md`) for agent configs that changed, using an LLM CLI: it collects each changed agent's JSON config and JS-action summaries into the input folder, rewrites the human docs, applies them, and regenerates the generated reference docs.

Typically run from CI on pull requests that modify agent configs; the calling workflow commits the resulting diff back to the PR branch.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `agents` — explicit list of agent config names (without `.json`) to document. When set, takes priority over change detection.
- `baseBranch` — git ref to diff against (e.g. `origin/main`); only agents whose JSON changed vs that ref are documented. When neither `agents` nor `baseBranch` is set, all tracked agent configs are documented.
