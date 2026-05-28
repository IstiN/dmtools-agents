#!/usr/bin/env bash
# Install CodeGraph CLI via npm (@colbymchenry/codegraph).
#
# Usage:
#   codegraph.sh [version]                     # positional arg
#   CODEGRAPH_VERSION=0.9.6 codegraph.sh       # env override
#
# Version examples: 0.9.6, latest (default)
# Package: @colbymchenry/codegraph
# Cache path: ~/.npm-global
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

CODEGRAPH_VERSION="${1:-${CODEGRAPH_VERSION:-latest}}"
CODEGRAPH_PACKAGE="@colbymchenry/codegraph"
NPM_GLOBAL_BIN="${HOME}/.npm-global/bin"

echo "🛠  CodeGraph (${CODEGRAPH_PACKAGE})"

# Ensure npm uses our global prefix so the binary lands in ~/.npm-global/bin
npm config set prefix "${HOME}/.npm-global" 2>/dev/null || true

# ── Already installed? ────────────────────────────────────────────────────────
if command -v codegraph &>/dev/null; then
  VER="$(codegraph --version 2>/dev/null || echo "${CODEGRAPH_VERSION}")"
  echo "✅ CodeGraph already installed (cache hit): ${VER}"
  register_path "${NPM_GLOBAL_BIN}"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
if [ "${CODEGRAPH_VERSION}" = "latest" ] || [ -z "${CODEGRAPH_VERSION}" ]; then
  echo "📥 Installing CodeGraph (latest)..."
  npm install -g "${CODEGRAPH_PACKAGE}"
else
  echo "📥 Installing CodeGraph ${CODEGRAPH_VERSION}..."
  npm install -g "${CODEGRAPH_PACKAGE}@${CODEGRAPH_VERSION}"
fi

register_path "${NPM_GLOBAL_BIN}"
echo "✅ CodeGraph $(codegraph --version 2>/dev/null || echo "${CODEGRAPH_VERSION}")"
