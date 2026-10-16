#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Hand the issue to the reviewer (dev runs only)) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  gh issue edit "$NUMBER" --repo "${GITHUB_REPOSITORY}" \
    --remove-label "agent:rework" || true
  gh issue edit "$NUMBER" --repo "${GITHUB_REPOSITORY}" \
    --remove-label "agent:review" || true
  gh issue edit "$NUMBER" --repo "${GITHUB_REPOSITORY}" \
    --add-label "agent:review"
  echo "→ labeled agent:review (agent:rework stripped) — pr_review run queued"
