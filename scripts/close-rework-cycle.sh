#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Close the rework cycle (rework runs only)) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  repo="${GITHUB_REPOSITORY}"
  resolve_linked_issue_from_pr() {
    gh pr view "$1" --repo "$repo" --json body,headRefName --jq '
      ((.body // "") | (try capture("(?i)\\b(closes|fixes|resolves)\\s+#(?<n>[0-9]+)\\b").n catch empty))
      // ((.headRefName // "") | (try capture("(^|[-_./])gh-0*(?<n>[0-9]+)$").n catch empty))
      // empty' 2>/dev/null || true
  }
  resolve_linked_pr_from_issue() {
    gh pr list --repo "$repo" --state open --json number,body,headRefName --jq '
      [.[] | select(
          ((.body // "") | test("(?i)\\b(closes|fixes|resolves)\\s+#'"$1"'\\b"))
          or (.headRefName | test("^'"$1"'[-_.]"))
          or (.headRefName | test("(^|[-_./])gh-0*'"$1"'$")))
        | .number] | first // empty' 2>/dev/null || true
  }
  if [ -n "${PR_NUMBER:-}" ]; then
    gh pr edit "$PR_NUMBER" --repo "$repo" \
      --remove-label "agent:rework" || true
    linked_issue="${NUMBER:-$(resolve_linked_issue_from_pr "$PR_NUMBER")}"
    if [ -n "$linked_issue" ]; then
      gh issue edit "$linked_issue" --repo "$repo" \
        --remove-label "agent:rework" || true
    fi
    echo "→ rework cycle closed (agent:rework removed from PR #$PR_NUMBER${linked_issue:+ and issue #$linked_issue})"
  elif [ -n "${NUMBER:-}" ]; then
    gh issue edit "$NUMBER" --repo "$repo" \
      --remove-label "agent:rework" || true
    linked_pr="$(resolve_linked_pr_from_issue "$NUMBER")"
    if [ -n "$linked_pr" ]; then
      gh pr edit "$linked_pr" --repo "$repo" \
        --remove-label "agent:rework" || true
    fi
    echo "→ rework cycle closed (agent:rework removed${linked_pr:+ from issue #$NUMBER and PR #$linked_pr})"
  fi
