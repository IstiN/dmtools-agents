#!/usr/bin/env bash
# Configures git to use tracked hooks in .githooks/ (applies to main clone + all worktrees).
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
git -C "$REPO_ROOT" config core.hooksPath .githooks
chmod +x "$REPO_ROOT/.githooks/pre-commit"
echo "Configured git core.hooksPath=.githooks in $REPO_ROOT"
