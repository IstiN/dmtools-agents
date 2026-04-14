#!/usr/bin/env bash
# Install one or more tools. Version can be pinned per tool with a colon.
# Compatible with bash 3.2+ (macOS system bash).
#
# Usage:
#   install.sh tool1[:version] tool2[:version] ...
#   install.sh all                          # install all tools
#   install.sh all -tool1 -tool2            # install all except listed
#
# Examples:
#   install.sh dmtools maestro copilot
#   install.sh java:17 dmtools:v1.7.167 node:20 maestro copilot
#   install.sh all
#   install.sh all -cursor -codemie
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

# Canonical order for "all" (node before copilot, java before dmtools)
ALL_TOOLS="java node dmtools maestro copilot codemie cursor"

if [ $# -eq 0 ]; then
  echo "Usage: install.sh tool1[:version] tool2[:version] ..."
  echo "       install.sh all [-tool ...]"
  echo ""
  echo "Supported tools (in install order):"
  echo "  java      — Java (Temurin/OpenJDK). Default version: 17"
  echo "  node      — Node.js via nvm.         Default version: 20"
  echo "  dmtools   — DMtools CLI.             Default version: v1.7.170"
  echo "  maestro   — Maestro mobile testing.  Default version: latest"
  echo "  copilot   — @github/copilot npm CLI. Default version: latest  (needs node)"
  echo "  codemie   — codemie-claude CLI.      Default version: latest"
  echo "  cursor    — cursor-agent (check only; cannot be auto-installed)"
  echo ""
  echo "Examples:"
  echo "  install.sh dmtools maestro copilot"
  echo "  install.sh java:17 dmtools:v1.7.170 node:20 maestro copilot"
  echo "  install.sh all"
  echo "  install.sh all -cursor -codemie"
  exit 0
fi

# ── Resolve tool list ─────────────────────────────────────────────────────────
# bash 3.2 compatible: no associative arrays.
# Store version overrides as "tool=version" entries in a plain string.

VERSIONS=""   # space-separated "tool=version" pairs
EXCLUDE=""
EXPLICIT_TOOLS=""
USE_ALL=false

# Helper: get version override for a tool (bash 3.2 safe)
get_version() {
  local tool="$1"
  echo "${VERSIONS}" | tr ' ' '\n' | grep "^${tool}=" | cut -d= -f2 | head -1
}

for arg in "$@"; do
  if [ "${arg}" = "all" ]; then
    USE_ALL=true
  elif [ "${arg#-}" != "${arg}" ]; then
    # Exclusion: -cursor or --cursor → strip leading dashes
    stripped="${arg}"
    stripped="${stripped#--}"
    stripped="${stripped#-}"
    EXCLUDE="${EXCLUDE} ${stripped}"
  else
    TOOL_NAME="${arg%%:*}"
    TOOL_VERSION="${arg#*:}"
    [ "${TOOL_VERSION}" = "${TOOL_NAME}" ] && TOOL_VERSION=""
    EXPLICIT_TOOLS="${EXPLICIT_TOOLS} ${TOOL_NAME}"
    [ -n "${TOOL_VERSION}" ] && VERSIONS="${VERSIONS} ${TOOL_NAME}=${TOOL_VERSION}"
  fi
done

if $USE_ALL; then
  TOOL_LIST="${ALL_TOOLS}"
else
  TOOL_LIST="${EXPLICIT_TOOLS}"
fi

# ── Run installs ──────────────────────────────────────────────────────────────
INSTALLED=0
SKIPPED=0

for tool in ${TOOL_LIST}; do
  # Apply exclusions
  if echo " ${EXCLUDE} " | grep -qw "${tool}"; then
    echo "⏭  Skipping ${tool} (excluded)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if ! echo "${ALL_TOOLS}" | grep -qw "${tool}"; then
    echo "❌ Unknown tool: '${tool}'. Supported: ${ALL_TOOLS}" >&2
    exit 1
  fi

  SCRIPT="${SCRIPT_DIR}/${tool}.sh"
  if [ ! -f "${SCRIPT}" ]; then
    echo "❌ Script not found: ${SCRIPT}" >&2
    exit 1
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  VERSION="$(get_version "${tool}")"
  if [ -n "${VERSION}" ]; then
    bash "${SCRIPT}" "${VERSION}"
  else
    bash "${SCRIPT}"
  fi
  INSTALLED=$((INSTALLED + 1))
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Done: ${INSTALLED} installed, ${SKIPPED} skipped"
