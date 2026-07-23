#!/usr/bin/env bash
# Install Cursor Agent CLI.
# Requires CURSOR_API_KEY at runtime on CI (auth is not handled here).
#
# Usage:
#   cursor.sh
#
# Cache path: ~/.cursor
# Binary: agent or cursor-agent in ~/.local/bin / ~/.cursor/bin
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

CURSOR_HOME="${HOME}/.cursor"
CURSOR_LOCAL_BIN="${HOME}/.local/bin"
CURSOR_BIN_DIR="${CURSOR_HOME}/bin"

echo "🖱  Cursor Agent CLI"

_ensure_cursor_agent_symlink() {
  if command -v agent >/dev/null 2>&1 && ! command -v cursor-agent >/dev/null 2>&1; then
    mkdir -p "${CURSOR_LOCAL_BIN}"
    ln -sf "$(command -v agent)" "${CURSOR_LOCAL_BIN}/cursor-agent"
  fi
}

# ── Register bin dirs (before install check, like copilot.sh) ────────────────
mkdir -p "${CURSOR_LOCAL_BIN}"
register_path "${CURSOR_LOCAL_BIN}"
register_path "${CURSOR_BIN_DIR}"

# ── Already installed? ────────────────────────────────────────────────────────
if is_installed cursor-agent; then
  echo "✅ cursor-agent already installed: $(cursor-agent --version 2>/dev/null || echo 'present')"
  exit 0
fi
if is_installed agent; then
  _ensure_cursor_agent_symlink
  echo "✅ agent already on PATH: $(agent --version 2>/dev/null || echo 'present')"
  exit 0
fi
if [ -x "${CURSOR_BIN_DIR}/agent" ] || [ -x "${CURSOR_LOCAL_BIN}/agent" ]; then
  _ensure_cursor_agent_symlink
  echo "✅ Cursor Agent CLI already installed (cached)"
  exit 0
fi

# ── Prerequisite ─────────────────────────────────────────────────────────────
if ! is_installed curl; then
  echo "❌ curl not found. Install curl first (apt-get install -y curl on CI)." >&2
  exit 1
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing Cursor Agent CLI..."
curl https://cursor.com/install -fsS | bash

_ensure_cursor_agent_symlink

if is_installed cursor-agent || is_installed agent; then
  echo "✅ Cursor Agent CLI $(cursor-agent --version 2>/dev/null || agent --version 2>/dev/null || echo 'installed')"
else
  echo "❌ cursor-agent not found after install" >&2
  exit 1
fi
