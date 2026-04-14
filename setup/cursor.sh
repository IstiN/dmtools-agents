#!/usr/bin/env bash
# Check / validate cursor-agent availability.
# cursor-agent is part of the Cursor IDE and cannot be installed via script.
#
# Usage:
#   cursor.sh        # check and report status
#
# To use cursor as AI_AGENT_PROVIDER on CI, switch to 'copilot' or 'codemie' instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

echo "🖱  cursor-agent"

if is_installed cursor-agent; then
  echo "✅ cursor-agent available: $(cursor-agent --version 2>/dev/null || echo "present")"
else
  echo "⚠️  cursor-agent not found."
  echo ""
  echo "   cursor-agent ships with the Cursor IDE (https://www.cursor.com) and"
  echo "   cannot be installed via a script. It is intended for local development."
  echo ""
  echo "   On CI, use AI_AGENT_PROVIDER=copilot or AI_AGENT_PROVIDER=codemie instead."
  echo ""
  CI="$(detect_ci)"
  if [ "${CI}" != "local" ]; then
    echo "   ℹ️  Detected CI platform: ${CI} — cursor-agent will not work here."
  fi
fi
