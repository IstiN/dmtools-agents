#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Persist fa session to its git branch) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  if [ ! -d .dmtools/fa-sessions ] || \
     [ -z "$(find .dmtools/fa-sessions -type f -print -quit 2>/dev/null)" ]; then
    echo "no fa session to persist"
    exit 0
  fi
  git config user.name "dm.ai"
  git config user.email "dm.ai@epam.com"
  git fetch --depth 1 origin "refs/heads/$FA_SESS_BRANCH" || true
  SESS_SNAP="$(mktemp -d)"
  cp -a .dmtools/fa-sessions "$SESS_SNAP/"
  git switch --orphan "$FA_SESS_BRANCH" 2>/dev/null || git switch -C "$FA_SESS_BRANCH"
  rm -rf .dmtools/fa-sessions
  mkdir -p .dmtools
  cp -a "$SESS_SNAP/fa-sessions" .dmtools/
  rm -rf "$SESS_SNAP"
  git add -f .dmtools/fa-sessions
  if git diff --cached --quiet; then
    echo "fa session staged nothing (ignored/empty) — nothing to persist"
    exit 0
  fi
  git commit -m "fa sessions: GH-${ANCHOR} (${CONFIG}) [skip ci]"
  if git push origin "HEAD:$FA_SESS_BRANCH" --force; then
    echo "→ fa session persisted to $FA_SESS_BRANCH"
  else
    echo "::warning::fa session push rejected — session not persisted"
  fi
