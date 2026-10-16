#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Close the rework cycle (rework runs only)) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  if [ -n "$PR_NUMBER" ]; then
    gh pr edit "$PR_NUMBER" --repo "${GITHUB_REPOSITORY}" \
      --remove-label "agent:rework" || true
    echo "→ rework cycle closed (agent:rework removed from PR #$PR_NUMBER)"
  else
    gh issue edit "$NUMBER" --repo "${GITHUB_REPOSITORY}" \
      --remove-label "agent:rework" || true
    echo "→ rework cycle closed (agent:rework removed)"
  fi
