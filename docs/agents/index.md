# dmtools-agents agent catalog

This document describes every agent in the `agents/` directory: what ticket it handles, what context it reads, what outputs it produces, and what status transitions / next agents it triggers.

> **Scope**: `dmtools-agents` only. `trackstate` does not need to know about this file.
> **Maintainer**: regenerate via `dmtools run agents/js/unit-tests/run_agentDocs.json` when agent JSONs or JS actions change.

---

## Legend

| Field | Meaning |
|---|---|
| **ContextId** | Workflow context used for WIP labels, output folders, and logs |
| **Ticket type** | Jira issue type this agent is designed for |
| **Pre-actions** | `preJSAction` / `preCliJSAction` run before the LLM step |
| **Post-action** | `postJSAction` run after the LLM step |
| **Inputs** | Files written to `input/<KEY>/` by pre-actions |
| **Outputs** | Files written to `outputs/` by the LLM or post-action |
| **Status moves** | Jira transitions performed by the agent |
| **Next** | Agent(s) / SM rules triggered next |

---

## Orchestration

| Workflow | File | Trigger | Runs |
|---|---|---|---|
| SM Agent | `.github/workflows/sm.yml` | `workflow_dispatch`, after every `ai-teammate.yml` run | `agents/sm.json` |
| AI Teammate | `.github/workflows/ai-teammate.yml` | `workflow_dispatch` with `config_file` + `concurrency_key` | Any `agents/*.json` |
| Merge Trigger | `.github/workflows/merge-trigger.yml` | After `Flutter Required Checks` succeeds | `agents/sm_merge.json` |

### `sm.json` dispatch rules (summary)

`maxTriggeredWorkflows: 3`. All rules scope by `{jiraProject}`.

| # | Trigger status / type | Config file | Skip label | Adds label | Target status |
|---|---|---|---|---|---|
| 1 | Story, `PO Review` | `story_ba_check.json` | `sm_story_ba_check_triggered` | — | — |
| 2 | Story, `BA Analysis` | `story_acceptance_criteria.json` | `sm_story_acceptance_criteria_triggered` | `sm_story_acceptance_criteria_triggered` | — |
| 3 | Story, `Solution Architecture` | `story_solution.json` | `sm_story_solution_triggered` | `sm_story_solution_triggered` | — |
| 4 | Subtask `[Q]`, not Done | `po_refinement.json` | `sm_po_refinement_triggered` | `sm_po_refinement_triggered` | — |
| 5 | Story, `Backlog`/`To Do` | `story_questions.json` | `sm_story_questions_triggered`, `ai_questions_asked` | `sm_story_questions_triggered` | — |
| 6 | Task, `Backlog`/`To Do`, has parent | `intake.json` | `sm_task_intake_triggered` | `sm_task_intake_triggered` | `In Development` |
| 7 | Story, `Ready For Development` | `story_development.json` | `sm_story_development_triggered` | `sm_story_development_triggered` | — |
| 8 | Test Case, `Failed` | `recover_failed_tc_bug_status.json` | — | — | — |
| 9 | Test Case, `Failed`, no bulk label | `bulk_bugs_creation.json` | `sm_bulk_bugs_creation_triggered` | `sm_bulk_bugs_creation_triggered` | — |
| 10 | Bug, active statuses, updated ≤ -15m | `bug_development.json` | `sm_bug_development_triggered` | `sm_bug_development_triggered` | — |
| 11 | Story/Bug, `In Review`/`In Rework`/`Blocked` | `recover_merged_pr.json` | — | — | — |
| 12 | Story/Bug, `Blocked` | `unblock_resolved_dependencies.json` | — | — | — |
| 13 | Story/Bug, `In Review`, no `pr_approved` | `pr_review.json` | `sm_story_review_triggered` | `sm_story_review_triggered` | — |
| 14 | Story/Bug, `In Review`, `pr_approved` | `retry_merge.json` | — | — | — |
| 15 | Test Case, `In Review - Passed/Failed`, `pr_approved` | `retry_merge_test.json` | — | — | — |
| 16 | Story, `In Testing`, `pr_approved` | `story_test_automation_merge.json` | — | — | — |
| 17 | Bug, `In Testing`, `pr_approved` | `bug_test_automation_merge.json` | — | — | — |
| 18 | Story/Bug, `In Rework` | `pr_rework.json` | `sm_story_rework_triggered` | `sm_story_rework_triggered` | — |
| 19 | Story, `Merged` | `test_cases_generator.json` | `sm_test_cases_triggered` | `sm_test_cases_triggered` | `Ready For Testing` |
| 20 | Bug, `Merged` | `bug_merged.json` | `sm_bug_merged_triggered` | — | `Ready For Testing` |
| 21 | Bug, `Ready For Testing`, no test-cases label | `bug_test_cases_generator.json` | `sm_bug_test_cases_triggered` | `sm_bug_test_cases_triggered` | — |
| 22 | Bug, `Ready For Testing` | `bug_test_automation.json` | `sm_bug_test_automation_triggered` | `sm_bug_test_automation_triggered` | — |
| 23 | Story, `Ready For Testing` | `story_test_automation.json` | `sm_story_test_automation_triggered`, `sm_test_cases_triggered` | `sm_story_test_automation_triggered` | — |
| 24 | Story, `In Testing` | `story_done_check.json` | `sm_story_done_check_triggered` | — | — |
| 25 | Bug, `In Testing` | `bug_done_check.json` | `sm_bug_done_check_triggered` | — | — |
| 26 | Task, `In Development`/`In Progress` | `task_done_check.json` | `sm_task_done_check_triggered` | — | — |
| 27 | Test Case, `In Development`, stale | `recover_stuck_test_case.json` | — | — | — |
| 28 | Test Case, `In Rework` | `pr_test_automation_rework.json` | `sm_test_rework_triggered` | `sm_test_rework_triggered` | — |
| 29 | Test Case, `In Review - Passed/Failed`, no `pr_approved` | `pr_test_automation_review.json` | `sm_test_review_triggered` | `sm_test_review_triggered` | — |
| 30 | Test Case, dirty review | `recover_dirty_review_test_case.json` | — | — | — |
| 31 | Test Case, `Failed` | `bug_creation.json` | `sm_bug_creation_triggered` | `sm_bug_creation_triggered` | — |
| 32 | Test Case, `Backlog`/`To Do`/`Ready For Development` | `test_case_automation.json` | `sm_test_automation_triggered` | `sm_test_automation_triggered` | `In Development` |
| 33 | Story/Test Case, `Bug To Fix` | `bug_to_fix_check.json` | `sm_bug_to_fix_check_triggered` | — | — |

---

## Agent reference

### Intake & refinement

#### `intake.json` — Intake / task breakdown
- **ContextId**: `intake`
- **Ticket type**: `Task`
- **Pre-actions**: `checkWipLabel.js`, `fetchEpicsToInput.js`
- **Post-action**: `createIntakeTickets.js`
- **Inputs**: `input/<KEY>/existing_epics.json`, `existing_stories.json`
- **Outputs**: `outputs/stories.json`, `outputs/comment.md`
- **Status moves**: `Backlog`/`To Do` → `In Progress` / `In Development`
- **Next**: created Stories/Bugs picked up by SM dev rules

#### `story_questions.json` — Clarification questions
- **ContextId**: `story_questions`
- **Ticket type**: `Story`
- **Pre-actions**: `fetchQuestionsToInput.js`
- **Post-action**: `createQuestionsAndAssignForReview.js`
- **Inputs**: `input/<KEY>/existing_questions.json`, optional parent context
- **Outputs**: `outputs/questions.json`, per-question `outputs/questions/question-*.md`
- **Status moves**: `Backlog`/`To Do` → `PO Review`
- **Next**: `story_ba_check`

#### `po_refinement.json` — Answer `[Q]` subtasks
- **ContextId**: `po_refinement`
- **Ticket type**: `Subtask`
- **Pre-actions**: `fetchParentContextToInput.js`
- **Post-action**: `closeQuestionTicket.js`
- **Outputs**: writes `Answer` field
- **Status moves**: — → `Done`
- **Next**: `story_ba_check` on parent

### Story analysis

#### `story_ba_check.json` — Wait for PO answers
- **ContextId**: `story_ba_check`
- **Ticket type**: `Story`
- **Post-action**: `checkSubtasksDoneForBA.js`
- **Status moves**: if no open `[Q]` subtasks → `BA Analysis`
- **Next**: `story_acceptance_criteria`

#### `story_acceptance_criteria.json` — Acceptance Criteria
- **ContextId**: `story_acceptance_criteria`
- **Ticket type**: `Story`
- **Pre-actions**: `fetchQuestionsToInput.js`
- **Post-action**: `assignForSolutionArchitecture.js`
- **Outputs**: writes `Acceptance Criteria` field
- **Status moves**: `BA Analysis` → `Solution Architecture`
- **Next**: `story_solution`

#### `story_solution.json` — Solution Design
- **ContextId**: `story_solution`
- **Ticket type**: `Story`
- **Pre-actions**: `checkWipLabel.js`, `preCliSolutionSetup.js`
- **Post-action**: `writeSolutionAndDiagrams.js`
- **Outputs**: `outputs/response.md`, `outputs/diagram.md`
- **Status moves**: `Solution Architecture` → `Ready For Development`
- **Next**: `story_development` (optional auto-start) or SM rule 7

### Development

#### `story_development.json` — Implement Story
- **ContextId**: `story_development`
- **Ticket type**: `Story`
- **Pre-actions**: `checkWipLabel.js`, `preCliDevelopmentSetup.js`
- **Post-action**: `developTicketAndCreatePR.js`
- **Inputs**: questions, linked test cases, merge conflicts, parent context
- **Outputs**: `outputs/response.md` (PR body)
- **Status moves**: `Ready For Development` → `In Development` → `In Review`
- **Next**: `pr_review`

#### `bug_development.json` — Fix Bug
- **ContextId**: `bug_development`
- **Ticket type**: `Bug`
- **Pre-actions**: `checkWipLabel.js`, `preCliDevelopmentSetup.js`
- **Post-action**: `developBugAndCreatePR.js`
- **Status moves**: active statuses → `In Development` → `In Review`
- **Next**: `pr_review`

### Code review & rework

#### `pr_review.json` — Review code PR
- **ContextId**: `pr_review`
- **Ticket type**: `Story` / `Bug`
- **Pre-actions**: `checkWipLabel.js`, `preparePRForReview.js`
- **Post-action**: `postPRReviewComments.js`
- **Inputs**: `pr_info.md`, `pr_diff.txt`, `pr_discussions.md`, `pr_discussions_raw.json`, `ci_failures.md`
- **Outputs**:
  - `outputs/pr_review.json`
  - `outputs/pr_review_general.md`
  - `outputs/pr_review_comments/*.md`
- **Status moves**:
  - `APPROVE` → adds `pr_approved` label
  - `REQUEST_CHANGES`/`BLOCK` → `In Rework`
- **Next**: `retry_merge` or `pr_rework`

#### `pr_rework.json` — Address review comments
- **ContextId**: `pr_rework`
- **Ticket type**: `Story` / `Bug`
- **Pre-actions**: `checkWipLabel.js`, `preCliReworkSetup.js`
- **Post-action**: `pushReworkChanges.js`
- **Inputs**: PR context, merge conflicts, CI failures
- **Outputs**: `outputs/response.md`, `outputs/review_replies.json`
- **Status moves**: `In Rework` → `In Review`
- **Next**: `pr_review`

### Merge

#### `retry_merge.json` — Merge approved code PR
- **ContextId**: `retry_merge`
- **Ticket type**: `Story` / `Bug`
- **Post-action**: `retryMergePR.js`
- **Status moves**: success → `Merged`; conflict/CI fail → `In Rework`
- **Next**: `test_cases_generator` / `bug_merged`

#### `retry_merge_test.json` — Merge approved Test Case PR
- **ContextId**: `retry_merge_test`
- **Ticket type**: `Test Case`
- **Post-action**: `retryMergePR.js`
- **Status moves**: `In Review - Passed/Failed` → `Passed`/`Failed`; conflict → `In Rework`
- **Next**: done-checks

### Post-merge

#### `test_cases_generator.json` — Generate Story test cases
- **Ticket type**: `Story`
- **Pre-action**: `moveToReadyForTesting.js`
- **Post-action**: `finishTestCasesGeneration.js`
- **Status moves**: `Merged` → `Ready For Testing`
- **Next**: test automation

#### `bug_merged.json` — Bug post-merge summary
- **ContextId**: `bug_merged`
- **Ticket type**: `Bug`
- **Post-action**: `notifyBugMerged.js`
- **Status moves**: `Merged` → `Ready For Testing`
- **Next**: `bug_test_cases_generator`

### Test automation

#### `story_test_automation.json` — Bulk automate Story tests
- **ContextId**: `story_test_automation`
- **Ticket type**: `Story`
- **Pre-actions**: `checkWipLabel.js`, `preCliStoryTestAutomationSetup.js`
- **Post-action**: `postStoryTestAutomationResults.js`
- **Inputs**: `linked_test_cases.json/.md`, optional existing PR context, merge conflicts
- **Outputs**:
  - `outputs/story_test_automation_result.json`
  - `outputs/failed_description_<TC>.md`
  - `outputs/response.md`
- **Status moves**:
  - `Ready For Testing` → `In Testing`
  - TCs: `passed`→`In Review - Passed`; `failed`→`In Review - Failed`; `skipped`→`Skipped`; `irrelevant`→`Irrelevant`
  - `blocked_by_human` → `Blocked`
- **Next**: `pr_story_test_automation_review`

#### `bug_test_automation.json` — Bulk automate Bug tests
- **ContextId**: `bug_test_automation`
- **Ticket type**: `Bug`
- **Pre-actions**: `checkWipLabel.js`, `preCliStoryTestAutomationSetup.js`
- **Post-action**: `postStoryTestAutomationResults.js`
- **Status moves**: `Ready For Testing` → `In Testing`
- **Next**: `pr_bug_test_automation_review`

#### `test_case_automation.json` — Automate single Test Case
- **ContextId**: `test_case_automation`
- **Ticket type**: `Test Case`
- **Pre-actions**: `checkWipLabel.js`, `preCliTestAutomationSetup.js`
- **Post-action**: `postTestAutomationResults.js`
- **Outputs**:
  - `outputs/test_automation_result.json`
  - `outputs/failed_description_<TC>.md`
  - `outputs/response.md`, `outputs/pr_body.md`
- **Status moves**:
  - `Backlog`/`To Do`/`Ready For Development` → `In Development`
  - `passed` → `In Review - Passed` / `Passed` (no code changes)
  - `failed` → `In Review - Failed` / `Failed`
  - `blocked_by_human` → `Blocked`
- **Next**: `pr_test_automation_review`

### Test-automation review & rework

#### `pr_story_test_automation_review.json`
- **ContextId**: `pr_story_test_automation_review`
- **Ticket type**: `Story`
- **Pre-actions**: `checkWipLabel.js`, `prepareTestPRForReview.js`
- **Post-action**: `postStoryTestAutomationReview.js`
- **Outputs**: `outputs/pr_review.json`
- **Status moves**: `APPROVE` → `pr_approved`; changes → `test_pr_rework_needed`
- **Next**: `story_test_automation_merge` / `story_test_automation_rework`

#### `pr_bug_test_automation_review.json`
- **ContextId**: `pr_bug_test_automation_review`
- **Ticket type**: `Bug`
- **Pre-actions**: `checkWipLabel.js`, `prepareTestPRForReview.js`
- **Post-action**: `postStoryTestAutomationReview.js`
- **Next**: `bug_test_automation_merge` / `bug_test_automation_rework`

#### `pr_test_automation_review.json`
- **ContextId**: `pr_test_automation_review`
- **Ticket type**: `Test Case`
- **Pre-actions**: `checkWipLabel.js`, `prepareTestPRForReview.js`
- **Post-action**: `postStoryTestAutomationReview.js`
- **Next**: `retry_merge_test` / `pr_test_automation_rework`

#### `story_test_automation_rework.json` / `bug_test_automation_rework.json`
- **ContextId**: `story_test_automation_rework` / `bug_test_automation_rework`
- **Ticket type**: `Story` / `Bug`
- **Pre-actions**: `checkWipLabel.js`, `preCliStoryTestAutomationSetup.js`
- **Post-action**: `storyTestAutomationRework.js`
- **Outputs**: `outputs/response.md`, `outputs/review_replies.json`
- **Status moves**: stays `In Testing`, removes `test_pr_rework_needed`
- **Next**: review agent

#### `pr_test_automation_rework.json`
- **ContextId**: `pr_test_automation_rework`
- **Ticket type**: `Test Case`
- **Pre-actions**: `checkWipLabel.js`, `preCliStoryTestAutomationSetup.js`
- **Post-action**: `storyTestAutomationRework.js`
- **Next**: review agent

### Test-automation merge

#### `story_test_automation_merge.json`
- **ContextId**: `story_test_automation_merge`
- **Ticket type**: `Story`
- **Post-action**: `mergeStoryTestAutomationPR.js`
- **Status moves**: linked TCs finalized; Story stays `In Testing`
- **Next**: `story_done_check`

#### `bug_test_automation_merge.json`
- **ContextId**: `bug_test_automation_merge`
- **Ticket type**: `Bug`
- **Post-action**: `mergeStoryTestAutomationPR.js`
- **Status moves**: linked TCs finalized; Bug → `Done`
- **Next**: —

### Done / bug-to-fix checks

#### `story_done_check.json`
- **ContextId**: `story_done_check`
- **Ticket type**: `Story`
- **Post-action**: `checkStoryTestsPassed.js`
- **Status moves**:
  - all TCs `Passed`/`Skipped`/`Irrelevant` → `Done`
  - TCs with open bugs → `Bug To Fix`
  - failed TCs waiting bugs → wait
  - bugs Done → `Ready For Testing`
- **Next**: `Ready For Testing` → re-test; `Bug To Fix` → `bug_to_fix_check`

#### `bug_done_check.json`
- **ContextId**: `bug_done_check`
- **Ticket type**: `Bug`
- **Post-action**: `checkBugTestsPassed.js`
- **Status moves**: blocking TCs resolved → `Done`

#### `bug_to_fix_check.json`
- **ContextId**: `bug_to_fix_check`
- **Ticket type**: `Story` / `Test Case`
- **Post-action**: `checkBugToFixReady.js`
- **Status moves**:
  - Story + all linked Bugs Done → `Ready For Testing`
  - Test Case + all linked Bugs Done → `Backlog`
- **Next**: test automation

#### `task_done_check.json`
- **ContextId**: `task_done_check`
- **Ticket type**: `Task`
- **Post-action**: `checkTaskStoriesDone.js`
- **Status moves**: all linked Stories/Bugs Done → `Ready For Testing`

### Bug creation

#### `bulk_bugs_creation.json`
- **ContextId**: `bulk_bugs_creation`
- **Ticket type**: n/a (processes Failed TCs)
- **Pre-actions**: `prepareBulkBugsCreationContext.js`
- **Post-action**: `postBulkBugsCreation.js`
- **Outputs**: `outputs/bulk_bug_decisions.json`, `outputs/bug_*.md`
- **Status moves**: linked/new bug created → TC `Bug To Fix`; skipped → `Backlog`
- **Next**: `bug_to_fix_check`

#### `bug_creation.json`
- **ContextId**: `bug_creation`
- **Ticket type**: `Test Case`
- **Pre-actions**: `checkWipLabel.js`, `prepareBugCreationContext.js`
- **Post-action**: `postBugCreation.js`
- **Outputs**: `outputs/bug_decision.json`, `outputs/bug_description.md`
- **Status moves**: Failed TC → `Bug To Fix`
- **Next**: `bug_to_fix_check`

### Recovery agents

| Config | Post-action | Purpose | Status transitions |
|---|---|---|---|
| `recover_merged_pr.json` | `recoverMergedPRTicket.js` | Detect merged PRs with stale Jira status | `In Review`/`In Rework`/`Blocked` → `Merged` |
| `recover_stuck_test_case.json` | `recoverStuckTestCase.js` | Recover TCs stuck in `In Development` | no PR → `Backlog`; conflict → `In Rework`; clean → `In Review - Passed` |
| `recover_dirty_review_test_case.json` | `recoverDirtyReviewTestCase.js` | Detect dirty test PRs in review | `In Review - Passed/Failed` → `In Rework` |
| `recover_failed_tc_bug_status.json` | `recoverFailedTCBugStatus.js` | Move Failed TCs with open bugs to `Bug To Fix` | `Failed` → `Bug To Fix` |
| `unblock_resolved_dependencies.json` | `unblockResolvedDependencies.js` | Move `Blocked` tickets back when dependencies resolve | `Blocked` → `Backlog` |

### Reporting & watchdog

| Config | Script | Purpose | Outputs |
|---|---|---|---|
| `ai_teammate_token_usage_reporter.json` | `aiTeammateTokenUsageReporter.js` | Parse Copilot token summaries from workflow logs | `outputs/token_usage/*.{csv,json,html}` |
| `workflow_failure_reporter.json` | `workflowFailureReporter.js` | Watch failed GHA runs and create Jira Bugs | Jira Bugs labeled `ci-run-<runId>` |
| `df_manager.json` | `dfManager.js` | Audit labels/PRs/runs, detect stale work, auto-recover | `outputs/df_manager_report.json` |

---

## Generated

- Source: `agents/js/agentDocGenerator.js`
- Last updated: 2026-06-21
