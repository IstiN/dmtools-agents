---
name: df-manager
description: >
  Dark Factory manager runbook for monitoring Jira labels, GitHub Actions,
  open PRs, review/rework/merge loops, and recovering stuck automation.
  Use when tickets or PRs appear stuck, SM labels remain without active runs,
  CI fails after merge, or review/rework chains do not auto-start.
---

# DF Manager

DF Manager keeps a Dark Factory moving by cross-checking tracker state, source
control state, and workflow state. Do not trust one source alone: a Jira label,
a GitHub PR state, and an Actions run must agree before declaring a chain healthy.

## Deterministic auditor

Run the JS auditor first:

```bash
dmtools run agents/df_manager.json
```

It writes:

```text
outputs/df_manager_report.json
```

Default mode is read-only audit. To allow only safe recovery actions:

```bash
dmtools run agents/df_manager.json "$(python3 - <<'PY'
import json, urllib.parse
print(urllib.parse.quote(json.dumps({
  "params": {
    "customParams": {
      "autoRecover": True
    }
  }
})))
PY
)"
```

Safe recovery is intentionally narrow:

- Remove stale `sm_*_triggered` labels when no active workflow run references
  the ticket and the label is older than the configured stale window.
- Trigger `sm.yml` after releasing a stale lock or finding an approved clean PR
  that did not merge.
- Request a GitHub PR branch update when an approved PR is only `behind`.

Anything else is a human/agent investigation, not automatic mutation.

## Signals to inspect

Always collect all three layers:

1. **Jira**: key, summary, status, labels, updated time.
2. **GitHub PRs**: open PRs, head branch, title, merge state, checks, labels,
   review decision, last comments.
3. **GitHub Actions**: active runs, failed runs, run titles, branches, workflow
   names, URLs, failed job logs.

Useful Jira query:

```jql
project = TS
AND labels in (
  sm_story_review_triggered,
  sm_story_rework_triggered,
  sm_test_automation_triggered,
  sm_test_review_triggered,
  sm_test_rework_triggered,
  sm_bug_development_triggered,
  sm_bug_creation_triggered
)
ORDER BY updated ASC
```

Useful failed-test-case query:

```jql
project = TS
AND issuetype = "Test Case"
AND status = "Failed"
ORDER BY updated ASC
```

## Anomaly patterns

### Stale SM trigger label

Symptoms:

- Jira has `sm_*_triggered`.
- No active Actions run title/branch contains the ticket key.
- Ticket status is still in the source state for that rule.

Action:

1. Read the latest run history for the ticket.
2. If no run is active and the last run has finished or failed, remove only the
   stale SM label.
3. Trigger `sm.yml`.
4. Post a Jira comment if manual recovery was needed.

### Approved clean PR did not merge

Symptoms:

- PR is open.
- PR is `CLEAN` / mergeable.
- Jira or PR has `pr_approved`.
- No merge run is active.

Action:

1. Trigger `sm.yml` or the retry-merge job.
2. If it still does not merge, inspect branch protection and required checks.

### Rework failed to push

Common root causes:

- Dirty `agents` submodule.
- Branch mismatch after CLI work.
- Generated changes only inside a managed submodule.
- Commit failed because changes were not staged.

Action:

1. Inspect Jira comment and failed run logs.
2. Check PR branch diff and submodule diff.
3. Fix the shared agent if the failure is systemic.
4. Rewrite the PR branch only when the root cause and desired diff are clear.
5. Move the ticket back to `In Review`, remove rework SM label, and trigger SM.

### Missing output file leaves lock behind

Symptoms:

- Agent run is successful or failed after reporting missing
  `outputs/test_automation_result.json` or `outputs/pr_review.json`.
- Jira still has the SM trigger label.

Action:

1. Fix the post action to release the label on missing output.
2. Add a regression unit test.
3. Remove stale label for affected tickets and trigger SM.

### Failed test queue blocked by first stuck ticket

Symptoms:

- The failed test case rule uses a low `limit` such as `1`.
- One of the oldest failed test cases still has `sm_bug_creation_triggered`.
- SM keeps scanning the same failed ticket and never reaches the rest of the
  failed queue.
- The latest ticket comments or run logs show an early bug-creation failure such
  as missing `outputs/bug_decision.json` or a decision without a bug summary.

Action:

1. Query all failed test cases and count how many still have
   `sm_bug_creation_triggered`.
2. Inspect the oldest blocked failed ticket first; with a small `limit`, that
   one ticket can starve the whole queue.
3. Verify there is no active run for that ticket before removing only the stale
   `sm_bug_creation_triggered` label.
4. Fix the shared post action so early bug-creation failures also clear the SM
   trigger label, then add a regression unit test.
5. Trigger `sm.yml` and monitor until the blocked count returns to `0` and the
   previously stuck failed ticket advances to `Bug To Fix` or gets a linked bug.

### Main CI failed after merge

Symptoms:

- PR merged.
- Main `Flutter CI` / required pipeline failed.
- Subsequent PRs become noisy or blocked.

Action:

1. Treat this as a factory blocker.
2. Open a small fix PR against `main`.
3. Merge after required checks.
4. Confirm the main push pipeline succeeds.

## Guardrails

- Never remove a trigger label while a matching run is active.
- Never force-push a PR branch unless the existing branch is understood and the
  resulting diff is intentionally smaller/correcter.
- Do not auto-move Jira status based on labels alone; verify PR/run state.
- Do not swallow failures: every recovery action should be visible in Jira, PR,
  run logs, or `outputs/df_manager_report.json`.
- Prefer fixing the shared agent over manually unblocking the same pattern more
  than once.

## Useful commands

Open PRs:

```bash
gh -R OWNER/REPO pr list --state open --limit 100 \
  --json number,title,headRefName,mergeStateStatus,reviewDecision,labels,updatedAt,url
```

Active and recent failed runs:

```bash
gh -R OWNER/REPO run list --limit 100 \
  --json databaseId,displayTitle,status,conclusion,workflowName,headBranch,createdAt,url
```

Failed run logs:

```bash
gh -R OWNER/REPO run view RUN_ID --log-failed
```

Manual SM trigger:

```bash
gh -R OWNER/REPO workflow run sm.yml
```

Quick failed-test queue audit:

```bash
dmtools jira_search_by_jql \
  "project = TS AND issuetype = 'Test Case' AND status = 'Failed' ORDER BY updated ASC"
```

Factory watch loop:

```bash
while true; do
  date -u
  dmtools jira_search_by_jql \
    "project = TS AND issuetype = 'Test Case' AND status = 'Failed' AND labels = sm_bug_creation_triggered ORDER BY updated ASC"
  gh -R OWNER/REPO run list --limit 20 \
    --json displayTitle,status,conclusion,workflowName,headBranch,url
  sleep 300
done
```
