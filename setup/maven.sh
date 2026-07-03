#!/usr/bin/env bash
# Install Apache Maven (binary distribution from apache.org archive, apt fallback on Linux).
# Bash 3.2 compatible (macOS system bash).
#
# Usage:
#   maven.sh [version]              # e.g. maven.sh 3.8.6
#   MAVEN_VERSION=3.8.6 maven.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

MAVEN_VERSION="${1:-${MAVEN_VERSION:-3.9.9}}"
INSTALL_DIR="${MAVEN_INSTALL_DIR:-$HOME/.maven}"

echo "🔨 Maven ${MAVEN_VERSION} [CI=$(detect_ci)]"

# ── Check if the exact requested version is already available ────────────────
maven_version_ok() {
  if ! is_installed mvn; then return 1; fi
  local raw
  raw="$(mvn -v 2>/dev/null | head -1 || true)"
  echo "${raw}" | grep -q "${MAVEN_VERSION}"
}

if maven_version_ok; then
  echo "✅ Maven ${MAVEN_VERSION} already available — skipping install"
  exit 0
fi

# ── Install from Apache archive (works on Linux and macOS) ───────────────────
echo "📥 Installing Maven ${MAVEN_VERSION}..."
mkdir -p "${INSTALL_DIR}"
ARCHIVE="apache-maven-${MAVEN_VERSION}-bin.tar.gz"
BASE_URL="https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries"

download() {
  local url="$1" out="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL "${url}" -o "${out}"
  elif command -v wget &>/dev/null; then
    wget -q "${url}" -O "${out}"
  else
    echo "❌ Neither curl nor wget available to download Maven" >&2
    exit 1
  fi
}

if ! download "${BASE_URL}/${ARCHIVE}" "/tmp/${ARCHIVE}"; then
  echo "❌ Failed to download Maven ${MAVEN_VERSION} from ${BASE_URL}" >&2
  echo "   Falling back to apt (version may differ from requested)..." >&2
  OS="$(detect_os)"
  if [ "${OS}" = "linux" ]; then
    SUDO="$(sudo_cmd)"
    ${SUDO} apt-get update -qq && ${SUDO} apt-get install -y maven -qq
    exit 0
  fi
  exit 1
fi

tar -xzf "/tmp/${ARCHIVE}" -C "${INSTALL_DIR}" --strip-components=1
rm -f "/tmp/${ARCHIVE}"

register_path "${INSTALL_DIR}/bin"

echo "✅ Maven $("${INSTALL_DIR}/bin/mvn" -v 2>&1 | head -1)"
