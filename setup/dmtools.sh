#!/usr/bin/env bash
# Install DMtools CLI from epam/dm.ai.
#
# Usage:
#   dmtools.sh [version]                # positional arg
#   DMTOOLS_VERSION=v1.7.174 dmtools.sh # env override
#
# Version examples: v1.7.174 (default)
# Install source: https://raw.githubusercontent.com/epam/dm.ai/main/install
# Cache path: ~/.dmtools
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

DMTOOLS_VERSION="${1:-${DMTOOLS_VERSION:-v1.7.174}}"
DMTOOLS_HOME="${HOME}/.dmtools"
DMTOOLS_BIN="${DMTOOLS_HOME}/bin"

echo "🛠  DMtools ${DMTOOLS_VERSION}"

# ── Already installed? ────────────────────────────────────────────────────────
if [ -x "${DMTOOLS_BIN}/dmtools" ]; then
  echo "✅ DMtools already installed (cache hit): $(${DMTOOLS_BIN}/dmtools -v 2>/dev/null || echo "${DMTOOLS_VERSION}")"
  register_path "${DMTOOLS_BIN}"
  export_var "DMTOOLS_HOME" "${DMTOOLS_HOME}"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing DMtools ${DMTOOLS_VERSION}..."
curl -fsSL "https://raw.githubusercontent.com/epam/dm.ai/${DMTOOLS_VERSION}/install.sh" \
  | DMTOOLS_VERSION="${DMTOOLS_VERSION}" bash -s -- "${DMTOOLS_VERSION}"

register_path "${DMTOOLS_BIN}"
export_var "DMTOOLS_HOME" "${DMTOOLS_HOME}"

echo "✅ DMtools $(${DMTOOLS_BIN}/dmtools -v 2>/dev/null || echo "${DMTOOLS_VERSION}")"
