#!/usr/bin/env bash
# Install @github/copilot CLI via npm.
#
# Usage:
#   copilot.sh [version]         # npm version tag
#   COPILOT_VERSION=latest copilot.sh
#
# Runner support:
#   All platforms with npm available (run node.sh first if needed).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

COPILOT_VERSION="${1:-${COPILOT_VERSION:-latest}}"

echo "🤖 GitHub Copilot CLI ${COPILOT_VERSION}"

# ── Ensure npm is available ───────────────────────────────────────────────────
if ! is_installed npm; then
  echo "❌ npm not found. Run node.sh first." >&2; exit 1
fi

# ── Resolve npm global bin directory ─────────────────────────────────────────
# nvm-managed node: do NOT override npm prefix (nvm manages it internally).
# System node or unknown: set a stable prefix so binaries land in a predictable location.
if [ -s "${NVM_DIR:-${HOME}/.nvm}/nvm.sh" ] && [ -n "${NVM_BIN:-}" ]; then
  # nvm is active → use its built-in global bin
  NPM_GLOBAL_BIN="${NVM_BIN}"
else
  # System node: use ~/.npm-global
  NPM_GLOBAL="${HOME}/.npm-global"
  NPM_GLOBAL_BIN="${NPM_GLOBAL}/bin"
  mkdir -p "${NPM_GLOBAL_BIN}"
  npm config set prefix "${NPM_GLOBAL}" 2>/dev/null || true
fi

# Register the bin dir BEFORE checking if copilot is already installed there.
register_path "${NPM_GLOBAL_BIN}"

# ── Already installed? ────────────────────────────────────────────────────────
if [ -x "${NPM_GLOBAL_BIN}/copilot" ]; then
  echo "✅ GitHub Copilot CLI already installed: $("${NPM_GLOBAL_BIN}/copilot" --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi
# Also check plain 'copilot' on PATH (installed globally some other way)
if is_installed copilot && copilot --version &>/dev/null 2>&1; then
  echo "✅ GitHub Copilot CLI already on PATH: $(copilot --version)"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing @github/copilot@${COPILOT_VERSION}..."
npm install -g "@github/copilot@${COPILOT_VERSION}"

echo "✅ GitHub Copilot CLI $(copilot --version 2>/dev/null || echo 'installed')"
