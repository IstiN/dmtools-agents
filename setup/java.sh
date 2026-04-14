#!/usr/bin/env bash
# Install Java (Temurin / OpenJDK).
#
# Usage:
#   java.sh [min_version]          # minimum required major version
#   JAVA_MIN_VERSION=17 java.sh    # env override
#
# Default minimum: 17 (DMtools requires 17+).
# If any Java >= min_version is already installed, skips installation.
# A newer Java (e.g. 23) is always accepted.
#
# Runner support:
#   GHA ubuntu/macos  — uses JAVA_HOME_<VER>_X64 / ARM64 pre-set env vars
#   Bitrise Linux     — Java 17 pre-installed on android-22.04 image
#   Bitrise Mac       — installs via brew cask temurin@<min_version>
#   Local             — brew (macOS) or apt (Linux)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

JAVA_MIN_VERSION="${1:-${JAVA_MIN_VERSION:-17}}"
OS="$(detect_os)"
ARCH="$(uname -m)"

echo "☕ Java >=${JAVA_MIN_VERSION} [OS=${OS} ARCH=${ARCH} CI=$(detect_ci)]"

# ── Helper: resolve JAVA_HOME for current 'java' binary ──────────────────────
_resolve_java_home() {
  if [ "${OS}" = "macos" ]; then
    /usr/libexec/java_home 2>/dev/null || true
  else
    local java_bin
    java_bin="$(readlink -f "$(which java)" 2>/dev/null || true)"
    [ -n "${java_bin}" ] && dirname "$(dirname "${java_bin}")" || true
  fi
}

# ── Helper: get current java major version ────────────────────────────────────
_java_major() {
  java -version 2>&1 | grep -oE '"[0-9]+' | head -1 | tr -d '"'
}

# ── Helper: version is acceptable (>= min) ───────────────────────────────────
_java_ok() {
  local ver
  ver="$(_java_major 2>/dev/null || echo 0)"
  [ "${ver}" -ge "${JAVA_MIN_VERSION}" ] 2>/dev/null
}

# ── Priority 1: JAVA_HOME already set and valid ───────────────────────────────
if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/java" ]; then
  if PATH="${JAVA_HOME}/bin:${PATH}" _java_ok; then
    echo "✅ Java $(_java_major) via existing JAVA_HOME (>=${JAVA_MIN_VERSION} ✓)"
    register_path "${JAVA_HOME}/bin"
    exit 0
  fi
fi

# ── Priority 2: 'java' on PATH is already acceptable ─────────────────────────
if is_installed java && _java_ok; then
  echo "✅ Java $(_java_major) already on PATH (>=${JAVA_MIN_VERSION} ✓)"
  JAVA_HOME_RESOLVED="$(_resolve_java_home)"
  [ -n "${JAVA_HOME_RESOLVED}" ] && export_var "JAVA_HOME" "${JAVA_HOME_RESOLVED}"
  exit 0
fi

# ── Priority 3: GHA pre-installed JAVA_HOME_<VER>_<ARCH> env var ─────────────
# GHA sets these for multiple Java versions — pick the highest available >= min.
case "${ARCH}" in
  x86_64)        ARCH_TAG="X64"   ;;
  arm64|aarch64) ARCH_TAG="ARM64" ;;
  *)             ARCH_TAG=""      ;;
esac
if [ -n "${ARCH_TAG}" ]; then
  for try_ver in 23 21 17; do
    if [ "${try_ver}" -ge "${JAVA_MIN_VERSION}" ] 2>/dev/null; then
      gha_var="JAVA_HOME_${try_ver}_${ARCH_TAG}"
      gha_val="${!gha_var:-}"
      if [ -n "${gha_val}" ] && [ -d "${gha_val}" ]; then
        echo "✅ Java ${try_ver} via GHA pre-installed (${gha_var})"
        export_var "JAVA_HOME" "${gha_val}"
        register_path "${gha_val}/bin"
        exit 0
      fi
    fi
  done
fi

# ── Priority 4: Install ───────────────────────────────────────────────────────
echo "📥 Installing Java ${JAVA_MIN_VERSION}..."

JAVA_HOME_RESOLVED=""

if [ "${OS}" = "macos" ]; then
  brew install --cask "temurin@${JAVA_MIN_VERSION}" 2>/dev/null \
    || brew install "openjdk@${JAVA_MIN_VERSION}" 2>/dev/null \
    || { echo "❌ brew install failed for Java ${JAVA_MIN_VERSION}" >&2; exit 1; }
  JAVA_HOME_RESOLVED="$(/usr/libexec/java_home -v "${JAVA_MIN_VERSION}" 2>/dev/null || true)"

elif [ "${OS}" = "linux" ]; then
  if sudo apt-get install -y "openjdk-${JAVA_MIN_VERSION}-jdk" -qq 2>/dev/null; then
    :
  else
    echo "apt fallback: adding Adoptium repo for Temurin ${JAVA_MIN_VERSION}..."
    sudo apt-get install -y wget apt-transport-https gnupg -qq
    wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public \
      | sudo tee /etc/apt/trusted.gpg.d/adoptium.asc >/dev/null
    echo "deb https://packages.adoptium.net/artifactory/deb $(lsb_release -cs) main" \
      | sudo tee /etc/apt/sources.list.d/adoptium.list
    sudo apt-get update -qq
    sudo apt-get install -y "temurin-${JAVA_MIN_VERSION}-jdk" -qq
  fi
  JAVA_HOME_RESOLVED="$(_resolve_java_home)"

else
  echo "❌ Unsupported OS: ${OS}" >&2; exit 1
fi

[ -n "${JAVA_HOME_RESOLVED}" ] && export_var "JAVA_HOME" "${JAVA_HOME_RESOLVED}" \
  && register_path "${JAVA_HOME_RESOLVED}/bin"

java -version
echo "✅ Java installed"
