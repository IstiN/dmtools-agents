#!/usr/bin/env bash
# Install Maestro mobile testing framework.
#
# Usage:
#   maestro.sh [version]              # positional arg — passed to installer
#   MAESTRO_VERSION=1.40.0 maestro.sh # env override
#
# Version: optional; omit for latest  (default: latest)
# Cache path: ~/.maestro
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

MAESTRO_VERSION="${1:-${MAESTRO_VERSION:-}}"  # empty = latest
MAESTRO_HOME="${HOME}/.maestro"
MAESTRO_BIN="${MAESTRO_HOME}/bin"

echo "🎭 Maestro ${MAESTRO_VERSION:-latest}"

# ── Already installed? ────────────────────────────────────────────────────────
if [ -x "${MAESTRO_BIN}/maestro" ]; then
  INSTALLED="$("${MAESTRO_BIN}/maestro" --version 2>/dev/null || echo "cached")"
  echo "✅ Maestro already installed (cache hit): ${INSTALLED}"
  register_path "${MAESTRO_BIN}"
  export_var "MAESTRO_HOME" "${MAESTRO_HOME}"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing Maestro${MAESTRO_VERSION:+ ${MAESTRO_VERSION}}..."

if [ -n "${MAESTRO_VERSION}" ]; then
  # Install specific version
  curl -fsSL "https://get.maestro.mobile.dev" | MAESTRO_VERSION="${MAESTRO_VERSION}" bash
else
  curl -fsSL "https://get.maestro.mobile.dev" | bash
fi

register_path "${MAESTRO_BIN}"
export_var "MAESTRO_HOME" "${MAESTRO_HOME}"

echo "✅ Maestro $("${MAESTRO_BIN}/maestro" --version 2>/dev/null || echo "installed")"
