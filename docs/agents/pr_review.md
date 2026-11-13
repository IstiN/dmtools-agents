# pr review

Reviews a pull request like a senior reviewer: analyzes the diff, checks conventions and risks, and posts inline review comments plus a verdict.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `cacheToReleases` — when enabled, the autocommit timer snapshots accumulated CLI output into a git release asset.
- `scmProvider` — SCM provider override (`github`, `gitlab`, …) for this run.
- `targetRepository` — repository override block (`owner`, `repo`, `baseBranch`, `workingDir`) — run the review against this repository instead of the project default.

- `aiRepository` — repository the AI CLI works in when it differs from the PR repository.
- `allowApproveWithSuggestions` — legacy knob (gh-1351): policy-derived now; setting it against the resolved `reviewPolicy` logs a conflict audit line and the policy wins.
- `autoStartRework` — when `true`, automatically trigger the rework workflow when the review asks for changes.
- `autoStartReworkConfigFile` — agent config file used for the auto-started rework workflow.
- `checkOpenPR` — when `true`, skip tickets that already have an open pull request for this work.
- `configPath` — path to the project `.dmtools/config.js` to load for this run.
- `customStatuses` — legacy per-invocation override for individual `STATUSES` keys (e.g. `{ "IN_REWORK": "Ready For Development" }`); prefer the project-wide `jira.statuses` override in `.dmtools/config.js` for a project-wide remap instead.
- `formalGithubReview` — when `true`, in addition to the existing `pr_approved` label, formally submit a native GitHub PR review: `REQUEST_CHANGES` when the AI does not approve, or dismiss any prior `REQUEST_CHANGES` review when the AI approves. Does not change the `pr_approved` label lifecycle.
- `maxAutoReworkRounds` — maximum auto-started rework rounds (`rework-round-N` on the ticket, default `3`; values `<= 0` warn and fall back to `3` — use `autoStartRework: false` to disable) before the ticket is labeled `needs-human` and no further rework is chained.
- `maxReviewThreadsBeforeForceApprove` — maximum open review threads before the reviewer is forced to an approve/reject verdict.
- `onApproved` — action to run when the review approves (e.g. trigger merge).
- `projectKey` — tracker project key override.
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).

## Review policy: `reviewPolicy.verification` (gh-1403)

Set in the project `.dmtools/config.js` (e.g. `reviewPolicy: { verification: 'filter' }`); jobParams `reviewPolicy` overrides per run. The resolved table stamped into `review_policy.md` documents the active value.

- `none` (default) — findings post exactly as the review leg raised them. No extra cost, no extra risk.
- `filter` — a second, FRESH-context CLI pass re-verifies each file-referenced finding against the actual PR diff before it is posted, and rewrites the review:
  - `demote` — a still-valid finding loses its tier (no longer gates approval), its body is kept and prefixed with the machine-parsed provenance marker `dmtools:demoted-from-BLOCKING` / `dmtools:demoted-from-IMPORTANT`, the thread is resolved.
  - `drop` — a non-finding is removed, its thread resolved.
  - `keep` (default) — the finding posts unchanged. Round-none tiers (🪶 under the default preset) never enter the filter.
  - Verdict reconciliation: when the filter removed every rework-tier thread, a surviving `BLOCK`/`REQUEST_CHANGES` token is advisory — the machine verdict follows the post-filter census (logged as a machine-enforcement reconciliation). Without an applied filter the token rules stand: a model `BLOCK` is never silently overridden.
  - Anti-over-suppression guard: when every candidate of a run is dropped or demoted (nothing kept — a fully-demoted round flips every gated finding to non-gating too), a ⚠️ warning is stamped into the review summary — a miscalibrated filter must not silently erase real findings.

**Trial opt-in** (gh-1403): this repository opts in via `.dmtools/config.js` in #1408 — post-merge, once a pack release cut from post-gh-1403 main is out (the knob ships blockless until then: a `reviewPolicy` block, even with `'none'`, crashes released pre-gh-1403 packs at leg setup). The trial bar is fewer rework laps per PR AND higher precision AND ≈ 0 wrongly-dropped findings. Revert to `none` if the trial fails.

## Reviewer pool (gh-1406)

The review leg is a POOL of reviewer legs: the generalist (`base`) plus specialists (factory ships `security`; repos add their own). Every leg assembles `[roleLine → instructions/pr_review/base/* → lens → repo appends → few-shots + verdict rules]` and produces candidate findings only — the census and verdict stay the machine's (one census, one verdict).

- Skill files: factory `instructions/review/<name>.json`; repo `.dmtools/review/<name>.json`. Required fields `name` + `lens`; everything defaults (all tiers, `filterWeight: "normal"`, `isFiltered: true`, `rounds: ["all"]`, `triggerPaths: []`). A same-name repo file may only TUNE a factory reviewer (`isEnabled`, `rounds`, `triggerPaths`, `options`, `model`) — contract fields cannot be re-defined, and duplicate names fail the load.
- Pool config: `reviewPolicy: { required: ['base', 'security'], reviewers: { security: { isEnabled: true } }, promptAppend: { base: ['.dmtools/review/base.append.md'] } }` — `promptAppend` is additive-only (appends after the lens).
- `rounds: ["first","hunks"]` (specialist default) — full pass up front; later rounds only when new hunks touch `triggerPaths` (`first` counts completed passes, not attempts: a 429-failed leg re-fires until its completion marker exists).
- `reviewPolicy.required` (factory default `['base', 'security']`) gates the MERGE: every listed reviewer needs a same-head PASS marker, else the gh-1370 lane withholds the merge — retry with backoff, owner escalation past budget, never a silent merge. The list is repo-owned (`required: []` gates nothing — merge rules are repo rules); an explicit entry naming an unknown reviewer is a hard error (a misspelled gate silently gates nothing), while the factory DEFAULT list degrades to a warning for reviewers that did not load. The default list adapts when the io degrades; every reviewer still stamps its PASS marker — it doubles as the `first`-rounds completion counter.
- Validation: `node scripts/validate-review-skills.js .` — deterministic config check (schema, lens existence, duplicate names, tuning limits, prompt targets); wire it into CI next to the docs-coverage gate. Worked example (repo-defined legal reviewer + appends): the [`example/reviewer-pool`](https://github.com/ajaxspace/dm_tools_worflow_test_example/tree/example/reviewer-pool) branch of the factory test repo.
- Execution (gh-1471): the pre-cli action dispatches the round's specialist legs fire-and-forget (autoStart, duplicate-run-guarded by the PASS markers; the per-leg identity patch `reviewerPoolLeg` carries `{reviewer, required, contract, round, head}` — candidates legs answer `outputs/pr_review_candidates.json`, the posting leg keeps the verdict contract). The post action is the round's machine half: specialists stamp candidates + PASS markers and never post; the posting leg merges the round's candidates into ONE review (cross-reviewer dedup, severity escalates only, weighted retention for high-weight reviewers), runs the gh-1403 filter over the merged census, stamps the pool-outcome marker + the required-reviewer hold, and stamps its own PASS marker after posting. `reviewerPoolWaitSeconds` (default 0) bounds how long the aggregation waits for late specialists before naming them unavailable (fail-open); `reviewerPoolPollSeconds` (default 30) is the poll interval.

- `responseTarget`: `"scm"` — `outputs/response.md` becomes the PR body/comment, so the output-format prompt is GitHub-Flavored Markdown even on Jira (conditions `isResponseToScm.js` / `isResponseToTracker.js`).
