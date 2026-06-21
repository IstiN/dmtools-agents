# Known bottlenecks & vulnerabilities

This is a living list of weak points in the dmtools-agents dark-factory flow. It is meant to be reviewed while walking through the workflow diagram.

## 1. Concurrency & label races

- **Max 3 triggered workflows** (`sm.json` `maxTriggeredWorkflows: 3`). With many active tickets, SM can run out of budget and leave work queued until the next cycle.
- **Label-based idempotency** is the primary guard. If a post-action crashes after doing work but before removing the SM trigger label, the ticket is skipped until a recovery agent or manual cleanup fixes it.
- **Multiple rules can match the same ticket**. For example, an `In Review` ticket with `pr_approved` matches both the review rule and the merge rule. Ordering in `sm.json` mitigates this, but Jira index lag can still cause both rules to see slightly different label states.

## 2. Merge & CI timing races

- **Merge decisions rely on GitHub `mergeable_state`**, which can be `unknown`, `checking`, or stale. The agent returns `false` and waits, but if GitHub never computes mergeability the PR can stall.
- **`merge-trigger.yml` only runs after `Flutter Required Checks` succeeds**. If that workflow is renamed, skipped, or never reports, approved PRs never merge automatically.
- **Two merge paths**: `retryMergePR.js` (SM-driven) and `merge-trigger.yml` (CI-driven) can race. If one sees a conflict and the other sees a green PR, the ticket may be moved to `In Rework` while a merge is in flight.

## 3. Branch & push races

- **Force-push fallbacks** exist in `postStoryTestAutomationResults.js`, `storyTestAutomationRework.js`, `postTestAutomationResults.js`, and `developTicketAndCreatePR.js`. Concurrent runs on the same `ai/<KEY>` or `test/<KEY>` branch can overwrite each other.
- **Stale test PRs**: when a test branch is repeatedly merged with `main` but adds no new test code, an existing PR can end up with `changed_files === 0`. SM rules that match "In Testing + open PR" will still trigger review on an empty diff. `prepareTestPRForReview.js` now detects this and closes the branch, but the underlying race remains if multiple re-runs overlap.

## 4. Test-case lifecycle deadlocks

- **`bug_done_check`** uses directly linked Test Cases; if a Bug has no direct TC links it falls back to `linkedIssues`, which can block on unrelated Story TCs.
- **`story_done_check`** waits for `bulk_bugs_creation` to link bugs. If bulk bug creation fails or returns an empty `processed[]`, the Story can oscillate between `In Testing`, `Bug To Fix`, and `Ready For Testing`.
- **`bug_to_fix_check`** moves a Story back to `Ready For Testing` only when **all** linked Bugs are `Done`. If one bug is abandoned, the Story is stuck.

## 5. Recovery & watchdog gaps

- **`df_manager.js`** runs only when explicitly dispatched; it is **not** a scheduled SM rule. Stale labels > 45 min are only recovered if something triggers it.
- **`recover_merged_pr`** scans closed PRs for merged state. If the PR branch was deleted and the ticket key is not in the title, it may miss the merge.
- **`recover_stuck_test_case`** can move a clean PR to `In Review - Passed`, but it does not verify that tests actually passed; it trusts PR mergeability.

## 6. Input / output file vulnerabilities

- **Many agents read `outputs/response.md` as a success signal**. If a previous run’s stale `response.md` is present, the agent may think work succeeded when it did not. `preCliTestAutomationSetup.js` clears some stale outputs, but `story_development` does not.
- **`.dmtools/copilot-sessions` is excluded manually** in development/rework scripts. If the exclusion fails, session tokens or cached LLM data could be committed.
- **Duplicate bug creation**: `bulk_bugs_creation.json` and `bug_creation.json` both match `Test Case` `Failed`. The single `bug_creation` rule is limited to 5 tickets and runs alongside the bulk rule; label lag can create duplicate bugs.

## 7. Jira custom field fragility

- **Field names** (`Acceptance Criteria`, `Solution`, `Diagrams`, `Failed Reason`, `Answer`) are resolved by friendly name. If a project changes the field name or moves to ADF, field updates can silently fail or corrupt content.
- **`jira_get_field_custom_code`** is optional; if disabled, agents fall back to friendly names, which may not work on all Jira instances.

## 8. Token usage & observability

- **`ai_teammate_token_usage_reporter.js`** parses Copilot token summaries from free-text logs. Log format changes will break cost accounting.
- **`workflow_failure_reporter.js`** relies on `listWorkflowRuns` support by the SCM provider; not all providers implement it, causing silent no-ops.

## Generated

- Source: manual + `agents/js/agentDocGenerator.js`
- Last updated: 2026-06-21
