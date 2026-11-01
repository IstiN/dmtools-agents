#!/usr/bin/env bash
# Extracted from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Hand the issue to the reviewer (dev runs only)) — stage-2 de-bloat.
# Invoke with `bash -e` (the GH runner default shell for inline `run:`);
# env block stays on the workflow step.
#
# gh-1156 (live fa#1735): non-PR dev outcomes (blocked_without_codegraph →
# status:Ready For Development, blocked → status:Blocked, development-reset-
# for-retry, no-changes-needed) return exit 0 from dmtools without opening a
# PR. Only stamp agent:review when the issue still sits in status:In Review
# or carries ai_developed (never when reset to Ready For Development or moved
# to Blocked/Done).
#
# Ask-mode (no-assumptions rule): a ticket flagged ai_questions_asked is
# waiting on the reporter — the dev leg ended green WITHOUT a PR, so there
# is nothing to review and arming the reviewer only queues a PR-less review
# leg that fails and strips the label.
has_q="$(gh issue view "$NUMBER" --repo "${GITHUB_REPOSITORY}" --json labels -q '([.labels[].name] | index("ai_questions_asked")) != null' 2>/dev/null || echo false)"
if [ "$has_q" = "true" ]; then
  echo "→ ticket #$NUMBER carries ai_questions_asked — waiting for human input, no review hand-off"
  exit 0
fi
gh issue edit "$NUMBER" --repo "${GITHUB_REPOSITORY}" \
    --remove-label "agent:rework" || true
  gh issue edit "$NUMBER" --repo "${GITHUB_REPOSITORY}" \
    --remove-label "agent:review" || true
  ISSUE_LABELS="$(gh issue view "$NUMBER" --repo "${GITHUB_REPOSITORY}" \
    --json labels --jq '[.labels[].name] | join("\n")' 2>/dev/null || true)"
  if printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "status:Ready For Development" \
    || printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "status:Blocked" \
    || printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "status:Done" \
    || printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "blocked"; then
    echo "→ dev leg ended without review handoff (${ISSUE_LABELS//$'\n'/, }) — skipping agent:review (gh-1156)"
    exit 0
  fi
  if [ -n "$ISSUE_LABELS" ] \
    && ! printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "ai_developed" \
    && ! printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "status:In Review"; then
    echo "→ dev leg did not reach In Review / ai_developed (${ISSUE_LABELS//$'\n'/, }) — skipping agent:review (gh-1156)"
    exit 0
  fi
  gh issue edit "$NUMBER" --repo "${GITHUB_REPOSITORY}" \
    --add-label "agent:review"
  echo "→ labeled agent:review (agent:rework stripped) — pr_review run queued"
