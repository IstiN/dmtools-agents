#!/usr/bin/env bash
# Output cache paths and keys for CI platforms.
#
# Usage:
#   cache.sh keys    tool1 tool2 ...   # export {TOOL}_CACHE_PATH + {TOOL}_CACHE_KEY
#   cache.sh restore tool1 tool2 ...   # same as 'keys' (actual restore done by CI YAML)
#   cache.sh save    tool1 tool2 ...   # print paths to cache (for CI YAML reference)
#   cache.sh info                      # print cache table for all known tools
#
# Examples:
#   cache.sh keys dmtools maestro copilot node
#   cache.sh keys dmtools:v1.7.167 java:17
#
# After running, CI cache steps can reference exported env vars:
#   Bitrise:  key: $DMTOOLS_CACHE_KEY   paths: $DMTOOLS_CACHE_PATH
#   GHA:      key: ${{ env.DMTOOLS_CACHE_KEY }}   path: ${{ env.DMTOOLS_CACHE_PATH }}
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

OS_TAG="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"

# ── Per-tool cache definitions ────────────────────────────────────────────────

_cache_dmtools() {
  local version="${1:-${DMTOOLS_VERSION:-v1.7.171}}"
  export_var "DMTOOLS_CACHE_PATH" "${HOME}/.dmtools"
  export_var "DMTOOLS_CACHE_KEY"  "dmtools-${version}-${OS_TAG}"
}

_cache_java() {
  local version="${1:-${JAVA_VERSION:-17}}"
  # Java is managed by the OS package manager; cache JAVA_HOME only
  local home=""
  if [ "$(detect_os)" = "macos" ]; then
    home="$(/usr/libexec/java_home -v "${version}" 2>/dev/null || echo "")"
  fi
  export_var "JAVA_CACHE_PATH" "${home:-/usr/lib/jvm}"
  export_var "JAVA_CACHE_KEY"  "java-${version}-${OS_TAG}"
}

_cache_node() {
  local version="${1:-${NODE_VERSION:-20}}"
  export_var "NODE_CACHE_PATH" "${HOME}/.nvm"
  export_var "NODE_CACHE_KEY"  "nvm-node${version}-${OS_TAG}"
}

_cache_maestro() {
  local version="${1:-${MAESTRO_VERSION:-latest}}"
  export_var "MAESTRO_CACHE_PATH" "${HOME}/.maestro"
  export_var "MAESTRO_CACHE_KEY"  "maestro-${version}-${OS_TAG}"
}

_cache_copilot() {
  local version="${1:-${COPILOT_VERSION:-latest}}"
  export_var "COPILOT_CACHE_PATH" "${HOME}/.npm-global"
  export_var "COPILOT_CACHE_KEY"  "npm-global-copilot-${version}-${OS_TAG}"
}

_cache_codemie() {
  local version="${1:-${CODEMIE_VERSION:-latest}}"
  export_var "CODEMIE_CACHE_PATH" "${HOME}/.local/bin"
  export_var "CODEMIE_CACHE_KEY"  "codemie-${version}-${OS_TAG}"
}

# ── Dispatch ──────────────────────────────────────────────────────────────────

_dispatch_tool() {
  local tool="$1" version="$2"
  case "${tool}" in
    dmtools)  _cache_dmtools  "${version}" ;;
    java)     _cache_java     "${version}" ;;
    node)     _cache_node     "${version}" ;;
    maestro)  _cache_maestro  "${version}" ;;
    copilot)  _cache_copilot  "${version}" ;;
    codemie)  _cache_codemie  "${version}" ;;
    cursor)   echo "ℹ️  cursor-agent is not cacheable (part of Cursor IDE)" ;;
    *)        echo "⚠️  Unknown tool '${tool}' — skipping cache config" ;;
  esac
}

_print_info() {
  echo ""
  echo "┌─────────────┬──────────────────────────────────┬────────────────────────────────────────────────┐"
  printf "│ %-11s │ %-32s │ %-46s │\n" "Tool" "Cache Path" "Cache Key (example)"
  echo "├─────────────┼──────────────────────────────────┼────────────────────────────────────────────────┤"
  printf "│ %-11s │ %-32s │ %-46s │\n" "dmtools"  "~/.dmtools"     "dmtools-v1.7.167-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "java"     "~/.sdkman/... " "java-17-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "node"     "~/.nvm"         "nvm-node20-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "maestro"  "~/.maestro"     "maestro-latest-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "copilot"  "~/.npm-global"  "npm-global-copilot-latest-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "codemie"  "~/.local/bin"   "codemie-latest-linux-x86_64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "cursor"   "(not cacheable)" "-"
  echo "└─────────────┴──────────────────────────────────┴────────────────────────────────────────────────┘"
  echo ""
  echo "Exported env vars per tool:"
  echo "  {TOOL}_CACHE_PATH  — directory to cache"
  echo "  {TOOL}_CACHE_KEY   — cache key string"
  echo ""
  echo "Usage in Bitrise YAML:"
  echo "  - script@1:"
  echo "      inputs: [content: bash agents/setup/cache.sh keys dmtools maestro]"
  echo "  - restore-cache@3:"
  echo "      inputs: [key: \$DMTOOLS_CACHE_KEY, path: \$DMTOOLS_CACHE_PATH]"
}

# ── Main ──────────────────────────────────────────────────────────────────────

ALL_TOOLS="java node dmtools maestro copilot codemie"  # cursor has no cache

MODE="${1:-info}"
shift || true

if [ "${MODE}" = "info" ]; then
  _print_info
  exit 0
fi

if [ "${MODE}" != "keys" ] && [ "${MODE}" != "restore" ] && [ "${MODE}" != "save" ]; then
  echo "Usage: cache.sh keys|restore|save|info [tool1[:version] ... | all [-tool ...]]"
  exit 1
fi

if [ $# -eq 0 ]; then
  echo "No tools specified."
  echo "Example: cache.sh keys dmtools maestro copilot"
  echo "         cache.sh keys all"
  echo "         cache.sh keys all -cursor -codemie"
  exit 0
fi

# ── Resolve tool list (supports 'all' and '-exclusions') ──────────────────────

EXCLUDE=""
TOOL_LIST=""
USE_ALL=false

for arg in "$@"; do
  if [ "${arg}" = "all" ]; then
    USE_ALL=true
  elif [[ "${arg}" == -* ]]; then
    EXCLUDE="${EXCLUDE} ${arg#-}"
  else
    TOOL_NAME="${arg%%:*}"
    TOOL_LIST="${TOOL_LIST} ${arg}"  # keep version suffix if present
  fi
done

if $USE_ALL; then
  TOOL_LIST=""
  for t in ${ALL_TOOLS}; do
    TOOL_LIST="${TOOL_LIST} ${t}"
  done
fi

# ── Export cache vars per tool ────────────────────────────────────────────────

for arg in ${TOOL_LIST}; do
  TOOL_NAME="${arg%%:*}"
  TOOL_VERSION="${arg#*:}"
  [ "${TOOL_VERSION}" = "${TOOL_NAME}" ] && TOOL_VERSION=""

  if echo " ${EXCLUDE} " | grep -qw "${TOOL_NAME}"; then
    echo "⏭  Skipping cache config for ${TOOL_NAME} (excluded)"
    continue
  fi

  _dispatch_tool "${TOOL_NAME}" "${TOOL_VERSION}"

  VAR_PREFIX="$(echo "${TOOL_NAME}" | tr '[:lower:]' '[:upper:]')"
  PATH_VAR="${VAR_PREFIX}_CACHE_PATH"
  KEY_VAR="${VAR_PREFIX}_CACHE_KEY"
  echo "📦 ${TOOL_NAME}: key=${!KEY_VAR:-?}  path=${!PATH_VAR:-?}"
done

