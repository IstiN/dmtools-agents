# retry merge github

Squash-merges an approved GitHub PR for the machine loop (the `sm_github.json` merge rule runs this config via localExecution): resolves the linked PR for the issue, verifies checks/mergeability, merges one PR per tick, cleans the trigger labels, and posts the closing comment.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `approvedLabel` — issue label that marks an approved review verdict (default `pr_approved`).
- `removeLabel` — label removed from the issue after a successful merge (idempotency cleanup).
- `reworkLabel` — label added back when the merge is not yet possible so the rework leg can react.
- `prNumber` — explicit PR number override; when absent the PR is resolved from the branch prefix or the PR body.
- `branchPrefix` — PR head-branch prefix used to link PRs to `gh-<n>` issues (default `ai/gh-`).
- `repository` — target `owner/repo`; defaults to the SM rule's repository.
- `mergeMethod` — GitHub merge method (default `squash`).
