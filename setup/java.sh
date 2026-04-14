#!/usr/bin/env bash
# Install Java (Temurin / OpenJDK).
# Any Java >= JAVA_MIN_VERSION on PATH is accepted (e.g. 23 is fine when min is 17).
# Bash 3.2 compatible (macOS system bash).
#
# Usage:
#   java.sh [min_version]          # minimum required major version
#   JAVA_MIN_VERSION=17 java.sh    # env override
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

JAVA_MIN_VERSION="${1:-${JAVA_MIN_VERSION:-17}}"
OS="$(detect_os)"

echo "☕ Java >=${JAVA_MIN_VERSION} [OS=${OS} CI=$(detect_ci)]"

# ── Check if acceptable Java is already available ─────────────────────────────
java_version_ok() {
  if ! is_installed java; then return 1; fi
  # Get major version: "17.0.1" -> 17, "1.8.0" -> 1
  local raw major
  raw="$(java -version 2>&1 | head -1 || true)"
  # Extract first quoted number group
  major="$(echo "${raw}" | sed 's/.*"\([0-9]*\).*/\1/' || true)"
  # Handle old 1.x format
  if [ "${major}" = "1" ]; then
    major="$(echo "${raw}" | sed 's/.*"1\.\([0-9]*\).*/\1/' || true)"
  fi
  # If we couldn't parse, assume ok (don't block on parse failure)
  [ -z "${major}" ] && return 0
  [ "${major}" -ge "${JAVA_MIN_VERSION}" ] 2>/dev/null
}

if java_version_ok; then
  echo "✅ Java already available (>=${JAVA_MIN_VERSION} ✓) — skipping install"
  if [ -n "${JAVA_HOME:-}" ]; then
    register_path "${JAVA_HOME}/bin"
  fi
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing Java ${JAVA_MIN_VERSION}..."

if [ "${OS}" = "macos" ]; then
  brew install --cask "temurin@${JAVA_MIN_VERSION}" \
    || brew install "openjdk@${JAVA_MIN_VERSION}" \
    || { echo "❌ brew install failed for Java ${JAVA_MIN_VERSION}" >&2; exit 1; }
  JAVA_HOME_RESOLVED="$(/usr/libexec/java_home -v "${JAVA_MIN_VERSION}" 2>/dev/null || true)"

elif [ "${OS}" = "linux" ]; then
  if ! sudo apt-get install -y "openjdk-${JAVA_MIN_VERSION}-jdk" -qq 2>/dev/null; then
    echo "apt fallback: adding Adoptium Temurin repo..."
    sudo apt-get install -y wget apt-transport-https gnupg -qq
    wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public \
      | sudo tee /etc/apt/trusted.gpg.d/adoptium.asc >/dev/null
    echo "deb https://packages.adoptium.net/artifactory/deb $(lsb_release -cs) main" \
      | sudo tee /etc/apt/sources.list.d/adoptium.list
    sudo apt-get update -qq
    sudo apt-get install -y "temurin-${JAVA_MIN_VERSION}-jdk" -qq
  fi
  JAVA_HOME_RESOLVED="$(dirname "$(dirname "$(readlink -f "$(which java)" 2>/dev/null || true)")" 2>/dev/null || true)"

else
  echo "❌ Unsupported OS: ${OS}" >&2; exit 1
fi

if [ -n "${JAVA_HOME_RESOLVED:-}" ]; then
  export_var "JAVA_HOME" "${JAVA_HOME_RESOLVED}"
  register_path "${JAVA_HOME_RESOLVED}/bin"
fi

java -version
echo "✅ Java ${JAVA_MIN_VERSION} installed"
