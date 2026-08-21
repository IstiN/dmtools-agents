#!/usr/bin/env bash
# Install the Fa CLI (fa) — Dart-based AI agent harness.
#
# Usage:
#   fa.sh [version]        (version is accepted for install.sh symmetry; the
#                           upstream installer always fetches the latest)
#   FA_INSTALL_DIR=... fa.sh
#
# Install: https://fa1.dev/install.sh (binary lands in ~/.local/bin by
# default). Cache path: ~/.local/bin
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

FA_BIN_DIR="${FA_INSTALL_DIR:-${HOME}/.local/bin}"

# ── Configure the deterministic session for AI Teammate runs ─────────────────
_configure_session() {
  if [ -z "${AI_TEAMMATE_CONFIG_FILE:-}" ]; then
    return 0
  fi
  if [ -f "${SCRIPT_DIR}/fa-session.sh" ]; then
    # shellcheck source=/dev/null
    source "${SCRIPT_DIR}/fa-session.sh" env
  fi
}

echo "⚡ Fa CLI"

# ── Already installed? ────────────────────────────────────────────────────────
if is_installed fa || is_installed fah; then
  echo "✅ fa already installed: $(fa --version 2>/dev/null || fah --version 2>/dev/null || echo "cached")"
  register_path "${FA_BIN_DIR}"
  _configure_session
  exit 0
fi

if [ -x "${FA_BIN_DIR}/fa" ]; then
  register_path "${FA_BIN_DIR}"
  echo "✅ fa already installed: ${FA_BIN_DIR}/fa"
  _configure_session
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing fa..."

FA_INSTALL_DIR="${FA_BIN_DIR}" bash -c \
  'curl -fsSL "https://fa1.dev/install.sh?v=2" | sh'

if [ -x "${FA_BIN_DIR}/fa" ]; then
  register_path "${FA_BIN_DIR}"
  echo "✅ fa installed: ${FA_BIN_DIR}/fa"
  _configure_session
else
  echo "⚠️  fa could not be installed automatically."
  echo "    Install manually: curl -fsSL \"https://fa1.dev/install.sh?v=2\" | sh"
fi
