#!/usr/bin/env bash
# Install Node.js.
#
# Usage:
#   node.sh [version]          # major version number
#   NODE_VERSION=20 node.sh    # env override
#
# Version examples: 20, 22, lts  (default: 20)
# Cache path: ~/.nvm
#
# Runner support:
#   GHA ubuntu/macos  — Node pre-installed; uses nvm if version mismatch
#   Bitrise Linux     — Node pre-installed; uses nvm if version mismatch
#   Bitrise Mac       — brew or nvm fallback
#   Local             — nvm
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

NODE_VERSION="${1:-${NODE_VERSION:-20}}"
OS="$(detect_os)"
NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"

echo "🟩 Node.js ${NODE_VERSION} [OS=${OS} CI=$(detect_ci)]"

# ── Helper: check if current node matches requested major version ─────────────
_node_version_ok() {
  if ! is_installed node; then return 1; fi
  local current_major
  current_major="$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)"
  # Handle "lts" by accepting any even major >= 18
  if [ "${NODE_VERSION}" = "lts" ]; then
    [ "$(( current_major % 2 ))" -eq 0 ] && [ "${current_major}" -ge 18 ]
  else
    [ "${current_major}" = "${NODE_VERSION}" ]
  fi
}

# ── Priority 1: Node already at the right version on PATH ────────────────────
if _node_version_ok; then
  echo "✅ Node.js already at $(node --version) (no install needed)"
  register_path "$(dirname "$(which node)")"
  export_var "NODE_VERSION" "$(node --version | sed 's/v//' | cut -d. -f1)"
  exit 0
fi

# ── Priority 2: nvm already has the version ───────────────────────────────────
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  export NVM_DIR
  # shellcheck source=/dev/null
  source "${NVM_DIR}/nvm.sh" --no-use 2>/dev/null || source "${NVM_DIR}/nvm.sh"
  if nvm ls "${NODE_VERSION}" &>/dev/null 2>&1; then
    echo "✅ Node.js ${NODE_VERSION} in nvm cache"
    nvm use "${NODE_VERSION}"
    nvm alias default "${NODE_VERSION}"
    register_path "$(dirname "$(nvm which "${NODE_VERSION}")")"
    export_var "NODE_VERSION" "${NODE_VERSION}"
    echo "✅ $(node --version) · npm $(npm --version)"
    exit 0
  fi
fi

# ── Priority 3: Install via nvm ───────────────────────────────────────────────
echo "📥 Installing Node.js ${NODE_VERSION} via nvm..."

if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
  echo "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi

export NVM_DIR
# shellcheck source=/dev/null
source "${NVM_DIR}/nvm.sh"

nvm install "${NODE_VERSION}"
nvm use "${NODE_VERSION}"
nvm alias default "${NODE_VERSION}"

register_path "$(dirname "$(nvm which "${NODE_VERSION}")")"
export_var "NODE_VERSION" "${NODE_VERSION}"

echo "✅ $(node --version) · npm $(npm --version)"

