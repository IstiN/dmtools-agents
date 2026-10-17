#!/usr/bin/env bash
# Extracted from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Restore fa session (resume the ticket conversation)) — stage-2 de-bloat.
# Engine-side since dmtools-agents#943 (the only source; shipped in the
# factory-setup zip). Invoke with `bash -e` (the GH runner default shell for
# inline `run:`); env block stays on the workflow step.
#
# gh-944 deviation from the a4cd62f byte-shape (first-session dev legs died
# 2/2 on #925, runs 38965689543 + its 01:01Z retry):
#   1. The fetch carries a FORCE DESTINATION refspec. The bare
#      `refs/heads/<branch>` refspec materializes NO
#      refs/remotes/origin/<branch> tracking ref in an actions/checkout
#      single-branch clone (remote.origin.fetch is pinned to the head
#      branch), so the checkout below failed to resolve the ref (rc 128
#      `fatal: invalid reference` on modern git) — or, where the ref did
#      resolve, hit a branch whose tree carries no store and died with the
#      gh-944 `error: pathspec '.dmtools/fa-sessions' did not match any
#      file(s) known to git`. Under `bash -e` either shape killed the leg.
#      `+` (force): persist force-pushes the branch.
#   2. The checkout is guarded by `git ls-tree`: a branch that exists but
#      carries no session store (the first-session shape — acceptance (a))
#      is a clean "starting fresh" no-op, never a pathspec error.
  if git fetch --depth 1 origin "+refs/heads/$FA_SESS_BRANCH:refs/remotes/origin/$FA_SESS_BRANCH"; then
    if [ -n "$(git ls-tree --name-only "refs/remotes/origin/$FA_SESS_BRANCH" -- .dmtools/fa-sessions)" ]; then
      git checkout "refs/remotes/origin/$FA_SESS_BRANCH" -- .dmtools/fa-sessions
      # Unstage (checkout <ref> -- <path> STAGES): the session store
      # belongs on the fa-sess branch only.
      git restore --staged .dmtools/fa-sessions
      echo "→ fa session restored from $FA_SESS_BRANCH"
    else
      echo "→ $FA_SESS_BRANCH carries no fa session store — starting fresh"
    fi
  else
    echo "→ no saved fa session yet ($FA_SESS_BRANCH absent) — starting fresh"
  fi
