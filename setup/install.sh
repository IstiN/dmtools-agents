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
#   install.sh dmtools maestro copilot playwright
#   install.sh java:17 dmtools:v1.7.195 node:20 maestro copilot playwright
#   install.sh all
#   install.sh all -cursor -codemie -kimi
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

# Canonical order for "all" (node before copilot, java before dmtools)
ALL_TOOLS="java maven node dmtools maestro copilot codemie cursor codegraph playwright kimi gradle android emulator konan"

if [ $# -eq 0 ]; then
  echo "Usage: install.sh tool1[:version] tool2[:version] ..."
  echo "       install.sh all [-tool ...]"
  echo ""
  echo "Supported tools (in install order):"
  echo "  java      — Java (Temurin/OpenJDK). Default version: 17"
  echo "  maven     — Apache Maven.            Default version: 3.9.9"
  echo "  node      — Node.js via nvm.         Default version: 20"
  echo "  dmtools   — DMtools CLI.             Default version: v1.7.228"
  echo "  maestro   — Maestro mobile testing.  Default version: latest"
  echo "  copilot   — @github/copilot npm CLI. Default version: latest  (needs node)"
  echo "  codemie   — codemie-claude CLI.      Default version: latest"
  echo "  cursor    — cursor-agent (check only; cannot be auto-installed)"
  echo "  codegraph — CodeGraph CLI (npm).     Default version: latest"
  echo "  playwright — Playwright + Chromium.  Default version: latest"
  echo "  kimi      — Kimi Code CLI.           Default version: latest"
  echo "  gradle    — Gradle wrapper pre-warm. Default version: (wrapper version)"
  echo "  android   — Android SDK cmdline.     Default compileSdk: 36"
  echo "  emulator  — Android AVD create+boot. Default: agent_avd, API 35, arch-matched ABI (needs android)"
  echo "  konan     — Kotlin/KMP native toolchain pre-warm"
  echo ""
  echo "Examples:"
  echo "  install.sh dmtools maestro copilot playwright"
  echo "  install.sh java:17 dmtools:v1.7.195 node:20 maestro copilot playwright"
  echo "  install.sh all"
  echo "  install.sh all -cursor -codemie -kimi"
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
  # Auto-inject node before any npm-dependent tools (copilot, codemie, codegraph)
  # if node is not already in the list
  NEEDS_NODE=false
  for _t in ${TOOL_LIST}; do
    case "${_t}" in copilot|codemie|codegraph) NEEDS_NODE=true; break ;; esac
  done
  if $NEEDS_NODE && ! echo " ${TOOL_LIST} " | grep -qw "node"; then
    TOOL_LIST="node ${TOOL_LIST}"
    echo "ℹ️  Auto-injecting node (required by npm-based tool)"
  fi
fi

# ── Run installs ──────────────────────────────────────────────────────────────
INSTALLED=0
SKIPPED=0

# Each tool below runs as its own `bash "${SCRIPT}"` subprocess, so a
# register_path call made INSIDE one tool's script (e.g. node.sh registering
# its nvm-installed bin dir) only updates that subprocess's own PATH and
# /tmp/_registered_paths — it can never propagate back into install.sh's own
# PATH by itself. Re-reading /tmp/_registered_paths after every tool (not
# just once before/after the whole loop) is what makes a later tool in the
# SAME install.sh run (e.g. copilot, which needs npm) actually see an
# earlier tool's PATH additions (e.g. node's).
#
# This was masked on Bitrise's macOS images because they ship a pre-existing
# asdf-managed Node.js already on PATH (independent of anything node.sh
# does), so copilot.sh's `is_installed npm` check happened to pass by pure
# coincidence. A clean Bitrise Linux image has no such pre-baked Node, which
# is what exposed the real bug: `❌ npm not found. Run node.sh first.` even
# though node.sh had just run successfully immediately before it in the
# very same install.sh invocation.
_sync_registered_paths() {
  [ -f /tmp/_registered_paths ] || return 0
  while IFS= read -r dir; do
    case ":${PATH}:" in
      *":${dir}:"*) ;;
      *) export PATH="${dir}:${PATH}" ;;
    esac
  done < /tmp/_registered_paths
}

# Restore paths accumulated by previous install.sh calls (file survives across calls)
_sync_registered_paths

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

  # Pick up any PATH entries the tool we just ran registered, so the NEXT
  # tool in this loop (e.g. copilot right after node) can see them.
  _sync_registered_paths
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Accumulate PATH from all child processes and call envman once ─────────────
# (PATH is already fully up to date here thanks to _sync_registered_paths
# being called after every tool above — this final sync is now mostly a
# no-op, kept only so the envman call below sees the definitely-final PATH.)
_sync_registered_paths
if [ -f /tmp/_registered_paths ]; then
  # DON'T delete — next install.sh call needs these paths too
  # rm -f /tmp/_registered_paths

  # Single envman call with the full cumulative PATH
  if [ "$(detect_ci)" = "bitrise" ]; then
    command -v envman &>/dev/null \
      && envman add --key PATH --value "${PATH}" \
      || true
  fi
fi

echo "✅ Done: ${INSTALLED} installed, ${SKIPPED} skipped"

# ── Verify installed tools are on PATH ────────────────────────────────────────
VERIFY_FAIL=0
for tool in ${TOOL_LIST}; do
  # Skip excluded tools
  echo " ${EXCLUDE} " | grep -qw "${tool}" && continue

  # Map tool name → binary name
  case "${tool}" in
    java)    BIN="java" ;;
    maven)   BIN="mvn" ;;
    node)    BIN="node" ;;
    dmtools) BIN="dmtools" ;;
    maestro) BIN="maestro" ;;
    copilot) BIN="copilot" ;;
    codemie) BIN="codemie-claude" ;;
    cursor)  BIN="cursor-agent" ;;
    codegraph) BIN="codegraph" ;;
    playwright) BIN="playwright" ;;
    kimi)    BIN="kimi" ;;
    gradle)  BIN="./gradlew" ;;  # project-local wrapper, never on PATH — see below
    android) BIN="sdkmanager" ;;
    emulator) BIN="emulator" ;;
    konan)   continue ;;  # no standalone binary — toolchain lives in ~/.konan
    *)       continue ;;
  esac

  # `gradlew` is a committed wrapper script in the repo working directory,
  # never a PATH binary — `command -v gradlew` is a structural false
  # negative (confirmed live: gradle.sh itself printed "✅ gradlew is
  # executable" moments earlier in the same run, then this check failed the
  # whole install with "NOT FOUND on PATH"). Check executability in place
  # instead of resolving it as a command.
  if [ "${tool}" = "gradle" ]; then
    if [ -x "${BIN}" ]; then
      echo "  ✓ ${BIN} → $(cd "$(dirname "${BIN}")" && pwd)/$(basename "${BIN}")"
    else
      echo "  ✗ ${BIN} — not found or not executable in $(pwd)" >&2
      VERIFY_FAIL=1
    fi
    continue
  fi

  if command -v "${BIN}" &>/dev/null; then
    LOC="$(command -v "${BIN}")"
    echo "  ✓ ${BIN} → ${LOC}"
  else
    echo "  ✗ ${BIN} — NOT FOUND on PATH" >&2
    VERIFY_FAIL=1
  fi
done

if [ "${VERIFY_FAIL}" -eq 1 ]; then
  echo "" >&2
  echo "❌ Some tools are missing from PATH!" >&2
  echo "   PATH=${PATH}" >&2
  exit 1
fi
