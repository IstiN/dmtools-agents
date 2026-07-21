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
#   cache.sh keys dmtools maestro copilot node playwright
#   cache.sh keys dmtools:v1.7.195 java:17
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
  local version="${1:-${DMTOOLS_VERSION:-v1.7.228}}"
  export_var "DMTOOLS_CACHE_PATH" "${HOME}/.dmtools"
  export_var "DMTOOLS_CACHE_KEY"  "dmtools-${version}-${OS_TAG}"
  # Restore key uses only the minor version prefix (e.g. v1.7.) so cache
  # hits are limited to the same minor line. The install script verifies
  # the exact version and reinstalls if the patch level differs.
  local minor_prefix="${version%.*}."
  export_var "DMTOOLS_CACHE_RESTORE_KEY" "dmtools-${minor_prefix}"
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

_cache_copilot_session() {
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/copilot-session.sh" env
}

_cache_codegraph() {
  local version="${1:-${CODEGRAPH_VERSION:-latest}}"
  # Binary cache (~/.npm-global)
  export_var "CODEGRAPH_CACHE_PATH" "${HOME}/.npm-global"
  export_var "CODEGRAPH_CACHE_KEY"  "npm-global-codegraph-${version}-${OS_TAG}"
  # Index cache (.codegraph/ in the workspace)
  local workspace="${GITHUB_WORKSPACE:-${PWD}}"
  export_var "CODEGRAPH_INDEX_CACHE_PATH" "${workspace}/.codegraph"
  export_var "CODEGRAPH_INDEX_CACHE_KEY"  "codegraph-index-${OS_TAG}"
}

_cache_playwright() {
  local version="${1:-${PLAYWRIGHT_VERSION:-latest}}"
  export_var "PLAYWRIGHT_CACHE_PATH" "${HOME}/.cache/ms-playwright"
  export_var "PLAYWRIGHT_CACHE_KEY"  "playwright-browsers-${version}-${OS_TAG}"
}

_cache_codemie() {
  local version="${1:-${CODEMIE_VERSION:-latest}}"
  export_var "CODEMIE_CACHE_PATH" "${HOME}/.local/bin"
  export_var "CODEMIE_CACHE_KEY"  "codemie-${version}-${OS_TAG}"
}

_cache_kimi() {
  local version="${1:-${KIMI_VERSION:-latest}}"
  export_var "KIMI_CACHE_PATH" "${HOME}/.kimi-code"
  export_var "KIMI_CACHE_KEY"  "kimi-${version}-${OS_TAG}"
}

_cache_kimi_session() {
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/kimi-session.sh" env
}

_cache_gradle() {
  # Gradle wrapper distribution (~/.gradle/wrapper) and dependency cache (~/.gradle/caches).
  # Keys hash the files most likely to change the cache content:
  #   wrapper key  — gradle-wrapper.properties (changes when Gradle version bumps)
  #   caches key   — libs.versions.toml + all *.gradle.kts (changes when deps or build scripts change)
  local workspace="${GITHUB_WORKSPACE:-${PWD}}"

  local wrapper_hash
  wrapper_hash="$(hash_file "${workspace}/gradle/wrapper/gradle-wrapper.properties")"

  # Aggregate hash over the version catalog + every Gradle Kotlin build script,
  # sorted for stability across filesystems/find implementations.
  local caches_hash="nokey"
  if command -v find &>/dev/null; then
    local build_files
    build_files="$(find "${workspace}" \( -name "libs.versions.toml" -o -name "*.gradle.kts" \) -not -path "*/build/*" -not -path "*/.git/*" 2>/dev/null | sort)"
    if [ -n "${build_files}" ]; then
      # shellcheck disable=SC2086
      caches_hash="$(hash_files ${build_files})"
    fi
  fi

  export_var "GRADLE_WRAPPER_CACHE_PATH" "${HOME}/.gradle/wrapper"
  export_var "GRADLE_WRAPPER_CACHE_KEY"  "gradle-wrapper-${wrapper_hash}"
  export_var "GRADLE_WRAPPER_CACHE_RESTORE_KEY" "gradle-wrapper-"

  export_var "GRADLE_CACHES_CACHE_PATH" "${HOME}/.gradle/caches"
  export_var "GRADLE_CACHES_CACHE_KEY"  "gradle-caches-${caches_hash}"
  export_var "GRADLE_CACHES_CACHE_RESTORE_KEY" "gradle-caches-"
}

_cache_konan() {
  # Kotlin/KMP native toolchain (~/.konan).
  # Key hashes libs.versions.toml because the Kotlin version bump triggers a new toolchain download.
  local workspace="${GITHUB_WORKSPACE:-${PWD}}"
  local konan_hash
  konan_hash="$(hash_file "${workspace}/gradle/libs.versions.toml")"

  export_var "KONAN_CACHE_PATH" "${HOME}/.konan"
  export_var "KONAN_CACHE_KEY"  "konan-${konan_hash}"
  export_var "KONAN_CACHE_RESTORE_KEY" "konan-"
}

_cache_android() {
  local compile_sdk="${1:-${ANDROID_COMPILE_SDK:-36}}"
  # Android SDK packages are large but stable — key on compileSdk version.
  local android_home="${ANDROID_HOME:-${HOME}/Android/Sdk}"

  export_var "ANDROID_CACHE_PATH" "${android_home}/platforms/android-${compile_sdk} ${android_home}/build-tools ${android_home}/platform-tools"
  export_var "ANDROID_CACHE_KEY"  "android-sdk-${compile_sdk}-${OS_TAG}"
  export_var "ANDROID_CACHE_RESTORE_KEY" "android-sdk-${compile_sdk}-"
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
    copilot-session) _cache_copilot_session ;;
    kimi-session) _cache_kimi_session ;;
    codegraph) _cache_codegraph "${version}" ;;
    playwright) _cache_playwright "${version}" ;;
    codemie)  _cache_codemie  "${version}" ;;
    kimi)     _cache_kimi     "${version}" ;;
    cursor)   echo "ℹ️  cursor-agent is not cacheable (part of Cursor IDE)" ;;
    gradle)   _cache_gradle ;;
    konan)    _cache_konan ;;
    android)  _cache_android  "${version}" ;;
    *)        echo "⚠️  Unknown tool '${tool}' — skipping cache config" ;;
  esac
}

_print_info() {
  echo ""
  echo "┌─────────────┬──────────────────────────────────┬────────────────────────────────────────────────┐"
  printf "│ %-11s │ %-32s │ %-46s │\n" "Tool" "Cache Path" "Cache Key (example)"
  echo "├─────────────┼──────────────────────────────────┼────────────────────────────────────────────────┤"
  printf "│ %-11s │ %-32s │ %-46s │\n" "dmtools"  "~/.dmtools"     "dmtools-v1.7.228-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "java"     "~/.sdkman/... " "java-17-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "node"     "~/.nvm"         "nvm-node20-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "maestro"  "~/.maestro"     "maestro-latest-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "copilot"  "~/.npm-global"  "npm-global-copilot-latest-darwin-arm64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "codemie"  "~/.local/bin"   "codemie-latest-linux-x86_64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "cursor"   "(not cacheable)" "-"
  printf "│ %-11s │ %-32s │ %-46s │\n" "codegraph" "~/.npm-global + .codegraph/" "npm-global-codegraph-latest-linux-x86_64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "playwright" "~/.cache/ms-playwright" "playwright-browsers-latest-linux-x86_64"
  printf "│ %-11s │ %-32s │ %-46s │\n" "gradle"    "~/.gradle/wrapper + caches" "gradle-wrapper-<hash> / gradle-caches-<hash>"
  printf "│ %-11s │ %-32s │ %-46s │\n" "konan"     "~/.konan"            "konan-<libs.versions.toml-hash>"
  printf "│ %-11s │ %-32s │ %-46s │\n" "android"   "\$ANDROID_HOME/..."  "android-sdk-36-linux-x86_64"
  echo "└─────────────┴──────────────────────────────────┴────────────────────────────────────────────────┘"
  echo ""
  echo "Exported env vars per tool:"
  echo "  {TOOL}_CACHE_PATH        — directory to cache"
  echo "  {TOOL}_CACHE_KEY         — cache key string"
  echo "  CODEGRAPH_INDEX_CACHE_PATH — .codegraph/ index directory (codegraph only)"
  echo "  CODEGRAPH_INDEX_CACHE_KEY  — cache key for the index (codegraph only)"
  echo ""
  echo "Usage in Bitrise YAML:"
  echo "  - script@1:"
  echo "      inputs: [content: bash agents/setup/cache.sh keys dmtools maestro]"
  echo "  - restore-cache@3:"
  echo "      inputs: [key: \$DMTOOLS_CACHE_KEY, path: \$DMTOOLS_CACHE_PATH]"
}

# ── Main ──────────────────────────────────────────────────────────────────────

ALL_TOOLS="java node dmtools maestro copilot copilot-session kimi-session codemie codegraph playwright kimi"  # cursor has no cache

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

  # gradle exports two independent cache namespaces (wrapper + caches) instead of
  # a single {TOOL}_CACHE_* pair, so it needs its own print branch.
  if [ "${TOOL_NAME}" = "gradle" ]; then
    echo "📦 gradle: key=${GRADLE_WRAPPER_CACHE_KEY:-?}  path=${GRADLE_WRAPPER_CACHE_PATH:-?}"
    echo "📦 gradle: key=${GRADLE_CACHES_CACHE_KEY:-?}  path=${GRADLE_CACHES_CACHE_PATH:-?}"
    continue
  fi

  VAR_PREFIX="$(echo "${TOOL_NAME}" | tr '[:lower:]-' '[:upper:]_')"
  PATH_VAR="${VAR_PREFIX}_CACHE_PATH"
  KEY_VAR="${VAR_PREFIX}_CACHE_KEY"
  echo "📦 ${TOOL_NAME}: key=${!KEY_VAR:-?}  path=${!PATH_VAR:-?}"
done
