#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Restore fa session (resume the ticket conversation)) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  if git fetch --depth 1 origin "refs/heads/$FA_SESS_BRANCH"; then
    git checkout "refs/remotes/origin/$FA_SESS_BRANCH" -- .dmtools/fa-sessions
    # Unstage (checkout <ref> -- <path> STAGES): the session store
    # belongs on the fa-sess branch only.
    git restore --staged .dmtools/fa-sessions
    echo "→ fa session restored from $FA_SESS_BRANCH"
  else
    echo "→ no saved fa session yet ($FA_SESS_BRANCH absent) — starting fresh"
  fi
