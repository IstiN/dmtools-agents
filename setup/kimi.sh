#!/usr/bin/env bash
# Install Kimi Code CLI (kimi).
#
# Usage:
#   kimi.sh [version]
#   KIMI_VERSION=latest kimi.sh
#
# Cache path: ~/.kimi-code/bin
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

KIMI_VERSION="${1:-${KIMI_VERSION:-}}"
KIMI_INSTALL_DIR="${HOME}/.kimi-code"
KIMI_BIN_DIR="${KIMI_INSTALL_DIR}/bin"

echo "🌙 Kimi Code CLI"

# ── Already installed? ────────────────────────────────────────────────────────
if is_installed kimi; then
  echo "✅ kimi already installed: $(kimi --version 2>/dev/null || echo "cached")"
  exit 0
fi

if [ -x "${KIMI_BIN_DIR}/kimi" ]; then
  register_path "${KIMI_BIN_DIR}"
  echo "✅ kimi already installed: ${KIMI_BIN_DIR}/kimi"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing kimi-code..."

mkdir -p "${KIMI_BIN_DIR}"

INSTALL_ENV=()
if [ -n "${KIMI_VERSION}" ]; then
  INSTALL_ENV+=(env "KIMI_VERSION=${KIMI_VERSION}")
fi
INSTALL_ENV+=(env "KIMI_NO_MODIFY_PATH=1")

"${INSTALL_ENV[@]}" bash -c 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'

if [ -x "${KIMI_BIN_DIR}/kimi" ]; then
  register_path "${KIMI_BIN_DIR}"
  echo "✅ kimi installed: ${KIMI_BIN_DIR}/kimi"
else
  echo "⚠️  kimi could not be installed automatically."
  echo "    Install manually: curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
fi
