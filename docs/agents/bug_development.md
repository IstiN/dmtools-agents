# bug development

Implements a bug fix end to end: checks out the repository, analyzes the root cause, writes the fix with tests, and opens a pull request.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `branchCreateFnPath` — branch create fn path.
- `checkOpenPR` — check open pr.
- `removeLabel` — remove label.
- `targetRepository.workingDir` — working dir.
