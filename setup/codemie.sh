#!/usr/bin/env bash
# Install codemie-claude CLI.
# Requires CODEMIE_API_KEY and CODEMIE_BASE_URL to be set at runtime.
#
# Usage:
#   codemie.sh [version]
#   CODEMIE_VERSION=latest codemie.sh
#
# Cache path: ~/.local/bin (Linux) or ~/.codemie (fallback)
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

CODEMIE_VERSION="${1:-${CODEMIE_VERSION:-latest}}"
CODEMIE_BIN_DIR="${HOME}/.local/bin"

echo "🧠 codemie-claude ${CODEMIE_VERSION}"

# ── Already installed? ────────────────────────────────────────────────────────
if is_installed codemie-claude; then
  echo "✅ codemie-claude already installed: $(codemie-claude --version 2>/dev/null || echo "cached")"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
OS="$(detect_os)"
echo "📥 Installing codemie-claude..."

mkdir -p "${CODEMIE_BIN_DIR}"

# Try pip first (Python package)
if is_installed pip3; then
  if [ "${CODEMIE_VERSION}" = "latest" ]; then
    pip3 install --quiet codemie-claude 2>/dev/null \
      || pip3 install --quiet --user codemie-claude 2>/dev/null \
      || true
  else
    pip3 install --quiet "codemie-claude==${CODEMIE_VERSION}" 2>/dev/null \
      || pip3 install --quiet --user "codemie-claude==${CODEMIE_VERSION}" 2>/dev/null \
      || true
  fi
fi

# Try binary download as fallback
if ! is_installed codemie-claude; then
  ARCH="$(uname -m)"
  BIN_NAME="codemie-claude"
  case "${OS}-${ARCH}" in
    macos-arm64|macos-aarch64) PLATFORM="darwin-arm64" ;;
    macos-x86_64)              PLATFORM="darwin-amd64" ;;
    linux-x86_64)              PLATFORM="linux-amd64"  ;;
    linux-arm64|linux-aarch64) PLATFORM="linux-arm64"  ;;
    *) PLATFORM="" ;;
  esac

  if [ -n "${PLATFORM}" ]; then
    TAG="${CODEMIE_VERSION}"
    [ "${TAG}" = "latest" ] && TAG="$(curl -fsSL https://api.github.com/repos/codemie-ai/codemie-claude/releases/latest | grep '"tag_name"' | cut -d'"' -f4 2>/dev/null || echo "")"
    if [ -n "${TAG}" ]; then
      curl -fsSL \
        "https://github.com/codemie-ai/codemie-claude/releases/download/${TAG}/${BIN_NAME}-${PLATFORM}" \
        -o "${CODEMIE_BIN_DIR}/codemie-claude" 2>/dev/null \
        && chmod +x "${CODEMIE_BIN_DIR}/codemie-claude" || true
    fi
  fi
fi

if is_installed codemie-claude || [ -x "${CODEMIE_BIN_DIR}/codemie-claude" ]; then
  register_path "${CODEMIE_BIN_DIR}"
  echo "✅ codemie-claude installed"
else
  echo "⚠️  codemie-claude could not be installed automatically."
  echo "    Set CODEMIE_API_KEY + CODEMIE_BASE_URL and install manually if needed."
fi
