#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Persist fa project memory into the repository) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  bash "${RUNNER_TEMP}/factory-kit/kit/install-source-git-credentials.sh" 2>/dev/null \
    || bash "${FACTORY_ROOT}/setup/install-source-git-credentials.sh"
  echo "── post-agent extraheader trace (must be empty) ──"
  git config --show-origin --get-all http.https://github.com/.extraheader | sed -E 's/^([^\t]*\t).*/\1<redacted>/; t; s/.+/<redacted> (unexpected line without origin)/' || true
  if git config --get-all http.https://github.com/.extraheader | grep -q .; then
    echo "::error::App-token extraheader reappeared after the agent session — a mid-run re-assertion would push as github-actions[bot]"
    exit 1
  fi
  if [ -d .fah/memory ] && [ -n "$(git status --porcelain -- .fah/memory)" ]; then
    git add .fah/memory
    git commit -m "chore(fa): persist agent project memory [skip ci]"
    git push || echo "::warning::memory push rejected (protected branch?) — kept in run only"
  else
    echo "no new fa memory to persist"
  fi
  if [ -f .dmtools/credential-helper.log ]; then
    echo "── SOURCE_GITHUB_TOKEN helper invocations this run ──"
    cat .dmtools/credential-helper.log
  fi
